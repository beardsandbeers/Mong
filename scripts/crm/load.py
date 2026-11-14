"""Create CRM search indexes and stream faker documents into mongot in batches.

Indexes are instance-wide. A definition change replaces the index with an empty
generation, so the following upsert reingests the documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, Sequence

from tqdm import tqdm

from mong.service import MongotService
from scripts.crm.generate import ENTITY_KEYS, CrmGenerator, CrmSpec

RELATIONSHIP_FIELDS: dict[str, tuple[str, ...]] = {
    "accounts": ("_id",),
    "contacts": ("_id", "account_id", "opportunity_ids"),
    "opportunities": ("_id", "account_id", "contact_ids", "primary_contact_id"),
}


def search_definition(entity: str) -> dict[str, Any]:
    """Dynamic mapping plus token-indexed id fields so `equals`/`in` lookups can follow links."""
    return {
        "mappings": {
            "dynamic": True,
            "fields": {path: {"type": "token"} for path in RELATIONSHIP_FIELDS.get(entity, ("_id",))},
        },
        "storedSource": True,
    }


class Upserter(Protocol):
    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> Any: ...


def find_search_index(service: MongotService, name: str) -> dict[str, Any] | None:
    for index in service.list_indexes():
        if index.get("name") == name and str(index.get("type", "")).upper() == "SEARCH":
            return index
    return None


def ensure_search_index(
    service: MongotService,
    *,
    name: str,
    definition: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Return (index, action) where action is 'created', 'updated', or 'existing'.

    ``updated`` means UpdateIndex replaced the index with an empty generation.
    Callers must reingest documents after that.
    """
    existing = find_search_index(service, name)
    if existing is None:
        index = service.create_index(
            name=name,
            index_type="SEARCH",
            definition=definition,
        )
        return index, "created"
    if existing.get("definition") != definition:
        return service.update_index(existing["index_id"], definition=definition), "updated"
    return existing, "existing"


def ensure_targets(
    service: MongotService,
    *,
    entities: Sequence[str],
    index_suffix: str = "_search",
    log: Callable[[str], None] = print,
) -> dict[str, dict[str, Any]]:
    targets: dict[str, dict[str, Any]] = {}
    for entity in entities:
        index_name = f"{entity}{index_suffix}"
        index, index_action = ensure_search_index(
            service,
            name=index_name,
            definition=search_definition(entity),
        )
        note = ""
        if index_action == "updated":
            note = "; definition change rebuilt an empty generation"
        log(f"{index_name}: index {index['index_id']} ({index_action}{note})")
        targets[entity] = {
            "index_id": index["index_id"],
            "index_name": index_name,
            "index_action": index_action,
        }
    return targets


@dataclass
class _Buffer:
    index_id: str
    documents: list[dict[str, Any]] = field(default_factory=list)
    first_account: int | None = None
    written: int = 0
    batches: int = 0


def stream_crm_documents(
    spec: CrmSpec,
    *,
    upserter: Upserter,
    index_ids: dict[str, str],
    entities: Sequence[str] = ENTITY_KEYS,
    batch_size: int = 100,
    concern: str = "committed",
    progress: bool = True,
) -> dict[str, Any]:
    """Generate documents account by account and flush each index every batch_size docs.

    Memory is bounded by one account's link table plus one batch per index.
    On interrupt, ``resume_from_account`` is the lowest account index whose
    documents may not all have been written (upserts are idempotent, so
    re-running from there is safe).
    """
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")

    totals = spec.document_counts(entities)
    buffers = {entity: _Buffer(index_ids[entity]) for entity in entities}
    bar = tqdm(
        total=sum(totals.values()),
        unit="doc",
        unit_scale=True,
        dynamic_ncols=True,
        disable=not progress,
    )
    current_account = spec.start_account
    interrupted = False

    def flush(entity: str) -> None:
        buf = buffers[entity]
        if not buf.documents:
            return
        upserter.upsert_many(buf.index_id, buf.documents, concern=concern)
        count = len(buf.documents)
        buf.written += count
        buf.batches += 1
        buf.documents = []
        buf.first_account = None
        bar.update(count)
        bar.set_postfix(
            at_account=current_account,
            **{key: b.written for key, b in buffers.items()},
            refresh=False,
        )

    try:
        generator = CrmGenerator(spec)
        for account, entity, document in generator.iter_documents(entities):
            current_account = account
            buf = buffers[entity]
            if buf.first_account is None:
                buf.first_account = account
            buf.documents.append(document)
            if len(buf.documents) >= batch_size:
                flush(entity)
        for entity in entities:
            flush(entity)
    except KeyboardInterrupt:
        interrupted = True
    finally:
        bar.close()

    pending = [b.first_account for b in buffers.values() if b.first_account is not None]
    resume_from = min([current_account, *pending]) if interrupted else None
    return {
        "seed": spec.seed,
        "start_account": spec.start_account,
        "accounts": spec.accounts,
        "interrupted": interrupted,
        "resume_from_account": resume_from,
        "entities": {
            entity: {
                "index_id": buf.index_id,
                "expected": totals[entity],
                "written": buf.written,
                "batches": buf.batches,
            }
            for entity, buf in buffers.items()
        },
    }
