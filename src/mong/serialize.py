"""Convert mongot protobuf / BSON values into JSON-friendly dicts."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from bson import json_util
from google.protobuf.descriptor import FieldDescriptor
from google.protobuf.message import Message
from mongot_standalone import api, decode_bson

INDEX_TYPE_NAMES = {
    api.INDEX_TYPE_UNSPECIFIED: "UNSPECIFIED",
    api.INDEX_TYPE_SEARCH: "SEARCH",
    api.INDEX_TYPE_VECTOR_SEARCH: "VECTOR_SEARCH",
}

INDEX_TYPE_VALUES = {
    "UNSPECIFIED": api.INDEX_TYPE_UNSPECIFIED,
    "SEARCH": api.INDEX_TYPE_SEARCH,
    "VECTOR_SEARCH": api.INDEX_TYPE_VECTOR_SEARCH,
    "INDEX_TYPE_UNSPECIFIED": api.INDEX_TYPE_UNSPECIFIED,
    "INDEX_TYPE_SEARCH": api.INDEX_TYPE_SEARCH,
    "INDEX_TYPE_VECTOR_SEARCH": api.INDEX_TYPE_VECTOR_SEARCH,
}


def bson_to_python(data: bytes | None) -> Any:
    if not data:
        return None
    return decode_bson(data)


_MAX_SAFE_INTEGER = 2**53 - 1


def _tag_values(value: Any, *, tag_doubles: bool) -> Any:
    """Tag values JavaScript cannot represent: large integers, and optionally whole doubles."""
    if isinstance(value, dict):
        return {key: _tag_values(item, tag_doubles=tag_doubles) for key, item in value.items()}
    if isinstance(value, list):
        return [_tag_values(item, tag_doubles=tag_doubles) for item in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and abs(value) > _MAX_SAFE_INTEGER:
        return {"$numberLong": str(value)}
    if tag_doubles and isinstance(value, float) and value.is_integer():
        return {"$numberDouble": repr(value)}
    return value


def python_to_jsonable(value: Any, *, tag_doubles: bool = False) -> Any:
    """Relaxed Extended JSON as plain JSON values (``{"$oid"}``, ``{"$date"}``, ...).

    ``tag_doubles`` marks whole-number doubles as ``{"$numberDouble"}`` because
    JavaScript cannot tell ``5.0`` from ``5``; use it for documents that may be edited
    and written back.
    """
    plain = json.loads(json_util.dumps(value, json_options=json_util.RELAXED_JSON_OPTIONS))
    return _tag_values(plain, tag_doubles=tag_doubles)


def results_to_jsonable(results: list[Any]) -> list[Any]:
    """Search hits with document values type-tagged. Top-level ``$`` keys are search metadata."""
    out = []
    for hit in results:
        if not isinstance(hit, dict):
            out.append(python_to_jsonable(hit, tag_doubles=True))
            continue
        out.append(
            {
                key: python_to_jsonable(item, tag_doubles=not key.startswith("$"))
                for key, item in hit.items()
            }
        )
    return out


def parse_json_document(raw: str | dict | list) -> Any:
    """Decode Extended JSON (``{"$oid"}``, ``{"$date"}``, ``{"$numberDouble"}``, ...) to BSON values."""
    if isinstance(raw, (dict, list)):
        return json_util.loads(json_util.dumps(raw))
    return json_util.loads(raw)


def parse_json_value(raw: Any) -> Any:
    """Decode one Extended JSON value, such as a document id."""
    if isinstance(raw, (dict, list)):
        return json_util.loads(json_util.dumps(raw))
    return raw


_OWNERSHIP_NAMES = {}
_VERSION_DOMAINS = {}


def _ownership_names() -> dict[int, str]:
    if not _OWNERSHIP_NAMES and hasattr(api, "INDEX_OWNERSHIP_STANDALONE"):
        _OWNERSHIP_NAMES[api.INDEX_OWNERSHIP_STANDALONE] = "standalone"
        _OWNERSHIP_NAMES[api.INDEX_OWNERSHIP_REPLICATED] = "replicated"
    return _OWNERSHIP_NAMES


def _version_domains() -> dict[int, str]:
    if not _VERSION_DOMAINS and hasattr(api, "IndexVersion"):
        _VERSION_DOMAINS[api.IndexVersion.DOMAIN_STANDALONE_REVISION] = "standalone_revision"
        _VERSION_DOMAINS[api.IndexVersion.DOMAIN_NATIVE_DEFINITION_VERSION] = "native_definition"
    return _VERSION_DOMAINS


def _has_field(message: Any, name: str) -> bool:
    has = getattr(message, "HasField", None)
    if has is None:
        return False
    try:
        return bool(has(name))
    except ValueError:
        return False


def _version_dict(version: Any) -> dict[str, Any] | None:
    if version is None:
        return None
    domain = int(getattr(version, "domain", 0) or 0)
    number = int(getattr(version, "definition_version", 0) or 0)
    if domain == 0 and number == 0:
        return None
    return {"domain": _version_domains().get(domain, str(domain)), "version": number}


def _namespace_dict(namespace: Any) -> dict[str, Any] | None:
    if namespace is None:
        return None
    data = {
        "database": getattr(namespace, "database", "") or None,
        "collection": getattr(namespace, "collection_name", "") or None,
        "collection_uuid": getattr(namespace, "collection_uuid", "") or None,
        "view": getattr(namespace, "view_name", "") or None,
    }
    if not any(data.values()):
        return None
    return data


def _build_dict(build: Any) -> dict[str, Any] | None:
    if build is None:
        return None
    state = getattr(build, "state", "") or None
    generation_id = getattr(build, "generation_id", "") or None
    version = _version_dict(getattr(build, "version", None))
    if not state and not generation_id and version is None:
        return None
    return {"generation_id": generation_id, "state": state, "version": version}


def index_to_dict(index: api.IndexDescription) -> dict[str, Any]:
    definition = bson_to_python(index.desired_definition_bson)
    active_raw = getattr(index, "active_definition_bson", b"") or b""
    active = bson_to_python(active_raw) if active_raw else None
    ownership = _ownership_names().get(int(getattr(index, "ownership", 0) or 0))
    capabilities = [item for item in (getattr(index, "read_capabilities", []) or []) if item]
    return {
        "index_id": index.index_id,
        "name": index.name,
        "source": "mongot",
        "type": INDEX_TYPE_NAMES.get(index.type, str(index.type)),
        "type_code": index.type,
        "desired_revision": index.desired_revision,
        "active_revision": index.active_revision,
        "lifecycle_state": index.lifecycle_state,
        "generation_id": index.generation_id or None,
        "failure_message": index.failure_message or None,
        "definition": python_to_jsonable(definition) if definition is not None else None,
        "active_definition": python_to_jsonable(active) if active is not None else None,
        "ownership": ownership,
        "namespace": _namespace_dict(index.namespace) if _has_field(index, "namespace") else None,
        "queryable": bool(getattr(index, "queryable", False)),
        "read_capabilities": capabilities,
        "active_version": _version_dict(index.active_version) if _has_field(index, "active_version") else None,
        "desired_version": _version_dict(index.desired_version) if _has_field(index, "desired_version") else None,
        "build": _build_dict(index.build) if _has_field(index, "build") else None,
        "source_status": getattr(index, "source_status", "") or None,
    }


# Gauges and counters mongot labels per index generation. The odd label names
# ("indexId logString") are what the process actually emits.
_INDEX_STAT_FIELDS = {
    "index.stats.numLuceneDocs": ("documents", "value"),
    "index.stats.indexSizeBytes": ("size_bytes", "value"),
    "index.stats.numFilesInIndex": ("files", "value"),
    "index.stats.segment_count": ("segments", "value"),
    "index.stats.query.totalQueries": ("queries", "count"),
}


def _metric_field(metric: Any, name: str) -> Any:
    if isinstance(metric, dict):
        return metric.get(name)
    return getattr(metric, name, None)


def _label(labels: dict[str, Any], *names: str) -> str | None:
    for name in names:
        value = labels.get(name)
        if value not in (None, ""):
            return str(value)
    return None


def _whole_number(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def index_stats_by_id(indexes: list[dict[str, Any]], metrics: Any) -> dict[str, dict[str, Any]]:
    """Sum live-generation index gauges so the UI can show docs, size, and similar."""
    preferred = {
        index["index_id"]: str(index.get("generation_id") or "")
        for index in indexes
        if index.get("index_id")
    }
    totals: dict[tuple[str, str, str], float] = {}
    seen_generations: dict[str, set[str]] = {}

    for metric in metrics:
        spec = _INDEX_STAT_FIELDS.get(_metric_field(metric, "name"))
        if spec is None:
            continue
        field, measurement = spec
        labels = dict(_metric_field(metric, "labels") or {})
        measurements = dict(_metric_field(metric, "measurements") or {})
        index_id = _label(labels, "indexId logString", "indexId")
        if not index_id:
            continue
        raw = _json_safe_number(measurements.get(measurement))
        if not isinstance(raw, (int, float)):
            continue
        generation = _label(labels, "generationId logString", "generationId") or ""
        key = (index_id, generation, field)
        totals[key] = totals.get(key, 0.0) + float(raw)
        seen_generations.setdefault(index_id, set()).add(generation)

    stats: dict[str, dict[str, Any]] = {}
    fields = {field for field, _measurement in _INDEX_STAT_FIELDS.values()}
    for index_id, generation in preferred.items():
        generations = seen_generations.get(index_id) or set()
        chosen = generation if generation in generations else ""
        if chosen == "" and len(generations) == 1:
            chosen = next(iter(generations))
        row = {field: None for field in fields}
        for field in fields:
            value = totals.get((index_id, chosen, field))
            if value is not None:
                row[field] = _whole_number(value)
        stats[index_id] = row
    return stats


def attach_index_stats(indexes: list[dict[str, Any]], metrics: Any) -> list[dict[str, Any]]:
    by_id = index_stats_by_id(indexes, metrics)
    for index in indexes:
        index["stats"] = by_id.get(
            index.get("index_id"),
            {field: None for field in {item[0] for item in _INDEX_STAT_FIELDS.values()}},
        )
    return indexes


def _json_safe_number(value: Any) -> Any:
    """Coerce non-finite floats to None so browsers can JSON.parse the payload."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _json_safe_mapping(mapping: Any) -> dict[str, Any]:
    return {str(key): _json_safe_number(val) for key, val in dict(mapping).items()}


def _enum_name(field: FieldDescriptor, number: int) -> str:
    """``MEASUREMENT_METHOD_FILE_RANGE`` -> ``FILE_RANGE``."""
    value = field.enum_type.values_by_number.get(number)
    if value is None:
        return str(number)
    prefix = re.sub(r"(?<!^)(?=[A-Z])", "_", field.enum_type.name).upper() + "_"
    return value.name.removeprefix(prefix)


def _scalar(field: FieldDescriptor, value: Any) -> Any:
    if field.type == FieldDescriptor.TYPE_ENUM:
        return _enum_name(field, value)
    if field.message_type is not None:
        return message_to_dict(value)
    return _json_safe_number(value)


def message_to_dict(message: Message) -> dict[str, Any]:
    """Proto message to snake_case dict.

    Unset optional scalars and unset sub-messages become ``None``: in the stats API a
    missing value means "unavailable" while a present zero is a real measurement.
    """
    out: dict[str, Any] = {}
    for field in message.DESCRIPTOR.fields:
        value = getattr(message, field.name)
        if field.message_type is not None and field.message_type.GetOptions().map_entry:
            value_field = field.message_type.fields_by_name["value"]
            out[field.name] = {str(k): _scalar(value_field, v) for k, v in value.items()}
        elif field.is_repeated:
            out[field.name] = [_scalar(field, item) for item in value]
        elif field.has_presence and not message.HasField(field.name):
            out[field.name] = None
        else:
            out[field.name] = _scalar(field, value)
    return out


def index_mappings_to_dict(response: api.GetIndexMappingsResponse) -> dict[str, Any]:
    return {
        "index_id": response.index_id,
        "generation_id": response.generation_id or None,
        "active_revision": response.active_revision,
        "mappings": python_to_jsonable(json_util.loads(response.mappings_json)),
        "definition": python_to_jsonable(json_util.loads(response.definition_json)),
    }


def status_to_dict(status: api.ServiceStatus, *, include_metrics: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "management_ready": status.management_ready,
        "failure_message": status.failure_message or None,
        "free_disk_bytes": status.free_disk_bytes,
        "indexes": attach_index_stats(
            [index_to_dict(idx) for idx in status.indexes],
            status.metrics,
        ),
        "metrics_count": len(status.metrics),
    }
    if include_metrics:
        # mongot emits NaN for some unused gauges; scrub before JSON serialization.
        payload["metrics"] = [
            {
                "name": metric.name,
                "labels": dict(metric.labels),
                "measurements": _json_safe_mapping(metric.measurements),
            }
            for metric in status.metrics
        ]
    return payload
