"""CRM document shape shared by the mongot and mongod loaders.

Relationship fields are the links join queries follow. Both targets index them
as ``token`` fields on a search index. mongod also puts an ordinary index on
each of them except ``_id``.
"""

from __future__ import annotations

from typing import Any

RELATIONSHIP_FIELDS: dict[str, tuple[str, ...]] = {
    "accounts": ("_id", "tenant_id"),
    "contacts": ("_id", "tenant_id", "account_id", "opportunity_ids"),
    "opportunities": ("_id", "tenant_id", "account_id", "contact_ids", "primary_contact_id"),
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
