from __future__ import annotations

from typing import Any

import pytest
from bson.int64 import Int64
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError

from mong.mongod import MongodError, MongodSearch, index_id, merge_summary, parse_index_id
from mong.service import MongotService
from mong.sources import SearchService

URI = "mongodb://app:s3cret@db.example:27017/app?authSource=app"
ACCOUNTS = index_id("crm", "accounts", "accounts_search")


class FakeCursor:
    def __init__(self, documents: list[dict[str, Any]]) -> None:
        self._documents = [dict(document) for document in documents]
        self.closed = False
        self.batch_sizes: list[int] = []

    def __iter__(self) -> FakeCursor:
        return self

    def __next__(self) -> dict[str, Any]:
        if self.closed or not self._documents:
            raise StopIteration
        return self._documents.pop(0)

    @property
    def alive(self) -> bool:
        return bool(self._documents) and not self.closed

    def batch_size(self, size: int) -> FakeCursor:
        self.batch_sizes.append(size)
        return self

    def close(self) -> None:
        self.closed = True

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


class FakeCollection:
    def __init__(self, documents: list[dict[str, Any]] = (), search_indexes: list[dict[str, Any]] = ()) -> None:
        self.documents = list(documents)
        self.search_indexes = list(search_indexes)
        self.pipelines: list[tuple[list[dict[str, Any]], dict[str, Any]]] = []
        self.finds: list[tuple[dict[str, Any], int | None]] = []
        self.cursors: list[FakeCursor] = []
        self.meta: dict[str, Any] | None = None
        self.error: Exception | None = None

    def list_search_indexes(self, name: str | None = None) -> list[dict[str, Any]]:
        return [item for item in self.search_indexes if name is None or item["name"] == name]

    def estimated_document_count(self) -> int:
        return len(self.documents)

    def aggregate(self, pipeline: list[dict[str, Any]], **kwargs: Any) -> FakeCursor:
        if self.error is not None:
            raise self.error
        self.pipelines.append((pipeline, kwargs))
        if "$searchMeta" in pipeline[0]:
            return FakeCursor([self.meta] if self.meta else [])
        if "$sample" in pipeline[0]:
            cursor = FakeCursor(self.documents[:pipeline[0]["$sample"]["size"]])
            self.cursors.append(cursor)
            return cursor
        cursor = FakeCursor([{**document, "__mong_score": 1.5} for document in self.documents])
        self.cursors.append(cursor)
        return cursor

    def find(self, query: dict[str, Any], batch_size: int | None = None) -> FakeCursor:
        self.finds.append((query, batch_size))
        return FakeCursor(self.documents)


class FakeDatabase:
    def __init__(self, collections: dict[str, FakeCollection]) -> None:
        self.collections = collections
        self.commands: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
        self.explain: dict[str, Any] = {}

    def list_collections(self) -> list[dict[str, Any]]:
        return [{"name": name, "type": "collection"} for name in self.collections]

    def __getitem__(self, name: str) -> FakeCollection:
        return self.collections[name]

    def command(self, name: str, spec: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        self.commands.append((name, spec, kwargs))
        return self.explain


class FakeClient:
    def __init__(self, databases: dict[str, FakeDatabase]) -> None:
        self.databases = databases
        self.listings = 0
        self.error: Exception | None = None

    def list_database_names(self) -> list[str]:
        if self.error is not None:
            raise self.error
        self.listings += 1
        return list(self.databases)

    def __getitem__(self, name: str) -> FakeDatabase:
        return self.databases[name]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _raw(name: str, *, kind: str = "search", status: str = "READY", version: int = 0, active: int | None = None) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "id": f"id-{name}",
        "name": name,
        "type": kind,
        "status": status,
        "queryable": status == "READY",
        "latestDefinitionVersion": {"version": version},
        "latestDefinition": {"mappings": {"dynamic": True}, "storedSource": True},
    }
    if active is not None:
        raw["statusDetail"] = [{"mainIndex": {"definitionVersion": {"version": active}}}]
    return raw


def _accounts() -> FakeCollection:
    documents = [{"_id": f"a{number}", "name": f"Account {number}"} for number in range(3)]
    return FakeCollection(documents, [_raw("accounts_search")])


def _client(accounts: FakeCollection | None = None) -> FakeClient:
    return FakeClient(
        {
            "admin": FakeDatabase({"hidden": FakeCollection(search_indexes=[_raw("hidden")])}),
            "__mdb_internal_search": FakeDatabase({"indexCatalog": FakeCollection(search_indexes=[_raw("x")])}),
            "crm": FakeDatabase(
                {
                    "accounts": accounts or _accounts(),
                    "system.views": FakeCollection(search_indexes=[_raw("ignored")]),
                    "plain": FakeCollection([{"_id": 1}]),
                    "vectors": FakeCollection([{"_id": 1}], [_raw("embeddings", kind="vectorSearch", version=2, active=1)]),
                }
            ),
        }
    )


def _mongod(client: FakeClient, clock: Clock | None = None) -> MongodSearch:
    return MongodSearch(URI, connect=lambda _uri: client, clock=clock or Clock())


def test_index_ids_round_trip_names_with_separators() -> None:
    value = index_id("crm", "a:b/c", "my index%")
    assert value.startswith("mongod:") and "/" not in value
    assert parse_index_id(value) == ("crm", "a:b/c", "my index%")
    with pytest.raises(MongodError):
        parse_index_id("mongod:crm:accounts")


def test_snapshot_lists_search_indexes_outside_system_databases() -> None:
    client = _client()
    clock = Clock()
    mongod = _mongod(client, clock)

    state = mongod.snapshot()
    assert state["connected"] and state["error"] is None
    by_name = {index["name"]: index for index in state["indexes"]}
    assert sorted(by_name) == ["crm.accounts/accounts_search", "crm.vectors/embeddings"]
    accounts = by_name["crm.accounts/accounts_search"]
    assert accounts["index_id"] == ACCOUNTS
    assert accounts["source"] == "mongod"
    assert (accounts["database"], accounts["collection"], accounts["index_name"]) == ("crm", "accounts", "accounts_search")
    assert accounts["type"] == "SEARCH"
    assert accounts["stats"]["documents"] == 3
    assert accounts["definition"] == {"mappings": {"dynamic": True}, "storedSource": True}
    vectors = by_name["crm.vectors/embeddings"]
    assert vectors["type"] == "VECTOR_SEARCH"
    assert (vectors["desired_revision"], vectors["active_revision"]) == (2, 1)

    mongod.snapshot()
    assert client.listings == 1
    mongod.snapshot(refresh=True)
    clock.now += 60
    mongod.snapshot()
    assert client.listings == 3


def test_disabled_without_a_uri(monkeypatch) -> None:
    monkeypatch.delenv("MONGODB_URI", raising=False)

    def refuse(_uri: str) -> Any:
        raise AssertionError("no connection without MONGODB_URI")

    mongod = MongodSearch(connect=refuse)
    assert mongod.snapshot() == {"enabled": False, "connected": False, "error": None, "indexes": []}
    with pytest.raises(MongodError) as exc:
        mongod.search(ACCOUNTS, {"exists": {"path": "_id"}})
    assert exc.value.code == "MONGOD_DISABLED"


def test_outage_keeps_the_last_indexes_and_hides_the_password() -> None:
    client = _client()
    mongod = _mongod(client)
    known = mongod.snapshot()["indexes"]

    client.error = ServerSelectionTimeoutError(f"db.example:27017: timed out, Timeout: 3.0s, Topology Description: {URI}")
    state = mongod.snapshot(refresh=True)
    assert not state["connected"]
    assert state["error"].startswith("MongoDB is unreachable: db.example:27017: timed out")
    assert "s3cret" not in state["error"]
    assert state["indexes"] == known


def test_search_pages_through_a_kept_cursor() -> None:
    accounts = _accounts()
    mongod = _mongod(_client(accounts))

    first = mongod.search(
        ACCOUNTS,
        {"index": "crm.accounts/accounts_search", "text": {"path": "name", "query": "account"}},
        batch_size=2,
    )
    pipeline, options = accounts.pipelines[0]
    assert pipeline[0] == {"$search": {"text": {"path": "name", "query": "account"}, "index": "accounts_search"}}
    assert options == {"batchSize": 2}
    assert [hit["_id"] for hit in first["results"]] == ["a0", "a1"]
    assert first["results"][0] == {"$searchScore": 1.5, "_id": "a0", "name": "Account 0"}
    assert first["has_more"] and first["cursor_id"].startswith("mongod-")

    second = mongod.search_more(first["cursor_id"], batch_size=5, page=2)
    assert [hit["_id"] for hit in second["results"]] == ["a2"]
    assert second["index_id"] == ACCOUNTS and second["page"] == 2
    assert not second["has_more"] and second["cursor_id"] is None
    assert accounts.cursors[0].batch_sizes == [5] and accounts.cursors[0].closed

    with pytest.raises(MongodError) as exc:
        mongod.search_more(first["cursor_id"])
    assert exc.value.status == 404


def test_kill_cursor_closes_it() -> None:
    accounts = _accounts()
    mongod = _mongod(_client(accounts))
    page = mongod.search(ACCOUNTS, {"exists": {"path": "_id"}}, batch_size=1)
    assert mongod.kill_cursor(page["cursor_id"]) == {"cursor_id": page["cursor_id"], "killed": True}
    assert accounts.cursors[0].closed


def test_count_runs_search_meta_without_hit_options() -> None:
    accounts = _accounts()
    accounts.meta = {"count": {"total": Int64(3)}}
    mongod = _mongod(_client(accounts))

    page = mongod.search(
        ACCOUNTS,
        {
            "text": {"path": "name", "query": "account"},
            "count": {"type": "total"},
            "returnStoredSource": True,
            "highlight": {"path": "name"},
        },
    )
    assert page["metadata"] == {"count": {"total": 3}}
    meta_pipeline = next(pipeline for pipeline, _ in accounts.pipelines if "$searchMeta" in pipeline[0])
    assert meta_pipeline == [
        {"$searchMeta": {"text": {"path": "name", "query": "account"}, "count": {"type": "total"}, "index": "accounts_search"}}
    ]
    search_pipeline = next(pipeline for pipeline, _ in accounts.pipelines if "$search" in pipeline[0])
    assert search_pipeline[1]["$addFields"]["__mong_highlights"] == {"$meta": "searchHighlights"}


def test_vector_queries_use_vector_search_and_its_score() -> None:
    accounts = _accounts()
    mongod = _mongod(_client(accounts))
    page = mongod.search(
        ACCOUNTS,
        {"path": "embedding", "queryVector": [0.1, 0.2], "numCandidates": 10, "limit": 2, "count": {"type": "total"}},
        vector=True,
    )
    assert len(accounts.pipelines) == 1
    stage = accounts.pipelines[0][0][0]["$vectorSearch"]
    assert stage["index"] == "accounts_search" and stage["limit"] == 2
    assert page["results"][0]["$vectorSearchScore"] == 1.5
    assert page["metadata"] is None


def test_explain_returns_the_mongot_plan_with_mongod_stages() -> None:
    accounts = _accounts()
    client = _client(accounts)
    client["crm"].explain = {
        "stages": [
            {
                "$_internalSearchMongotRemote": {"mongotQuery": {}, "explain": {"query": {"type": "TermQuery"}}},
                "nReturned": Int64(2),
            },
            {"$_internalSearchIdLookup": {"totalDocsExamined": Int64(2)}},
        ],
        "serverInfo": {"host": "db"},
        "ok": 1.0,
    }
    mongod = _mongod(client)

    page = mongod.search(ACCOUNTS, {"exists": {"path": "_id"}}, explain="query_planner")
    assert page["explain_verbosity"] == "query_planner"
    assert page["explain"]["query"] == {"type": "TermQuery"}
    stages = page["explain"]["mongod"]["stages"]
    assert stages[0] == {"$_internalSearchMongotRemote": {"mongotQuery": {}}, "nReturned": 2}
    assert "serverInfo" not in page["explain"]["mongod"]
    assert page["results"] == [] and not accounts.pipelines
    name, spec, options = client["crm"].commands[0]
    assert (name, spec["aggregate"], options) == ("explain", "accounts", {"verbosity": "queryPlanner"})

    executed = mongod.search(ACCOUNTS, {"exists": {"path": "_id"}}, explain="execution_stats")
    assert executed["count"] == 3 and executed["explain"]["query"] == {"type": "TermQuery"}


def test_browse_reads_the_collection() -> None:
    accounts = _accounts()
    mongod = _mongod(_client(accounts))
    page = mongod.browse(ACCOUNTS, batch_size=2, count=True)
    assert accounts.finds == [({}, 2)] and not accounts.pipelines
    assert page["metadata"] == {"count": {"total": 3}}
    assert page["results"] == [{"_id": "a0", "name": "Account 0"}, {"_id": "a1", "name": "Account 1"}]
    assert page["has_more"]


def test_query_errors_are_bad_requests() -> None:
    accounts = _accounts()
    accounts.error = OperationFailure("failed", code=8, details={"errmsg": "unknown operator textt"})
    mongod = _mongod(_client(accounts))
    with pytest.raises(MongodError) as exc:
        mongod.search(ACCOUNTS, {"textt": {}})
    assert (exc.value.status, str(exc.value)) == (400, "unknown operator textt")


def test_search_service_reads_mongod_ids_and_refuses_writes(monkeypatch) -> None:
    service = SearchService(mongod=_mongod(_client()))
    monkeypatch.setattr(MongotService, "search", lambda self, index_id, query, **kwargs: {"standalone": index_id})

    assert service.search("abc123", {"exists": {"path": "_id"}}) == {"standalone": "abc123"}
    page = service.search(ACCOUNTS, {"exists": {"path": "_id"}}, batch_size=1)
    assert page["results"][0]["_id"] == "a0"
    assert service.search_more(page["cursor_id"], batch_size=5)["count"] == 2
    assert service.get_index(ACCOUNTS)["name"] == "crm.accounts/accounts_search"

    for call in (
        lambda: service.update_index(ACCOUNTS, definition={}, expected_revision=0),
        lambda: service.drop_index(ACCOUNTS, expected_revision=0),
        lambda: service.upsert_documents(ACCOUNTS, [{"_id": 1}]),
        lambda: service.delete_by_query(ACCOUNTS, match_all=True),
        lambda: service.index_stats(ACCOUNTS),
    ):
        with pytest.raises(MongodError) as exc:
            call()
        assert exc.value.code == "READ_ONLY"
        assert "crm.accounts/accounts_search is managed by MongoDB" in str(exc.value)


def test_merge_summary_adds_indexes_and_sorts_alerts() -> None:
    standalone = {"index_id": "s1", "name": "people", "metrics": {"documents": 5}}
    summary = {"connected": True, "indexes": [standalone], "alerts": [{"id": "x", "severity": "info"}]}
    failed = _mongod(_client()).snapshot()["indexes"][0] | {"lifecycle_state": "FAILED", "failure_message": "bad mapping"}
    state = {"enabled": True, "connected": True, "error": None, "indexes": [failed]}

    merged = merge_summary(summary, state)
    assert [index["name"] for index in merged["indexes"]] == ["people", "crm.accounts/accounts_search"]
    assert merged["indexes"][1]["metrics"] == {"documents": 3, "status_label": None}
    assert [alert["severity"] for alert in merged["alerts"]] == ["error", "info"]
    assert merged["alerts"][0]["detail"] == "bad mapping"
    assert merged["mongod"] == {"enabled": True, "connected": True, "error": None}


def test_api_lists_and_guards_mongod_indexes(monkeypatch) -> None:
    from mong.web import api as web_api
    from mong.web.app import create_app

    monkeypatch.setattr(web_api.service, "mongod", _mongod(_client()))
    monkeypatch.setattr(web_api.sampler, "ensure_started", lambda: None)
    monkeypatch.setattr(web_api.sampler, "summary", lambda: {"connected": True, "indexes": [], "alerts": []})
    client = create_app().test_client()
    host = {"Host": "127.0.0.1:5050"}

    summary = client.get("/api/metrics/summary", headers=host).get_json()
    assert {index["source"] for index in summary["indexes"]} == {"mongod"}
    assert summary["mongod"]["connected"] is True

    write = client.post(f"/api/indexes/{ACCOUNTS}/documents", json={"documents": [{"_id": 1}]}, headers=host)
    assert write.status_code == 400 and write.get_json()["code"] == "READ_ONLY"
    browse = client.post(f"/api/indexes/{ACCOUNTS}/browse", json={"batch_size": 2, "count": True}, headers=host)
    assert browse.status_code == 200 and browse.get_json()["metadata"] == {"count": {"total": 3}}

    suggestions = client.get(f"/api/indexes/{ACCOUNTS}/field-suggestions", headers=host)
    assert suggestions.status_code == 200
    assert suggestions.get_json() == {
        "source": "sampled", "sample_size": 3,
        "mappings": {"dynamic": True, "fields": {"_id": [{"type": "string"}], "name": [{"type": "string"}]}},
    }
    assert client.get(f"/api/indexes/{ACCOUNTS}/mappings", headers=host).get_json()["code"] == "READ_ONLY"


def test_field_suggestions_bound_sampling_and_close_cursor() -> None:
    accounts = _accounts()
    accounts.documents = [{"name": "Example"}] * 150
    result = _mongod(_client(accounts)).field_suggestions(ACCOUNTS)
    assert result["sample_size"] == 100
    assert accounts.pipelines == [([{"$sample": {"size": 100}}], {"maxTimeMS": 2000})]
    assert accounts.cursors[0].closed
    assert "Example" not in str(result)


def test_static_and_vector_indexes_do_not_sample() -> None:
    accounts = _accounts()
    accounts.search_indexes[0]["latestDefinition"] = {"mappings": {"fields": {"name": {"type": "string"}}}}
    client = _client(accounts)
    mongod = _mongod(client)
    assert mongod.field_suggestions(ACCOUNTS)["sample_size"] == 0
    assert mongod.field_suggestions(index_id("crm", "vectors", "embeddings"))["sample_size"] == 0
    assert not accounts.pipelines and not client["crm"]["vectors"].pipelines


def test_field_suggestion_failure_is_reported() -> None:
    accounts = _accounts()
    accounts.error = OperationFailure("sample timed out", code=50)
    with pytest.raises(MongodError, match="sample timed out"):
        _mongod(_client(accounts)).field_suggestions(ACCOUNTS)
