"""REST API for the NoMongo-T admin UI."""

from __future__ import annotations

import time
from typing import Any

from flask import Blueprint, jsonify, request, send_file
from grpc import RpcError

from mong.jobs import JobConflict, JobManager
from mong.metrics import MetricsSampler
from mong.mongod import MongodError, merge_summary
from mong.sources import SearchService

api_bp = Blueprint("api", __name__, url_prefix="/api")
service = SearchService()
sampler = MetricsSampler(
    lambda: service.status(include_metrics=True),
    fetch_indexes=lambda: service.list_index_definitions(),
)
jobs = JobManager(service)


def _error(message: str, status: int = 400, **extra: Any):
    payload = {"error": message, **extra}
    return jsonify(payload), status


_RPC_STATUS = {
    "INVALID_ARGUMENT": 400,
    "OUT_OF_RANGE": 400,
    "NOT_FOUND": 404,
    "ALREADY_EXISTS": 409,
    "ABORTED": 409,
    "FAILED_PRECONDITION": 409,
    "RESOURCE_EXHAUSTED": 429,
    "UNAVAILABLE": 503,
    "DEADLINE_EXCEEDED": 504,
}


def _from_rpc(exc: Exception):
    if isinstance(exc, MongodError):
        return _error(str(exc), exc.status, code=exc.code)
    if isinstance(exc, JobConflict):
        return _error(str(exc), 409, code="JOB_CONFLICT")
    if isinstance(exc, FileNotFoundError):
        return _error(str(exc), 503, code="CREDENTIALS_MISSING")
    if isinstance(exc, ValueError):
        return _error(str(exc), 400, code="INVALID_ARGUMENT")
    if isinstance(exc, RpcError):
        details = exc.details() if hasattr(exc, "details") else str(exc)
        code = exc.code().name if hasattr(exc, "code") else "UNKNOWN"
        return _error(details or str(exc), _RPC_STATUS.get(code, 502), code=code)
    return _error(str(exc), 500, code="INTERNAL")


def _revision(body: dict[str, Any]) -> int | None:
    value = body.get("expected_revision")
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _flag(name: str) -> bool:
    return request.args.get(name, "").lower() in {"1", "true", "yes"}


@api_bp.get("/health")
def health():
    return jsonify({"ok": True})


@api_bp.get("/status")
def status():
    include_metrics = _flag("metrics")
    try:
        return jsonify(service.status(include_metrics=include_metrics))
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes")
def list_indexes():
    try:
        return jsonify({"indexes": service.list_indexes()})
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes/<index_id>")
def get_index(index_id: str):
    try:
        return jsonify(service.get_index(index_id))
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes")
def create_index():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return _error("name is required")
    try:
        index = service.create_index(
            name=name,
            index_type=body.get("type") or "SEARCH",
            definition=body.get("definition"),
        )
        return jsonify(index), 201
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.put("/indexes/<index_id>")
def update_index(index_id: str):
    body = request.get_json(silent=True) or {}
    definition = body.get("definition")
    if definition is None:
        return _error("definition is required")
    revision = _revision(body)
    if revision is None:
        return _error("expected_revision is required (the revision the definition was loaded from)")
    try:
        index = service.update_index(
            index_id,
            definition=definition,
            expected_revision=revision,
            update_mode_name=body.get("update_mode") or "auto",
        )
        return jsonify(index)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.delete("/indexes/<index_id>")
def drop_index(index_id: str):
    body = request.get_json(silent=True) or {}
    revision = _revision(body)
    if revision is None:
        return _error("expected_revision is required (the revision the index was loaded at)")
    try:
        index = service.drop_index(
            index_id,
            expected_revision=revision,
        )
        return jsonify(index)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes/<index_id>/mappings")
def export_mappings(index_id: str):
    try:
        return jsonify(
            service.export_mappings(
                index_id,
                generation_id=request.args.get("generation_id", ""),
            )
        )
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes/<index_id>/field-suggestions")
def field_suggestions(index_id: str):
    try:
        return jsonify(service.field_suggestions(index_id, generation_id=request.args.get("generation_id", "")))
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes/<index_id>/stats")
def index_stats(index_id: str):
    try:
        return jsonify(
            service.index_stats(
                index_id,
                refresh=_flag("refresh"),
                generation_id=request.args.get("generation_id", ""),
            )
        )
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes/<index_id>/field-stats")
def field_stats(index_id: str):
    try:
        return jsonify(
            service.field_stats(
                index_id,
                refresh=_flag("refresh"),
                paths=[path for path in request.args.getlist("path") if path],
                page_size=int(request.args.get("page_size") or 100),
                page_token=request.args.get("page_token", ""),
                generation_id=request.args.get("generation_id", ""),
            )
        )
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/documents")
def upsert_documents(index_id: str):
    body = request.get_json(silent=True) or {}
    documents = body.get("documents")
    if documents is None and "document" in body:
        documents = [body["document"]]
    if not isinstance(documents, list) or not documents:
        return _error("documents must be a non-empty array")
    try:
        result = service.upsert_documents(
            index_id,
            documents,
            concern=body.get("concern") or "visible",
            generation_id=body.get("generation_id") or "",
        )
        return jsonify(result), 201
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/documents/delete")
def delete_documents(index_id: str):
    body = request.get_json(silent=True) or {}
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids:
        return _error("ids must be a non-empty array")
    try:
        result = service.delete_documents(
            index_id,
            ids,
            concern=body.get("concern") or "visible",
            generation_id=body.get("generation_id") or "",
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.delete("/indexes/<index_id>/documents/<path:document_id>")
def delete_document(index_id: str, document_id: str):
    # Prefer JSON body when ID type matters (int vs string).
    body = request.get_json(silent=True) or {}
    doc_id: Any = body.get("id", document_id)
    try:
        result = service.delete_document(
            index_id,
            doc_id,
            concern=body.get("concern") or "visible",
            generation_id=body.get("generation_id") or "",
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/delete-by-query")
def delete_by_query(index_id: str):
    body = request.get_json(silent=True) or {}
    match_all = bool(body.get("match_all"))
    query = None if match_all else body.get("query")
    if not match_all and not isinstance(query, dict):
        return _error("query must be an object")
    try:
        max_matches = int(body.get("max_matches") or 0)
    except (TypeError, ValueError):
        return _error("max_matches must be an integer")
    try:
        result = service.delete_by_query(
            index_id,
            query=query,
            vector=bool(body.get("vector")),
            match_all=match_all,
            dry_run=bool(body.get("dry_run", True)),
            max_matches=max_matches,
            concern=body.get("concern") or "visible",
            generation_id=body.get("generation_id") or "",
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/search")
def search(index_id: str):
    body = request.get_json(silent=True) or {}
    query = body.get("query")
    if not isinstance(query, dict):
        return _error("query must be an object")
    explain = body.get("explain") or ""
    if not isinstance(explain, str):
        return _error("explain must be a string")
    try:
        result = service.search(
            index_id,
            query,
            batch_size=int(body.get("batch_size") or body.get("page_size") or 25),
            vector=bool(body.get("vector")),
            page=int(body.get("page") or 1),
            drain=bool(body.get("drain")),
            max_batches=int(body.get("max_batches") or 20),
            generation_id=body.get("generation_id") or "",
            explain=explain,
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/search-meta")
def search_meta(index_id: str):
    body = request.get_json(silent=True) or {}
    query = body.get("query")
    if not isinstance(query, dict):
        return _error("query must be an object")
    explain = body.get("explain") or ""
    if not isinstance(explain, str):
        return _error("explain must be a string")
    try:
        result = service.search_meta(
            index_id,
            query,
            generation_id=body.get("generation_id") or "",
            explain=explain,
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/indexes/<index_id>/browse")
def browse(index_id: str):
    body = request.get_json(silent=True) or {}
    try:
        result = service.browse(
            index_id,
            batch_size=int(body.get("batch_size") or body.get("page_size") or 25),
            query=body.get("query"),
            page=int(body.get("page") or 1),
            drain=bool(body.get("drain")),
            generation_id=body.get("generation_id") or "",
            count=bool(body.get("count")),
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/query/more")
def search_more():
    body = request.get_json(silent=True) or {}
    cursor_id = body.get("cursor_id")
    if cursor_id in (None, ""):
        return _error("cursor_id is required")
    try:
        result = service.search_more(
            cursor_id,
            index_id=body.get("index_id") or "",
            batch_size=int(body.get("batch_size") or body.get("page_size") or 25),
            page=int(body.get("page") or 1),
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.delete("/query/cursors/<cursor_id>")
def kill_cursor(cursor_id: str):
    try:
        return jsonify(service.kill_cursor(cursor_id))
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/metrics/summary")
def metrics_summary():
    sampler.ensure_started()
    refresh = _flag("refresh")
    if refresh:
        sampler.sample_once(min_gap=2.0)
    return jsonify(merge_summary(sampler.summary(), service.mongod.snapshot(refresh=refresh)))


@api_bp.get("/metrics/series")
def metrics_series():
    sampler.ensure_started()
    since_arg = request.args.get("since")
    try:
        since = float(since_arg) if since_arg else None
    except ValueError:
        return _error("since must be a number (epoch seconds)")
    return jsonify(sampler.series(index_id=request.args.get("index") or None, since=since))


@api_bp.get("/jobs")
def list_jobs():
    return jsonify({"jobs": jobs.list()})


@api_bp.post("/jobs")
def create_job():
    body = request.get_json(silent=True) or {}
    params = {key: value for key, value in body.items() if key not in ("kind", "index_id")}
    try:
        job = jobs.create(str(body.get("kind") or ""), str(body.get("index_id") or ""), params)
        return jsonify(job.to_dict()), 202
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/jobs/<job_id>")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        return _error("job not found (jobs are lost when the server restarts)", 404, code="NOT_FOUND")
    return jsonify(job.to_dict())


@api_bp.post("/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    job = jobs.cancel(job_id)
    if job is None:
        return _error("job not found", 404, code="NOT_FOUND")
    return jsonify(job.to_dict())


@api_bp.get("/jobs/<job_id>/download")
def download_job(job_id: str):
    job = jobs.get(job_id)
    if job is None or job.path is None or not job.path.exists():
        return _error("no export file for this job", 404, code="NOT_FOUND")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(job.finished_at or time.time()))
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in job.index_name)
    mimetype = "text/csv" if job.path.suffix == ".csv" else "application/x-ndjson"
    return send_file(
        job.path,
        mimetype=mimetype,
        as_attachment=True,
        download_name=f"{safe_name}-{stamp}{job.path.suffix}",
    )

