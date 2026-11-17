"""Server-side jobs for long operations: clearing an index, large deletes, and exports.

Jobs run on daemon threads inside the Flask process, so they survive a closed browser
tab but not a server restart. State is kept in memory.
"""

from __future__ import annotations

import csv
import json
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

DELETE_PASS = 10_000
EXPORT_BATCH = 1000
MAX_JOBS = 50
MUTATING_KINDS = {"clear_index", "delete_by_query"}
KINDS = {"clear_index", "delete_by_query", "export"}
EXPORT_FORMATS = {"ndjson", "csv"}
EXPORT_DIR = Path(tempfile.gettempdir()) / "mong-exports"


class JobConflict(Exception):
    """Another mutating job is already running on the same index."""


class JobCancelled(Exception):
    pass


@dataclass
class Job:
    kind: str
    index_id: str
    index_name: str
    params: dict[str, Any]
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    state: str = "queued"
    done: int = 0
    total: int | None = None
    unit: str = "documents"
    message: str = ""
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    path: Path | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)

    @property
    def active(self) -> bool:
        return self.state in ("queued", "running")

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "index_id": self.index_id,
            "index_name": self.index_name,
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "unit": self.unit,
            "message": self.message,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "result": self.result,
            "downloadable": self.state == "succeeded" and self.path is not None and self.path.exists(),
        }


def _int(value: Any, name: str, default: int = 0) -> int:
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if number < 0:
        raise ValueError(f"{name} must be >= 0")
    return number


def _describe(exc: Exception) -> str:
    details = getattr(exc, "details", None)
    if callable(details):
        try:
            text = details()
        except Exception:  # noqa: BLE001
            text = None
        if text:
            return str(text)
    return str(exc) or exc.__class__.__name__


def export_document(hit: Any) -> Any:
    """The document to export for one search hit: stored source when present, else the hit."""
    if isinstance(hit, dict):
        source = hit.get("storedSource")
        if isinstance(source, dict):
            return source
        return {key: value for key, value in hit.items() if not str(key).startswith("$")}
    return hit


def _flatten(value: Any, prefix: str, out: dict[str, Any]) -> None:
    if isinstance(value, dict) and value and not any(str(key).startswith("$") for key in value):
        for key, item in value.items():
            _flatten(item, f"{prefix}.{key}" if prefix else str(key), out)
        return
    out[prefix or "value"] = value


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict) and len(value) == 1:
        (key, inner), = value.items()
        if key in ("$oid", "$numberDecimal", "$numberLong", "$numberDouble", "$numberInt", "$symbol"):
            return str(inner)
        if key == "$date":
            return inner if isinstance(inner, str) else json.dumps(inner)
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def ndjson_to_csv(source: Path, target: Path, cancelled: Callable[[], bool] = lambda: False) -> int:
    """Convert NDJSON to CSV with dotted column paths, in two streaming passes."""
    columns: dict[str, None] = {}
    with source.open("r", encoding="utf-8") as handle:
        for line in handle:
            if cancelled():
                raise JobCancelled()
            if line.strip():
                row: dict[str, Any] = {}
                _flatten(json.loads(line), "", row)
                columns.update(dict.fromkeys(row))
    names = list(columns)
    if "_id" in columns:
        names.remove("_id")
        names.insert(0, "_id")
    rows = 0
    with source.open("r", encoding="utf-8") as handle, target.open("w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(names)
        for line in handle:
            if not line.strip():
                continue
            row = {}
            _flatten(json.loads(line), "", row)
            writer.writerow([_csv_cell(row.get(name)) for name in names])
            rows += 1
    return rows


class JobManager:
    def __init__(self, service: Any, *, export_dir: Path = EXPORT_DIR) -> None:
        self._service = service
        self._export_dir = export_dir
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    # ----- registry -----

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda job: job.created_at, reverse=True)
        return [job.to_dict() for job in jobs]

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job is not None and job.active:
            job.cancel_event.set()
            job.message = "Cancelling…"
        return job

    def _evict(self) -> None:
        finished = sorted(
            (job for job in self._jobs.values() if not job.active), key=lambda job: job.created_at
        )
        while len(self._jobs) > MAX_JOBS and finished:
            job = finished.pop(0)
            self._jobs.pop(job.id, None)
            if job.path is not None:
                job.path.unlink(missing_ok=True)

    # ----- creation -----

    def create(self, kind: str, index_id: str, params: dict[str, Any] | None = None) -> Job:
        params = dict(params or {})
        if kind not in KINDS:
            raise ValueError(f"unknown job kind {kind!r}; expected one of {sorted(KINDS)}")
        if not index_id:
            raise ValueError("index_id is required")
        validated = self._validate(kind, params)
        index = self._service.get_index(index_id)
        if kind in MUTATING_KINDS and index.get("source") == "mongod":
            raise ValueError(
                f"{index.get('name') or index_id} is managed by MongoDB; delete its documents in the collection"
            )
        job = Job(
            kind=kind,
            index_id=index_id,
            index_name=index.get("name") or index_id,
            params={**validated, "index_type": index.get("type"), "source": index.get("source")},
        )
        with self._lock:
            if kind in MUTATING_KINDS:
                for other in self._jobs.values():
                    if other.index_id == index_id and other.kind in MUTATING_KINDS and other.active:
                        raise JobConflict(
                            f"{other.kind.replace('_', ' ')} job {other.id} is already running on this index"
                        )
            self._jobs[job.id] = job
            self._evict()
        thread = threading.Thread(target=self._run, args=(job,), name=f"mong-job-{job.id}", daemon=True)
        thread.start()
        return job

    def _validate(self, kind: str, params: dict[str, Any]) -> dict[str, Any]:
        concern = params.get("concern") or "visible"
        if concern not in ("indexed", "committed", "visible"):
            raise ValueError("concern must be indexed, committed, or visible")
        if kind == "clear_index":
            return {"concern": concern, "estimate": _int(params.get("estimate"), "estimate") or None}
        if kind == "delete_by_query":
            query = params.get("query")
            if not isinstance(query, dict):
                raise ValueError("query must be an object")
            return {
                "query": query,
                "vector": bool(params.get("vector")),
                "limit": _int(params.get("limit"), "limit"),
                "concern": concern,
                "estimate": _int(params.get("estimate"), "estimate") or None,
            }
        query = params.get("query")
        if query is not None and not isinstance(query, dict):
            raise ValueError("query must be an object")
        export_format = params.get("format") or "ndjson"
        if export_format not in EXPORT_FORMATS:
            raise ValueError("format must be ndjson or csv")
        return {
            "query": query,
            "vector": bool(params.get("vector")),
            "format": export_format,
            "limit": _int(params.get("limit"), "limit"),
            "estimate": _int(params.get("estimate"), "estimate") or None,
        }

    # ----- execution -----

    def _run(self, job: Job) -> None:
        job.state = "running"
        job.started_at = time.time()
        try:
            runner = {
                "clear_index": self._clear_index,
                "delete_by_query": self._delete_by_query,
                "export": self._export,
            }[job.kind]
            runner(job)
            job.state = "succeeded"
        except JobCancelled:
            job.state = "cancelled"
            job.message = f"Cancelled after {job.done:,} {job.unit}"
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI as the job error
            job.state = "failed"
            job.error = _describe(exc)
        finally:
            job.finished_at = time.time()

    def _delete_passes(self, job: Job, *, query: dict[str, Any] | None, vector: bool, limit: int) -> None:
        job.total = job.params.get("estimate") or (limit or None)
        passes = 0
        while True:
            job.check_cancelled()
            cap = DELETE_PASS if not limit else min(DELETE_PASS, limit - job.done)
            if cap <= 0:
                break
            result = self._service.delete_by_query(
                job.index_id,
                query=None if query is None else dict(query),
                vector=vector,
                match_all=query is None,
                dry_run=False,
                max_matches=cap,
                concern=job.params.get("concern") or "visible",
            )
            passes += 1
            matched = int(result.get("matched_count") or 0)
            processed = int(result.get("processed_count") or 0)
            job.done += processed
            if job.total is not None and job.done > job.total:
                job.total = job.done
            job.message = f"Pass {passes}: deleted {processed:,}"
            if matched == 0:
                break
            if processed == 0:
                raise RuntimeError(f"{matched:,} documents matched but none were deleted; stopping")
        job.total = job.done
        job.result = {"deleted": job.done, "passes": passes}
        job.message = f"Deleted {job.done:,} documents in {passes} pass{'es' if passes != 1 else ''}"

    def _clear_index(self, job: Job) -> None:
        self._delete_passes(job, query=None, vector=False, limit=0)

    def _delete_by_query(self, job: Job) -> None:
        self._delete_passes(
            job,
            query=job.params["query"],
            vector=bool(job.params.get("vector")),
            limit=int(job.params.get("limit") or 0),
        )

    def _export(self, job: Job) -> None:
        params = job.params
        limit = int(params.get("limit") or 0)
        job.total = limit or params.get("estimate")
        self._export_dir.mkdir(parents=True, exist_ok=True)
        ndjson_path = self._export_dir / f"{job.id}.ndjson"
        vector = bool(params.get("vector")) or params.get("index_type") == "VECTOR_SEARCH"
        query = params.get("query")
        cursor_id: str | None = None
        try:
            # A MongoDB-managed index browses its collection, so it needs no query even for vectors.
            if query is None and (not vector or params.get("source") == "mongod"):
                page = self._service.browse(job.index_id, batch_size=EXPORT_BATCH)
            elif query is None:
                raise ValueError("a vector index export needs a $vectorSearch query")
            else:
                page = self._service.search(job.index_id, dict(query), batch_size=EXPORT_BATCH, vector=vector)
            with ndjson_path.open("w", encoding="utf-8") as out:
                batch = 1
                while True:
                    for hit in page.get("results") or []:
                        if limit and job.done >= limit:
                            break
                        out.write(json.dumps(export_document(hit), ensure_ascii=False, separators=(",", ":")))
                        out.write("\n")
                        job.done += 1
                    cursor_id = page.get("cursor_id")
                    job.message = f"Wrote {job.done:,} documents"
                    if job.total is not None and job.done > job.total:
                        job.total = job.done
                    if not cursor_id or (limit and job.done >= limit):
                        break
                    job.check_cancelled()
                    batch += 1
                    page = self._service.search_more(
                        cursor_id, index_id=job.index_id, batch_size=EXPORT_BATCH, page=batch
                    )
                    cursor_id = None
            if cursor_id:
                self._kill(cursor_id)
                cursor_id = None
            path = ndjson_path
            if params.get("format") == "csv":
                job.message = "Converting to CSV"
                path = self._export_dir / f"{job.id}.csv"
                ndjson_to_csv(ndjson_path, path, job.cancel_event.is_set)
                ndjson_path.unlink(missing_ok=True)
            job.path = path
            job.total = job.done
            job.result = {"documents": job.done, "format": params.get("format"), "bytes": path.stat().st_size}
            job.message = f"Exported {job.done:,} documents"
        except BaseException:
            if cursor_id:
                self._kill(cursor_id)
            ndjson_path.unlink(missing_ok=True)
            (self._export_dir / f"{job.id}.csv").unlink(missing_ok=True)
            raise

    def _kill(self, cursor_id: str) -> None:
        try:
            self._service.kill_cursor(cursor_id)
        except Exception:  # noqa: BLE001 - the cursor times out on its own
            pass
