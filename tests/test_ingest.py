"""mongot and mongod writers, without a live server."""

from __future__ import annotations

import pickle
from typing import Any

import pytest

from scripts.crm.schema import RELATIONSHIP_FIELDS, search_definition
from scripts.ingest.concerns import concerns_for, default_concern_for
from scripts.ingest.mongod import (
    DEFAULT_DATABASE,
    DEFAULT_MONGO_URI,
    IngestError,
    MongodWriter,
    concern_options,
    ensure_collection,
    ensure_collection_search_index,
    redact_secrets,
    redact_uri,
    resolve_uri,
    validate_database,
)
from scripts.ingest.mongot import ensure_search_index


def test_concerns_do_not_overlap() -> None:
    assert set(concerns_for("mongot")).isdisjoint(concerns_for("mongod"))
    assert default_concern_for("mongot") == "indexed"
    assert default_concern_for("mongod") == "acknowledged"
    with pytest.raises(ValueError):
        concerns_for("elastic")


def test_search_definition_tokens_match_relationship_fields() -> None:
    definition = search_definition("opportunities")
    fields = definition["mappings"]["fields"]
    assert set(fields) == set(RELATIONSHIP_FIELDS["opportunities"])
    assert all(spec == {"type": "token"} for spec in fields.values())


def test_redact_uri_drops_userinfo() -> None:
    shown = redact_uri("mongodb://user:s%3Acret@localhost:27017/crm?authSource=admin")
    assert shown == "mongodb://***@localhost:27017/crm"
    assert "s%3Acret" not in shown
    assert redact_uri(DEFAULT_MONGO_URI) == DEFAULT_MONGO_URI


def test_redact_secrets_strips_decoded_password() -> None:
    uri = "mongodb://user:s%3Acret@localhost:27017/crm"
    text = redact_secrets("auth failed for user password s:cret", uri)
    assert "s:cret" not in text
    assert "user" not in text
    assert "***" in text


def test_database_names() -> None:
    validate_database("crm")
    validate_database(DEFAULT_DATABASE)
    with pytest.raises(ValueError, match="empty"):
        validate_database("  ")
    with pytest.raises(ValueError, match="invalid"):
        validate_database("bad.name")


def test_resolve_uri_prefers_the_flag_over_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MONGODB_URI", "mongodb://from-env:27017")
    assert resolve_uri("mongodb://from-flag:27017") == "mongodb://from-flag:27017"
    assert resolve_uri(None) == "mongodb://from-env:27017"
    monkeypatch.delenv("MONGODB_URI")
    assert resolve_uri(None) == DEFAULT_MONGO_URI
    with pytest.raises(ValueError, match="must start with"):
        resolve_uri("http://localhost:27017")


class _Collection:
    def __init__(self, name: str) -> None:
        self.name = name
        self.indexes: list[Any] = []

    def create_index(self, keys: list[tuple[str, int]], name: str) -> str:
        self.indexes.append((keys, name))
        return name


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
            self.cols[name] = _Collection(name)
        return self.cols[name]


def test_ensure_collection_is_idempotent() -> None:
    database = _Database()
    created = ensure_collection(database, "contacts", index_fields=RELATIONSHIP_FIELDS["contacts"])
    again = ensure_collection(database, "contacts", index_fields=RELATIONSHIP_FIELDS["contacts"])
    assert created["action"] == "created"
    assert again["action"] == "existing"
    assert created["indexes"] == ["tenant_id", "account_id", "opportunity_ids"]
    assert database.names == ["contacts"]
    assert database.cols["contacts"].indexes == [
        ([("tenant_id", 1)], "tenant_id_1"),
        ([("account_id", 1)], "account_id_1"),
        ([("opportunity_ids", 1)], "opportunity_ids_1"),
        ([("tenant_id", 1)], "tenant_id_1"),
        ([("account_id", 1)], "account_id_1"),
        ([("opportunity_ids", 1)], "opportunity_ids_1"),
    ]


class _SearchCollection:
    def __init__(self) -> None:
        self.indexes: list[dict[str, Any]] = []
        self.updates: list[tuple[str, dict[str, Any]]] = []

    def list_search_indexes(self, name: str | None = None) -> list[dict[str, Any]]:
        if name is None:
            return list(self.indexes)
        return [index for index in self.indexes if index.get("name") == name]

    def create_search_index(self, model: dict[str, Any]) -> str:
        self.indexes.append(
            {
                "id": "si-1",
                "name": model["name"],
                "type": model.get("type", "search"),
                "latestDefinition": model["definition"],
            }
        )
        return model["name"]

    def update_search_index(self, name: str, definition: dict[str, Any]) -> None:
        self.updates.append((name, definition))
        for index in self.indexes:
            if index["name"] == name:
                index["latestDefinition"] = definition


def test_collection_search_index_is_created_once() -> None:
    collection = _SearchCollection()
    definition = search_definition("contacts")
    created = ensure_collection_search_index(collection, name="contacts_search", definition=definition)
    assert collection.indexes[0]["type"] == "search"
    echoed = {
        "id": "si-1",
        "name": "contacts_search",
        "latestDefinition": {
            "mappings": {**definition["mappings"], "analyzer": "lucene.standard"},
            "storedSource": True,
            "analyzer": "lucene.standard",
        },
    }
    collection.indexes[0] = echoed
    again = ensure_collection_search_index(collection, name="contacts_search", definition=definition)
    assert created == {"name": "contacts_search", "action": "created", "id": "si-1"}
    assert again["action"] == "existing"
    assert collection.updates == []

    changed = search_definition("accounts")
    updated = ensure_collection_search_index(collection, name="contacts_search", definition=changed)
    assert updated["action"] == "updated"
    assert collection.updates == [("contacts_search", changed)]


def test_accounts_index_tenant_id() -> None:
    database = _Database()
    info = ensure_collection(database, "accounts", index_fields=RELATIONSHIP_FIELDS["accounts"])
    assert info["indexes"] == ["tenant_id"]
    assert database.cols["accounts"].indexes == [([("tenant_id", 1)], "tenant_id_1")]


def test_concern_options() -> None:
    assert concern_options("acknowledged") == {"w": 1}
    assert concern_options("journaled") == {"w": 1, "j": True}
    assert concern_options("majority") == {"w": "majority"}
    with pytest.raises(ValueError, match="mongod concern"):
        concern_options("indexed")


def test_writer_rejects_documents_without_ids() -> None:
    writer = MongodWriter(DEFAULT_MONGO_URI, "crm", client=_Client())
    with pytest.raises(ValueError, match="_id"):
        writer.upsert_many("accounts", [{"name": "x"}], concern="acknowledged")
    writer.close()
    assert writer._client.closed is False


class _Client:
    def __init__(self) -> None:
        self.closed = False
        self.dbs: dict[str, _Database] = {}

    def __getitem__(self, name: str) -> _Database:
        return self.dbs.setdefault(name, _Database())

    def close(self) -> None:
        self.closed = True


def test_mongod_writer_replaces_by_id() -> None:
    pytest.importorskip("pymongo")
    from pymongo import ReplaceOne, WriteConcern

    class RecordingCollection(_Collection):
        def __init__(self, name: str) -> None:
            super().__init__(name)
            self.writes: list[Any] = []

        def with_options(self, write_concern: Any) -> RecordingCollection:
            clone = RecordingCollection(self.name)
            clone.writes = self.writes
            clone.concern = write_concern
            return clone

        def bulk_write(self, operations: list[Any], ordered: bool = True) -> None:
            self.writes.append((self.concern, ordered, operations))

    client = _Client()
    database = client["crm"]
    database.cols["accounts"] = RecordingCollection("accounts")
    writer = MongodWriter("mongodb://127.0.0.1:27017", "crm", client=client)
    document = {"_id": "a1", "name": "Acme"}
    writer.upsert_many("accounts", [document], concern="journaled")

    concern, ordered, operations = database.cols["accounts"].writes[0]
    assert isinstance(concern, WriteConcern)
    assert dict(concern.document) == {"w": 1, "j": True}
    assert ordered is False
    assert len(operations) == 1
    operation = operations[0]
    assert isinstance(operation, ReplaceOne)
    assert operation._filter == {"_id": "a1"}
    assert operation._doc == document
    assert operation._upsert is True


def test_connection_errors_are_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    class Boom(Exception):
        pass

    Boom.__module__ = "pymongo.errors"

    def fail(uri: str) -> Any:
        raise Boom("password s3cret rejected")

    monkeypatch.setattr("scripts.ingest.mongod.connect", fail)
    with pytest.raises(IngestError, match="Could not reach mongod") as exc:
        MongodWriter("mongodb://user:s3cret@localhost:27017", "crm")
    assert "s3cret" not in str(exc.value)
    assert "localhost:27017" in str(exc.value)


def test_mongot_writer_factory_is_picklable() -> None:
    from scripts.ingest.mongot import mongot_writer

    restored = pickle.loads(pickle.dumps(mongot_writer))
    assert restored.__name__ == "mongot_writer"


def test_ensure_search_index_still_reports_actions() -> None:
    """The moved helper keeps the created/existing/updated contract."""

    class Service:
        def __init__(self) -> None:
            self.indexes: list[dict[str, Any]] = []

        def list_indexes(self) -> list[dict[str, Any]]:
            return list(self.indexes)

        def create_index(self, *, name: str, index_type: str = "SEARCH", definition: dict[str, Any] | None = None) -> dict[str, Any]:
            index = {
                "index_id": "idx-1",
                "name": name,
                "type": index_type.upper(),
                "definition": definition,
            }
            self.indexes.append(index)
            return index

        def update_index(self, index_id: str, *, definition: dict[str, Any]) -> dict[str, Any]:
            index = self.indexes[0]
            index["definition"] = definition
            return index

    service = Service()
    definition = search_definition("accounts")
    _, created = ensure_search_index(service, name="accounts_search", definition=definition)
    _, existing = ensure_search_index(service, name="accounts_search", definition=definition)
    changed = dict(definition)
    changed["storedSource"] = False
    _, updated = ensure_search_index(service, name="accounts_search", definition=changed)
    assert (created, existing, updated) == ("created", "existing", "updated")
