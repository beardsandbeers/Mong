"""High-level NoMongo-T operations used by the admin API."""

from __future__ import annotations

import uuid
from typing import Any

from mongot_standalone import api, encode_bson

from mong.client import create_client
from mong.registry import CollectionRegistry
from mong.serialize import (
    INDEX_TYPE_VALUES,
    bson_to_python,
    collection_to_dict,
    index_to_dict,
    parse_json_document,
    python_to_jsonable,
    status_to_dict,
)


def _request_id(prefix: str, explicit: str | None = None) -> str:
    return explicit or f"{prefix}-{uuid.uuid4()}"


class MongotService:
    def __init__(self, registry: CollectionRegistry | None = None) -> None:
        self.registry = registry or CollectionRegistry()

    def status(self, *, include_metrics: bool = False) -> dict[str, Any]:
        with create_client() as client:
            status = client.get_status(api.GetStatusRequest())
        payload = status_to_dict(status, include_metrics=include_metrics)
        self.registry.merge_from_indexes(payload["indexes"])
        return payload

    def list_collections(self) -> list[dict[str, Any]]:
        status = self.status()
        collections = self.registry.merge_from_indexes(status["indexes"])
        enriched: list[dict[str, Any]] = []
        for item in collections:
            if item.get("database") and item.get("name"):
                enriched.append(item)
                continue
            try:
                enriched.append(self.get_collection(item["collection_id"]))
            except Exception:
                enriched.append(item)
        return enriched

    def create_collection(
        self,
        *,
        database: str,
        name: str,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        with create_client() as client:
            collection = client.create_collection(
                api.CreateCollectionRequest(
                    request_id=_request_id("create-collection", request_id),
                    database=database,
                    name=name,
                )
            )
        return self.registry.upsert(collection_to_dict(collection))

    def get_collection(self, collection_id: str) -> dict[str, Any]:
        with create_client() as client:
            collection = client.get_collection(
                api.GetCollectionRequest(collection_id=collection_id)
            )
        return self.registry.upsert(collection_to_dict(collection))

    def list_indexes(
        self,
        *,
        collection_id: str | None = None,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        if collection_id:
            indexes: list[dict[str, Any]] = []
            page_token = ""
            with create_client() as client:
                while True:
                    response = client.list_indexes(
                        api.ListIndexesRequest(
                            collection_id=collection_id,
                            page_size=page_size,
                            page_token=page_token,
                        )
                    )
                    indexes.extend(index_to_dict(idx) for idx in response.indexes)
                    if not response.next_page_token:
                        break
                    page_token = response.next_page_token
            return indexes
        return self.status()["indexes"]

    def get_index(self, index_id: str) -> dict[str, Any]:
        with create_client() as client:
            index = client.get_index(api.GetIndexRequest(index_id=index_id))
        return index_to_dict(index)

    def create_index(
        self,
        *,
        collection_id: str,
        name: str,
        index_type: str = "SEARCH",
        definition: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        type_code = INDEX_TYPE_VALUES.get(index_type.upper())
        if type_code is None:
            raise ValueError(f"Unknown index type: {index_type}")
        if definition is None:
            if type_code == api.INDEX_TYPE_VECTOR_SEARCH:
                definition = {
                    "fields": [
                        {
                            "type": "vector",
                            "path": "embedding",
                            "numDimensions": 3,
                            "similarity": "cosine",
                        }
                    ]
                }
            else:
                definition = {"mappings": {"dynamic": True}, "storedSource": True}

        with create_client() as client:
            index = client.create_index(
                api.CreateIndexRequest(
                    request_id=_request_id("create-index", request_id),
                    collection_id=collection_id,
                    name=name,
                    type=type_code,
                    definition_bson=encode_bson(definition),
                )
            )
        return index_to_dict(index)

    def update_index(
        self,
        index_id: str,
        *,
        definition: dict[str, Any],
        expected_revision: int | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        current = self.get_index(index_id)
        revision = expected_revision if expected_revision is not None else current["desired_revision"]
        with create_client() as client:
            index = client.update_index(
                api.UpdateIndexRequest(
                    request_id=_request_id("update-index", request_id),
                    index_id=index_id,
                    expected_revision=revision,
                    definition_bson=encode_bson(definition),
                )
            )
        return index_to_dict(index)

    def drop_index(
        self,
        index_id: str,
        *,
        expected_revision: int | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        current = self.get_index(index_id)
        revision = expected_revision if expected_revision is not None else current["desired_revision"]
        with create_client() as client:
            index = client.drop_index(
                api.DropIndexRequest(
                    request_id=_request_id("drop-index", request_id),
                    index_id=index_id,
                    expected_revision=revision,
                )
            )
        return index_to_dict(index)

    def upsert_documents(
        self,
        collection_id: str,
        documents: list[dict[str, Any]],
        *,
        concern: str = "visible",
    ) -> dict[str, Any]:
        parsed = [parse_json_document(doc) for doc in documents]
        with create_client() as client:
            response = client.upsert_many(collection_id, parsed, concern=concern)
        return {
            "collection_id": response.collection_id,
            "request_id": response.request_id,
            "upserted_count": response.upserted_count,
            "accepted_sequence": response.accepted_sequence,
        }

    def delete_document(
        self,
        collection_id: str,
        document_id: Any,
        *,
        concern: str = "visible",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete(collection_id, document_id, concern=concern)
        return {
            "collection_id": response.collection_id,
            "request_id": response.request_id,
            "deleted_count": response.deleted_count,
            "accepted_sequence": response.accepted_sequence,
        }

    def delete_documents(
        self,
        collection_id: str,
        document_ids: list[Any],
        *,
        concern: str = "visible",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete_many(collection_id, document_ids, concern=concern)
        return {
            "collection_id": response.collection_id,
            "request_id": response.request_id,
            "deleted_count": response.deleted_count,
            "accepted_sequence": response.accepted_sequence,
        }

    def _query_page_from_response(
        self,
        *,
        index_id: str,
        response: Any,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        batch = bson_to_python(response.batch_bson) or {}
        results = batch.get("results", [])
        metadata = bson_to_python(response.metadata_bson) if response.metadata_bson else None
        cursor_id = int(response.cursor_id or 0)
        return {
            "index_id": index_id,
            "page": page,
            "page_size": page_size,
            "count": len(results),
            "results": python_to_jsonable(results),
            "metadata": python_to_jsonable(metadata),
            "generation_id": response.generation_id or "",
            "cursor_id": str(cursor_id) if cursor_id else None,
            "has_more": bool(cursor_id),
        }

    def search(
        self,
        index_id: str,
        query: dict[str, Any],
        *,
        batch_size: int = 25,
        vector: bool = False,
        page: int = 1,
        drain: bool = False,
        max_batches: int = 20,
    ) -> dict[str, Any]:
        page_size = max(1, min(int(batch_size), 1000))
        with create_client() as client:
            request = api.QueryRequest(
                index_id=index_id,
                query_bson=encode_bson(query),
                batch_size=page_size,
            )
            response = client.vector_search(request) if vector else client.search(request)

            if not drain:
                return self._query_page_from_response(
                    index_id=index_id,
                    response=response,
                    page=max(1, int(page)),
                    page_size=page_size,
                )

            results: list[Any] = []
            metadata: Any = None
            generation_id = ""
            batches = 0
            while True:
                batches += 1
                batch = bson_to_python(response.batch_bson) or {}
                results.extend(batch.get("results", []))
                if response.metadata_bson:
                    metadata = bson_to_python(response.metadata_bson)
                generation_id = response.generation_id or generation_id
                if not response.cursor_id or batches >= max_batches:
                    if response.cursor_id:
                        client.kill_cursor(api.KillCursorRequest(cursor_id=response.cursor_id))
                    break
                response = client.get_more(
                    api.GetMoreRequest(cursor_id=response.cursor_id, batch_size=page_size)
                )

        return {
            "index_id": index_id,
            "page": 1,
            "page_size": page_size,
            "count": len(results),
            "results": python_to_jsonable(results),
            "metadata": python_to_jsonable(metadata),
            "generation_id": generation_id,
            "cursor_id": None,
            "has_more": batches >= max_batches,
            "truncated": batches >= max_batches,
        }

    def search_more(
        self,
        cursor_id: str | int,
        *,
        index_id: str = "",
        batch_size: int = 25,
        page: int = 1,
    ) -> dict[str, Any]:
        page_size = max(1, min(int(batch_size), 1000))
        with create_client() as client:
            response = client.get_more(
                api.GetMoreRequest(cursor_id=int(cursor_id), batch_size=page_size)
            )
        return self._query_page_from_response(
            index_id=index_id,
            response=response,
            page=max(1, int(page)),
            page_size=page_size,
        )

    def kill_cursor(self, cursor_id: str | int) -> dict[str, Any]:
        with create_client() as client:
            client.kill_cursor(api.KillCursorRequest(cursor_id=int(cursor_id)))
        return {"cursor_id": str(cursor_id), "killed": True}

    def browse(
        self,
        index_id: str,
        *,
        batch_size: int = 25,
        query: dict[str, Any] | None = None,
        page: int = 1,
        drain: bool = False,
    ) -> dict[str, Any]:
        """Browse documents via a broad search expression on a search index."""
        default_query = {"exists": {"path": "_id"}}
        return self.search(
            index_id,
            query or default_query,
            batch_size=batch_size,
            vector=False,
            page=page,
            drain=drain,
        )

    @staticmethod
    def _delete_by_query_to_dict(result: Any) -> dict[str, Any]:
        return {
            "collection_id": result.collection_id,
            "request_id": result.request_id,
            "index_id": result.index_id,
            "generation_id": result.generation_id,
            "snapshot_sequence": result.snapshot_sequence,
            "selection_complete": result.selection_complete,
            "matched_count": result.matched_count,
            "deleted_count": result.deleted_count,
            "conflict_count": result.conflict_count,
            "missing_count": result.missing_count,
            "failed_count": result.failed_count,
            "accepted_sequence": result.accepted_sequence,
            "complete": result.complete,
            "failure_message": result.failure_message or None,
        }

    def delete_by_query(
        self,
        collection_id: str,
        index_id: str,
        query: dict[str, Any],
        *,
        request_id: str | None = None,
        batch_size: int = 100,
        concern: str = "visible",
    ) -> dict[str, Any]:
        with create_client() as client:
            result = client.delete_by_query(
                collection_id,
                index_id,
                query,
                request_id=_request_id("delete-by-query", request_id),
                batch_size=max(1, min(int(batch_size), 1000)),
                concern=concern,
            )
        return self._delete_by_query_to_dict(result)

    def delete_by_query_result(self, collection_id: str, request_id: str) -> dict[str, Any]:
        with create_client() as client:
            result = client.delete_by_query_result(collection_id, request_id)
        return self._delete_by_query_to_dict(result)
