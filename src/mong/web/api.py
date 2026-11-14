"""REST API for the NoMongo-T admin UI."""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request
from grpc import RpcError

from mong.service import MongotService

api_bp = Blueprint("api", __name__, url_prefix="/api")
service = MongotService()


def _error(message: str, status: int = 400, **extra: Any):
    payload = {"error": message, **extra}
    return jsonify(payload), status


def _from_rpc(exc: Exception):
    if isinstance(exc, FileNotFoundError):
        return _error(str(exc), 503)
    if isinstance(exc, ValueError):
        return _error(str(exc), 400)
    if isinstance(exc, RpcError):
        details = exc.details() if hasattr(exc, "details") else str(exc)
        code = exc.code().name if hasattr(exc, "code") else "UNKNOWN"
        return _error(details or str(exc), 502, code=code)
    return _error(str(exc), 500)


@api_bp.get("/health")
def health():
    return jsonify({"ok": True})


@api_bp.get("/status")
def status():
    include_metrics = request.args.get("metrics", "").lower() in {"1", "true", "yes"}
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
    try:
        index = service.update_index(
            index_id,
            definition=definition,
            expected_revision=body.get("expected_revision"),
        )
        return jsonify(index)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.delete("/indexes/<index_id>")
def drop_index(index_id: str):
    body = request.get_json(silent=True) or {}
    try:
        index = service.drop_index(
            index_id,
            expected_revision=body.get("expected_revision"),
        )
        return jsonify(index)
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


@api_bp.post("/indexes/<index_id>/search")
def search(index_id: str):
    body = request.get_json(silent=True) or {}
    query = body.get("query")
    if not isinstance(query, dict):
        return _error("query must be an object")
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

