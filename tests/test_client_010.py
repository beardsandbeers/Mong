"""mongot-standalone-client 0.10 fields: replicated indexes, joins, and update mode."""

from __future__ import annotations

from mongot_standalone import api, encode_bson

from mong.serialize import index_to_dict
from mong.service import join_bindings, list_index_pages, query_has_join, update_mode

import pytest


def test_replicated_index_exposes_its_namespace() -> None:
    index = api.IndexDescription(
        index_id="idx",
        name="accounts_search",
        type=api.INDEX_TYPE_SEARCH,
        desired_revision=2,
        active_revision=1,
        lifecycle_state="READY",
        ownership=api.INDEX_OWNERSHIP_REPLICATED,
        queryable=True,
        namespace=api.IndexNamespace(database="crm", collection_name="accounts"),
        read_capabilities=["search"],
        source_status="STEADY",
        desired_definition_bson=encode_bson({"mappings": {"dynamic": True}}),
    )
    data = index_to_dict(index)
    assert data["ownership"] == "replicated"
    assert data["namespace"] == {
        "database": "crm",
        "collection": "accounts",
        "collection_uuid": None,
        "view": None,
    }
    assert data["queryable"] is True
    assert data["read_capabilities"] == ["search"]
    assert data["source_status"] == "STEADY"
    assert data["source"] == "mongot"


def test_list_pages_and_falls_back_without_the_read_contract() -> None:
    class Pages:
        def list_indexes(self, request):
            if request.page_token == "next":
                return type("R", (), {"indexes": ["b"], "next_page_token": ""})()
            return type("R", (), {"indexes": ["a"], "next_page_token": "next"})()

    assert list_index_pages(Pages()) == ["a", "b"]

    class Old:
        def __init__(self) -> None:
            self.calls = []

        def list_indexes(self, request):
            self.calls.append(request.page_size)
            if request.page_size:
                raise RuntimeError("Server does not support the all-index direct read contract")
            return type("R", (), {"indexes": ["one"]})()

    old = Old()
    assert list_index_pages(old) == ["one"]
    assert old.calls == [200, 0]


def test_join_bindings_use_a_unique_index_name() -> None:
    query = {"compound": {"filter": [{"join": {"from": "accounts_search", "operator": {}}}, {"join": {"from": "shared"}}]}}
    indexes = [
        {"name": "accounts_search", "index_id": "idx-a"},
        {"name": "shared", "index_id": "idx-1"},
        {"name": "shared", "index_id": "idx-2"},
    ]
    bindings = join_bindings(query, indexes)
    assert [(item.alias, item.index_id) for item in bindings] == [("accounts_search", "idx-a")]
    assert query_has_join(query) is True
    assert query_has_join({"text": {"path": "title", "query": "x"}}) is False


def test_update_mode_names() -> None:
    assert update_mode("preserve") == api.INDEX_UPDATE_MODE_REQUIRE_PRESERVE
    assert update_mode("rebuild") == api.INDEX_UPDATE_MODE_REBUILD_EMPTY
    assert update_mode(None) == api.INDEX_UPDATE_MODE_AUTO
    with pytest.raises(ValueError):
        update_mode("wipe")
