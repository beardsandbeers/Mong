"""Direct writes to standalone mongot search indexes.

``--target mongot`` uses ``mongot_writer``. ``upsert_many`` on the returned
client is the loader's writer protocol: the first argument is an index id, and
``concern`` is ``indexed``, ``committed``, or ``visible``. Creating the index
stays here; the caller chooses the definition.
"""

from __future__ import annotations

from typing import Any, Callable

from mong.service import MongotService

# 0.7 and later write these when a definition omits them. They are not a definition change.
_DEFAULT_ANALYZER = "lucene.standard"


def mongot_writer() -> Any:
    """Open one mongot client. Each ingest process calls this itself."""
    from mong.client import create_client

    return create_client()


def find_search_index(service: MongotService, name: str) -> dict[str, Any] | None:
    for index in service.list_indexes():
        if index.get("name") == name and str(index.get("type", "")).upper() == "SEARCH":
            return index
    return None


def definitions_match(stored: Any, wanted: dict[str, Any]) -> bool:
    """True when ``stored`` is ``wanted``, ignoring server-filled default analyzers."""
    if stored == wanted:
        return True
    if not isinstance(stored, dict):
        return False
    normalized = dict(stored)
    for key in ("analyzer", "searchAnalyzer"):
        if key not in wanted and normalized.get(key) == _DEFAULT_ANALYZER:
            normalized.pop(key)
    return normalized == wanted


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
    if not definitions_match(existing.get("definition"), definition):
        return service.update_index(existing["index_id"], definition=definition), "updated"
    return existing, "existing"


def log_search_index(
    index_name: str,
    index: dict[str, Any],
    action: str,
    log: Callable[[str], None],
) -> None:
    note = ""
    if action == "updated":
        note = "; definition change rebuilt an empty generation"
    log(f"{index_name}: index {index['index_id']} ({action}{note})")
