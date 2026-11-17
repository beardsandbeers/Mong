"""Choose where a CRM load writes: mongot search indexes or mongod collections.

Both targets create one search index per entity. mongot receives the documents
directly. mongod stores them in a collection and creates the search index there.

Both targets prepare the destination, then hand the loader a picklable writer
factory. The loader calls ``upsert_many(address, documents, concern=...)`` and
does not know which server is on the other side. ``address`` is an index id for
mongot and a collection name for mongod.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from typing import Any, Callable, Sequence

from scripts.crm.schema import RELATIONSHIP_FIELDS, search_definition
from scripts.ingest.concerns import (
    MONGOD_CONCERNS,
    MONGOD_DEFAULT_CONCERN,
    MONGOT_CONCERNS,
    MONGOT_DEFAULT_CONCERN,
)
from scripts.ingest.mongod import (
    DEFAULT_DATABASE,
    ensure_collection,
    ensure_collection_search_index,
    mongod_writer,
    resolve_uri,
    validate_database,
)

DEFAULT_INDEX_SUFFIX = "_search"


@dataclass(frozen=True)
class Prepared:
    """``ids`` is entity -> writer address. ``details`` is the JSON report block."""

    ids: dict[str, str]
    details: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class MongotTarget:
    index_suffix: str = DEFAULT_INDEX_SUFFIX
    key: str = "mongot"
    concerns: tuple[str, ...] = MONGOT_CONCERNS
    default_concern: str = MONGOT_DEFAULT_CONCERN

    def prepare(
        self,
        entities: Sequence[str],
        *,
        log: Callable[[str], None] = print,
        service: Any = None,
    ) -> Prepared:
        if service is None:
            from mong.service import MongotService

            service = MongotService()
        details = ensure_targets(service, entities=entities, index_suffix=self.index_suffix, log=log)
        return Prepared(
            ids={entity: info["index_id"] for entity, info in details.items()},
            details=details,
        )

    def writer_factory(self) -> Callable[[], Any]:
        from scripts.ingest.mongot import mongot_writer

        return mongot_writer


@dataclass(frozen=True)
class MongodTarget:
    uri: str
    database: str
    index_suffix: str = DEFAULT_INDEX_SUFFIX
    key: str = "mongod"
    concerns: tuple[str, ...] = MONGOD_CONCERNS
    default_concern: str = MONGOD_DEFAULT_CONCERN

    def __post_init__(self) -> None:
        validate_database(self.database)
        if not self.uri.startswith(("mongodb://", "mongodb+srv://")):
            raise ValueError("MongoDB URI must start with mongodb:// or mongodb+srv://")

    def prepare(
        self,
        entities: Sequence[str],
        *,
        log: Callable[[str], None] = print,
        client: Any = None,
    ) -> Prepared:
        from scripts.ingest.mongod import as_ingest_error, connect

        owns = client is None
        if client is None:
            try:
                client = connect(self.uri)
            except ImportError:
                raise
            except Exception as exc:
                wrapped = as_ingest_error(exc, self.uri, action="Could not reach mongod")
                if wrapped is None:
                    raise
                raise wrapped from exc
        try:
            try:
                client.admin.command("ping")
            except Exception as exc:
                wrapped = as_ingest_error(exc, self.uri, action="Could not reach mongod")
                if wrapped is None:
                    raise
                raise wrapped from exc
            database = client[self.database]
            details: dict[str, dict[str, Any]] = {}
            for entity in entities:
                info = ensure_collection(
                    database,
                    entity,
                    index_fields=RELATIONSHIP_FIELDS.get(entity, ("_id",)),
                )
                info["database"] = self.database
                try:
                    search = ensure_collection_search_index(
                        database[entity],
                        name=f"{entity}{self.index_suffix}",
                        definition=search_definition(entity),
                    )
                except Exception as exc:
                    wrapped = as_ingest_error(exc, self.uri, action="Could not create search index")
                    if wrapped is None:
                        raise
                    raise wrapped from exc
                info["search_index"] = search["name"]
                info["search_index_action"] = search["action"]
                if search.get("id") is not None:
                    info["search_index_id"] = search["id"]
                details[entity] = info
                extra = f"; indexes {', '.join(info['indexes'])}" if info["indexes"] else ""
                log(f"{self.database}.{entity}: collection ({info['action']}{extra})")
                note = "; definition replaced" if search["action"] == "updated" else ""
                log(f"{search['name']}: search index ({search['action']}{note})")
            return Prepared(ids={entity: entity for entity in entities}, details=details)
        finally:
            if owns:
                client.close()

    def writer_factory(self) -> Callable[[], Any]:
        return partial(mongod_writer, self.uri, self.database)


def ensure_targets(
    service: Any,
    *,
    entities: Sequence[str],
    index_suffix: str = DEFAULT_INDEX_SUFFIX,
    log: Callable[[str], None] = print,
) -> dict[str, dict[str, Any]]:
    """Create or reuse one search index per entity. Same report shape as before the split."""
    from scripts.ingest.mongot import ensure_search_index, log_search_index

    targets: dict[str, dict[str, Any]] = {}
    for entity in entities:
        index_name = f"{entity}{index_suffix}"
        index, action = ensure_search_index(
            service,
            name=index_name,
            definition=search_definition(entity),
        )
        log_search_index(index_name, index, action, log)
        targets[entity] = {
            "index_id": index["index_id"],
            "index_name": index_name,
            "index_action": action,
        }
    return targets


def open_target(
    name: str,
    *,
    index_suffix: str | None = None,
    mongo_uri: str | None = None,
    database: str | None = None,
) -> MongotTarget | MongodTarget:
    """Build a target. This does not connect; ``prepare`` does."""
    if name == "mongot":
        return MongotTarget(index_suffix=index_suffix or DEFAULT_INDEX_SUFFIX)
    if name == "mongod":
        return MongodTarget(
            uri=resolve_uri(mongo_uri),
            database=database or DEFAULT_DATABASE,
            index_suffix=index_suffix or DEFAULT_INDEX_SUFFIX,
        )
    raise ValueError(f"unknown target: {name}")
