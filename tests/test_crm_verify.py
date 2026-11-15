from __future__ import annotations

import copy
import random
from typing import Any, Callable

import pytest

from scripts.crm.generate import ENTITY_KEYS, CrmGenerator, CrmSpec
from scripts.crm.verify import (
    EDGES,
    SHAPES,
    Oracle,
    UnsupportedQuery,
    plan_checks,
    sample_pool,
    verify_crm,
)

NAMES = {entity: f"{entity}_search" for entity in ENTITY_KEYS}
INDEX_IDS = {"accounts": "idx-a", "contacts": "idx-c", "opportunities": "idx-o"}
ENTITY_BY_ID = {index_id: entity for entity, index_id in INDEX_IDS.items()}


def _spec(**overrides: Any) -> CrmSpec:
    params: dict[str, Any] = {
        "seed": 42,
        "accounts": 12,
        "contacts_per_account": (0, 5),
        "opportunities_per_account": (0, 4),
    }
    params.update(overrides)
    return CrmSpec(**params)


def _dataset(spec: CrmSpec) -> dict[str, list[dict[str, Any]]]:
    data: dict[str, list[dict[str, Any]]] = {entity: [] for entity in ENTITY_KEYS}
    for _, entity, doc in CrmGenerator(spec).iter_documents():
        data[entity].append(doc)
    return data


def _reference_searcher(
    spec: CrmSpec,
    perturb: Callable[[str, dict[str, Any], list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
) -> Callable[[str, dict[str, Any]], list[dict[str, Any]]]:
    """A correct in-memory server over the whole dataset, optionally made wrong by ``perturb``."""
    data = _dataset(spec)
    oracle = Oracle(data, NAMES)
    by_id = {doc["_id"]: doc for docs in data.values() for doc in docs}

    def search(index_id: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        entity = ENTITY_BY_ID[index_id]
        hits = [
            {"$searchScore": 1.0, "storedSource": copy.deepcopy(by_id[doc_id])}
            for doc_id in oracle.matching_ids(entity, query)
        ]
        return perturb(entity, query, hits) if perturb else hits

    return search


def _verify(spec: CrmSpec, searcher: Callable[..., Any], **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "index_ids": INDEX_IDS,
        "index_names": NAMES,
        "searcher": searcher,
        "verify_seed": 7,
        "pool_accounts": 5,
        "queries": 2 * len(SHAPES) * len(EDGES),
        "timeout": 0,
        "progress": False,
        "sleep": lambda _seconds: None,
    }
    params.update(overrides)
    return verify_crm(spec, **params)


def test_oracle_matches_join_guide_example() -> None:
    documents = {
        "accounts": [
            {"_id": "a1", "region": "bay area", "industry": "aerospace"},
            {"_id": "a2", "region": "new york", "industry": "aerospace"},
            {"_id": "a3", "region": "bay area", "industry": "finance"},
        ],
        "contacts": [
            {"_id": "c1", "account_id": "a1", "title": "Principal Software Architect", "peers": ["x"]},
            {"_id": "c2", "account_id": "a2", "title": "Solutions Architect", "peers": ["x", "y"]},
            {"_id": "c3", "account_id": "a1", "title": "Aerospace Engineer", "peers": []},
            {"_id": "c4", "account_id": "a3", "title": "Cloud Architect", "peers": ["y"]},
        ],
        "opportunities": [],
    }
    oracle = Oracle(documents, NAMES)
    bay_aerospace = {
        "join": {
            "from": "accounts_search",
            "localField": "account_id",
            "foreignField": "_id",
            "operator": {
                "compound": {
                    "filter": [
                        {"text": {"path": "region", "query": "bay"}},
                        {"text": {"path": "industry", "query": "aerospace"}},
                    ]
                }
            },
        }
    }
    architects = {"text": {"path": "title", "query": "architect"}}
    assert oracle.matching_ids("contacts", {"compound": {"must": [architects], "filter": [bay_aerospace]}}) == ["c1"]
    assert oracle.matching_ids("contacts", {"compound": {"must": [architects], "mustNot": [bay_aerospace]}}) == [
        "c2",
        "c4",
    ]
    reverse = {
        "join": {
            "from": "contacts_search",
            "localField": "_id",
            "foreignField": "account_id",
            "operator": architects,
        }
    }
    assert oracle.matching_ids("accounts", {"compound": {"filter": [reverse]}}) == ["a1", "a2", "a3"]
    # Arrays share any value; omitting `from` joins the index to itself.
    peers_of_c1 = {
        "join": {
            "localField": "peers",
            "foreignField": "peers",
            "operator": {"in": {"path": "_id", "value": ["c1"]}},
        }
    }
    assert oracle.matching_ids("contacts", {"compound": {"filter": [peers_of_c1]}}) == ["c1", "c2"]


def test_oracle_rejects_operators_it_does_not_model() -> None:
    oracle = Oracle({"contacts": [{"_id": "c1"}]}, NAMES)
    with pytest.raises(UnsupportedQuery):
        oracle.matching_ids("contacts", {"compound": {"should": [{"in": {"path": "_id", "value": ["c1"]}}]}})
    with pytest.raises(UnsupportedQuery):
        oracle.matching_ids("contacts", {"phrase": {"path": "title", "query": "a b"}})


def test_pool_answers_match_the_full_dataset() -> None:
    spec = _spec()
    full = Oracle(_dataset(spec), NAMES)
    rng = random.Random(3)
    pool = sample_pool(spec, 5, rng)
    checks = plan_checks(
        pool,
        NAMES,
        count=3 * len(SHAPES) * len(EDGES),
        rng=rng,
        unscoped_foreign=frozenset(ENTITY_KEYS),
    )
    for check in checks:
        assert list(check.expected) == full.matching_ids(check.entity, check.query), check
    nonempty = sum(bool(check.expected) for check in checks)
    assert len(checks) // 3 < nonempty < len(checks)


def test_every_shape_and_edge_is_planned() -> None:
    rng = random.Random(11)
    pool = sample_pool(_spec(), 4, rng)
    checks = plan_checks(pool, NAMES, count=len(SHAPES) * len(EDGES), rng=rng)
    assert {(check.shape, check.edges[0]) for check in checks} == {
        (shape, edge.name) for shape in SHAPES for edge in EDGES
    }


def _join_placements(node: Any, path: tuple[str, ...] = ()) -> list[tuple[str, ...]]:
    found: list[tuple[str, ...]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "join":
                found.append(path)
                found += [("inside-join", *p) for p in _join_placements(value["operator"])]
            else:
                found += _join_placements(value, (*path, key))
    elif isinstance(node, list):
        for item in node:
            found += _join_placements(item, path)
    return found


def test_joins_only_appear_where_mongot_accepts_them() -> None:
    rng = random.Random(5)
    pool = sample_pool(_spec(), 6, rng)
    for check in plan_checks(pool, NAMES, count=200, rng=rng, unscoped_foreign=frozenset(ENTITY_KEYS)):
        placements = _join_placements(check.query)
        assert placements, check.query
        for placement in placements:
            assert "inside-join" not in placement
            assert placement[0] == "compound" and placement[-1] in ("filter", "mustNot")
            assert "must" not in placement


def test_verify_passes_against_a_correct_server() -> None:
    spec = _spec()
    report = _verify(spec, _reference_searcher(spec))
    assert report["pool_loaded"] is True
    assert report["failed"] == 0
    assert report["passed"] == report["queries"] == 2 * len(SHAPES) * len(EDGES)
    assert set(report["shapes"]) == set(SHAPES)
    assert {edge.name for edge in EDGES} <= set(report["edges"])


def test_verify_reports_wrong_documents() -> None:
    spec = _spec()

    def perturb(entity: str, query: dict[str, Any], hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if "compound" not in query or not hits:
            return hits
        if entity == "contacts":
            return hits[1:]
        if entity == "opportunities":
            return hits + hits[:1]
        hits[0]["storedSource"]["industry"] = "Changed"
        return hits

    report = _verify(spec, _reference_searcher(spec, perturb))
    assert report["pool_loaded"] is True
    assert report["failed"] > 0
    kinds = {kind for failure in report["failures"] for kind in ("missing", "duplicates", "stale") if kind in failure}
    assert kinds == {"missing", "duplicates", "stale"}
    assert all("query" in failure for failure in report["failures"])


def test_verify_reports_errors_per_query() -> None:
    spec = _spec()
    correct = _reference_searcher(spec)

    def searcher(index_id: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        if "compound" in query and "mustNot" in query["compound"]:
            raise RuntimeError("join rejected")
        return correct(index_id, query)

    report = _verify(spec, searcher)
    errors = [failure for failure in report["failures"] if "error" in failure]
    assert errors and all(failure["error"] == "RuntimeError: join rejected" for failure in errors)
    assert report["passed"] > 0


def test_pool_check_waits_for_documents_to_become_visible() -> None:
    spec = _spec()
    correct = _reference_searcher(spec)
    calls = {"n": 0}

    def eventually(index_id: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        calls["n"] += 1
        return [] if calls["n"] <= 3 else correct(index_id, query)

    report = _verify(spec, eventually, timeout=60, queries=5)
    assert report["pool_loaded"] is True
    assert report["failed"] == 0


def test_pool_check_fails_when_documents_never_appear() -> None:
    spec = _spec()
    report = _verify(spec, lambda _index_id, _query: [], queries=5)
    assert report["pool_loaded"] is False
    assert report["queries"] == 0
    assert report["failed"] > 0
    assert all(failure["shape"] == "pool" and "missing" in failure for failure in report["failures"])


def test_pool_check_fails_fast_on_documents_from_another_spec() -> None:
    loaded = _spec(contacts_per_account=(6, 8))
    sleeps: list[float] = []
    report = _verify(_spec(), _reference_searcher(loaded), timeout=60, sleep=sleeps.append, queries=5)
    assert report["pool_loaded"] is False
    assert sleeps == []
