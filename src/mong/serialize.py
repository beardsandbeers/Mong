"""Convert mongot protobuf / BSON values into JSON-friendly dicts."""

from __future__ import annotations

import math
from typing import Any

from bson import json_util
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


def python_to_jsonable(value: Any) -> Any:
    """Round-trip through bson.json_util so ObjectId/datetime/etc survive."""
    return json_util.loads(json_util.dumps(value))


def parse_json_document(raw: str | dict | list) -> Any:
    if isinstance(raw, (dict, list)):
        return json_util.loads(json_util.dumps(raw))
    return json_util.loads(raw)


def watermarks_to_dict(marks: Any) -> dict[str, Any] | None:
    if marks is None or not getattr(marks, "generation_id", ""):
        # building may be empty; still surface numeric fields when present
        if marks is None:
            return None
        if not marks.generation_id and marks.applied_sequence == 0 and marks.snapshot_documents == 0:
            return None
    return {
        "generation_id": marks.generation_id,
        "applied_sequence": marks.applied_sequence,
        "committed_sequence": marks.committed_sequence,
        "visible_sequence": marks.visible_sequence,
        "snapshot_documents": marks.snapshot_documents,
        "snapshot_complete": marks.snapshot_complete,
    }


def index_to_dict(index: api.IndexDescription) -> dict[str, Any]:
    definition = bson_to_python(index.desired_definition_bson)
    return {
        "index_id": index.index_id,
        "collection_id": index.collection_id,
        "name": index.name,
        "type": INDEX_TYPE_NAMES.get(index.type, str(index.type)),
        "type_code": index.type,
        "desired_revision": index.desired_revision,
        "active_revision": index.active_revision,
        "lifecycle_state": index.lifecycle_state,
        "failure_message": index.failure_message or None,
        "definition": python_to_jsonable(definition) if definition is not None else None,
        "live": watermarks_to_dict(index.live),
        "building": watermarks_to_dict(index.building),
    }


def collection_to_dict(collection: api.CollectionDescription) -> dict[str, Any]:
    return {
        "collection_id": collection.collection_id,
        "database": collection.database,
        "name": collection.name,
        "accepted_sequence": collection.accepted_sequence,
    }


def _json_safe_number(value: Any) -> Any:
    """Coerce non-finite floats to None so browsers can JSON.parse the payload."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _json_safe_mapping(mapping: Any) -> dict[str, Any]:
    return {str(key): _json_safe_number(val) for key, val in dict(mapping).items()}


def status_to_dict(status: api.ServiceStatus, *, include_metrics: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "instance_id": status.instance_id,
        "management_ready": status.management_ready,
        "failure_message": status.failure_message or None,
        "store_schema_version": status.store_schema_version,
        "retry_retention_millis": status.retry_retention_millis,
        "logical_log_bytes": status.logical_log_bytes,
        "retry_requests": status.retry_requests,
        "retention_pins": status.retention_pins,
        "source_bytes": status.source_bytes,
        "store_file_bytes": status.store_file_bytes,
        "sqlite_wal_bytes": status.sqlite_wal_bytes,
        "free_disk_bytes": status.free_disk_bytes,
        "indexes": [index_to_dict(idx) for idx in status.indexes],
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
