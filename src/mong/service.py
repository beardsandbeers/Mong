"""High-level NoMongo-T operations used by the admin API.

Writes push BSON directly into an index (0.3+). There is no collection catalog
or source document store. 0.4 adds static mapping export, 0.5 adds index and
per-field statistics, and 0.8 adds query explain plus delete-by-query.
"""

from __future__ import annotations

import re
import time
from typing import Any

from mongot_standalone import api, encode_bson

from mong.client import create_client
from mong.serialize import (
    INDEX_TYPE_VALUES,
    bson_to_python,
    index_mappings_to_dict,
    index_to_dict,
    message_to_dict,
    parse_json_document,
    parse_json_value,
    python_to_jsonable,
    results_to_jsonable,
    status_to_dict,
)

MAX_FIELD_STATS_PAGE_SIZE = 500

_EXPLAIN_VERBOSITY = {
    "": api.EXPLAIN_VERBOSITY_UNSPECIFIED,
    "off": api.EXPLAIN_VERBOSITY_UNSPECIFIED,
    "unspecified": api.EXPLAIN_VERBOSITY_UNSPECIFIED,
    "query_planner": api.EXPLAIN_VERBOSITY_QUERY_PLANNER,
    "execution_stats": api.EXPLAIN_VERBOSITY_EXECUTION_STATS,
    "all_plans_execution": api.EXPLAIN_VERBOSITY_ALL_PLANS_EXECUTION,
}

_EXPLAIN_NAMES = {
    api.EXPLAIN_VERBOSITY_QUERY_PLANNER: "query_planner",
    api.EXPLAIN_VERBOSITY_EXECUTION_STATS: "execution_stats",
    api.EXPLAIN_VERBOSITY_ALL_PLANS_EXECUTION: "all_plans_execution",
}

_UPDATE_MODES = {
    "auto": api.INDEX_UPDATE_MODE_AUTO,
    "preserve": api.INDEX_UPDATE_MODE_REQUIRE_PRESERVE,
    "rebuild": api.INDEX_UPDATE_MODE_REBUILD_EMPTY,
}

_DIRECT_READ = "direct read contract"


def update_mode(value: str | None) -> int:
    """Map a definition-save choice onto the 0.10 IndexUpdateMode enum."""
    key = (value or "auto").strip().lower().replace("-", "_")
    try:
        return _UPDATE_MODES[key]
    except KeyError:
        raise ValueError("update_mode must be auto, preserve, or rebuild") from None


def _unsupported_direct_read(exc: Exception) -> bool:
    return isinstance(exc, RuntimeError) and _DIRECT_READ in str(exc)


def _page_token(response: Any) -> str:
    token = getattr(response, "next_page_token", "") or ""
    return token if isinstance(token, str) else ""


def list_index_pages(client: Any) -> list[Any]:
    """Every index the server will list, including replicated ones on 0.10.

    Pagination asks the server to acknowledge the direct-read contract. An older
    server rejects that, and the unpaged list is used instead.
    """
    try:
        request = api.ListIndexesRequest(page_size=200)
        indexes: list[Any] = []
        while True:
            response = client.list_indexes(request)
            indexes.extend(response.indexes)
            token = _page_token(response)
            if not token:
                return indexes
            request = api.ListIndexesRequest(page_size=200, page_token=token)
    except RuntimeError as exc:
        if not _unsupported_direct_read(exc):
            raise
        return list(client.list_indexes(api.ListIndexesRequest()).indexes)


def query_has_join(query: Any) -> bool:
    if isinstance(query, dict):
        join = query.get("join")
        if isinstance(join, dict) and join.get("from"):
            return True
        return any(query_has_join(value) for value in query.values())
    if isinstance(query, list):
        return any(query_has_join(item) for item in query)
    return False


def join_bindings(query: Any, indexes: list[dict[str, Any]]) -> list[Any]:
    """Bind each join ``from`` name to an index id when that name is unique.

    0.10 uses these bindings to read a joined index directly. Ambiguous names are
    left for the server to resolve.
    """
    names: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            join = node.get("join")
            if isinstance(join, dict) and isinstance(join.get("from"), str) and join["from"]:
                names.append(join["from"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(query)
    by_name: dict[str, str] = {}
    ambiguous: set[str] = set()
    for index in indexes:
        name = index.get("name")
        index_id = index.get("index_id")
        if not name or not index_id or name in ambiguous:
            continue
        if name in by_name and by_name[name] != index_id:
            ambiguous.add(name)
            by_name.pop(name, None)
            continue
        by_name[name] = index_id
    seen: set[str] = set()
    bindings = []
    for name in names:
        if name in seen or name not in by_name:
            continue
        seen.add(name)
        bindings.append(api.JoinIndexBinding(alias=name, index_id=by_name[name]))
    return bindings


def explain_verbosity(value: str | None) -> int:
    """Map an explain name onto the 0.8 QueryRequest enum. Blank means off."""
    raw = (value or "").strip()
    if raw.lower().startswith("explain_verbosity_"):
        raw = raw[len("explain_verbosity_") :]
    key = re.sub(r"[\s-]+", "_", raw)
    key = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", key).lower()
    try:
        return _EXPLAIN_VERBOSITY[key]
    except KeyError:
        raise ValueError(
            "explain must be query_planner, execution_stats, or all_plans_execution"
        ) from None


def explain_name(value: str | None) -> str | None:
    """Canonical explain name (``query_planner``, ...), or None when explain is off."""
    return _EXPLAIN_NAMES.get(explain_verbosity(value))


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


class MongotService:
    def status(self, *, include_metrics: bool = False) -> dict[str, Any]:
        with create_client() as client:
            status = client.get_status(api.GetStatusRequest())
        return status_to_dict(status, include_metrics=include_metrics)

    def list_indexes(self) -> list[dict[str, Any]]:
        with create_client() as client:
            listed = list_index_pages(client)
        indexes = [index_to_dict(idx) for idx in listed]
        by_id = {item["index_id"]: item.get("stats") for item in self.status()["indexes"]}
        for index in indexes:
            if index["index_id"] in by_id:
                index["stats"] = by_id[index["index_id"]]
        return indexes

    def list_index_definitions(self) -> list[dict[str, Any]]:
        """Indexes with their definitions, without the per-index stats that need GetStatus."""
        with create_client() as client:
            listed = list_index_pages(client)
        return [index_to_dict(idx) for idx in listed]

    def get_index(self, index_id: str) -> dict[str, Any]:
        with create_client() as client:
            index = client.get_index(api.GetIndexRequest(index_id=index_id))
        return index_to_dict(index)

    def create_index(
        self,
        *,
        name: str,
        index_type: str = "SEARCH",
        definition: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        type_code = INDEX_TYPE_VALUES.get(index_type.upper())
        if type_code is None:
            raise ValueError(f"Unknown index type: {index_type}")
        if definition is None:
            if type_code == api.INDEX_TYPE_VECTOR_SEARCH:
                definition = {
                    "fields": [
                        {
                            "type": "vector",
                            "path": "embedding",
                            "numDimensions": 3,
                            "similarity": "cosine",
                        }
                    ]
                }
            else:
                definition = {"mappings": {"dynamic": True}, "storedSource": True}

        with create_client() as client:
            index = client.create_index(
                api.CreateIndexRequest(
                    name=name,
                    type=type_code,
                    definition_bson=encode_bson(definition),
                )
            )
        return index_to_dict(index)

    def update_index(
        self,
        index_id: str,
        *,
        definition: dict[str, Any],
        expected_revision: int | None = None,
        update_mode_name: str = "auto",
    ) -> dict[str, Any]:
        revision = expected_revision
        if revision is None:
            revision = self.get_index(index_id)["desired_revision"]
        mode = update_mode(update_mode_name)
        with create_client() as client:
            index = client.update_index(
                api.UpdateIndexRequest(
                    index_id=index_id,
                    expected_revision=revision,
                    definition_bson=encode_bson(definition),
                    update_mode=mode,
                )
            )
        return index_to_dict(index)

    def drop_index(
        self,
        index_id: str,
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        revision = expected_revision
        if revision is None:
            revision = self.get_index(index_id)["desired_revision"]
        with create_client() as client:
            index = client.drop_index(
                api.DropIndexRequest(
                    index_id=index_id,
                    expected_revision=revision,
                )
            )
        return index_to_dict(index)

    def export_mappings(self, index_id: str, *, generation_id: str = "") -> dict[str, Any]:
        """Static mapping inferred from the types observed in a search index.

        Vector-search indexes are rejected by the server with FAILED_PRECONDITION.
        """
        with create_client() as client:
            response = client.get_index_mappings(
                api.GetIndexMappingsRequest(index_id=index_id, generation_id=generation_id)
            )
        return index_mappings_to_dict(response)

    def index_stats(
        self,
        index_id: str,
        *,
        refresh: bool = False,
        generation_id: str = "",
    ) -> dict[str, Any]:
        with create_client() as client:
            stats = client.get_index_stats(
                api.GetIndexStatsRequest(
                    index_id=index_id,
                    generation_id=generation_id,
                    refresh=refresh,
                )
            )
        return message_to_dict(stats)

    def field_stats(
        self,
        index_id: str,
        *,
        refresh: bool = False,
        paths: list[str] | None = None,
        page_size: int = 100,
        page_token: str = "",
        generation_id: str = "",
        wait_seconds: float = 10.0,
    ) -> dict[str, Any]:
        """One page of per-field storage/memory attribution.

        Polls while the server is still collecting, up to ``wait_seconds``. Page tokens
        bind to the first page's filters and page size, and later pages must not refresh.
        """
        request = api.GetIndexFieldStatsRequest(
            index_id=index_id,
            generation_id=generation_id,
            refresh=refresh and not page_token,
            paths=paths or [],
            page_size=max(1, min(int(page_size), MAX_FIELD_STATS_PAGE_SIZE)),
            page_token=page_token,
        )
        deadline = time.monotonic() + wait_seconds
        with create_client() as client:
            while True:
                response = client.get_index_field_stats(request)
                if response.state != api.STATS_COLLECTION_STATE_COLLECTING:
                    break
                if time.monotonic() >= deadline:
                    break
                request.refresh = False
                time.sleep(max(response.retry_after_millis, 100) / 1000)
        return message_to_dict(response)

    def upsert_documents(
        self,
        index_id: str,
        documents: list[dict[str, Any]],
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        parsed = [parse_json_document(doc) for doc in documents]
        with create_client() as client:
            response = client.upsert_many(
                index_id,
                parsed,
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "indexed_count": response.indexed_count,
        }

    def delete_document(
        self,
        index_id: str,
        document_id: Any,
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete(
                index_id,
                parse_json_value(document_id),
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "processed_count": response.processed_count,
        }

    def delete_documents(
        self,
        index_id: str,
        document_ids: list[Any],
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete_many(
                index_id,
                [parse_json_value(item) for item in document_ids],
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "processed_count": response.processed_count,
        }

    def delete_by_query(
        self,
        index_id: str,
        *,
        query: dict[str, Any] | None = None,
        vector: bool = False,
        match_all: bool = False,
        dry_run: bool = True,
        max_matches: int = 0,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        """Delete ids selected by a search query, a vector metadata filter, or every document.

        ``dry_run`` counts matches and writes nothing. ``max_matches`` of 0 uses the
        server default (10,000). The server rejects a larger cap. A real delete can
        apply only a prefix if ingestion interleaves or the call fails.
        """
        if match_all and query is not None:
            raise ValueError("match_all cannot be combined with a query")
        if not match_all and not isinstance(query, dict):
            raise ValueError("query must be an object")
        limit = int(max_matches)
        if limit < 0:
            raise ValueError("max_matches must be >= 0")
        predicate = None
        if not match_all:
            predicate = parse_json_document(dict(query or {}))
            if not vector:
                predicate.pop("index", None)
        with create_client() as client:
            response = client.index(index_id).delete_by_query(
                predicate,
                vector=vector,
                match_all=match_all,
                concern=concern,
                generation_id=generation_id,
                max_matches=limit,
                dry_run=dry_run,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "active_revision": response.active_revision,
            "matched_count": response.matched_count,
            "processed_count": response.processed_count,
            "dry_run": response.dry_run,
        }

    def _query_page_from_response(
        self,
        *,
        index_id: str,
        response: Any,
        page: int,
        page_size: int,
        explain: str = "",
    ) -> dict[str, Any]:
        batch = bson_to_python(response.batch_bson) or {}
        results = batch.get("results", [])
        metadata = bson_to_python(response.metadata_bson) if response.metadata_bson else None
        explain_bson = getattr(response, "explain_bson", b"") or b""
        explained = bson_to_python(explain_bson) if explain_bson else None
        cursor_id = int(response.cursor_id or 0)
        verbosity = _EXPLAIN_NAMES.get(explain_verbosity(explain))
        return {
            "index_id": index_id,
            "page": page,
            "page_size": page_size,
            "count": len(results),
            "results": results_to_jsonable(results),
            "metadata": python_to_jsonable(metadata),
            "explain": python_to_jsonable(explained) if explained is not None else None,
            "explain_verbosity": verbosity,
            "generation_id": response.generation_id or "",
            "cursor_id": str(cursor_id) if cursor_id else None,
            "has_more": bool(cursor_id),
        }

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
        started = time.perf_counter()
        page_size = max(1, min(int(batch_size), 1000))
        verbosity = explain_verbosity(explain)
        # `index` is an editor affordance. mongot receives the id on the request.
        payload = parse_json_document(dict(query))
        payload.pop("index", None)
        bindings = join_bindings(payload, self.list_index_definitions()) if query_has_join(payload) else []
        with create_client() as client:
            request = api.QueryRequest(
                index_id=index_id,
                query_bson=encode_bson(payload),
                batch_size=page_size,
                generation_id=generation_id,
                explain_verbosity=verbosity,
                join_indexes=bindings,
            )

            def run(current: Any) -> Any:
                return client.vector_search(current) if vector else client.search(current)

            try:
                response = run(request)
            except RuntimeError as exc:
                if not bindings or not _unsupported_direct_read(exc):
                    raise
                request = api.QueryRequest(
                    index_id=index_id,
                    query_bson=encode_bson(payload),
                    batch_size=page_size,
                    generation_id=generation_id,
                    explain_verbosity=verbosity,
                )
                response = run(request)

            if not drain:
                page_result = self._query_page_from_response(
                    index_id=index_id,
                    response=response,
                    page=max(1, int(page)),
                    page_size=page_size,
                    explain=explain,
                )
                page_result["latency_ms"] = _elapsed_ms(started)
                return page_result

            results: list[Any] = []
            metadata: Any = None
            explained: Any = None
            seen_generation = ""
            batches = 0
            while True:
                batches += 1
                batch = bson_to_python(response.batch_bson) or {}
                results.extend(batch.get("results", []))
                if response.metadata_bson:
                    metadata = bson_to_python(response.metadata_bson)
                explain_bson = getattr(response, "explain_bson", b"") or b""
                if explain_bson:
                    explained = bson_to_python(explain_bson)
                seen_generation = response.generation_id or seen_generation
                if not response.cursor_id or batches >= max_batches:
                    if response.cursor_id:
                        client.kill_cursor(api.KillCursorRequest(cursor_id=response.cursor_id))
                    break
                response = client.get_more(
                    api.GetMoreRequest(cursor_id=response.cursor_id, batch_size=page_size)
                )

        return {
            "index_id": index_id,
            "page": 1,
            "page_size": page_size,
            "count": len(results),
            "results": results_to_jsonable(results),
            "metadata": python_to_jsonable(metadata),
            "explain": python_to_jsonable(explained) if explained is not None else None,
            "explain_verbosity": _EXPLAIN_NAMES.get(verbosity),
            "generation_id": seen_generation,
            "cursor_id": None,
            "has_more": batches >= max_batches,
            "truncated": batches >= max_batches,
            "latency_ms": _elapsed_ms(started),
        }

    def search_more(
        self,
        cursor_id: str | int,
        *,
        index_id: str = "",
        batch_size: int = 25,
        page: int = 1,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        page_size = max(1, min(int(batch_size), 1000))
        with create_client() as client:
            response = client.get_more(
                api.GetMoreRequest(cursor_id=int(cursor_id), batch_size=page_size)
            )
        page_result = self._query_page_from_response(
            index_id=index_id,
            response=response,
            page=max(1, int(page)),
            page_size=page_size,
        )
        page_result["latency_ms"] = _elapsed_ms(started)
        return page_result

    def search_meta(
        self,
        index_id: str,
        query: dict[str, Any],
        *,
        generation_id: str = "",
        explain: str = "",
    ) -> dict[str, Any]:
        """Facet and count metadata with no hits. Requires a server that has SearchMeta."""
        started = time.perf_counter()
        verbosity = explain_verbosity(explain)
        payload = parse_json_document(dict(query))
        payload.pop("index", None)
        bindings = join_bindings(payload, self.list_index_definitions()) if query_has_join(payload) else []
        with create_client() as client:
            request = api.SearchMetaRequest(
                index_id=index_id,
                query_bson=encode_bson(payload),
                generation_id=generation_id,
                explain_verbosity=verbosity,
                target_index_id=index_id,
                join_indexes=bindings,
            )
            try:
                response = client.search_meta(request)
            except RuntimeError as exc:
                if not _unsupported_direct_read(exc):
                    raise
                response = client.search_meta(
                    api.SearchMetaRequest(
                        index_id=index_id,
                        query_bson=encode_bson(payload),
                        generation_id=generation_id,
                        explain_verbosity=verbosity,
                    )
                )
        metadata = bson_to_python(response.metadata_bson) if response.metadata_bson else None
        explain_bson = getattr(response, "explain_bson", b"") or b""
        explained = bson_to_python(explain_bson) if explain_bson else None
        return {
            "index_id": index_id,
            "page": 1,
            "page_size": 0,
            "count": 0,
            "results": [],
            "metadata": python_to_jsonable(metadata),
            "explain": python_to_jsonable(explained) if explained is not None else None,
            "explain_verbosity": _EXPLAIN_NAMES.get(verbosity),
            "generation_id": response.generation_id or "",
            "cursor_id": None,
            "has_more": False,
            "latency_ms": _elapsed_ms(started),
        }

    def kill_cursor(self, cursor_id: str | int) -> dict[str, Any]:
        with create_client() as client:
            client.kill_cursor(api.KillCursorRequest(cursor_id=int(cursor_id)))
        return {"cursor_id": str(cursor_id), "killed": True}

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
        """Browse documents via a broad search expression on a search index.

        Always requests stored source so each hit is the full document, not only ``_id``.
        Stored source is returned only when the index definition enables it.
        """
        expression = dict(query) if query else {"exists": {"path": "_id"}}
        expression["returnStoredSource"] = True
        if count:
            expression.setdefault("count", {"type": "lowerBound"})
        return self.search(
            index_id,
            expression,
            batch_size=batch_size,
            vector=False,
            page=page,
            drain=drain,
            generation_id=generation_id,
        )
