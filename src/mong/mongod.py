"""Search indexes that MongoDB manages, read through mongod.

``createSearchIndex`` on a collection creates these. nomongo-t 0.10 lists the
replicated copies itself; this module is the fallback when that list is empty,
and it queries them with ``$search`` and ``$vectorSearch``.
Mong only reads them: documents change in the collection, and definitions change
through MongoDB.

``MONGODB_URI`` turns this on. Messages never include the URI's password.
"""

from __future__ import annotations

import itertools
import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator
from urllib.parse import quote, unquote, urlsplit

from pymongo import MongoClient, errors

from mong.field_suggestions import SAMPLE_SIZE, SAMPLE_TIMEOUT_MS, has_dynamic, sample_mapping
from mong.serialize import INDEX_TYPE_VALUES, parse_json_document, python_to_jsonable, results_to_jsonable
from mong.service import explain_name

ID_PREFIX = "mongod:"
CURSOR_PREFIX = "mongod-"
SKIPPED_DATABASES = {"admin", "config", "local"}
INTERNAL_DATABASE_PREFIX = "__mdb_internal"
SNAPSHOT_SECONDS = 5.0
CURSOR_IDLE_SECONDS = 600.0
MAX_CURSORS = 100
MAX_PAGE_SIZE = 1000
SERVER_SELECTION_TIMEOUT_MS = 3000

_SCORE = "__mong_score"
_HIGHLIGHTS = "__mong_highlights"
_SCORE_DETAILS = "__mong_score_details"
# $search options that only shape the hits. $searchMeta rejects them.
_HIT_OPTIONS = {"returnStoredSource", "highlight", "scoreDetails", "sort", "searchAfter", "searchBefore", "tracking"}
_EXPLAIN_VERBOSITY = {
    "query_planner": "queryPlanner",
    "execution_stats": "executionStats",
    "all_plans_execution": "allPlansExecution",
}
_EXPLAIN_NOISE = {"serverParameters", "serverInfo", "command", "ok", "$clusterTime", "operationTime", "queryShapeHash"}
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


class MongodError(Exception):
    """A mongod failure with the HTTP status to report. The message is safe to show."""

    def __init__(self, message: str, *, status: int = 502, code: str = "MONGOD_ERROR") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def index_id(database: str, collection: str, name: str) -> str:
    return ID_PREFIX + ":".join(quote(part, safe="") for part in (database, collection, name))


def parse_index_id(value: str) -> tuple[str, str, str]:
    parts = value[len(ID_PREFIX) :].split(":") if value.startswith(ID_PREFIX) else []
    if len(parts) != 3 or not all(parts):
        raise MongodError(f"Not a MongoDB index id: {value}", status=400, code="INVALID_ARGUMENT")
    database, collection, name = (unquote(part) for part in parts)
    return database, collection, name


def is_index_id(value: str) -> bool:
    return str(value).startswith(ID_PREFIX)


def is_cursor_id(value: str | int) -> bool:
    return str(value).startswith(CURSOR_PREFIX)


def display_name(database: str, collection: str, name: str) -> str:
    return f"{database}.{collection}/{name}"


def describe_index(database: str, collection: str, raw: dict[str, Any], documents: int | None) -> dict[str, Any]:
    """One ``$listSearchIndexes`` entry in the shape of a standalone index."""
    name = str(raw.get("name") or "default")
    status = str(raw.get("status") or "UNKNOWN").upper()
    latest = (raw.get("latestDefinitionVersion") or {}).get("version")
    active = latest
    message = raw.get("message")
    for detail in raw.get("statusDetail") or []:
        main = detail.get("mainIndex") or {}
        version = (main.get("definitionVersion") or {}).get("version")
        if version is not None:
            active = version
        message = message or main.get("message") or detail.get("message")
    index_type = "VECTOR_SEARCH" if raw.get("type") == "vectorSearch" else "SEARCH"
    definition = raw.get("latestDefinition")
    return {
        "index_id": index_id(database, collection, name),
        "name": display_name(database, collection, name),
        "source": "mongod",
        "database": database,
        "collection": collection,
        "index_name": name,
        "mongot_id": raw.get("id"),
        "type": index_type,
        "type_code": INDEX_TYPE_VALUES[index_type],
        "desired_revision": int(latest or 0),
        "active_revision": int(active if active is not None else latest or 0),
        "lifecycle_state": status,
        "queryable": bool(raw.get("queryable")),
        "generation_id": None,
        "failure_message": str(message) if status == "FAILED" and message else None,
        "definition": python_to_jsonable(definition) if definition is not None else None,
        "stats": {"documents": documents, "size_bytes": None, "files": None, "segments": None, "queries": None},
    }


def _redact(text: str, uri: str) -> str:
    if uri:
        text = text.replace(uri, "<MONGODB_URI>")
        password = urlsplit(uri).password
        if password:
            for secret in {password, unquote(password)}:
                text = text.replace(secret, "***")
    return text


def _as_error(exc: Exception, uri: str) -> MongodError | None:
    if isinstance(exc, errors.ConnectionFailure):
        detail = str(exc).split(", Timeout:")[0]
        return MongodError(_redact(f"MongoDB is unreachable: {detail}", uri), status=503, code="MONGOD_UNAVAILABLE")
    if isinstance(exc, errors.OperationFailure):
        message = _redact(str((exc.details or {}).get("errmsg") or exc), uri)
        if exc.code == 43:
            return MongodError("The result cursor expired. Run the query again.", status=404, code="CURSOR_NOT_FOUND")
        if exc.code in (13, 18):
            return MongodError(f"MongoDB refused the request: {message}", status=403, code="MONGOD_UNAUTHORIZED")
        return MongodError(message, status=400, code="MONGOD_ERROR")
    if isinstance(exc, errors.ConfigurationError):
        return MongodError(_redact(f"MONGODB_URI is invalid: {exc}", uri), status=500, code="MONGOD_CONFIG")
    if isinstance(exc, errors.PyMongoError):
        return MongodError(_redact(f"{type(exc).__name__}: {exc}", uri), status=502)
    return None


def _connect(uri: str) -> Any:
    return MongoClient(uri, serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS, appname="mong-admin")


def _page_size(batch_size: int) -> int:
    return max(1, min(int(batch_size), MAX_PAGE_SIZE))


def _pipeline(name: str, payload: dict[str, Any], *, vector: bool) -> list[dict[str, Any]]:
    if vector:
        return [
            {"$vectorSearch": {**payload, "index": name}},
            {"$addFields": {_SCORE: {"$meta": "vectorSearchScore"}}},
        ]
    fields: dict[str, Any] = {_SCORE: {"$meta": "searchScore"}}
    if payload.get("highlight"):
        fields[_HIGHLIGHTS] = {"$meta": "searchHighlights"}
    if payload.get("scoreDetails"):
        fields[_SCORE_DETAILS] = {"$meta": "searchScoreDetails"}
    return [{"$search": {**payload, "index": name}}, {"$addFields": fields}]


def _hit(document: dict[str, Any], score_key: str) -> dict[str, Any]:
    """Search metadata under the ``$`` keys standalone hits use, then the document."""
    hit: dict[str, Any] = {}
    if _SCORE in document:
        hit[score_key] = document.pop(_SCORE)
    if _HIGHLIGHTS in document:
        hit["$searchHighlights"] = document.pop(_HIGHLIGHTS)
    if _SCORE_DETAILS in document:
        hit["$searchScoreDetails"] = document.pop(_SCORE_DETAILS)
    hit.update(document)
    return hit


def _explain_document(raw: dict[str, Any]) -> Any:
    """mongot's explain (the format standalone queries return) with mongod's stages under ``mongod``."""
    mongot: dict[str, Any] | None = None
    stages = []
    for stage in raw.get("stages") or []:
        entry = {}
        for key, value in stage.items():
            if mongot is None and isinstance(value, dict) and isinstance(value.get("explain"), dict):
                mongot = value["explain"]
                value = {inner: item for inner, item in value.items() if inner != "explain"}
            entry[key] = value
        stages.append(entry)
    rest = {key: value for key, value in raw.items() if key not in _EXPLAIN_NOISE and key != "stages"}
    document = dict(mongot or {})
    document["mongod"] = {**rest, "stages": stages} if stages else rest
    return python_to_jsonable(document)


def _page(index_id: str, hits: list[dict[str, Any]], *, page: int, page_size: int) -> dict[str, Any]:
    return {
        "index_id": index_id,
        "page": max(1, int(page)),
        "page_size": page_size,
        "count": len(hits),
        "results": results_to_jsonable(hits),
        "metadata": None,
        "explain": None,
        "explain_verbosity": None,
        "generation_id": "",
        "cursor_id": None,
        "has_more": False,
    }


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def _close_quietly(cursor: Any) -> None:
    try:
        cursor.close()
    except Exception:  # noqa: BLE001 - mongod reaps idle cursors on its own
        pass


@dataclass
class _Cursor:
    cursor: Any
    index_id: str
    score_key: str
    used: float


class MongodSearch:
    """Lists and queries MongoDB-managed search indexes. One client per process; thread-safe."""

    def __init__(
        self,
        uri: str | None = None,
        *,
        connect: Callable[[str], Any] = _connect,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._uri = uri
        self._connect = connect
        self._clock = clock
        self._client: Any = None
        self._lock = threading.Lock()
        self._snapshot: tuple[float, dict[str, Any]] | None = None
        self._known: list[dict[str, Any]] = []
        self._cursors: dict[str, _Cursor] = {}

    @property
    def uri(self) -> str:
        value = self._uri if self._uri is not None else os.environ.get("MONGODB_URI", "")
        return value.strip()

    @property
    def enabled(self) -> bool:
        return bool(self.uri)

    @contextmanager
    def _mongod(self) -> Iterator[None]:
        try:
            yield
        except MongodError:
            raise
        except Exception as exc:
            converted = _as_error(exc, self.uri)
            if converted is None:
                raise
            raise converted from None

    def _db(self) -> Any:
        if not self.enabled:
            raise MongodError("Set MONGODB_URI to read MongoDB-managed indexes.", status=503, code="MONGOD_DISABLED")
        with self._lock:
            if self._client is None:
                self._client = self._connect(self.uri)
            return self._client

    # ----- listing -----

    def snapshot(self, *, refresh: bool = False) -> dict[str, Any]:
        """Indexes and connection state, cached briefly because the UI polls.

        On a failure the last listed indexes are kept, so a short outage does not empty the list.
        """
        if not self.enabled:
            return {"enabled": False, "connected": False, "error": None, "indexes": []}
        now = self._clock()
        with self._lock:
            cached = self._snapshot
        if cached is not None and not refresh and now - cached[0] < SNAPSHOT_SECONDS:
            return cached[1]
        try:
            with self._mongod():
                indexes = self._list_indexes()
            state = {"enabled": True, "connected": True, "error": None, "indexes": indexes}
        except MongodError as exc:
            state = {"enabled": True, "connected": False, "error": str(exc), "indexes": self._known}
        with self._lock:
            if state["connected"]:
                self._known = state["indexes"]
            self._snapshot = (now, state)
        return state

    def list_indexes(self) -> list[dict[str, Any]]:
        return list(self.snapshot()["indexes"])

    def _list_indexes(self) -> list[dict[str, Any]]:
        client = self._db()
        indexes: list[dict[str, Any]] = []
        for database_name in sorted(client.list_database_names()):
            if database_name in SKIPPED_DATABASES or database_name.startswith(INTERNAL_DATABASE_PREFIX):
                continue
            database = client[database_name]
            for info in sorted(database.list_collections(), key=lambda item: item["name"]):
                name = info["name"]
                if name.startswith("system.") or info.get("type", "collection") not in ("collection", "view"):
                    continue
                collection = database[name]
                try:
                    listed = list(collection.list_search_indexes())
                except errors.OperationFailure:
                    continue
                if listed:
                    documents = self._document_count(collection)
                    indexes.extend(describe_index(database_name, name, raw, documents) for raw in listed)
        return indexes

    @staticmethod
    def _document_count(collection: Any) -> int | None:
        try:
            return int(collection.estimated_document_count())
        except errors.OperationFailure:
            return None

    def get_index(self, index_id: str) -> dict[str, Any]:
        database, collection_name, name = parse_index_id(index_id)
        with self._mongod():
            collection = self._db()[database][collection_name]
            raw = next((item for item in collection.list_search_indexes(name) if item.get("name") == name), None)
            if raw is None:
                raise MongodError(
                    f"No search index {display_name(database, collection_name, name)}", status=404, code="NOT_FOUND"
                )
            return describe_index(database, collection_name, raw, self._document_count(collection))

    def field_suggestions(self, index_id: str) -> dict[str, Any]:
        """Bounded collection sample for editor hints, not a mapping export."""
        index = self.get_index(index_id)
        definition = index.get("definition") or {}
        documents: list[dict[str, Any]] = []
        if index["type"] == "SEARCH" and has_dynamic(definition.get("mappings") or {}):
            database, collection_name, _ = parse_index_id(index_id)
            with self._mongod():
                collection = self._db()[database][collection_name]
                with collection.aggregate(
                    [{"$sample": {"size": SAMPLE_SIZE}}], maxTimeMS=SAMPLE_TIMEOUT_MS,
                ) as cursor:
                    documents = list(itertools.islice(cursor, SAMPLE_SIZE))
        return {
            "mappings": sample_mapping(definition, documents),
            "source": "sampled",
            "sample_size": len(documents),
        }

    # ----- queries -----

    def search(
        self,
        index_id: str,
        query: dict[str, Any],
        *,
        batch_size: int = 25,
        vector: bool = False,
        page: int = 1,
        drain: bool = False,
        max_batches: int = 20,
        generation_id: str = "",
        explain: str = "",
    ) -> dict[str, Any]:
        """``$search`` or ``$vectorSearch`` on the index's collection, as a standalone query page.

        ``query`` is the same expression standalone mongot takes; an ``index`` key is the
        editor's and is replaced with this index's name. ``generation_id`` has no meaning here.
        """
        started = time.perf_counter()
        database_name, collection_name, name = parse_index_id(index_id)
        page_size = _page_size(batch_size)
        verbosity = explain_name(explain)
        payload = parse_json_document(dict(query))
        payload.pop("index", None)
        pipeline = _pipeline(name, payload, vector=vector)
        score_key = "$vectorSearchScore" if vector else "$searchScore"
        with self._mongod():
            database = self._db()[database_name]
            collection = database[collection_name]
            explained = None
            if verbosity:
                raw = database.command(
                    "explain",
                    {"aggregate": collection_name, "pipeline": pipeline, "cursor": {}},
                    verbosity=_EXPLAIN_VERBOSITY[verbosity],
                )
                explained = _explain_document(raw)
            metadata = None
            if not vector and ("count" in payload or "facet" in payload):
                metadata = self._search_meta(collection, name, payload)
            if verbosity == "query_planner":
                result = _page(index_id, [], page=page, page_size=page_size)
            else:
                cursor = collection.aggregate(pipeline, batchSize=page_size)
                result = self._first_page(
                    index_id, cursor, score_key, page=page, page_size=page_size, drain=drain, max_batches=max_batches
                )
        result.update(metadata=metadata, explain=explained, explain_verbosity=verbosity, latency_ms=_elapsed_ms(started))
        return result

    def search_meta(
        self,
        index_id: str,
        query: dict[str, Any],
        *,
        generation_id: str = "",
        explain: str = "",
    ) -> dict[str, Any]:
        """``$searchMeta`` for a MongoDB-managed index. No hits are returned."""
        del generation_id
        started = time.perf_counter()
        database_name, collection_name, name = parse_index_id(index_id)
        verbosity = explain_name(explain)
        payload = parse_json_document(dict(query))
        payload.pop("index", None)
        with self._mongod():
            database = self._db()[database_name]
            collection = database[collection_name]
            explained = None
            if verbosity:
                stage = {key: value for key, value in payload.items() if key not in _HIT_OPTIONS}
                stage["index"] = name
                raw = database.command(
                    "explain",
                    {"aggregate": collection_name, "pipeline": [{"$searchMeta": stage}], "cursor": {}},
                    verbosity=_EXPLAIN_VERBOSITY[verbosity],
                )
                explained = _explain_document(raw)
            metadata = None if verbosity == "query_planner" else self._search_meta(collection, name, payload)
        return {
            "index_id": index_id,
            "page": 1,
            "page_size": 0,
            "count": 0,
            "results": [],
            "metadata": metadata,
            "explain": explained,
            "explain_verbosity": verbosity or None,
            "generation_id": "",
            "cursor_id": None,
            "has_more": False,
            "latency_ms": _elapsed_ms(started),
        }

    @staticmethod
    def _search_meta(collection: Any, name: str, payload: dict[str, Any]) -> Any:
        stage = {key: value for key, value in payload.items() if key not in _HIT_OPTIONS}
        stage["index"] = name
        with collection.aggregate([{"$searchMeta": stage}]) as cursor:
            found = next(cursor, None)
        return python_to_jsonable(found) if found is not None else None

    def browse(
        self,
        index_id: str,
        *,
        batch_size: int = 25,
        query: dict[str, Any] | None = None,
        page: int = 1,
        drain: bool = False,
        generation_id: str = "",
        count: bool = False,
    ) -> dict[str, Any]:
        """The collection's documents, which are what the index holds. With ``query`` this searches."""
        if query:
            expression = dict(query)
            if count:
                expression.setdefault("count", {"type": "lowerBound"})
            return self.search(index_id, expression, batch_size=batch_size, page=page, drain=drain)
        started = time.perf_counter()
        database_name, collection_name, _name = parse_index_id(index_id)
        page_size = _page_size(batch_size)
        with self._mongod():
            collection = self._db()[database_name][collection_name]
            metadata = None
            if count:
                total = self._document_count(collection)
                metadata = {"count": {"total": total}} if total is not None else None
            cursor = collection.find({}, batch_size=page_size)
            result = self._first_page(index_id, cursor, "$searchScore", page=page, page_size=page_size, drain=drain)
        result.update(metadata=metadata, latency_ms=_elapsed_ms(started))
        return result

    def _first_page(
        self,
        index_id: str,
        cursor: Any,
        score_key: str,
        *,
        page: int,
        page_size: int,
        drain: bool,
        max_batches: int = 20,
    ) -> dict[str, Any]:
        limit = page_size * max(1, int(max_batches)) if drain else page_size
        try:
            hits = [_hit(document, score_key) for document in itertools.islice(cursor, limit)]
            more = bool(cursor.alive)
        except BaseException:
            _close_quietly(cursor)
            raise
        result = _page(index_id, hits, page=page, page_size=page_size)
        if more and not drain:
            result["cursor_id"] = self._keep(_Cursor(cursor, index_id, score_key, self._clock()))
            result["has_more"] = True
        else:
            _close_quietly(cursor)
            if drain:
                result["has_more"] = more
                result["truncated"] = more
        return result

    def search_more(
        self,
        cursor_id: str | int,
        *,
        index_id: str = "",
        batch_size: int = 25,
        page: int = 1,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        key = str(cursor_id)
        with self._lock:
            entry = self._cursors.pop(key, None)
        if entry is None:
            raise MongodError("The result cursor expired. Run the query again.", status=404, code="CURSOR_NOT_FOUND")
        page_size = _page_size(batch_size)
        with self._mongod():
            try:
                entry.cursor.batch_size(page_size)
                hits = [_hit(document, entry.score_key) for document in itertools.islice(entry.cursor, page_size)]
                more = bool(entry.cursor.alive)
            except BaseException:
                _close_quietly(entry.cursor)
                raise
        result = _page(index_id or entry.index_id, hits, page=page, page_size=page_size)
        if more:
            entry.used = self._clock()
            result["cursor_id"] = self._keep(entry, key)
            result["has_more"] = True
        else:
            _close_quietly(entry.cursor)
        result["latency_ms"] = _elapsed_ms(started)
        return result

    def kill_cursor(self, cursor_id: str | int) -> dict[str, Any]:
        with self._lock:
            entry = self._cursors.pop(str(cursor_id), None)
        if entry is not None:
            _close_quietly(entry.cursor)
        return {"cursor_id": str(cursor_id), "killed": True}

    def _keep(self, entry: _Cursor, key: str | None = None) -> str:
        """Hold a cursor for the next page. Idle and excess cursors are closed."""
        key = key or CURSOR_PREFIX + uuid.uuid4().hex
        now = self._clock()
        with self._lock:
            self._cursors[key] = entry
            stale = {name for name, item in self._cursors.items() if now - item.used > CURSOR_IDLE_SECONDS}
            by_age = sorted(self._cursors, key=lambda name: self._cursors[name].used)
            stale.update(by_age[: max(0, len(self._cursors) - MAX_CURSORS)])
            stale.discard(key)
            closing = [self._cursors.pop(name) for name in stale]
        for item in closing:
            _close_quietly(item.cursor)
        return key


def alerts(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Metrics-summary alerts for MongoDB-managed indexes and the mongod connection."""
    found: list[dict[str, Any]] = []

    def add(alert_id: str, severity: str, title: str, detail: str, index: dict[str, Any] | None = None) -> None:
        found.append(
            {
                "id": alert_id,
                "severity": severity,
                "title": title,
                "detail": detail,
                "index_id": index["index_id"] if index else None,
                "index_name": index["name"] if index else None,
            }
        )

    if state.get("error"):
        add("mongod-unreachable", "error", "MongoDB is unreachable", state["error"])
    for index in state.get("indexes") or []:
        index_key, name, status = index["index_id"], index["name"], index["lifecycle_state"]
        if status == "FAILED":
            add(f"failed:{index_key}", "error", f"{name} failed", index.get("failure_message") or "MongoDB reports FAILED.", index)
        elif status in ("STALE", "DOES_NOT_EXIST"):
            label = status.lower().replace("_", " ")
            add(f"status:{index_key}", "warning", f"{name} is {label}", f"MongoDB reports {status}.", index)
        elif status != "READY":
            add(f"lifecycle:{index_key}", "info", f"{name} is {status.lower()}", f"MongoDB reports {status}.", index)
        elif index["desired_revision"] != index["active_revision"]:
            add(
                f"rebuilding:{index_key}",
                "info",
                f"{name} is rebuilding",
                f"Definition version {index['desired_revision']} is building; "
                f"version {index['active_revision']} serves queries.",
                index,
            )
    return found


def _coupled_key(index: dict[str, Any]) -> tuple[str, str, str] | None:
    """``(database, collection, index name)`` for one physical search index."""
    namespace = index.get("namespace") or {}
    database = namespace.get("database") or index.get("database")
    collection = namespace.get("collection") or index.get("collection")
    name = index.get("index_name") or index.get("name")
    if database and collection and name and "/" not in str(name):
        return (str(database), str(collection), str(name))
    return None


def merge_summary(summary: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Add MongoDB-managed indexes nomongo-t did not already report.

    A replicated index and the ``$listSearchIndexes`` entry for the same
    collection index are one index. The collection document count fills in
    when nomongo-t has no document gauge for it.
    """
    listed = [dict(index) for index in summary.get("indexes") or []]
    by_key = {key: index for index in listed if (key := _coupled_key(index))}
    extras: list[dict[str, Any]] = []
    for index in state.get("indexes") or []:
        documents = (index.get("stats") or {}).get("documents")
        match = by_key.get(_coupled_key(index) or ("", "", ""))
        if match is not None:
            metrics = dict(match.get("metrics") or {})
            if metrics.get("documents") is None and documents is not None:
                metrics["documents"] = documents
                match["metrics"] = metrics
            continue
        extras.append({**index, "metrics": {"documents": documents, "status_label": None}})
    merged = [*summary.get("alerts", []), *alerts(state)]
    merged.sort(key=lambda alert: _SEVERITY_ORDER.get(alert["severity"], 3))
    return {
        **summary,
        "indexes": [*listed, *extras],
        "alerts": merged,
        "mongod": {key: state[key] for key in ("enabled", "connected", "error")},
    }
