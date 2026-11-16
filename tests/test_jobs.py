from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from mong.jobs import JobConflict, JobManager, export_document, ndjson_to_csv


class FakeService:
    def __init__(self, documents: int = 0) -> None:
        self.remaining = documents
        self.calls: list[dict[str, Any]] = []
        self.killed: list[str] = []
        self.gate: threading.Event | None = None

    def get_index(self, index_id: str) -> dict[str, Any]:
        return {"index_id": index_id, "name": "people", "type": "SEARCH"}

    def delete_by_query(self, index_id: str, **kwargs: Any) -> dict[str, Any]:
        if self.gate is not None:
            self.gate.wait(5)
        self.calls.append(kwargs)
        matched = min(self.remaining, kwargs["max_matches"])
        self.remaining -= matched
        return {"matched_count": matched, "processed_count": matched}

    def browse(self, index_id: str, *, batch_size: int) -> dict[str, Any]:
        return {"results": [{"_id": 1, "storedSource": {"_id": 1, "a": {"b": 2}}}], "cursor_id": "77"}

    def search(self, index_id: str, query: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
        return {"results": [{"_id": {"$oid": "65f0a1b2c3d4e5f601234567"}, "$searchScore": 1.0}], "cursor_id": None}

    def search_more(self, cursor_id: str, **kwargs: Any) -> dict[str, Any]:
        return {"results": [{"_id": 2, "storedSource": {"_id": 2, "tags": ["x"]}}], "cursor_id": None}

    def kill_cursor(self, cursor_id: str) -> dict[str, Any]:
        self.killed.append(cursor_id)
        return {}


def _wait(manager: JobManager, job_id: str) -> dict[str, Any]:
    deadline = time.time() + 5
    while time.time() < deadline:
        job = manager.get(job_id)
        assert job is not None
        if not job.active:
            return job.to_dict()
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_clear_index_loops_until_nothing_matches(tmp_path: Path) -> None:
    service = FakeService(documents=25_000)
    manager = JobManager(service, export_dir=tmp_path)
    job = manager.create("clear_index", "idx", {"estimate": 25_000})
    result = _wait(manager, job.id)
    assert result["state"] == "succeeded"
    assert result["done"] == 25_000
    assert [call["max_matches"] for call in service.calls] == [10_000, 10_000, 10_000, 10_000]
    assert all(call["match_all"] and not call["dry_run"] for call in service.calls)


def test_delete_by_query_respects_limit(tmp_path: Path) -> None:
    service = FakeService(documents=50_000)
    manager = JobManager(service, export_dir=tmp_path)
    job = manager.create("delete_by_query", "idx", {"query": {"text": {"query": "x", "path": "a"}}, "limit": 15_000})
    result = _wait(manager, job.id)
    assert result["done"] == 15_000
    assert [call["max_matches"] for call in service.calls] == [10_000, 5_000]
    assert service.calls[0]["match_all"] is False


def test_one_mutating_job_per_index(tmp_path: Path) -> None:
    service = FakeService(documents=10)
    service.gate = threading.Event()
    manager = JobManager(service, export_dir=tmp_path)
    first = manager.create("clear_index", "idx")
    with pytest.raises(JobConflict):
        manager.create("clear_index", "idx")
    manager.create("export", "idx")  # exports do not conflict
    service.gate.set()
    _wait(manager, first.id)


def test_cancel_stops_between_passes(tmp_path: Path) -> None:
    service = FakeService(documents=100_000)
    service.gate = threading.Event()
    manager = JobManager(service, export_dir=tmp_path)
    job = manager.create("clear_index", "idx")
    manager.cancel(job.id)
    service.gate.set()
    result = _wait(manager, job.id)
    assert result["state"] == "cancelled"
    assert len(service.calls) <= 1


def test_export_ndjson_follows_cursor(tmp_path: Path) -> None:
    manager = JobManager(FakeService(), export_dir=tmp_path)
    job = manager.create("export", "idx", {"format": "ndjson"})
    result = _wait(manager, job.id)
    assert result["state"] == "succeeded"
    assert result["downloadable"] is True
    lines = (tmp_path / f"{job.id}.ndjson").read_text(encoding="utf-8").splitlines()
    assert [json.loads(line) for line in lines] == [{"_id": 1, "a": {"b": 2}}, {"_id": 2, "tags": ["x"]}]


def test_export_csv_flattens_paths(tmp_path: Path) -> None:
    manager = JobManager(FakeService(), export_dir=tmp_path)
    job = manager.create("export", "idx", {"format": "csv"})
    _wait(manager, job.id)
    text = (tmp_path / f"{job.id}.csv").read_text(encoding="utf-8").splitlines()
    assert text[0] == "_id,a.b,tags"
    assert text[1] == "1,2,"
    assert text[2] == '2,,"[""x""]"'
    assert not (tmp_path / f"{job.id}.ndjson").exists()


def test_export_limit_kills_open_cursor(tmp_path: Path) -> None:
    service = FakeService()
    manager = JobManager(service, export_dir=tmp_path)
    job = manager.create("export", "idx", {"limit": 1})
    result = _wait(manager, job.id)
    assert result["done"] == 1
    assert service.killed == ["77"]


def test_export_document_strips_metadata() -> None:
    assert export_document({"_id": 1, "$searchScore": 2.0}) == {"_id": 1}
    assert export_document({"storedSource": {"x": 1}, "$searchScore": 1}) == {"x": 1}


def test_ndjson_to_csv_keeps_ejson_scalars(tmp_path: Path) -> None:
    source = tmp_path / "in.ndjson"
    source.write_text(
        json.dumps({"_id": {"$oid": "65f0a1b2c3d4e5f601234567"}, "when": {"$date": "2024-01-01T00:00:00Z"}}) + "\n",
        encoding="utf-8",
    )
    target = tmp_path / "out.csv"
    assert ndjson_to_csv(source, target) == 1
    assert target.read_text(encoding="utf-8").splitlines()[1] == "65f0a1b2c3d4e5f601234567,2024-01-01T00:00:00Z"


def test_validation_errors(tmp_path: Path) -> None:
    manager = JobManager(FakeService(), export_dir=tmp_path)
    with pytest.raises(ValueError):
        manager.create("nope", "idx")
    with pytest.raises(ValueError):
        manager.create("delete_by_query", "idx", {"query": "text"})
    with pytest.raises(ValueError):
        manager.create("export", "idx", {"format": "xml"})


def test_job_routes(monkeypatch, tmp_path: Path) -> None:
    from mong.web import api as web_api
    from mong.web.app import create_app

    manager = JobManager(FakeService(documents=3), export_dir=tmp_path)
    monkeypatch.setattr(web_api, "jobs", manager)
    client = create_app().test_client()

    created = client.post("/api/jobs", json={"kind": "export", "index_id": "idx", "format": "ndjson"})
    assert created.status_code == 202
    job_id = created.get_json()["id"]
    _wait(manager, job_id)
    assert client.get(f"/api/jobs/{job_id}").get_json()["state"] == "succeeded"
    assert client.get("/api/jobs").get_json()["jobs"][0]["id"] == job_id
    download = client.get(f"/api/jobs/{job_id}/download")
    assert download.status_code == 200
    assert "people-" in download.headers["Content-Disposition"]
    download.close()
    assert client.get("/api/jobs/missing").status_code == 404
    assert client.post("/api/jobs", json={"kind": "bad", "index_id": "idx"}).status_code == 400


def test_bulk_delete_route(monkeypatch) -> None:
    from mong.web import api as web_api
    from mong.web.app import create_app

    captured: dict[str, Any] = {}

    def fake_delete(index_id: str, ids: list[Any], **kwargs: Any) -> dict[str, Any]:
        captured.update(index_id=index_id, ids=ids, **kwargs)
        return {"index_id": index_id, "generation_id": "g", "processed_count": len(ids)}

    monkeypatch.setattr(web_api.service, "delete_documents", fake_delete)
    client = create_app().test_client()
    response = client.post("/api/indexes/idx/documents/delete", json={"ids": [1, {"$oid": "65f0a1b2c3d4e5f601234567"}]})
    assert response.status_code == 200
    assert response.get_json()["processed_count"] == 2
    assert captured["concern"] == "visible"
    assert client.post("/api/indexes/idx/documents/delete", json={"ids": []}).status_code == 400
