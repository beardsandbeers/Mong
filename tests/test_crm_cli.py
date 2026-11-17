"""CLI routing between the mongot and mongod loaders. Nothing here connects."""

from __future__ import annotations

import json
import pickle
from typing import Any

import pytest

from scripts.crm.cli import main
from scripts.crm.load import IngestFailed
from scripts.crm.targets import MongodTarget, MongotTarget, Prepared, open_target
from scripts.ingest.mongod import DEFAULT_DATABASE, DEFAULT_MONGO_URI


class _Service:
    def __init__(self) -> None:
        self.indexes: list[dict[str, Any]] = []

    def list_indexes(self) -> list[dict[str, Any]]:
        return list(self.indexes)

    def create_index(
        self,
        *,
        name: str,
        index_type: str = "SEARCH",
        definition: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        index = {
            "index_id": f"idx-{len(self.indexes) + 1}",
            "name": name,
            "type": index_type.upper(),
            "definition": definition,
        }
        self.indexes.append(index)
        return index

    def update_index(self, index_id: str, *, definition: dict[str, Any]) -> dict[str, Any]:
        index = next(item for item in self.indexes if item["index_id"] == index_id)
        index["definition"] = definition
        return index


class _Admin:
    def command(self, name: str) -> dict[str, int]:
        assert name == "ping"
        return {"ok": 1}


class _Collection:
    def __init__(self) -> None:
        self.indexes: list[Any] = []
        self.search_indexes: list[dict[str, Any]] = []

    def create_index(self, keys: Any, name: str) -> str:
        self.indexes.append((keys, name))
        return name

    def list_search_indexes(self, name: str | None = None) -> list[dict[str, Any]]:
        if name is None:
            return list(self.search_indexes)
        return [index for index in self.search_indexes if index.get("name") == name]

    def create_search_index(self, model: dict[str, Any]) -> str:
        self.search_indexes.append(
            {
                "id": f"si-{len(self.search_indexes) + 1}",
                "name": model["name"],
                "latestDefinition": model["definition"],
            }
        )
        return model["name"]

    def update_search_index(self, name: str, definition: dict[str, Any]) -> None:
        for index in self.search_indexes:
            if index["name"] == name:
                index["latestDefinition"] = definition


class _Database:
    def __init__(self) -> None:
        self.names: list[str] = []
        self.cols: dict[str, _Collection] = {}

    def list_collection_names(self) -> list[str]:
        return list(self.names)

    def create_collection(self, name: str) -> _Collection:
        self.names.append(name)
        return self[name]

    def __getitem__(self, name: str) -> _Collection:
        if name not in self.cols:
            self.cols[name] = _Collection()
        return self.cols[name]


class _Mongo:
    def __init__(self) -> None:
        self.admin = _Admin()
        self.dbs: dict[str, _Database] = {}
        self.closed = False

    def __getitem__(self, name: str) -> _Database:
        return self.dbs.setdefault(name, _Database())

    def close(self) -> None:
        self.closed = True


def _block_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("network")

    monkeypatch.setattr("scripts.ingest.mongod.connect", fail)
    monkeypatch.setattr("mong.client.create_client", fail)


def test_mongot_target_prepares_one_index_per_entity() -> None:
    service = _Service()
    lines: list[str] = []
    prepared = MongotTarget(index_suffix="_search").prepare(
        ("accounts", "contacts"),
        log=lines.append,
        service=service,
    )
    assert prepared.ids["accounts"] == "idx-1"
    assert prepared.details["contacts"]["index_name"] == "contacts_search"
    assert prepared.details["contacts"]["index_action"] == "created"
    assert "account_id" in service.indexes[1]["definition"]["mappings"]["fields"]
    assert any("contacts_search: index idx-2 (created)" == line for line in lines)

    again = MongotTarget().prepare(("contacts",), log=lines.append, service=service)
    assert again.details["contacts"]["index_action"] == "existing"
    assert len(service.indexes) == 2


def test_mongod_target_prepares_collections_without_connecting() -> None:
    client = _Mongo()
    lines: list[str] = []
    target = MongodTarget(uri="mongodb://127.0.0.1:27017", database="crm")
    prepared = target.prepare(("accounts", "contacts"), log=lines.append, client=client)
    assert prepared.ids == {"accounts": "accounts", "contacts": "contacts"}
    assert prepared.details["contacts"]["action"] == "created"
    assert prepared.details["contacts"]["indexes"] == ["tenant_id", "account_id", "opportunity_ids"]
    assert prepared.details["accounts"]["indexes"] == ["tenant_id"]
    assert prepared.details["contacts"]["search_index"] == "contacts_search"
    assert prepared.details["contacts"]["search_index_action"] == "created"
    assert prepared.details["contacts"]["search_index_id"] == "si-1"
    assert client.closed is False
    assert any(
        line == "crm.contacts: collection (created; indexes tenant_id, account_id, opportunity_ids)" for line in lines
    )
    assert any(line == "contacts_search: search index (created)" for line in lines)

    second = target.prepare(("contacts",), log=lines.append, client=client)
    assert second.details["contacts"]["action"] == "existing"
    assert second.details["contacts"]["search_index_action"] == "existing"


def test_open_target_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MONGODB_URI", raising=False)
    mongot = open_target("mongot")
    assert isinstance(mongot, MongotTarget)
    assert mongot.index_suffix == "_search"
    mongod = open_target("mongod")
    assert isinstance(mongod, MongodTarget)
    assert mongod.database == DEFAULT_DATABASE
    assert mongod.uri == DEFAULT_MONGO_URI
    assert mongod.index_suffix == "_search"
    assert open_target("mongod", index_suffix="_idx").index_suffix == "_idx"
    with pytest.raises(ValueError, match="invalid database name"):
        open_target("mongod", database="bad.name")
    with pytest.raises(ValueError, match="unknown target"):
        open_target("elastic")


def test_mongod_writer_factory_pickles_the_uri_not_a_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MONGODB_URI", raising=False)
    factory = open_target(
        "mongod",
        mongo_uri="mongodb://127.0.0.1:27018",
        database="analytics",
    ).writer_factory()
    restored = pickle.loads(pickle.dumps(factory))
    assert restored.args == ("mongodb://127.0.0.1:27018", "analytics")


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--verify", "--target", "mongod", "--seed", "1"], "requires --target mongot"),
        (["--load", "--database", "crm", "--seed", "1"], "apply only with --target mongod"),
        (
            ["--load", "--target", "mongod", "--concern", "indexed", "--seed", "1"],
            "not valid for --target mongod",
        ),
        (["--load", "--concern", "majority", "--seed", "1"], "not valid for --target mongot"),
        (
            ["--load", "--target", "mongod", "--database", "bad.name", "--seed", "1"],
            "invalid database name",
        ),
        (
            ["--load", "--target", "mongod", "--mongo-uri", "http://localhost", "--seed", "1"],
            "must start with mongodb://",
        ),
    ],
)
def test_target_flag_errors(argv: list[str], message: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _block_network(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        main(argv)
    assert exc.value.code == 2
    assert message in capsys.readouterr().err


def test_print_does_not_open_a_target(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _block_network(monkeypatch)

    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("prepared")

    monkeypatch.setattr(MongotTarget, "prepare", boom)
    monkeypatch.setattr(MongodTarget, "prepare", boom)
    main(["--accounts", "1", "--seed", "1", "--entity", "accounts", "--contacts-min", "0", "--contacts-max", "0"])
    line = json.loads(capsys.readouterr().out.strip())
    assert line["entity"] == "accounts"
    assert line["document"]["_id"]


def _patch_stream(monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any], *, report: dict[str, Any] | None = None, error: BaseException | None = None) -> None:
    def fake_stream(*_args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["kwargs"] = kwargs
        if error is not None:
            raise error
        return report or {
            "interrupted": False,
            "resume_from_account": None,
            "workers": kwargs["workers"],
            "entities": {},
        }

    monkeypatch.setattr("scripts.crm.load.stream_crm_documents", fake_stream)


def test_load_mongot_uses_index_ids(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _block_network(monkeypatch)
    captured: dict[str, Any] = {}
    service = _Service()

    def prepare(self: MongotTarget, entities: tuple[str, ...], *, log: Any, service: Any = service) -> Prepared:
        captured["suffix"] = self.index_suffix
        from scripts.crm.targets import ensure_targets

        details = ensure_targets(service, entities=entities, index_suffix=self.index_suffix, log=log)
        return Prepared(ids={entity: info["index_id"] for entity, info in details.items()}, details=details)

    monkeypatch.setattr(MongotTarget, "prepare", prepare)
    _patch_stream(monkeypatch, captured)
    main(
        [
            "--load",
            "--seed",
            "3",
            "--accounts",
            "2",
            "--no-progress",
            "--entity",
            "accounts",
            "--index-suffix",
            "_idx",
        ]
    )
    assert captured["suffix"] == "_idx"
    kwargs = captured["kwargs"]
    assert kwargs["concern"] == "indexed"
    assert kwargs["address_field"] == "index_id"
    assert kwargs["index_ids"] == {"accounts": "idx-1"}
    out = capsys.readouterr().out
    report = json.loads(out[out.index("{") :])
    assert report["target"] == "mongot"
    assert report["targets"]["accounts"]["index_name"] == "accounts_idx"


def test_load_mongod_uses_collection_names(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _block_network(monkeypatch)
    monkeypatch.delenv("MONGODB_URI", raising=False)
    captured: dict[str, Any] = {}
    client = _Mongo()
    original = MongodTarget.prepare

    def prepare(self: MongodTarget, entities: tuple[str, ...], *, log: Any, client: Any = client) -> Prepared:
        captured["uri"] = self.uri
        captured["database"] = self.database
        return original(self, entities, log=log, client=client)

    monkeypatch.setattr(MongodTarget, "prepare", prepare)
    _patch_stream(monkeypatch, captured)
    main(
        [
            "--load",
            "--target",
            "mongod",
            "--seed",
            "7",
            "--accounts",
            "4",
            "--no-progress",
            "--entity",
            "accounts",
            "--concern",
            "majority",
            "--database",
            "analytics",
            "--mongo-uri",
            "mongodb://127.0.0.1:27018",
        ]
    )
    assert captured["database"] == "analytics"
    assert captured["uri"] == "mongodb://127.0.0.1:27018"
    kwargs = captured["kwargs"]
    assert kwargs["concern"] == "majority"
    assert kwargs["address_field"] == "collection"
    assert kwargs["index_ids"] == {"accounts": "accounts"}
    out = capsys.readouterr().out
    assert "target=mongod database=analytics" in out
    assert "127.0.0.1:27018" not in out
    report = json.loads(out[out.index("{") :])
    assert report["target"] == "mongod"
    assert report["database"] == "analytics"
    assert report["targets"]["accounts"]["action"] == "created"
    assert report["targets"]["accounts"]["search_index"] == "accounts_search"
    assert report["targets"]["accounts"]["search_index_action"] == "created"


def test_mongod_load_does_not_print_a_uri_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _block_network(monkeypatch)
    host = "super-secret-host.example"
    monkeypatch.setenv("MONGODB_URI", f"mongodb://user:s3cret@{host}:27017")
    captured: dict[str, Any] = {}

    def prepare(self: MongodTarget, entities: tuple[str, ...], *, log: Any, client: Any = None) -> Prepared:
        captured["uri"] = self.uri
        return Prepared(
            ids={entity: entity for entity in entities},
            details={entity: {"database": self.database, "collection": entity, "action": "existing", "indexes": []} for entity in entities},
        )

    monkeypatch.setattr(MongodTarget, "prepare", prepare)
    _patch_stream(monkeypatch, captured)
    main(["--load", "--target", "mongod", "--seed", "1", "--accounts", "1", "--no-progress", "--entity", "accounts"])
    assert captured["uri"] == f"mongodb://user:s3cret@{host}:27017"
    printed = capsys.readouterr()
    assert host not in printed.out
    assert host not in printed.err
    assert "s3cret" not in printed.out
    assert "s3cret" not in printed.err
    assert "database=crm" in printed.out


def test_failed_load_resume_names_the_target(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _block_network(monkeypatch)
    monkeypatch.delenv("MONGODB_URI", raising=False)
    captured: dict[str, Any] = {}

    def prepare(self: MongodTarget, entities: tuple[str, ...], *, log: Any, client: Any = None) -> Prepared:
        return Prepared(
            ids={entity: entity for entity in entities},
            details={entity: {"database": "analytics", "collection": entity, "action": "existing", "indexes": []} for entity in entities},
        )

    monkeypatch.setattr(MongodTarget, "prepare", prepare)
    _patch_stream(
        monkeypatch,
        captured,
        error=IngestFailed("worker 0: boom", {"resume_from_account": 2, "interrupted": True, "entities": {}}),
    )
    with pytest.raises(SystemExit) as exc:
        main(
            [
                "--load",
                "--target",
                "mongod",
                "--seed",
                "9",
                "--accounts",
                "8",
                "--database",
                "analytics",
                "--mongo-uri",
                "mongodb://127.0.0.1:27018",
                "--no-progress",
                "--entity",
                "contacts",
                "--index-suffix",
                "_idx",
            ]
        )
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "Load failed." in err
    assert "--target mongod" in err
    assert "--start-account 2" in err
    assert "--tenants 1" in err
    assert "--accounts 8" in err
    assert "--entity contacts" in err
    assert "--database analytics" in err
    assert "--index-suffix _idx" in err
    assert "Reuse the same MongoDB URI." in err
    assert "27018" not in err


def test_interrupted_mongot_resume_includes_a_custom_suffix(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _block_network(monkeypatch)

    def prepare(self: MongotTarget, entities: tuple[str, ...], *, log: Any, service: Any = None) -> Prepared:
        return Prepared(
            ids={entity: "idx" for entity in entities},
            details={
                entity: {"index_id": "idx", "index_name": f"{entity}{self.index_suffix}", "index_action": "existing"}
                for entity in entities
            },
        )

    monkeypatch.setattr(MongotTarget, "prepare", prepare)
    _patch_stream(
        monkeypatch,
        {},
        report={"interrupted": True, "resume_from_account": 4, "entities": {}, "workers": 1},
    )
    with pytest.raises(SystemExit) as exc:
        main(
            [
                "--load",
                "--seed",
                "1",
                "--accounts",
                "10",
                "--index-suffix",
                "_idx",
                "--no-progress",
                "--entity",
                "accounts",
            ]
        )
    assert exc.value.code == 130
    err = capsys.readouterr().err
    assert "--target mongot" in err
    assert "--index-suffix _idx" in err
    assert "--start-account 4" in err
    assert "--tenants 1" in err
    assert "--accounts 10" in err
    assert "--entity accounts" in err
