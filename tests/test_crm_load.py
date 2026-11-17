from __future__ import annotations

import multiprocessing as mp
from functools import partial
from typing import Any

import pytest

from scripts.crm.generate import (
    CrmGenerator,
    CrmSpec,
    account_id,
    contact_id,
    generate_crm_dataset,
    tenant_id,
)
from scripts.crm.load import (
    _accounts_completed,
    _list_upserter_factory,
    ensure_search_index,
    progress_bar,
    progress_totals,
    search_definition,
    stream_crm_documents,
)


class FakeService:
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
        index = next(idx for idx in self.indexes if idx["index_id"] == index_id)
        index["definition"] = definition
        return index


class FakeUpserter:
    def __init__(self, fail_after: int | None = None) -> None:
        self.calls: list[tuple[str, list[dict[str, Any]], str]] = []
        self.fail_after = fail_after

    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> None:
        if self.fail_after is not None and len(self.calls) >= self.fail_after:
            raise KeyboardInterrupt
        self.calls.append((index_id, list(documents), concern))


INDEX_IDS = {"accounts": "idx-a", "contacts": "idx-c", "opportunities": "idx-o"}


def _spec(**overrides: Any) -> CrmSpec:
    params: dict[str, Any] = {
        "seed": 42,
        "accounts": 6,
        "contacts_per_account": (0, 5),
        "opportunities_per_account": (0, 4),
    }
    params.update(overrides)
    return CrmSpec(**params)


def test_ensure_search_index_is_idempotent() -> None:
    service = FakeService()
    old = {"mappings": {"dynamic": True}, "storedSource": True}
    new = search_definition("contacts")
    idx1, action1 = ensure_search_index(service, name="contacts_search", definition=old)
    idx2, action2 = ensure_search_index(service, name="contacts_search", definition=old)
    idx3, action3 = ensure_search_index(service, name="contacts_search", definition=new)
    assert (action1, action2, action3) == ("created", "existing", "updated")
    assert idx1["index_id"] == idx2["index_id"] == idx3["index_id"]
    assert len(service.indexes) == 1
    assert service.indexes[0]["definition"]["mappings"]["fields"]["account_id"] == {"type": "token"}


def test_server_default_analyzers_are_not_a_definition_change() -> None:
    service = FakeService()
    definition = search_definition("accounts")
    created, action = ensure_search_index(service, name="accounts_search", definition=definition)
    echoed = dict(definition)
    echoed["analyzer"] = "lucene.standard"
    echoed["searchAnalyzer"] = "lucene.standard"
    service.indexes[0]["definition"] = echoed
    again, again_action = ensure_search_index(service, name="accounts_search", definition=definition)
    assert (action, again_action) == ("created", "existing")
    assert again["index_id"] == created["index_id"]
    assert len(service.indexes) == 1

    echoed["analyzer"] = "lucene.keyword"
    service.indexes[0]["definition"] = echoed
    _, changed = ensure_search_index(service, name="accounts_search", definition=definition)
    assert changed == "updated"


def test_generation_is_deterministic() -> None:
    a = generate_crm_dataset(account_count=3, seed=7)
    b = generate_crm_dataset(account_count=3, seed=7)
    c = generate_crm_dataset(account_count=3, seed=8)
    assert a == b
    assert a["accounts"][0]["_id"] != c["accounts"][0]["_id"]


def test_relationships_are_consistent() -> None:
    spec = _spec(accounts=20)
    data: dict[str, list[dict[str, Any]]] = {"accounts": [], "contacts": [], "opportunities": []}
    for _, entity, doc in CrmGenerator(spec).iter_documents():
        data[entity].append(doc)

    accounts = {doc["_id"] for doc in data["accounts"]}
    contacts = {doc["_id"]: doc for doc in data["contacts"]}
    opportunities = {doc["_id"]: doc for doc in data["opportunities"]}

    for contact in contacts.values():
        assert contact["account_id"] in accounts
        for opp_id in contact["opportunity_ids"]:
            assert contact["_id"] in opportunities[opp_id]["contact_ids"]
    for opp in opportunities.values():
        assert opp["account_id"] in accounts
        assert opp["primary_contact_id"] == opp["contact_ids"][0]
        for cid in opp["contact_ids"]:
            assert contacts[cid]["account_id"] == opp["account_id"]
            assert opp["_id"] in contacts[cid]["opportunity_ids"]


def test_single_entity_matches_full_generation() -> None:
    spec = _spec()
    full = [d for _, e, d in CrmGenerator(spec).iter_documents() if e == "contacts"]
    only = [d for _, _, d in CrmGenerator(spec).iter_documents(("contacts",))]
    assert full == only


def test_start_account_continues_same_dataset() -> None:
    whole = [d for _, _, d in CrmGenerator(_spec(tenants=2, accounts=3)).iter_documents()]
    head = [d for _, _, d in CrmGenerator(_spec(tenants=1, accounts=3)).iter_documents()]
    tail = [d for _, _, d in CrmGenerator(_spec(tenants=2, accounts=3, start_account=3)).iter_documents()]
    assert head + tail == whole


def test_large_runs_skip_the_exact_document_count(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("scripts.crm.load._EXACT_COUNT_LIMIT", 2)
    assert progress_totals(_spec(accounts=5), ("accounts",)) is None
    assert progress_totals(_spec(accounts=2), ("accounts",))["accounts"] == 2


def test_large_runs_measure_accounts_so_the_bar_has_an_eta(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("scripts.crm.load._EXACT_COUNT_LIMIT", 2)
    huge = _spec(accounts=5)
    assert progress_bar(huge, None) == (5, "account")
    small = progress_totals(_spec(accounts=2), ("accounts", "contacts"))
    assert small is not None
    assert progress_bar(_spec(accounts=2), small) == (sum(small.values()), "doc")


def test_accounts_completed_sums_finished_shards() -> None:
    shards = [(0, 10), (10, 10)]
    assert _accounts_completed(shards, [4, 10]) == 4
    assert _accounts_completed(shards, [10, 20]) == 20
    assert _accounts_completed(shards, [0, 15]) == 5


def test_tenant_id_groups_accounts() -> None:
    spec = _spec(tenants=3, accounts=4, contacts_per_account=(1, 1), opportunities_per_account=(1, 1))
    grouped: dict[str, list[dict[str, Any]]] = {"accounts": [], "contacts": [], "opportunities": []}
    for _, entity, doc in CrmGenerator(spec).iter_documents():
        grouped[entity].append(doc)

    assert len(grouped["accounts"]) == 12
    tenants = [doc["tenant_id"] for doc in grouped["accounts"]]
    assert tenants == [tenant_id(42, index // 4) for index in range(12)]
    assert len(set(tenants)) == 3
    by_account = {doc["_id"]: doc["tenant_id"] for doc in grouped["accounts"]}
    for entity in ("contacts", "opportunities"):
        assert grouped[entity]
        for doc in grouped[entity]:
            assert doc["tenant_id"] == by_account[doc["account_id"]]


def test_ids_are_derivable_without_generation() -> None:
    doc = CrmGenerator(_spec(contacts_per_account=(1, 1))).contact(2, 0, [])
    assert doc["_id"] == contact_id(42, 2, 0)
    assert doc["account_id"] == account_id(42, 2)


def test_stream_batches_and_counts() -> None:
    spec = _spec(accounts=10)
    upserter = FakeUpserter()
    report = stream_crm_documents(
        spec,
        upserter=upserter,
        index_ids=INDEX_IDS,
        batch_size=3,
        concern="committed",
        progress=False,
    )
    expected = spec.document_counts()
    assert report["interrupted"] is False
    for entity, info in report["entities"].items():
        assert info["written"] == info["expected"] == expected[entity]
        assert info["index_id"] == INDEX_IDS[entity]
    assert all(len(docs) <= 3 for _, docs, _ in upserter.calls)
    assert {concern for _, _, concern in upserter.calls} == {"committed"}


def test_account_is_upserted_before_its_children() -> None:
    spec = _spec(accounts=2, contacts_per_account=(40, 40), opportunities_per_account=(15, 15))
    upserter = FakeUpserter()
    stream_crm_documents(
        spec,
        upserter=upserter,
        index_ids=INDEX_IDS,
        batch_size=10,
        progress=False,
    )
    kinds = [index_id for index_id, _, _ in upserter.calls]
    assert kinds[0] == INDEX_IDS["accounts"]
    assert len(upserter.calls[0][1]) == 1
    # The second account is sent before the run has written every child of the first.
    second_account = kinds.index(INDEX_IDS["accounts"], 1)
    assert kinds[:second_account].count(INDEX_IDS["contacts"]) < 40
    assert {len(docs) for index_id, docs, _ in upserter.calls if index_id == INDEX_IDS["accounts"]} == {1}


def test_stream_interrupt_reports_resume_point() -> None:
    spec = _spec(accounts=50, contacts_per_account=(2, 2), opportunities_per_account=(1, 1))
    report = stream_crm_documents(
        spec,
        upserter=FakeUpserter(fail_after=5),
        index_ids=INDEX_IDS,
        batch_size=4,
        progress=False,
    )
    assert report["interrupted"] is True
    resume = report["resume_from_account"]
    assert resume is not None and 0 <= resume < 50
    written_accounts = report["entities"]["accounts"]["written"]
    assert resume <= written_accounts


def test_stream_workers_cover_every_document() -> None:
    spec = _spec(accounts=11, contacts_per_account=(1, 2), opportunities_per_account=(1, 1))
    ctx = mp.get_context("spawn")
    with ctx.Manager() as manager:
        calls = manager.list()
        report = stream_crm_documents(
            spec,
            index_ids=INDEX_IDS,
            client_factory=partial(_list_upserter_factory, calls),
            workers=3,
            batch_size=4,
            progress=False,
        )
        recorded = list(calls)

    assert report["interrupted"] is False
    assert report["workers"] == 3
    assert report["resume_from_account"] is None
    expected = {
        INDEX_IDS[entity]: [doc["_id"] for _, ent, doc in CrmGenerator(spec).iter_documents() if ent == entity]
        for entity in INDEX_IDS
    }
    got: dict[str, list[str]] = {index_id: [] for index_id in INDEX_IDS.values()}
    pids: set[int] = set()
    for pid, index_id, concern, ids in recorded:
        assert concern == "indexed"
        assert 1 <= len(ids) <= 4
        got[index_id].extend(ids)
        pids.add(pid)
    assert len(pids) == 3
    for index_id, ids in expected.items():
        assert sorted(got[index_id]) == sorted(ids)
        assert len(got[index_id]) == len(ids)
    for entity, info in report["entities"].items():
        assert info["written"] == len(expected[INDEX_IDS[entity]])


def test_invalid_ranges_rejected() -> None:
    with pytest.raises(ValueError):
        CrmSpec(seed=1, accounts=1, contacts_per_account=(3, 1))


def test_report_can_name_the_writer_address() -> None:
    spec = _spec(accounts=1, contacts_per_account=(0, 0), opportunities_per_account=(0, 0))
    report = stream_crm_documents(
        spec,
        upserter=FakeUpserter(),
        index_ids={"accounts": "accounts"},
        entities=("accounts",),
        progress=False,
        address_field="collection",
    )
    assert report["entities"]["accounts"]["collection"] == "accounts"
    assert "index_id" not in report["entities"]["accounts"]
