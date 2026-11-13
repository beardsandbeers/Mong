import math
from types import SimpleNamespace

from mong.serialize import status_to_dict


def test_status_omits_metrics_by_default() -> None:
    status = SimpleNamespace(
        instance_id="abc",
        management_ready=True,
        failure_message="",
        store_schema_version=1,
        retry_retention_millis=0,
        logical_log_bytes=0,
        retry_requests=0,
        retention_pins=0,
        source_bytes=0,
        store_file_bytes=0,
        sqlite_wal_bytes=0,
        free_disk_bytes=0,
        indexes=[],
        metrics=[
            SimpleNamespace(
                name="gauge",
                labels={},
                measurements={"value": math.nan},
            )
        ],
    )
    payload = status_to_dict(status)
    assert "metrics" not in payload
    assert payload["metrics_count"] == 1


def test_status_metrics_scrub_nan() -> None:
    status = SimpleNamespace(
        instance_id="abc",
        management_ready=True,
        failure_message="",
        store_schema_version=1,
        retry_retention_millis=0,
        logical_log_bytes=0,
        retry_requests=0,
        retention_pins=0,
        source_bytes=0,
        store_file_bytes=0,
        sqlite_wal_bytes=0,
        free_disk_bytes=0,
        indexes=[],
        metrics=[
            SimpleNamespace(
                name="gauge",
                labels={"k": "v"},
                measurements={"value": math.nan, "count": 1.0},
            )
        ],
    )
    payload = status_to_dict(status, include_metrics=True)
    assert payload["metrics"][0]["measurements"]["value"] is None
    assert payload["metrics"][0]["measurements"]["count"] == 1.0
