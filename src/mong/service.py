"""High-level NoMongo-T operations used by the admin API.

Release 0.3 writes BSON directly into an index. There is no collection catalog,
source document store, or delete-by-query workflow.
"""

from __future__ import annotations

from typing import Any

from mongot_standalone import api, encode_bson

from mong.client import create_client
from mong.serialize import (
    INDEX_TYPE_VALUES,
    bson_to_python,
    index_to_dict,
    parse_json_document,
    python_to_jsonable,
    status_to_dict,
)


class MongotService:
    def status(self, *, include_metrics: bool = False) -> dict[str, Any]:
        with create_client() as client:
            status = client.get_status(api.GetStatusRequest())
        return status_to_dict(status, include_metrics=include_metrics)

    def list_indexes(self) -> list[dict[str, Any]]:
        with create_client() as client:
            response = client.list_indexes(api.ListIndexesRequest())
        indexes = [index_to_dict(idx) for idx in response.indexes]
        by_id = {item["index_id"]: item.get("stats") for item in self.status()["indexes"]}
        for index in indexes:
            if index["index_id"] in by_id:
                index["stats"] = by_id[index["index_id"]]
        return indexes

    def get_index(self, index_id: str) -> dict[str, Any]:
        with create_client() as client:
            index = client.get_index(api.GetIndexRequest(index_id=index_id))
        return index_to_dict(index)

    def create_index(
        self,
        *,
        name: str,
        index_type: str = "SEARCH",
        definition: dict[str, Any] | None = None,
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
    ) -> dict[str, Any]:
        current = self.get_index(index_id)
        revision = expected_revision if expected_revision is not None else current["desired_revision"]
        with create_client() as client:
            index = client.update_index(
                api.UpdateIndexRequest(
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
    ) -> dict[str, Any]:
        current = self.get_index(index_id)
        revision = expected_revision if expected_revision is not None else current["desired_revision"]
        with create_client() as client:
            index = client.drop_index(
                api.DropIndexRequest(
                    index_id=index_id,
                    expected_revision=revision,
                )
            )
        return index_to_dict(index)

    def upsert_documents(
        self,
        index_id: str,
        documents: list[dict[str, Any]],
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        parsed = [parse_json_document(doc) for doc in documents]
        with create_client() as client:
            response = client.upsert_many(
                index_id,
                parsed,
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "indexed_count": response.indexed_count,
        }

    def delete_document(
        self,
        index_id: str,
        document_id: Any,
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete(
                index_id,
                document_id,
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "processed_count": response.processed_count,
        }

    def delete_documents(
        self,
        index_id: str,
        document_ids: list[Any],
        *,
        concern: str = "visible",
        generation_id: str = "",
    ) -> dict[str, Any]:
        with create_client() as client:
            response = client.delete_many(
                index_id,
                document_ids,
                concern=concern,
                generation_id=generation_id,
            )
        return {
            "index_id": response.index_id,
            "generation_id": response.generation_id,
            "processed_count": response.processed_count,
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
        generation_id: str = "",
    ) -> dict[str, Any]:
        page_size = max(1, min(int(batch_size), 1000))
        with create_client() as client:
            request = api.QueryRequest(
                index_id=index_id,
                query_bson=encode_bson(query),
                batch_size=page_size,
                generation_id=generation_id,
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
            seen_generation = ""
            batches = 0
            while True:
                batches += 1
                batch = bson_to_python(response.batch_bson) or {}
                results.extend(batch.get("results", []))
                if response.metadata_bson:
                    metadata = bson_to_python(response.metadata_bson)
                seen_generation = response.generation_id or seen_generation
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
            "generation_id": seen_generation,
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
        generation_id: str = "",
    ) -> dict[str, Any]:
        """Browse documents via a broad search expression on a search index.

        Always requests stored source so each hit is the full document, not only ``_id``.
        Stored source is returned only when the index definition enables it.
        """
        expression = dict(query) if query else {"exists": {"path": "_id"}}
        expression["returnStoredSource"] = True
        return self.search(
            index_id,
            expression,
            batch_size=batch_size,
            vector=False,
            page=page,
            drain=drain,
            generation_id=generation_id,
        )
