from mong.web.app import create_app


def test_health_endpoint() -> None:
    app = create_app()
    client = app.test_client()
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json()["ok"] is True


def test_javascript_modules_use_a_javascript_mime_type() -> None:
    app = create_app()
    client = app.test_client()
    response = client.get("/static/js/query-editor/index.js")
    assert response.status_code == 200
    assert response.mimetype == "text/javascript"


def test_legacy_page_served() -> None:
    app = create_app()
    client = app.test_client()
    response = client.get("/legacy/")
    assert response.status_code == 200
    assert b"Mong Admin" in response.data
    assert b"mong-query-editor" in response.data


def test_root_serves_build_or_explains_how_to_build(monkeypatch, tmp_path) -> None:
    from mong.web import app as web_app

    monkeypatch.setattr(web_app, "DIST_DIR", tmp_path)
    client = web_app.create_app().test_client()
    missing = client.get("/")
    assert missing.status_code == 503
    assert b"npm run build" in missing.data

    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<mong-app></mong-app>", encoding="utf-8")
    (tmp_path / "assets" / "app.js").write_text("export {};", encoding="utf-8")
    client = web_app.create_app().test_client()
    assert b"mong-app" in client.get("/").data
    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert asset.mimetype == "text/javascript"


def test_guard_rejects_foreign_host_header() -> None:
    client = create_app().test_client()
    assert client.get("/api/health", headers={"Host": "evil.example:5050"}).status_code == 403
    assert client.get("/api/health", headers={"Host": "127.0.0.1:5050"}).status_code == 200
    assert client.get("/api/health", headers={"Host": "[::1]:5050"}).status_code == 200


def test_guard_allows_extra_hosts_from_env(monkeypatch) -> None:
    monkeypatch.setenv("MONG_ALLOWED_HOSTS", "mong.internal")
    client = create_app().test_client()
    assert client.get("/api/health", headers={"Host": "mong.internal:5050"}).status_code == 200


def test_guard_rejects_cross_origin_writes(monkeypatch) -> None:
    from mong.web import api as web_api

    monkeypatch.setattr(web_api.service, "drop_index", lambda index_id, **kwargs: {"index_id": index_id})
    client = create_app().test_client()
    host = {"Host": "127.0.0.1:5050"}
    body = {"expected_revision": 3}

    evil = client.delete("/api/indexes/idx-1", json=body, headers={**host, "Origin": "https://evil.example"})
    assert evil.status_code == 403
    opaque = client.delete("/api/indexes/idx-1", json=body, headers={**host, "Origin": "null"})
    assert opaque.status_code == 403
    cross = client.delete("/api/indexes/idx-1", json=body, headers={**host, "Sec-Fetch-Site": "cross-site"})
    assert cross.status_code == 403
    same = client.delete("/api/indexes/idx-1", json=body, headers={**host, "Origin": "http://127.0.0.1:5050"})
    assert same.status_code == 200
    scripted = client.delete("/api/indexes/idx-1", json=body, headers=host)
    assert scripted.status_code == 200
    reads = client.get("/api/health", headers={**host, "Origin": "https://evil.example"})
    assert reads.status_code == 200


def test_update_and_drop_require_expected_revision(monkeypatch) -> None:
    from mong.web import api as web_api

    calls = {}

    def fake_update(index_id, **kwargs):
        calls["update"] = kwargs
        return {"index_id": index_id}

    def fake_drop(index_id, **kwargs):
        calls["drop"] = kwargs
        return {"index_id": index_id}

    monkeypatch.setattr(web_api.service, "update_index", fake_update)
    monkeypatch.setattr(web_api.service, "drop_index", fake_drop)
    client = create_app().test_client()

    assert client.put("/api/indexes/idx-1", json={"definition": {}}).status_code == 400
    assert client.delete("/api/indexes/idx-1", json={}).status_code == 400
    assert client.delete("/api/indexes/idx-1", json={"expected_revision": True}).status_code == 400
    assert "update" not in calls and "drop" not in calls

    assert client.put("/api/indexes/idx-1", json={"definition": {}, "expected_revision": "4"}).status_code == 200
    assert calls["update"]["expected_revision"] == 4
    assert client.delete("/api/indexes/idx-1", json={"expected_revision": 4}).status_code == 200
    assert calls["drop"]["expected_revision"] == 4


def test_rpc_errors_map_to_http_status(monkeypatch) -> None:
    import grpc

    from mong.web import api as web_api

    class _Conflict(grpc.RpcError):
        def code(self):
            return grpc.StatusCode.FAILED_PRECONDITION

        def details(self):
            return "revision mismatch"

    def fake_update(index_id, **kwargs):
        raise _Conflict()

    monkeypatch.setattr(web_api.service, "update_index", fake_update)
    response = create_app().test_client().put(
        "/api/indexes/idx-1", json={"definition": {}, "expected_revision": 1}
    )
    assert response.status_code == 409
    assert response.get_json() == {"error": "revision mismatch", "code": "FAILED_PRECONDITION"}


def test_search_strips_editor_index_key(monkeypatch) -> None:
    seen = {}

    def fake_encode(document):
        seen["query"] = document
        return b""

    class _Response:
        batch_bson = b""
        metadata_bson = b""
        cursor_id = 0
        generation_id = ""

    class _Client:
        def search(self, request):
            return _Response()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.encode_bson", fake_encode)
    monkeypatch.setattr("mong.service.create_client", lambda: _Client())

    from mong.service import MongotService

    query = {"index": "accounts_search", "text": {"path": "title", "query": "coffee"}}
    MongotService().search("idx-1", query)

    assert query["index"] == "accounts_search"
    assert "index" not in seen["query"]
    assert seen["query"]["text"]["path"] == "title"


def test_search_reports_round_trip_latency(monkeypatch) -> None:
    class _Response:
        batch_bson = b""
        metadata_bson = b""
        cursor_id = 0
        generation_id = ""

    class _Client:
        def search(self, request):
            return _Response()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.encode_bson", lambda document: b"")
    monkeypatch.setattr("mong.service.create_client", lambda: _Client())

    from mong.service import MongotService

    result = MongotService().search("idx-1", {"text": {"path": "title", "query": "coffee"}})

    assert isinstance(result["latency_ms"], float)
    assert result["latency_ms"] >= 0


def test_field_stats_polls_without_repeating_refresh(monkeypatch) -> None:
    from mongot_standalone import api

    requests = []
    states = [api.STATS_COLLECTION_STATE_COLLECTING, api.STATS_COLLECTION_STATE_READY]

    class _Client:
        def get_index_field_stats(self, request):
            copy = api.GetIndexFieldStatsRequest()
            copy.CopyFrom(request)
            requests.append(copy)
            return api.IndexFieldStatsResponse(state=states[len(requests) - 1], retry_after_millis=1)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.create_client", lambda: _Client())
    monkeypatch.setattr("mong.service.time.sleep", lambda _seconds: None)

    from mong.service import MongotService

    result = MongotService().field_stats("idx-1", refresh=True, paths=["title"], page_size=5000)
    assert result["state"] == "READY"
    assert [r.refresh for r in requests] == [True, False]
    assert list(requests[0].paths) == ["title"]
    assert requests[0].page_size == 500


def test_field_stats_never_refreshes_later_pages(monkeypatch) -> None:
    from mongot_standalone import api

    seen = {}

    class _Client:
        def get_index_field_stats(self, request):
            seen["refresh"] = request.refresh
            seen["token"] = request.page_token
            return api.IndexFieldStatsResponse(state=api.STATS_COLLECTION_STATE_READY)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.create_client", lambda: _Client())

    from mong.service import MongotService

    MongotService().field_stats("idx-1", refresh=True, page_token="tok")
    assert seen == {"refresh": False, "token": "tok"}


def test_search_route_serializes_object_ids_and_decimals(monkeypatch) -> None:
    from bson import Decimal128, ObjectId
    from mongot_standalone import encode_bson

    oid = ObjectId("65a1b2c3d4e5f60718293a4b")

    class _Response:
        batch_bson = encode_bson(
            {"results": [{"$searchScore": 1.0, "storedSource": {"_id": oid, "price": Decimal128("2.50")}}]}
        )
        metadata_bson = b""
        explain_bson = b""
        cursor_id = 0
        generation_id = "gen"

    class _Client:
        def search(self, request):
            return _Response()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.create_client", lambda: _Client())
    client = create_app().test_client()
    response = client.post("/api/indexes/idx-1/search", json={"query": {"exists": {"path": "_id"}}})

    assert response.status_code == 200
    doc = response.get_json()["results"][0]["storedSource"]
    assert doc == {"_id": {"$oid": str(oid)}, "price": {"$numberDecimal": "2.50"}}


def test_stats_routes_pass_query_args(monkeypatch) -> None:
    from mong.web import api as web_api

    calls = {}

    def fake_index_stats(index_id, **kwargs):
        calls["stats"] = (index_id, kwargs)
        return {"index_id": index_id}

    def fake_field_stats(index_id, **kwargs):
        calls["fields"] = (index_id, kwargs)
        return {"state": "READY", "fields": []}

    def fake_export(index_id, **kwargs):
        calls["mappings"] = (index_id, kwargs)
        return {"definition": {"mappings": {"dynamic": False}}}

    monkeypatch.setattr(web_api.service, "index_stats", fake_index_stats)
    monkeypatch.setattr(web_api.service, "field_stats", fake_field_stats)
    monkeypatch.setattr(web_api.service, "export_mappings", fake_export)
    client = create_app().test_client()

    assert client.get("/api/indexes/idx-1/stats?refresh=true").status_code == 200
    assert calls["stats"] == ("idx-1", {"refresh": True, "generation_id": ""})

    response = client.get("/api/indexes/idx-1/field-stats?path=a&path=b&page_size=7&page_token=t")
    assert response.status_code == 200
    assert calls["fields"] == (
        "idx-1",
        {"refresh": False, "paths": ["a", "b"], "page_size": 7, "page_token": "t", "generation_id": ""},
    )

    response = client.get("/api/indexes/idx-1/mappings?generation_id=g")
    assert response.get_json()["definition"]["mappings"]["dynamic"] is False
    assert calls["mappings"] == ("idx-1", {"generation_id": "g"})


def test_search_forwards_explain_and_decodes_plan(monkeypatch) -> None:
    from mongot_standalone import api, encode_bson

    seen = {}

    class _Response:
        batch_bson = encode_bson({"results": []})
        metadata_bson = b""
        explain_bson = encode_bson({"query": {"type": "TermQuery"}})
        cursor_id = 0
        generation_id = "gen"

    class _Client:
        def search(self, request):
            seen["verbosity"] = request.explain_verbosity
            return _Response()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.create_client", lambda: _Client())

    from mong.service import MongotService

    result = MongotService().search(
        "idx-1",
        {"text": {"path": "title", "query": "coffee"}},
        explain="executionStats",
    )

    assert seen["verbosity"] == api.EXPLAIN_VERBOSITY_EXECUTION_STATS
    assert result["explain"]["query"]["type"] == "TermQuery"
    assert result["explain_verbosity"] == "execution_stats"
    assert result["count"] == 0


def test_delete_by_query_strips_editor_index_and_stays_a_dry_run(monkeypatch) -> None:
    seen = {}

    class _Response:
        index_id = "idx-1"
        generation_id = "gen"
        active_revision = 4
        matched_count = 2
        processed_count = 0
        dry_run = True

    class _Index:
        def delete_by_query(self, predicate, **kwargs):
            seen["predicate"] = predicate
            seen["kwargs"] = kwargs
            return _Response()

    class _Client:
        def index(self, index_id):
            seen["index_id"] = index_id
            return _Index()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("mong.service.create_client", lambda: _Client())

    from mong.service import MongotService

    result = MongotService().delete_by_query(
        "idx-1",
        query={"index": "articles", "text": {"path": "title", "query": "coffee"}},
        dry_run=True,
        max_matches=25,
    )

    assert seen["index_id"] == "idx-1"
    assert "index" not in seen["predicate"]
    assert seen["predicate"]["text"]["query"] == "coffee"
    assert seen["kwargs"]["vector"] is False
    assert seen["kwargs"]["match_all"] is False
    assert seen["kwargs"]["dry_run"] is True
    assert seen["kwargs"]["max_matches"] == 25
    assert result["matched_count"] == 2
    assert result["processed_count"] == 0
    assert result["dry_run"] is True


def test_delete_by_query_route_defaults_to_dry_run(monkeypatch) -> None:
    from mong.web import api as web_api

    calls = {}

    def fake_delete(index_id, **kwargs):
        calls["args"] = (index_id, kwargs)
        return {"matched_count": 1, "processed_count": 0, "dry_run": True}

    monkeypatch.setattr(web_api.service, "delete_by_query", fake_delete)
    client = create_app().test_client()
    response = client.post(
        "/api/indexes/idx-1/delete-by-query",
        json={"query": {"text": {"path": "title", "query": "coffee"}}},
    )

    assert response.status_code == 200
    assert calls["args"][0] == "idx-1"
    assert calls["args"][1]["dry_run"] is True
    assert calls["args"][1]["match_all"] is False
    assert calls["args"][1]["vector"] is False
    assert response.get_json()["matched_count"] == 1

    rejected = client.post(
        "/api/indexes/idx-1/search",
        json={"query": {"exists": {"path": "_id"}}, "explain": 1},
    )
    assert rejected.status_code == 400
