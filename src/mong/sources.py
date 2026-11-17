"""Standalone mongot indexes and MongoDB-managed indexes behind one service.

Ids that start with ``mongod:`` name a MongoDB-managed index, and cursor ids that
start with ``mongod-`` page through one. Reads on those go to mongod. Writes,
statistics, and mapping export exist only on the standalone API, so they are refused.
"""

from __future__ import annotations

from typing import Any

from mong.mongod import MongodError, MongodSearch, display_name, is_cursor_id, is_index_id, parse_index_id
from mong.service import MongotService


def _standalone_only(index_id: str, action: str) -> None:
    if is_index_id(index_id):
        name = display_name(*parse_index_id(index_id))
        raise MongodError(
            f"{name} is managed by MongoDB. Mong can browse and query it but cannot {action}.",
            status=400,
            code="READ_ONLY",
        )


class SearchService(MongotService):
    def __init__(self, mongod: MongodSearch | None = None) -> None:
        self.mongod = mongod or MongodSearch()

    def list_indexes(self) -> list[dict[str, Any]]:
        return super().list_indexes() + self.mongod.list_indexes()

    def get_index(self, index_id: str) -> dict[str, Any]:
        if is_index_id(index_id):
            return self.mongod.get_index(index_id)
        return super().get_index(index_id)

    def search(self, index_id: str, query: dict[str, Any], **options: Any) -> dict[str, Any]:
        if is_index_id(index_id):
            return self.mongod.search(index_id, query, **options)
        return super().search(index_id, query, **options)

    def browse(self, index_id: str, **options: Any) -> dict[str, Any]:
        if is_index_id(index_id):
            return self.mongod.browse(index_id, **options)
        return super().browse(index_id, **options)

    def search_more(self, cursor_id: str | int, **options: Any) -> dict[str, Any]:
        if is_cursor_id(cursor_id):
            return self.mongod.search_more(cursor_id, **options)
        return super().search_more(cursor_id, **options)

    def kill_cursor(self, cursor_id: str | int) -> dict[str, Any]:
        if is_cursor_id(cursor_id):
            return self.mongod.kill_cursor(cursor_id)
        return super().kill_cursor(cursor_id)

    def update_index(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "change its definition")
        return super().update_index(index_id, **options)

    def drop_index(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "drop it")
        return super().drop_index(index_id, **options)

    def export_mappings(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "export its observed mapping")
        return super().export_mappings(index_id, **options)

    def field_suggestions(self, index_id: str, **options: Any) -> dict[str, Any]:
        if is_index_id(index_id):
            return self.mongod.field_suggestions(index_id)
        return super().export_mappings(index_id, **options)

    def index_stats(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "read its storage statistics")
        return super().index_stats(index_id, **options)

    def field_stats(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "read its field statistics")
        return super().field_stats(index_id, **options)

    def upsert_documents(self, index_id: str, documents: list[dict[str, Any]], **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "write documents")
        return super().upsert_documents(index_id, documents, **options)

    def delete_document(self, index_id: str, document_id: Any, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "delete documents")
        return super().delete_document(index_id, document_id, **options)

    def delete_documents(self, index_id: str, document_ids: list[Any], **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "delete documents")
        return super().delete_documents(index_id, document_ids, **options)

    def delete_by_query(self, index_id: str, **options: Any) -> dict[str, Any]:
        _standalone_only(index_id, "delete documents")
        return super().delete_by_query(index_id, **options)
