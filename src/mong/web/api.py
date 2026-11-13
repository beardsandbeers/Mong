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


@api_bp.get("/collections")
def list_collections():
    try:
        return jsonify({"collections": service.list_collections()})
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/collections")
def create_collection():
    body = request.get_json(silent=True) or {}
    database = (body.get("database") or "").strip()
    name = (body.get("name") or "").strip()
    if not database or not name:
        return _error("database and name are required")
    try:
        collection = service.create_collection(
            database=database,
            name=name,
            request_id=body.get("request_id"),
        )
        return jsonify(collection), 201
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/collections/<collection_id>")
def get_collection(collection_id: str):
    try:
        return jsonify(service.get_collection(collection_id))
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/indexes")
def list_indexes():
    collection_id = request.args.get("collection_id") or None
    try:
        return jsonify({"indexes": service.list_indexes(collection_id=collection_id)})
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
    collection_id = (body.get("collection_id") or "").strip()
    name = (body.get("name") or "").strip()
    if not collection_id or not name:
        return _error("collection_id and name are required")
    try:
        index = service.create_index(
            collection_id=collection_id,
            name=name,
            index_type=body.get("type") or "SEARCH",
            definition=body.get("definition"),
            request_id=body.get("request_id"),
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
            request_id=body.get("request_id"),
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
            request_id=body.get("request_id"),
        )
        return jsonify(index)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.post("/collections/<collection_id>/documents")
def upsert_documents(collection_id: str):
    body = request.get_json(silent=True) or {}
    documents = body.get("documents")
    if documents is None and "document" in body:
        documents = [body["document"]]
    if not isinstance(documents, list) or not documents:
        return _error("documents must be a non-empty array")
    try:
        result = service.upsert_documents(
            collection_id,
            documents,
            concern=body.get("concern") or "visible",
        )
        return jsonify(result), 201
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.delete("/collections/<collection_id>/documents/<path:document_id>")
def delete_document(collection_id: str, document_id: str):
    # Prefer JSON body when ID type matters (int vs string).
    body = request.get_json(silent=True) or {}
    doc_id: Any = body.get("id", document_id)
    try:
        result = service.delete_document(
            collection_id,
            doc_id,
            concern=body.get("concern") or "visible",
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


@api_bp.post("/collections/<collection_id>/delete-by-query")
def delete_by_query(collection_id: str):
    body = request.get_json(silent=True) or {}
    index_id = (body.get("index_id") or "").strip()
    query = body.get("query")
    if not index_id:
        return _error("index_id is required")
    if not isinstance(query, dict):
        return _error("query must be an object")
    try:
        result = service.delete_by_query(
            collection_id,
            index_id,
            query,
            request_id=body.get("request_id"),
            batch_size=int(body.get("batch_size") or 100),
            concern=body.get("concern") or "visible",
        )
        return jsonify(result)
    except Exception as exc:
        return _from_rpc(exc)


@api_bp.get("/collections/<collection_id>/delete-by-query/<request_id>")
def delete_by_query_status(collection_id: str, request_id: str):
    try:
        return jsonify(service.delete_by_query_result(collection_id, request_id))
    except Exception as exc:
        return _from_rpc(exc)
