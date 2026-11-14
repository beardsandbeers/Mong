from __future__ import annotations

from typing import Any

import pytest

from scripts.crm.generate import (
    CrmGenerator,
    CrmSpec,
    account_id,
    contact_id,
    generate_crm_dataset,
)
from scripts.crm.load import (
    ensure_search_index,
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
    whole = [d for _, _, d in CrmGenerator(_spec(accounts=6)).iter_documents()]
    head = [d for _, _, d in CrmGenerator(_spec(accounts=3)).iter_documents()]
    tail = [d for _, _, d in CrmGenerator(_spec(accounts=3, start_account=3)).iter_documents()]
    assert head + tail == whole


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
    assert all(len(docs) <= 3 for _, docs, _ in upserter.calls)
    assert {concern for _, _, concern in upserter.calls} == {"committed"}


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


def test_invalid_ranges_rejected() -> None:
    with pytest.raises(ValueError):
        CrmSpec(seed=1, accounts=1, contacts_per_account=(3, 1))
