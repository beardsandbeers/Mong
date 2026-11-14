import math
from types import SimpleNamespace

from mongot_standalone import api

from mong.serialize import (
    attach_index_stats,
    index_mappings_to_dict,
    message_to_dict,
    status_to_dict,
)


def test_message_to_dict_keeps_unavailable_distinct_from_zero() -> None:
    stats = api.IndexStats(
        index_id="idx-1",
        document_count=0,
        directory_size_bytes=api.ByteMeasurement(
            value=0,
            method=api.MEASUREMENT_METHOD_FILE_RANGE,
            completeness=api.MEASUREMENT_COMPLETENESS_COMPLETE,
        ),
        memory=api.IndexMemoryStats(
            accounted_reader_heap_bytes=api.ByteMeasurement(omitted_components=["postings"]),
        ),
    )
    payload = message_to_dict(stats)
    assert payload["document_count"] == 0
    assert payload["average_index_bytes_per_document"] is None
    assert payload["directory_size_bytes"]["value"] == 0
    assert payload["directory_size_bytes"]["method"] == "FILE_RANGE"
    assert payload["directory_size_bytes"]["completeness"] == "COMPLETE"
    reader = payload["memory"]["accounted_reader_heap_bytes"]
    assert reader["value"] is None
    assert reader["method"] == "UNAVAILABLE"
    assert reader["omitted_components"] == ["postings"]
    assert payload["memory"]["desired_vector_off_heap_bytes"] is None


def test_message_to_dict_field_stats_page() -> None:
    page = api.IndexFieldStatsResponse(
        state=api.STATS_COLLECTION_STATE_READY,
        fields=[
            api.IndexFieldStats(
                path="title",
                observed=True,
                representations=[
                    api.FieldRepresentationStats(
                        mapping_type="string",
                        vector_working_set_categories={"vec": 12},
                    )
                ],
            )
        ],
        storage_buckets=[api.StorageStatsBucket(component="stored_fields", bytes=10)],
        next_page_token="next",
    )
    payload = message_to_dict(page)
    assert payload["state"] == "READY"
    assert payload["index_stats"] is None
    assert payload["attribution_coverage"] is None
    assert payload["fields"][0]["representations"][0]["vector_working_set_categories"] == {"vec": 12}
    assert payload["storage_buckets"][0]["bytes"] == 10
    assert payload["next_page_token"] == "next"


def test_index_mappings_parse_extended_json() -> None:
    response = api.GetIndexMappingsResponse(
        index_id="idx-1",
        generation_id="gen-1",
        active_revision=2,
        mappings_json='{"dynamic": false, "fields": {"n": {"type": "number"}}}',
        definition_json='{"mappings": {"dynamic": false}, "storedSource": true}',
    )
    payload = index_mappings_to_dict(response)
    assert payload["mappings"]["fields"]["n"]["type"] == "number"
    assert payload["definition"]["storedSource"] is True
    assert payload["active_revision"] == 2


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
