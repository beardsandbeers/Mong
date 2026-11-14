from mong.service import MongotService


def test_browse_always_requests_stored_source(monkeypatch):
    captured = {}

    def fake_search(self, index_id, query, **kwargs):
        captured["index_id"] = index_id
        captured["query"] = query
        captured["kwargs"] = kwargs
        return {"results": []}

    monkeypatch.setattr(MongotService, "search", fake_search)
    MongotService().browse("idx-1", batch_size=10)

    assert captured["index_id"] == "idx-1"
    assert captured["query"] == {
        "exists": {"path": "_id"},
        "returnStoredSource": True,
    }
    assert captured["kwargs"]["vector"] is False


def test_browse_keeps_custom_query_and_forces_stored_source(monkeypatch):
    captured = {}
    supplied = {"text": {"path": "title", "query": "coffee"}, "returnStoredSource": False}

    def fake_search(self, index_id, query, **kwargs):
        captured["query"] = query
        return {"results": []}

    monkeypatch.setattr(MongotService, "search", fake_search)
    MongotService().browse("idx-1", query=supplied)

    assert supplied["returnStoredSource"] is False
    assert captured["query"]["text"] == supplied["text"]
    assert captured["query"]["returnStoredSource"] is True
