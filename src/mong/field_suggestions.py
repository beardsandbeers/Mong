"""Suggest search fields from BSON samples, without claiming an observed index mapping."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable
from uuid import UUID

from bson import Binary, ObjectId
from bson.code import Code

SAMPLE_SIZE = 100
SAMPLE_TIMEOUT_MS = 2000
CONTAINERS = {"document", "embeddedDocuments"}


def _types(value: Any) -> set[str]:
    # Test bool before int, and BSON Code before str. Decimal128 is not supported.
    if isinstance(value, bool):
        return {"boolean"}
    if isinstance(value, Code):
        return set()
    if isinstance(value, str):
        return {"string", "token", "autocomplete", "stringFacet"}
    if isinstance(value, (int, float)):
        return {"number", "numberFacet"}
    if isinstance(value, datetime):
        return {"date", "dateFacet"}
    if isinstance(value, ObjectId):
        return {"objectId"}
    if isinstance(value, UUID) or isinstance(value, Binary) and value.subtype == 4:
        return {"uuid"}
    return set()


def _specs(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def has_dynamic(mapping: dict[str, Any]) -> bool:
    return bool(mapping.get("dynamic")) or any(
        spec.get("type") in CONTAINERS and has_dynamic(spec)
        for field in mapping.get("fields", {}).values()
        for spec in _specs(field)
    )


def sample_mapping(definition: dict[str, Any], documents: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Keep explicit overrides and dynamic scopes; return paths/types, never values.

    The sample is incomplete. Dynamic scopes remain open so missing sample fields
    are still valid candidates. Arrays and nesting are bounded as well as documents.
    """
    mapping = definition.get("mappings") or {}
    type_sets = {item["name"]: item.get("types", []) for item in definition.get("typeSets", [])}
    default_types = {"boolean", "date", "number", "objectId", "string", "uuid"}
    output: dict[str, Any] = {"dynamic": mapping.get("dynamic", False), "fields": {}}

    def walk(document: dict[str, Any], scope: dict[str, Any], fields: dict[str, Any], depth: int) -> None:
        if depth > 32:
            return
        dynamic = scope.get("dynamic", False)
        explicit = scope.get("fields", {})
        for name, value in document.items():
            if name.startswith("$") or "." in name:
                continue
            visit(value, name, explicit, dynamic, fields, depth)

    def visit(value: Any, name: str, explicit: dict[str, Any], dynamic: Any, fields: dict[str, Any], depth: int) -> None:
        if depth > 32:
            return
        if isinstance(value, list):
            for item in value[:100]:
                visit(item, name, explicit, dynamic, fields, depth + 1)
            return
        if name in explicit:
            # Only descend into explicit containers; never infer extra types for an override.
            specs = [spec for spec in _specs(explicit[name]) if spec.get("type") in CONTAINERS]
        elif not dynamic:
            return
        elif isinstance(value, dict):
            specs = [{"type": "document", "dynamic": dynamic}]
        else:
            compatible = _types(value)
            candidates = type_sets.get(dynamic.get("typeSet"), []) if isinstance(dynamic, dict) else [
                {"type": kind} for kind in sorted(default_types)
            ]
            specs = [spec for spec in candidates if spec.get("type") in compatible]
        for spec in specs:
            kind = spec["type"]
            if kind in CONTAINERS and not isinstance(value, dict):
                continue
            entries = fields.setdefault(name, [])
            entry = next((item for item in entries if item["type"] == kind), None)
            if entry is None:
                entry = {"type": kind}
                if spec.get("multi"):
                    entry["multi"] = spec["multi"]
                if kind in CONTAINERS:
                    entry.update(dynamic=spec.get("dynamic", False), fields={})
                entries.append(entry)
            if kind in CONTAINERS:
                walk(value, spec, entry["fields"], depth + 1)

    for document in documents:
        walk(document, mapping, output["fields"], 0)
    return output
