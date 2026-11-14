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


def test_index_page_served() -> None:
    app = create_app()
    client = app.test_client()
    response = client.get("/")
    assert response.status_code == 200
    assert b"Mong Admin" in response.data
    assert b"mong-query-editor" in response.data


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
