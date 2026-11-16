from __future__ import annotations

from typing import Any

import pytest

from mong.metrics import MetricsSampler, derive, extract

INDEX_ID = "idx-1"
GEN = "idx-1-f6-u0-a0"


def _metric(name: str, labels: dict[str, Any] | None = None, **measurements: Any) -> dict[str, Any]:
    return {"name": name, "labels": labels or {}, "measurements": measurements}


def _index_labels(generation: str = GEN, index_id: str = INDEX_ID) -> dict[str, str]:
    return {"indexId logString": index_id, "generationId logString": generation}


def _status(
    *,
    queries: float = 0,
    failed: float = 0,
    inserts: float = 0,
    batch_count: float = 0,
    batch_total: float = 0,
    search_count: float = 0,
    search_seconds: float = 0,
    status_rpc: float = 1,
    docs: float = 100,
    max_docs: float = 100,
    generation: str = GEN,
    queued: float = 0,
    free_disk: float = 100 * 1024**3,
    steady_exceptions: float = 0,
    indexes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    labels = _index_labels(generation)
    metrics = [
        _metric("index.stats.query.totalQueries", labels, count=queries),
        _metric("index.stats.query.failedQueries", labels, count=failed),
        _metric("index.stats.indexing.insert", labels, count=inserts),
        _metric("index.stats.indexing.update", labels, count=0),
        _metric("index.stats.indexing.delete", labels, count=0),
        _metric("index.stats.indexing.steadyStateExceptions", labels, count=steady_exceptions),
        _metric("index.stats.numLuceneDocs", labels, value=docs),
        _metric("index.stats.numLuceneMaxDocs", labels, value=max_docs),
        _metric("index.stats.indexSizeBytes", labels, value=2048),
        _metric(
            "index.stats.query.searchResultBatchLatencies",
            {**labels, "timeUnit": "milliseconds"},
            count=batch_count,
            total=batch_total,
            max=9.0,
        ),
        _metric("index.stats.query.searchResultBatchLatencies.percentile", {**labels, "phi": "0.5"}, value=3.0),
        _metric("index.stats.indexStatusCode", {**labels, "status": "STEADY"}, value=1),
        _metric("index.stats.indexStatusCode", {**labels, "status": "STALE"}, value=0),
        _metric("standalone.rpc.duration", {"operation": "Search", "status": "OK"}, count=search_count, total=search_seconds),
        _metric("standalone.rpc.duration", {"operation": "GetStatus", "status": "OK"}, count=status_rpc, total=status_rpc * 0.01),
        _metric("standalone.rpc.inflight", value=1),
        _metric("standalone.rpc.queued", value=queued),
    ]
    return {
        "management_ready": True,
        "failure_message": None,
        "free_disk_bytes": free_disk,
        "metrics": metrics,
        "metrics_count": len(metrics),
        "indexes": indexes
        if indexes is not None
        else [
            {
                "index_id": INDEX_ID,
                "name": "people",
                "generation_id": generation,
                "lifecycle_state": "READY",
                "desired_revision": 1,
                "active_revision": 1,
            }
        ],
    }


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _sampler(statuses: list[dict[str, Any]]) -> tuple[MetricsSampler, FakeClock]:
    clock = FakeClock()
    feed = iter(statuses)

    def fetch() -> dict[str, Any]:
        item = next(feed)
        if isinstance(item, Exception):
            raise item
        return item

    return MetricsSampler(fetch, interval=5, clock=clock), clock


def _run(sampler: MetricsSampler, clock: FakeClock, count: int, step: float = 5) -> None:
    for _ in range(count):
        sampler.sample_once()
        clock.now += step


def test_extract_picks_live_generation_and_status_label() -> None:
    raw = extract(_status(queries=7))
    index = raw["indexes"][INDEX_ID]
    assert index["generation"] == GEN
    assert index["counters"]["queries"] == 7
    assert index["status_label"] == "STEADY"
    assert raw["gauges"]["rpc_inflight"] == 0  # our own GetStatus is excluded


def test_rates_and_interval_mean_latency() -> None:
    sampler, clock = _sampler(
        [
            _status(queries=10, inserts=0, batch_count=10, batch_total=50, search_count=10, search_seconds=0.5),
            _status(queries=60, inserts=100, batch_count=20, batch_total=250, search_count=60, search_seconds=1.5),
        ]
    )
    _run(sampler, clock, 2)
    summary = sampler.summary()
    metrics = summary["indexes"][0]["metrics"]
    assert metrics["qps"] == pytest.approx(10.0)
    assert metrics["ingest_rate"] == pytest.approx(20.0)
    assert metrics["batch_latency_mean_ms"] == pytest.approx(20.0)  # 200 ms over 10 batches
    assert metrics["batch_latency_p50_ms"] == 3.0
    assert metrics["status_label"] == "STEADY"
    assert summary["instance"]["search_latency_mean_ms"] == pytest.approx(20.0)  # 1 s over 50 calls
    rpc = {row["operation"]: row for row in summary["rpc"]}
    assert "GetStatus" not in rpc
    assert rpc["Search"]["rate"] == pytest.approx(10.0)


def test_counter_reset_yields_no_rate_and_restart_annotation() -> None:
    sampler, clock = _sampler(
        [
            _status(queries=500, search_count=500, status_rpc=50),
            _status(queries=3, search_count=3, status_rpc=1),
            _status(queries=13, search_count=13, status_rpc=2),
        ]
    )
    _run(sampler, clock, 3)
    series = sampler.series()
    rates = [sample["indexes"][INDEX_ID]["qps"] for sample in series["samples"]]
    assert rates == [None, None, pytest.approx(2.0)]
    assert [item["kind"] for item in series["annotations"]] == ["restart"]


def test_generation_change_is_annotated_as_rebuild() -> None:
    sampler, clock = _sampler(
        [
            _status(queries=100),
            _status(queries=5, generation="idx-1-f6-u1-a0"),
        ]
    )
    _run(sampler, clock, 2)
    series = sampler.series(index_id=INDEX_ID)
    assert series["samples"][-1]["indexes"][INDEX_ID]["qps"] is None
    assert series["annotations"][0]["kind"] == "rebuilt"
    assert series["annotations"][0]["label"] == "people rebuilt"


def test_created_and_dropped_annotations() -> None:
    sampler, clock = _sampler([_status(indexes=[]), _status(), _status(indexes=[])])
    _run(sampler, clock, 3)
    kinds = [item["kind"] for item in sampler.series()["annotations"]]
    assert kinds == ["created", "dropped"]


def test_series_since_filters_samples() -> None:
    sampler, clock = _sampler([_status(), _status(), _status()])
    _run(sampler, clock, 3)
    all_samples = sampler.series()["samples"]
    later = sampler.series(since=all_samples[0]["t"])["samples"]
    assert len(later) == 2
    assert "counters" not in later[0]


def test_unreachable_mongot_is_reported() -> None:
    sampler, clock = _sampler([RuntimeError("connection refused")])
    _run(sampler, clock, 1)
    summary = sampler.summary()
    assert summary["connected"] is False
    assert summary["error"] == "connection refused"
    assert summary["alerts"][0]["id"] == "mongot-unreachable"


def test_alerts_cover_disk_deletes_queue_and_failures() -> None:
    statuses = [
        _status(queued=2, free_disk=1 * 1024**3, docs=600, max_docs=2000, failed=0),
        _status(queued=2, free_disk=1 * 1024**3, docs=600, max_docs=2000, failed=4, steady_exceptions=2),
        _status(queued=2, free_disk=1 * 1024**3, docs=600, max_docs=2000, failed=4, steady_exceptions=2),
    ]
    sampler, clock = _sampler(statuses)
    _run(sampler, clock, 3)
    alerts = {alert["id"].split(":")[0]: alert for alert in sampler.summary()["alerts"]}
    assert alerts["low-disk"]["severity"] == "error"
    assert "deleted" in alerts
    assert "rpc-queued" in alerts
    assert "failed-queries" in alerts
    assert "steady_state_exceptions" in alerts


def test_rebuilding_and_lifecycle_alerts() -> None:
    index = {
        "index_id": INDEX_ID,
        "name": "people",
        "generation_id": GEN,
        "lifecycle_state": "INITIAL_SYNC",
        "desired_revision": 2,
        "active_revision": 1,
    }
    sampler, clock = _sampler([_status(indexes=[index])])
    _run(sampler, clock, 1)
    ids = [alert["id"] for alert in sampler.summary()["alerts"]]
    assert f"rebuilding:{INDEX_ID}" in ids
    assert f"lifecycle:{INDEX_ID}" in ids


def test_derive_without_previous_has_no_rates() -> None:
    instance, indexes, rpc = derive(extract(_status(queries=10)), None, 0)
    assert indexes[INDEX_ID]["qps"] is None
    assert instance["qps"] is None
    assert rpc["Search"]["rate"] is None


def test_definitions_fetched_only_for_new_revisions() -> None:
    calls: list[int] = []
    revision = {"value": 1}

    def statuses() -> dict[str, Any]:
        status = _status()
        status["indexes"][0]["desired_revision"] = revision["value"]
        return status

    def listed() -> list[dict[str, Any]]:
        calls.append(1)
        return [{"index_id": INDEX_ID, "desired_revision": revision["value"], "definition": {"storedSource": True}}]

    sampler = MetricsSampler(statuses, fetch_indexes=listed, clock=FakeClock())
    sampler.sample_once()
    sampler.sample_once()
    assert len(calls) == 1
    assert sampler.summary()["indexes"][0]["definition"] == {"storedSource": True}
    revision["value"] = 2
    sampler.sample_once()
    assert len(calls) == 2


def test_metrics_routes(monkeypatch) -> None:
    from mong.web import api as web_api
    from mong.web.app import create_app

    sampler, clock = _sampler([_status(queries=1), _status(queries=11), _status(queries=21)])
    monkeypatch.setattr(web_api, "sampler", sampler)
    monkeypatch.setattr(sampler, "ensure_started", lambda: None)
    client = create_app().test_client()
    _run(sampler, clock, 1)
    summary = client.get("/api/metrics/summary?refresh=true").get_json()
    assert summary["connected"] is True
    assert summary["indexes"][0]["name"] == "people"
    series = client.get(f"/api/metrics/series?index={INDEX_ID}").get_json()
    assert len(series["samples"]) == 2
    assert client.get("/api/metrics/series?since=abc").status_code == 400
