"""Direct writes to a mongod collection, plus the collection's search index.

``--target mongod`` uses ``mongod_writer``. On the loader's writer protocol the
first argument is the collection name (one batch is one collection) and
``concern`` is ``acknowledged``, ``journaled``, or ``majority``. The search
index is created before streaming, with the definition the caller supplies.

Each batch is a bulk replace keyed by ``_id``, so running the same documents
again upserts them in place. Install pymongo before opening a connection:

    pip install 'mong[mongod]'
"""

from __future__ import annotations

import os
from typing import Any, Sequence
from urllib.parse import unquote, urlsplit, urlunsplit

from scripts.ingest.concerns import MONGOD_CONCERNS

DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017"
DEFAULT_DATABASE = "crm"
_SERVER_SELECTION_TIMEOUT_MS = 5_000

# kwargs for pymongo.WriteConcern. Order matches MONGOD_CONCERNS.
_CONCERN_OPTIONS: dict[str, dict[str, Any]] = {
    "acknowledged": {"w": 1},
    "journaled": {"w": 1, "j": True},
    "majority": {"w": "majority"},
}

_INVALID_DB_CHARS = set('/\\. "$*<>:|?')


class IngestError(RuntimeError):
    """mongod could not be reached or a write failed. The message is safe to print."""


def validate_database(name: str) -> None:
    if not name or not name.strip():
        raise ValueError("database name is empty")
    if (
        name != name.strip()
        or len(name.encode("utf-8")) > 63
        or any(char in _INVALID_DB_CHARS or char == "\0" for char in name)
    ):
        raise ValueError("invalid database name")


def resolve_uri(explicit: str | None) -> str:
    """Flag, then ``MONGODB_URI``, then the local default. Never log the result."""
    if explicit is not None:
        uri = explicit
    else:
        uri = os.environ.get("MONGODB_URI") or DEFAULT_MONGO_URI
    if not uri or not uri.strip():
        raise ValueError("MongoDB URI is empty")
    if not uri.startswith(("mongodb://", "mongodb+srv://")):
        raise ValueError("MongoDB URI must start with mongodb:// or mongodb+srv://")
    return uri


def redact_uri(uri: str) -> str:
    """Host and scheme only. Userinfo and query strings stay out of logs."""
    parts = urlsplit(uri)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    if parts.username is not None or parts.password is not None:
        host = f"***@{host}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def redact_secrets(text: str, uri: str) -> str:
    parts = urlsplit(uri)
    username = unquote(parts.username) if parts.username else None
    password = unquote(parts.password) if parts.password else None
    encoded_user = parts.username
    encoded_password = parts.password
    userinfo = ""
    if encoded_user is not None:
        userinfo = encoded_user if encoded_password is None else f"{encoded_user}:{encoded_password}"
    for secret in (userinfo, encoded_password, password, encoded_user, username):
        if secret:
            text = text.replace(secret, "***")
    return text


def concern_options(concern: str) -> dict[str, Any]:
    try:
        return dict(_CONCERN_OPTIONS[concern])
    except KeyError:
        allowed = ", ".join(MONGOD_CONCERNS)
        raise ValueError(f"mongod concern must be one of {allowed}") from None


def connect(uri: str) -> Any:
    try:
        from pymongo import MongoClient
    except ImportError as exc:
        raise ImportError(
            "The mongod target needs pymongo. Install it with: pip install 'mong[mongod]'"
        ) from exc
    return MongoClient(uri, serverSelectionTimeoutMS=_SERVER_SELECTION_TIMEOUT_MS, appname="mong-crm")


def as_ingest_error(exc: Exception, uri: str, *, action: str) -> IngestError | None:
    module = type(exc).__module__
    if not (module.startswith("pymongo") or module.startswith("bson")):
        return None
    detail = redact_secrets(f"{type(exc).__name__}: {exc}", uri)
    return IngestError(f"{action} ({redact_uri(uri)}): {detail}")


def _stored_search_definition(index: dict[str, Any]) -> Any:
    if "latestDefinition" in index:
        return index["latestDefinition"]
    return index.get("definition")


def _search_definitions_match(stored: Any, wanted: dict[str, Any]) -> bool:
    """True when a mongod search definition is the one we asked for.

    Servers fill ``lucene.standard`` for an omitted analyzer, on the definition
    or under ``mappings``. That is not a definition change.
    """
    from scripts.ingest.mongot import definitions_match

    if definitions_match(stored, wanted):
        return True
    if not isinstance(stored, dict):
        return False
    normalized = dict(stored)
    mappings = normalized.get("mappings")
    wanted_mappings = wanted.get("mappings")
    if isinstance(mappings, dict):
        mappings = dict(mappings)
        expected = wanted_mappings if isinstance(wanted_mappings, dict) else {}
        for key in ("analyzer", "searchAnalyzer"):
            if key not in expected and mappings.get(key) == "lucene.standard":
                mappings.pop(key)
        normalized["mappings"] = mappings
    return definitions_match(normalized, wanted)


def _find_named_search_index(collection: Any, name: str) -> dict[str, Any] | None:
    listed = collection.list_search_indexes(name)
    try:
        indexes = list(listed)
    finally:
        close = getattr(listed, "close", None)
        if close is not None:
            close()
    for index in indexes:
        if index.get("name") == name:
            return dict(index)
    return None


def _describe_search_index(index: dict[str, Any], name: str, action: str) -> dict[str, Any]:
    info: dict[str, Any] = {"name": index.get("name") or name, "action": action}
    if index.get("id") is not None:
        info["id"] = index["id"]
    return info


def ensure_collection_search_index(
    collection: Any,
    *,
    name: str,
    definition: dict[str, Any],
) -> dict[str, Any]:
    """Create, reuse, or replace one search index on ``collection``.

    ``action`` is ``created``, ``existing``, or ``updated``. An update replaces
    the definition. Documents already in the collection stay where they are.
    """
    existing = _find_named_search_index(collection, name)
    if existing is None:
        collection.create_search_index({"name": name, "type": "search", "definition": definition})
        created = _find_named_search_index(collection, name) or {"name": name}
        return _describe_search_index(created, name, "created")
    if _search_definitions_match(_stored_search_definition(existing), definition):
        return _describe_search_index(existing, name, "existing")
    collection.update_search_index(name, definition)
    return _describe_search_index(existing, name, "updated")


def ensure_collection(database: Any, name: str, *, index_fields: Sequence[str]) -> dict[str, Any]:
    """Create ``name`` when it is missing and ensure secondary indexes on ``index_fields``.

    ``_id`` is skipped; mongod already indexes it. ``action`` is ``created`` or
    ``existing``. ``indexes`` lists the secondary fields, whether or not this call
    was the one that first built them. ``create_index`` is idempotent.
    """
    existing = set(database.list_collection_names())
    action = "existing" if name in existing else "created"
    if action == "created":
        database.create_collection(name)
    collection = database[name]
    indexes = [field for field in index_fields if field != "_id"]
    for field in indexes:
        collection.create_index([(field, 1)], name=f"{field}_1")
    return {"collection": name, "action": action, "indexes": indexes}


def mongod_writer(uri: str, database: str) -> MongodWriter:
    """Open one mongod writer. Safe to pass to a spawned ingest process."""
    return MongodWriter(uri, database)


class MongodWriter:
    """One process's mongod client. Do not share it across processes."""

    def __init__(self, uri: str, database: str, *, client: Any | None = None) -> None:
        self.uri = uri
        self.database_name = database
        self._owns = client is None
        if client is None:
            try:
                client = connect(uri)
            except ImportError:
                raise
            except Exception as exc:
                wrapped = as_ingest_error(exc, uri, action="Could not reach mongod")
                if wrapped is None:
                    raise
                raise wrapped from exc
        self._client = client
        self._database = client[database]

    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> None:
        """Bulk-replace ``documents`` into collection ``index_id``."""
        if not documents:
            return
        if any("_id" not in document for document in documents):
            raise ValueError("every document needs _id")
        options = concern_options(concern)
        try:
            from pymongo import ReplaceOne, WriteConcern
        except ImportError as exc:
            raise ImportError(
                "The mongod target needs pymongo. Install it with: pip install 'mong[mongod]'"
            ) from exc
        collection = self._database[index_id].with_options(write_concern=WriteConcern(**options))
        operations = [ReplaceOne({"_id": document["_id"]}, document, upsert=True) for document in documents]
        try:
            collection.bulk_write(operations, ordered=False)
        except Exception as exc:
            wrapped = as_ingest_error(exc, self.uri, action="mongod write failed")
            if wrapped is None:
                raise
            raise wrapped from exc

    def close(self) -> None:
        if self._owns:
            self._client.close()
