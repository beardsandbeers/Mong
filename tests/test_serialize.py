import math
from types import SimpleNamespace

from mong.serialize import attach_index_stats, status_to_dict


def _status(**overrides):
    payload = dict(
        management_ready=True,
        failure_message="",
        free_disk_bytes=0,
        indexes=[],
        metrics=[],
    )
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_status_omits_metrics_by_default() -> None:
    status = _status(
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
    assert payload["management_ready"] is True
    assert payload["free_disk_bytes"] == 0


def test_status_metrics_scrub_nan() -> None:
    status = _status(
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


def _metric(name, labels, measurements):
    return SimpleNamespace(name=name, labels=labels, measurements=measurements)


def test_index_stats_use_live_generation() -> None:
    indexes = [
        {
            "index_id": "idx-1",
            "generation_id": "gen-live",
        }
    ]
    metrics = [
        _metric(
            "index.stats.numLuceneDocs",
            {"indexId logString": "idx-1", "generationId logString": "gen-old"},
            {"value": 10},
        ),
        _metric(
            "index.stats.numLuceneDocs",
            {"indexId logString": "idx-1", "generationId logString": "gen-live", "numPartitions": "1"},
            {"value": 230},
        ),
        _metric(
            "index.stats.indexSizeBytes",
            {"indexId logString": "idx-1", "generationId logString": "gen-live", "numPartitions": "1"},
            {"value": 2048},
        ),
        _metric(
            "index.stats.indexSizeBytes",
            {"indexId logString": "idx-1", "generationId logString": "gen-live", "numPartitions": "1"},
            {"value": 1024},
        ),
        _metric(
            "index.stats.numFilesInIndex",
            {"indexId": "idx-1", "generationId": "gen-live"},
            {"value": 11},
        ),
        _metric(
            "index.stats.segment_count",
            {"indexId logString": "idx-1", "generationId logString": "gen-live"},
            {"value": math.nan},
        ),
        _metric(
            "index.stats.query.totalQueries",
            {"indexId logString": "idx-1", "generationId logString": "gen-live"},
            {"count": 3},
        ),
        _metric("index.stats.query.batchDataSize", {}, {"count": 99}),
    ]

    attach_index_stats(indexes, metrics)
    assert indexes[0]["stats"] == {
        "documents": 230,
        "size_bytes": 3072,
        "files": 11,
        "segments": None,
        "queries": 3,
    }
