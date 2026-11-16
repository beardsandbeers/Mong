"""Background sampler that turns mongot's cumulative metrics into rates and history.

mongot reports counters (totals since process start), gauges, timers (count, total,
and a decaying max), and rolling percentiles. The sampler polls ``GetStatus`` on an
interval and keeps a ring buffer of derived values: per-interval rates, the mean
latency of each interval, and gauge snapshots. History lives in memory only.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any, Callable

INDEX_LABELS = ("indexId logString", "indexId")
GENERATION_LABELS = ("generationId logString", "generationId")

INDEX_GAUGES = {
    "index.stats.numLuceneDocs": "documents",
    "index.stats.numLuceneMaxDocs": "max_documents",
    "index.stats.indexSizeBytes": "size_bytes",
    "index.stats.segment_count": "segments",
    "index.stats.requiredMemoryBytes": "memory_bytes",
}
INDEX_MAX_GAUGES = {"index.stats.indexing.replicationLagMs": "lag_ms"}
INDEX_COUNTERS = {
    "index.stats.query.totalQueries": "queries",
    "index.stats.query.failedQueries": "failed_queries",
    "index.stats.indexing.insert": "inserts",
    "index.stats.indexing.update": "updates",
    "index.stats.indexing.delete": "deletes",
    "index.stats.indexing.initialSyncExceptions": "initial_sync_exceptions",
    "index.stats.indexing.steadyStateExceptions": "steady_state_exceptions",
}
# Per-batch latency in milliseconds; there is no per-query timer per index.
BATCH_TIMER = "index.stats.query.searchResultBatchLatencies"
BATCH_PERCENTILES = BATCH_TIMER + ".percentile"
PERCENTILE_FIELDS = {"0.5": "batch_latency_p50_ms", "0.9": "batch_latency_p90_ms", "0.99": "batch_latency_p99_ms"}
STATUS_CODE = "index.stats.indexStatusCode"

# RPC durations are in seconds.
RPC_DURATION = "standalone.rpc.duration"
RPC_COMPLETED = "standalone.rpc.completed"
SELF_OPERATIONS = {"GetStatus"}
QUERY_OPERATIONS = {"Search", "VectorSearch", "GetMore"}
OK_STATUSES = {"OK", "CANCELLED"}

INSTANCE_GAUGES = {
    "standalone.rpc.inflight": "rpc_inflight",
    "standalone.rpc.queued": "rpc_queued",
    "mergeScheduler.currentlyRunningMerges": "merges",
    "cursorManager.trackedCursors": "cursors",
}
LIFECYCLE_FAILURES = (
    "lifecycle.failedDownloadIndexes",
    "lifecycle.failedDropIndexes",
    "lifecycle.failedInitializationIndexes",
)

ERROR_STATUSES = {"FAILED", "RECOVERING_NON_TRANSIENT", "DOES_NOT_EXIST"}
WARNING_STATUSES = {"STALE", "RECOVERING_TRANSIENT"}

GIB = 1024**3
LOW_DISK_WARNING = 10 * GIB
LOW_DISK_ERROR = 2 * GIB
DELETED_RATIO_WARNING = 0.30
DELETED_RATIO_MIN_DOCS = 1000
LAG_WARNING_MS = 10_000
ALERT_WINDOW_SECONDS = 300
QUEUED_SAMPLES = 3


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _label(labels: dict[str, Any], names: tuple[str, ...]) -> str:
    for name in names:
        value = labels.get(name)
        if value not in (None, ""):
            return str(value)
    return ""


def _whole(value: float | None) -> int | float | None:
    if value is None:
        return None
    return int(value) if float(value).is_integer() else round(value, 4)


def _rate(current: float | None, previous: float | None, seconds: float) -> float | None:
    """Per-second rate, or None after a counter reset (restart or new generation)."""
    if current is None or previous is None or seconds <= 0:
        return None
    delta = current - previous
    if delta < 0:
        return None
    return delta / seconds


def _interval_mean(
    count: float | None, total: float | None, prev_count: float | None, prev_total: float | None, scale: float
) -> float | None:
    if None in (count, total, prev_count, prev_total):
        return None
    d_count = count - prev_count  # type: ignore[operator]
    d_total = total - prev_total  # type: ignore[operator]
    if d_count <= 0 or d_total < 0:
        return None
    return d_total / d_count * scale


def _sum(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return sum(present) if present else None


def extract(status: dict[str, Any]) -> dict[str, Any]:
    """Raw readings from one status payload, with each index pinned to its live generation."""
    metrics = status.get("metrics") or []
    indexes = status.get("indexes") or []
    by_index: dict[str, dict[str, list[dict[str, Any]]]] = {}
    instance_gauges: dict[str, float] = {}
    rpc: dict[tuple[str, str], dict[str, float]] = {}
    lifecycle_failures = 0.0

    for metric in metrics:
        name = metric.get("name")
        labels = metric.get("labels") or {}
        measurements = metric.get("measurements") or {}
        index_id = _label(labels, INDEX_LABELS)
        if index_id:
            generation = _label(labels, GENERATION_LABELS)
            by_index.setdefault(index_id, {}).setdefault(generation, []).append(metric)
            continue
        if name in INSTANCE_GAUGES:
            value = _number(measurements.get("value"))
            if value is not None:
                key = INSTANCE_GAUGES[name]
                instance_gauges[key] = instance_gauges.get(key, 0.0) + value
        elif name in (RPC_DURATION, RPC_COMPLETED):
            operation = str(labels.get("operation") or "unknown")
            outcome = str(labels.get("status") or "OK")
            entry = rpc.setdefault((operation, outcome), {})
            count = _number(measurements.get("count"))
            if name == RPC_DURATION:
                total = _number(measurements.get("total"))
                if count is not None:
                    entry["count"] = count
                if total is not None:
                    entry["total"] = total
            elif count is not None and "count" not in entry:
                entry["count"] = count
        elif name in LIFECYCLE_FAILURES:
            lifecycle_failures += _number(measurements.get("count")) or 0.0

    # Our own GetStatus call is in flight while the server measures.
    if "rpc_inflight" in instance_gauges:
        instance_gauges["rpc_inflight"] = max(0.0, instance_gauges["rpc_inflight"] - 1)

    raw_indexes: dict[str, dict[str, Any]] = {}
    for index in indexes:
        index_id = index.get("index_id")
        if not index_id:
            continue
        generations = by_index.get(index_id, {})
        preferred = str(index.get("generation_id") or "")
        if preferred in generations:
            generation = preferred
        elif len(generations) == 1:
            generation = next(iter(generations))
        else:
            generation = preferred
        raw_indexes[index_id] = _index_readings(generations.get(generation, []), generation or preferred)

    return {
        "management_ready": bool(status.get("management_ready")),
        "failure_message": status.get("failure_message"),
        "free_disk_bytes": _number(status.get("free_disk_bytes")),
        "metrics_count": int(status.get("metrics_count") or len(metrics)),
        "gauges": instance_gauges,
        "rpc": rpc,
        "lifecycle_failures": lifecycle_failures,
        "indexes": raw_indexes,
    }


def _index_readings(metrics: list[dict[str, Any]], generation: str) -> dict[str, Any]:
    gauges: dict[str, float] = {}
    counters: dict[str, float] = {}
    timer = {"count": None, "total": None, "max": None}
    percentiles: dict[str, float] = {}
    status_label: str | None = None
    for metric in metrics:
        name = metric.get("name")
        labels = metric.get("labels") or {}
        measurements = metric.get("measurements") or {}
        if name in INDEX_GAUGES:
            value = _number(measurements.get("value"))
            if value is not None:
                key = INDEX_GAUGES[name]
                gauges[key] = gauges.get(key, 0.0) + value
        elif name in INDEX_MAX_GAUGES:
            value = _number(measurements.get("value"))
            if value is not None:
                key = INDEX_MAX_GAUGES[name]
                gauges[key] = max(gauges.get(key, value), value)
        elif name in INDEX_COUNTERS:
            value = _number(measurements.get("count"))
            if value is not None:
                key = INDEX_COUNTERS[name]
                counters[key] = counters.get(key, 0.0) + value
        elif name == BATCH_TIMER:
            for field in ("count", "total"):
                value = _number(measurements.get(field))
                if value is not None:
                    timer[field] = (timer[field] or 0.0) + value
            peak = _number(measurements.get("max"))
            if peak is not None:
                timer["max"] = max(timer["max"] or 0.0, peak)
        elif name == BATCH_PERCENTILES:
            phi = str(labels.get("phi") or "")
            value = _number(measurements.get("value"))
            if phi in PERCENTILE_FIELDS and value is not None:
                percentiles[phi] = max(percentiles.get(phi, value), value)
        elif name == STATUS_CODE:
            value = _number(measurements.get("value"))
            if value is not None and value >= 1:
                status_label = str(labels.get("status") or "") or None
    return {
        "generation": generation,
        "gauges": gauges,
        "counters": counters,
        "timer": timer,
        "percentiles": percentiles,
        "status_label": status_label,
    }


def derive(
    current: dict[str, Any], previous: dict[str, Any] | None, seconds: float
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Instance values, per-index values, and per-operation RPC values for one sample."""
    prev_indexes = (previous or {}).get("indexes", {})
    indexes: dict[str, dict[str, Any]] = {}
    for index_id, raw in current["indexes"].items():
        prev = prev_indexes.get(index_id)
        same_generation = prev is not None and prev["generation"] == raw["generation"]
        p_counters = prev["counters"] if same_generation else {}
        p_timer = prev["timer"] if same_generation else {"count": None, "total": None}
        counters = raw["counters"]
        gauges = raw["gauges"]

        def rate(key: str) -> float | None:
            return _rate(counters.get(key), p_counters.get(key), seconds)

        inserts, updates = rate("inserts"), rate("updates")
        documents = gauges.get("documents")
        max_documents = gauges.get("max_documents")
        deleted_ratio = None
        if documents is not None and max_documents:
            deleted_ratio = max(0.0, (max_documents - documents) / max_documents)
        values = {
            "qps": rate("queries"),
            "failed_qps": rate("failed_queries"),
            "insert_rate": inserts,
            "update_rate": updates,
            "delete_rate": rate("deletes"),
            "ingest_rate": _sum([inserts, updates]),
            "batch_latency_mean_ms": _interval_mean(
                raw["timer"]["count"], raw["timer"]["total"], p_timer["count"], p_timer["total"], 1.0
            ),
            "batch_latency_max_ms": raw["timer"]["max"],
            "lag_ms": gauges.get("lag_ms"),
            "documents": documents,
            "max_documents": max_documents,
            "deleted_ratio": deleted_ratio,
            "segments": gauges.get("segments"),
            "size_bytes": gauges.get("size_bytes"),
            "memory_bytes": gauges.get("memory_bytes"),
            "initial_sync_exceptions": counters.get("initial_sync_exceptions"),
            "steady_state_exceptions": counters.get("steady_state_exceptions"),
            "failed_queries_total": counters.get("failed_queries"),
        }
        for phi, field in PERCENTILE_FIELDS.items():
            values[field] = raw["percentiles"].get(phi)
        indexes[index_id] = {key: _whole(value) if key in _COUNT_FIELDS else value for key, value in values.items()}

    prev_rpc = (previous or {}).get("rpc", {})
    by_operation: dict[str, dict[str, float]] = {}
    query_now = {"count": 0.0, "total": 0.0}
    query_prev = {"count": 0.0, "total": 0.0}
    query_complete = previous is not None
    for (operation, outcome), entry in current["rpc"].items():
        if operation in SELF_OPERATIONS:
            continue
        prev_entry = prev_rpc.get((operation, outcome), {"count": 0.0, "total": 0.0} if previous else None)
        bucket = by_operation.setdefault(
            operation,
            {"count": 0.0, "errors": 0.0, "d_count": 0.0, "d_errors": 0.0, "d_total": 0.0, "reset": 0.0},
        )
        count = entry.get("count", 0.0)
        total = entry.get("total", 0.0)
        bucket["count"] += count
        if outcome not in OK_STATUSES:
            bucket["errors"] += count
        if prev_entry is None:
            bucket["reset"] = 1.0
            continue
        d_count = count - prev_entry.get("count", 0.0)
        d_total = total - prev_entry.get("total", 0.0)
        if d_count < 0 or d_total < 0:
            bucket["reset"] = 1.0
            continue
        bucket["d_count"] += d_count
        bucket["d_total"] += d_total
        if outcome not in OK_STATUSES:
            bucket["d_errors"] += d_count
        if operation in QUERY_OPERATIONS and outcome in OK_STATUSES:
            query_now["count"] += count
            query_now["total"] += total
            query_prev["count"] += prev_entry.get("count", 0.0)
            query_prev["total"] += prev_entry.get("total", 0.0)

    rpc: dict[str, dict[str, Any]] = {}
    for operation, bucket in by_operation.items():
        usable = previous is not None and not bucket["reset"] and seconds > 0
        rpc[operation] = {
            "rate": bucket["d_count"] / seconds if usable else None,
            "error_rate": bucket["d_errors"] / seconds if usable else None,
            "mean_ms": bucket["d_total"] / bucket["d_count"] * 1000 if usable and bucket["d_count"] > 0 else None,
            "total": int(bucket["count"]),
            "errors": int(bucket["errors"]),
        }

    gauges = current["gauges"]
    index_values = list(indexes.values())
    instance = {
        "management_ready": current["management_ready"],
        "failure_message": current["failure_message"],
        "free_disk_bytes": current["free_disk_bytes"],
        "metrics_count": current["metrics_count"],
        "qps": _sum([item["qps"] for item in index_values]),
        "failed_qps": _sum([item["failed_qps"] for item in index_values]),
        "ingest_rate": _sum([item["ingest_rate"] for item in index_values]),
        "search_latency_mean_ms": _interval_mean(
            query_now["count"], query_now["total"], query_prev["count"], query_prev["total"], 1000.0
        )
        if query_complete
        else None,
        "rpc_inflight": gauges.get("rpc_inflight"),
        "rpc_queued": gauges.get("rpc_queued"),
        "merges": gauges.get("merges"),
        "cursors": gauges.get("cursors"),
        "documents": _sum([item["documents"] for item in index_values]),
        "size_bytes": _sum([item["size_bytes"] for item in index_values]),
        "lifecycle_failures": current["lifecycle_failures"],
    }
    return instance, indexes, rpc


_COUNT_FIELDS = {
    "documents",
    "max_documents",
    "segments",
    "size_bytes",
    "memory_bytes",
    "initial_sync_exceptions",
    "steady_state_exceptions",
    "failed_queries_total",
}

SERIES_INSTANCE_FIELDS = (
    "qps",
    "failed_qps",
    "ingest_rate",
    "search_latency_mean_ms",
    "rpc_inflight",
    "rpc_queued",
    "merges",
    "cursors",
    "free_disk_bytes",
    "documents",
    "size_bytes",
)
SERIES_INDEX_FIELDS = (
    "qps",
    "failed_qps",
    "insert_rate",
    "update_rate",
    "delete_rate",
    "ingest_rate",
    "batch_latency_mean_ms",
    "batch_latency_max_ms",
    "lag_ms",
    "documents",
    "max_documents",
    "deleted_ratio",
    "segments",
    "size_bytes",
    "memory_bytes",
)


ALERT_COUNTERS = ("initial_sync_exceptions", "steady_state_exceptions")


def _total_rpc_count(raw: dict[str, Any]) -> float:
    return sum(entry.get("count", 0.0) for entry in raw["rpc"].values())


class MetricsSampler:
    """Polls ``fetch_status`` every ``interval`` seconds and keeps ``capacity`` samples."""

    def __init__(
        self,
        fetch_status: Callable[[], dict[str, Any]],
        *,
        fetch_indexes: Callable[[], list[dict[str, Any]]] | None = None,
        interval: float = 5.0,
        capacity: int = 720,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._fetch = fetch_status
        self._fetch_indexes = fetch_indexes
        self._definitions: dict[tuple[str, Any], Any] = {}
        self.interval = interval
        self._clock = clock
        self._samples: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._annotations: deque[dict[str, Any]] = deque(maxlen=200)
        self._lock = threading.Lock()
        self._sample_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._previous_raw: dict[str, Any] | None = None
        self._previous_t: float | None = None
        self._status: dict[str, Any] | None = None
        self._latest: dict[str, Any] | None = None
        self._error: str | None = None
        self._started_at: float | None = None

    # ----- lifecycle -----

    def ensure_started(self) -> None:
        """Start the sampling thread once; take a first sample if none exists yet."""
        with self._lock:
            alive = self._thread is not None and self._thread.is_alive()
            if not alive:
                self._stop.clear()
                self._started_at = self._clock()
                self._thread = threading.Thread(target=self._run, name="mong-metrics", daemon=True)
                self._thread.start()
        with self._sample_lock:
            if self._latest is None and self._error is None:
                self._sample_locked()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self.sample_once()

    # ----- sampling -----

    def sample_once(self, *, min_gap: float = 0.0) -> None:
        """Take a sample now. ``min_gap`` skips it when the last sample is younger than that
        many seconds, since very short intervals make rates noisy."""
        with self._sample_lock:
            if min_gap and self._previous_t is not None and self._error is None:
                if self._clock() - self._previous_t < min_gap:
                    return
            self._sample_locked()

    def _sample_locked(self) -> None:
        now = self._clock()
        try:
            status = self._fetch()
        except Exception as exc:  # noqa: BLE001 - any failure means "unreachable" to the UI
            with self._lock:
                self._error = _describe_error(exc)
            return
        self._attach_definitions(status)
        self._record(status, now)

    def _attach_definitions(self, status: dict[str, Any]) -> None:
        """GetStatus omits definitions; fetch them only when an index or revision is new."""
        indexes = status.get("indexes") or []
        if self._fetch_indexes is None or not indexes:
            return
        keys = {(index.get("index_id"), index.get("desired_revision")) for index in indexes}
        if not keys <= set(self._definitions):
            try:
                listed = self._fetch_indexes()
            except Exception:  # noqa: BLE001 - definitions are optional; retry on the next sample
                listed = None
            if listed is not None:
                self._definitions = {
                    (item.get("index_id"), item.get("desired_revision")): item.get("definition") for item in listed
                }
        for index in indexes:
            if index.get("definition") is None:
                index["definition"] = self._definitions.get((index.get("index_id"), index.get("desired_revision")))

    def _record(self, status: dict[str, Any], now: float) -> None:
        raw = extract(status)
        previous = self._previous_raw
        seconds = now - self._previous_t if self._previous_t is not None else 0.0
        instance, indexes, rpc = derive(raw, previous, seconds)
        names = {index["index_id"]: index.get("name") or index["index_id"] for index in status.get("indexes", [])}
        annotations = self._annotate(raw, previous, names, now)
        sample = {
            "t": round(now, 3),
            "instance": {key: instance.get(key) for key in SERIES_INSTANCE_FIELDS},
            "indexes": {
                index_id: {key: values.get(key) for key in SERIES_INDEX_FIELDS} for index_id, values in indexes.items()
            },
            "rpc": {op: {k: v for k, v in values.items() if k in ("rate", "error_rate", "mean_ms")} for op, values in rpc.items()},
            "counters": {
                index_id: {key: values.get(key) for key in ALERT_COUNTERS} for index_id, values in indexes.items()
            },
        }
        with self._lock:
            self._samples.append(sample)
            self._annotations.extend(annotations)
            self._status = status
            self._latest = {"instance": instance, "indexes": indexes, "rpc": rpc, "raw": raw}
            self._error = None
            self._previous_raw = raw
            self._previous_t = now

    def _annotate(
        self, raw: dict[str, Any], previous: dict[str, Any] | None, names: dict[str, str], now: float
    ) -> list[dict[str, Any]]:
        if previous is None:
            return []
        out: list[dict[str, Any]] = []
        if _total_rpc_count(raw) < _total_rpc_count(previous):
            out.append({"t": now, "kind": "restart", "index_id": None, "label": "mongot restarted"})
        before = previous["indexes"]
        for index_id, readings in raw["indexes"].items():
            name = names.get(index_id, index_id)
            if index_id not in before:
                out.append({"t": now, "kind": "created", "index_id": index_id, "label": f"{name} created"})
            elif readings["generation"] and before[index_id]["generation"] != readings["generation"]:
                out.append({"t": now, "kind": "rebuilt", "index_id": index_id, "label": f"{name} rebuilt"})
        prev_names = self._index_names()
        for index_id in before:
            if index_id not in raw["indexes"]:
                label = prev_names.get(index_id, index_id)
                out.append({"t": now, "kind": "dropped", "index_id": index_id, "label": f"{label} dropped"})
        return out

    def _index_names(self) -> dict[str, str]:
        status = self._status or {}
        return {index["index_id"]: index.get("name") or index["index_id"] for index in status.get("indexes", [])}

    # ----- queries -----

    def series(self, *, index_id: str | None = None, since: float | None = None) -> dict[str, Any]:
        with self._lock:
            samples = [
                {key: value for key, value in sample.items() if key != "counters"}
                for sample in self._samples
                if since is None or sample["t"] > since
            ]
            annotations = [item for item in self._annotations if since is None or item["t"] > since]
        if index_id:
            samples = [
                {**sample, "indexes": {index_id: sample["indexes"][index_id]} if index_id in sample["indexes"] else {}}
                for sample in samples
            ]
            annotations = [item for item in annotations if item["index_id"] in (None, index_id)]
        return {"interval": self.interval, "samples": samples, "annotations": annotations, "now": self._clock()}

    def summary(self) -> dict[str, Any]:
        with self._lock:
            status = self._status
            latest = self._latest
            error = self._error
            history = list(self._samples)
            started_at = self._started_at
        connected = error is None and latest is not None
        sampled_at = history[-1]["t"] if history else None
        indexes: list[dict[str, Any]] = []
        if status and latest:
            for index in status.get("indexes", []):
                metrics = dict(latest["indexes"].get(index["index_id"], {}))
                metrics["status_label"] = latest["raw"]["indexes"].get(index["index_id"], {}).get("status_label")
                indexes.append({**index, "metrics": metrics})
        instance = None
        if latest:
            instance = {key: value for key, value in latest["instance"].items() if key != "lifecycle_failures"}
        rpc = []
        if latest:
            rpc = [{"operation": op, **values} for op, values in sorted(latest["rpc"].items())]
        return {
            "connected": connected,
            "error": error,
            "sampled_at": sampled_at,
            "interval": self.interval,
            "started_at": started_at,
            "instance": instance,
            "indexes": indexes,
            "rpc": rpc,
            "alerts": evaluate_alerts(indexes, latest, history, error, self.interval),
        }


def _describe_error(exc: Exception) -> str:
    details = getattr(exc, "details", None)
    if callable(details):
        try:
            text = details()
        except Exception:  # noqa: BLE001
            text = None
        if text:
            return str(text)
    return str(exc) or exc.__class__.__name__


def _window(history: list[dict[str, Any]], interval: float) -> list[dict[str, Any]]:
    if not history:
        return []
    cutoff = history[-1]["t"] - ALERT_WINDOW_SECONDS
    return [sample for sample in history if sample["t"] >= cutoff] or history[-1:]


def evaluate_alerts(
    indexes: list[dict[str, Any]],
    latest: dict[str, Any] | None,
    history: list[dict[str, Any]],
    error: str | None,
    interval: float,
) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []

    def add(alert_id: str, severity: str, title: str, detail: str, index: dict[str, Any] | None = None) -> None:
        alerts.append(
            {
                "id": alert_id,
                "severity": severity,
                "title": title,
                "detail": detail,
                "index_id": index.get("index_id") if index else None,
                "index_name": index.get("name") if index else None,
            }
        )

    if error:
        add("mongot-unreachable", "error", "mongot is unreachable", error)
    if not latest:
        return alerts

    instance = latest["instance"]
    if not instance.get("management_ready"):
        add("management-not-ready", "error", "Management API is not ready", "mongot reports management_ready = false.")
    if instance.get("failure_message"):
        add("instance-failure", "error", "mongot reports a failure", str(instance["failure_message"]))

    free = instance.get("free_disk_bytes")
    if free is not None and free < LOW_DISK_ERROR:
        add("low-disk", "error", "Disk almost full", f"{free / GIB:.1f} GiB free on the mongot data volume.")
    elif free is not None and free < LOW_DISK_WARNING:
        add("low-disk", "warning", "Disk space is low", f"{free / GIB:.1f} GiB free on the mongot data volume.")

    window = _window(history, interval)
    queued = [sample["instance"].get("rpc_queued") for sample in window[-QUEUED_SAMPLES:]]
    if len(queued) >= QUEUED_SAMPLES and all((value or 0) > 0 for value in queued):
        add("rpc-queued", "warning", "Requests are queuing", f"{int(queued[-1] or 0)} RPCs are waiting for a worker.")

    for index in indexes:
        index_id = index["index_id"]
        name = index.get("name") or index_id
        metrics = index.get("metrics") or {}
        if index.get("failure_message"):
            add(f"failed:{index_id}", "error", f"{name} failed", str(index["failure_message"]), index)
        lifecycle = str(index.get("lifecycle_state") or "").upper()
        if lifecycle and lifecycle != "READY":
            severity = "error" if "FAIL" in lifecycle else "info"
            add(f"lifecycle:{index_id}", severity, f"{name} is {lifecycle.lower()}", f"Lifecycle state {lifecycle}.", index)
        if index.get("desired_revision") != index.get("active_revision"):
            add(
                f"rebuilding:{index_id}",
                "info",
                f"{name} is rebuilding",
                f"Revision {index.get('desired_revision')} is building; revision {index.get('active_revision')} serves queries.",
                index,
            )
        label = metrics.get("status_label")
        if label in ERROR_STATUSES:
            add(f"status:{index_id}", "error", f"{name} status is {label}", "The index cannot serve queries.", index)
        elif label in WARNING_STATUSES:
            add(f"status:{index_id}", "warning", f"{name} status is {label}", "The index may serve stale results.", index)

        for key, title in (
            ("initial_sync_exceptions", "initial sync"),
            ("steady_state_exceptions", "steady-state indexing"),
        ):
            now_value = metrics.get(key)
            then_value = _window_start(window, index_id, key)
            if now_value is not None and then_value is not None and now_value > then_value:
                add(
                    f"{key}:{index_id}",
                    "warning",
                    f"{name} has {title} exceptions",
                    f"{int(now_value - then_value)} new in the last {ALERT_WINDOW_SECONDS // 60} minutes.",
                    index,
                )

        ratio = metrics.get("deleted_ratio")
        if ratio is not None and ratio > DELETED_RATIO_WARNING and (metrics.get("max_documents") or 0) >= DELETED_RATIO_MIN_DOCS:
            add(
                f"deleted:{index_id}",
                "warning",
                f"{name} is {ratio:.0%} deleted documents",
                "Deleted documents use disk and memory until segment merges reclaim them.",
                index,
            )
        lag = metrics.get("lag_ms")
        if lag is not None and lag > LAG_WARNING_MS:
            add(f"lag:{index_id}", "warning", f"{name} is lagging", f"Replication lag is {lag / 1000:.0f} s.", index)

        failed = sum(
            (sample["indexes"].get(index_id, {}).get("failed_qps") or 0.0) * interval for sample in window
        )
        if failed >= 0.5:
            add(
                f"failed-queries:{index_id}",
                "warning",
                f"{name} has failing queries",
                f"About {round(failed)} failed in the last {ALERT_WINDOW_SECONDS // 60} minutes.",
                index,
            )
    order = {"error": 0, "warning": 1, "info": 2}
    alerts.sort(key=lambda alert: order.get(alert["severity"], 3))
    return alerts


def _window_start(window: list[dict[str, Any]], index_id: str, key: str) -> float | None:
    for sample in window:
        value = sample.get("counters", {}).get(index_id, {}).get(key)
        if value is not None:
            return value
    return None
