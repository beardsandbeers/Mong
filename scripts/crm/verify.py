"""Fire parent/child join queries at the CRM indexes and check the exact documents returned.

The generator is deterministic, so the verifier samples a pool of accounts,
regenerates every document those accounts own, and computes each query's
expected result with an in-memory reference evaluator (``Oracle``).

Every id and link field (``_id``, ``account_id``, ``contact_ids``,
``opportunity_ids``, ``primary_contact_id``) only holds ids of documents that
belong to one account, so a join can only pair documents of the same account.
Each generated query carries an ``in`` clause on the scoped accounts, either on
the local side or on the operator of a required join. That confines the true
answer to the pool, which makes the pool-only evaluation exact for the whole
dataset. ``Oracle.is_scoped`` enforces this for every generated query.

Before the join checks run, each index must hold exactly the pool's documents
(stored source equal to the regenerated document). Writes made with the
``indexed`` concern become searchable after the next refresh, so that check is
retried until ``timeout``.
"""

from __future__ import annotations

import operator as op
import random
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

from tqdm import tqdm

from scripts.crm.generate import ENTITY_KEYS, CrmGenerator, CrmSpec, account_id

SCOPE_PATH = {"accounts": "_id", "contacts": "account_id", "opportunities": "account_id"}
QUERY_OPTIONS = frozenset({"returnStoredSource", "index"})
# Joins whose foreign side is not scoped collect keys from the whole foreign index.
# The server rejects more than 100,000 distinct keys per query, so only leave the
# foreign side unscoped for indexes comfortably under that.
UNSCOPED_FOREIGN_LIMIT = 50_000
MAX_LISTED_IDS = 10
MAX_LISTED_FAILURES = 25

Searcher = Callable[[str, dict[str, Any]], list[dict[str, Any]]]


@dataclass(frozen=True)
class Edge:
    """One way to relate a local document to foreign documents by shared id keys."""

    name: str
    local: str
    local_field: str
    foreign: str
    foreign_field: str


EDGES: tuple[Edge, ...] = (
    Edge("contact->account", "contacts", "account_id", "accounts", "_id"),
    Edge("opportunity->account", "opportunities", "account_id", "accounts", "_id"),
    Edge("account->contacts", "accounts", "_id", "contacts", "account_id"),
    Edge("account->opportunities", "accounts", "_id", "opportunities", "account_id"),
    Edge("opportunity->contacts", "opportunities", "contact_ids", "contacts", "_id"),
    Edge("opportunity->primary contact", "opportunities", "primary_contact_id", "contacts", "_id"),
    Edge("contact->opportunities", "contacts", "_id", "opportunities", "contact_ids"),
    Edge("contact->opportunities (back-ref)", "contacts", "opportunity_ids", "opportunities", "_id"),
    Edge("contact->opportunities as primary", "contacts", "_id", "opportunities", "primary_contact_id"),
    Edge("contact<->same account", "contacts", "account_id", "contacts", "account_id"),
    Edge("contact<->same opportunity", "contacts", "opportunity_ids", "contacts", "opportunity_ids"),
    Edge("opportunity<->same account", "opportunities", "account_id", "opportunities", "account_id"),
    Edge("opportunity<->shared contact", "opportunities", "contact_ids", "opportunities", "contact_ids"),
)
EDGES_BY_LOCAL: dict[str, tuple[Edge, ...]] = {
    entity: tuple(edge for edge in EDGES if edge.local == entity) for entity in ENTITY_KEYS
}

# (path, kind). Text predicates only use fields drawn from the generator's fixed
# vocabularies, where lucene.standard tokenization is plain word splitting.
PREDICATE_FIELDS: dict[str, tuple[tuple[str, str], ...]] = {
    "accounts": (
        ("industry", "text"),
        ("type", "text"),
        ("status", "text"),
        ("employee_count", "range"),
        ("annual_revenue", "range"),
    ),
    "contacts": (("department", "text"), ("status", "text"), ("is_primary", "bool")),
    "opportunities": (("stage", "text"), ("type", "text"), ("amount", "range"), ("probability", "range")),
}
_RANGE_FORMS = (("gte",), ("lte",), ("gt",), ("lt",), ("gte", "lte"))
_RANGE_OPS = {"gt": op.gt, "gte": op.ge, "lt": op.lt, "lte": op.le}
_WORD = re.compile(r"[^\W_]+")
_HIT_META = frozenset({"$searchScore", "score", "$search"})


class UnsupportedQuery(ValueError):
    """The reference evaluator does not model this operator or clause."""


def _terms(value: str) -> set[str]:
    return set(_WORD.findall(value.lower()))


def _only(node: Mapping[str, Any]) -> tuple[str, Any]:
    if len(node) != 1:
        raise UnsupportedQuery(f"expected exactly one operator, got {sorted(node)}")
    return next(iter(node.items()))


def _root(query: Mapping[str, Any]) -> Mapping[str, Any]:
    return {key: value for key, value in query.items() if key not in QUERY_OPTIONS}


def _lookup(doc: Mapping[str, Any], path: str) -> Any:
    value: Any = doc
    for part in path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return None
        value = value[part]
    return value


def _keys(doc: Mapping[str, Any], path: str) -> set[str]:
    """Token keys of a field: a string, or the strings of an array."""
    value = _lookup(doc, path)
    if isinstance(value, str):
        return {value}
    if isinstance(value, list):
        return {item for item in value if isinstance(item, str)}
    return set()


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class Oracle:
    """Reference semantics for the operators the verifier generates.

    A ``join`` matches a local document when any of its ``localField`` keys
    equals a ``foreignField`` key of a foreign document matching ``operator``.
    Omitting ``from`` joins the index to itself.
    """

    def __init__(self, documents: Mapping[str, Sequence[dict[str, Any]]], index_names: Mapping[str, str]):
        self.documents = documents
        self._entities = {name: entity for entity, name in index_names.items()}

    def foreign_entity(self, entity: str, join: Mapping[str, Any]) -> str:
        name = join.get("from")
        if name is None:
            return entity
        try:
            return self._entities[name]
        except KeyError:
            raise UnsupportedQuery(f"unknown index {name!r}") from None

    def matching_ids(self, entity: str, query: Mapping[str, Any]) -> list[str]:
        node = _root(query)
        memo: dict[int, set[str]] = {}
        return [doc["_id"] for doc in self.documents[entity] if self._matches(entity, node, doc, memo)]

    def is_scoped(self, entity: str, node: Mapping[str, Any]) -> bool:
        """True when a required ``in`` clause restricts matches to listed accounts."""
        name, body = _only(_root(node))
        if name == "in":
            return body["path"] == SCOPE_PATH[entity]
        if name == "join":
            return self.is_scoped(self.foreign_entity(entity, body), body["operator"])
        if name == "compound":
            return any(self.is_scoped(entity, clause) for clause in (*body.get("must", ()), *body.get("filter", ())))
        return False

    def _matches(self, entity: str, node: Mapping[str, Any], doc: Mapping[str, Any], memo: dict[int, set[str]]) -> bool:
        name, body = _only(node)
        if name == "compound":
            unknown = set(body) - {"must", "filter", "mustNot"}
            if unknown:
                raise UnsupportedQuery(f"compound clauses {sorted(unknown)}")
            required = (*body.get("must", ()), *body.get("filter", ()))
            return all(self._matches(entity, clause, doc, memo) for clause in required) and not any(
                self._matches(entity, clause, doc, memo) for clause in body.get("mustNot", ())
            )
        if name == "join":
            return bool(_keys(doc, body["localField"]) & self._join_keys(entity, body, memo))
        if name == "in":
            return bool(_keys(doc, body["path"]) & set(body["value"]))
        if name == "text":
            value = _lookup(doc, body["path"])
            return isinstance(value, str) and bool(_terms(value) & _terms(body["query"]))
        if name == "equals":
            if not isinstance(body["value"], bool):
                raise UnsupportedQuery("equals is only modeled for booleans")
            return _lookup(doc, body["path"]) is body["value"]
        if name == "range":
            value = _lookup(doc, body["path"])
            bounds = {key: bound for key, bound in body.items() if key != "path"}
            if not bounds or set(bounds) - set(_RANGE_OPS):
                raise UnsupportedQuery(f"range bounds {sorted(bounds)}")
            return _is_number(value) and all(_RANGE_OPS[key](value, bound) for key, bound in bounds.items())
        raise UnsupportedQuery(f"operator {name!r}")

    def _join_keys(self, entity: str, join: Mapping[str, Any], memo: dict[int, set[str]]) -> set[str]:
        key = id(join)
        if key not in memo:
            foreign = self.foreign_entity(entity, join)
            keys: set[str] = set()
            for candidate in self.documents[foreign]:
                if self._matches(foreign, join["operator"], candidate, memo):
                    keys |= _keys(candidate, join["foreignField"])
            memo[key] = keys
        return memo[key]


@dataclass
class Pool:
    """Every document owned by the sampled accounts."""

    accounts: tuple[int, ...]
    documents: dict[str, list[dict[str, Any]]]
    by_account: dict[str, dict[str, list[dict[str, Any]]]]

    def by_id(self) -> dict[str, dict[str, Any]]:
        return {doc["_id"]: doc for docs in self.documents.values() for doc in docs}


def sample_pool(spec: CrmSpec, size: int, rng: random.Random) -> Pool:
    accounts = tuple(sorted(rng.sample(spec.account_range, min(size, spec.accounts))))
    generator = CrmGenerator(spec)
    documents: dict[str, list[dict[str, Any]]] = {entity: [] for entity in ENTITY_KEYS}
    by_account: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for account in accounts:
        bucket: dict[str, list[dict[str, Any]]] = {entity: [] for entity in ENTITY_KEYS}
        for entity, document in generator.iter_account(account):
            bucket[entity].append(document)
            documents[entity].append(document)
        by_account[account_id(spec.seed, account)] = bucket
    return Pool(accounts, documents, by_account)


@dataclass
class _Draw:
    """Random building blocks for one query, scoped to a subset of the pool."""

    rng: random.Random
    pool: Pool
    index_names: Mapping[str, str]
    scope_ids: list[str]
    unscoped_foreign: frozenset[str]

    def scope(self, entity: str) -> dict[str, Any]:
        return {"in": {"path": SCOPE_PATH[entity], "value": list(self.scope_ids)}}

    def _anchor(self, entity: str) -> dict[str, Any] | None:
        """A document the predicate is built to match, usually from the scope so results are not empty."""
        docs = [doc for aid in self.scope_ids for doc in self.pool.by_account[aid][entity]]
        if not docs or self.rng.random() < 0.2:
            docs = self.pool.documents[entity]
        return self.rng.choice(docs) if docs else None

    def predicate(self, entity: str) -> dict[str, Any]:
        path, kind = self.rng.choice(PREDICATE_FIELDS[entity])
        anchor = self._anchor(entity)
        value = None if anchor is None else anchor.get(path)
        if kind == "text":
            terms = sorted(_terms(value)) if isinstance(value, str) else []
            return {"text": {"path": path, "query": self.rng.choice(terms) if terms else "unmatched"}}
        if kind == "bool":
            flag = value if isinstance(value, bool) else self.rng.random() < 0.5
            return {"equals": {"path": path, "value": flag}}
        bound = value if _is_number(value) else 0
        return {"range": {"path": path, **{key: bound for key in self.rng.choice(_RANGE_FORMS)}}}

    def condition(self, entity: str) -> dict[str, Any]:
        if self.rng.random() < 0.25:
            return {"compound": {"filter": [self.predicate(entity), self.predicate(entity)]}}
        return self.predicate(entity)

    def join(self, edge: Edge, *, scoped: bool) -> dict[str, Any]:
        condition = self.condition(edge.foreign)
        if scoped or edge.foreign not in self.unscoped_foreign:
            condition = {"compound": {"filter": [self.scope(edge.foreign), condition]}}
        spec: dict[str, Any] = {}
        # Self-joins may omit `from` or name their own index; both must behave the same.
        if edge.local != edge.foreign or self.rng.random() < 0.5:
            spec["from"] = self.index_names[edge.foreign]
        spec.update(localField=edge.local_field, foreignField=edge.foreign_field, operator=condition)
        return {"join": spec}

    def partner(self, edge: Edge) -> Edge:
        return self.rng.choice(EDGES_BY_LOCAL[edge.local])

    def coin(self, p: float = 0.5) -> bool:
        return self.rng.random() < p


def _semijoin(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    placement = draw.rng.choice(("local", "foreign", "both"))
    clauses = [draw.scope(edge.local)] if placement != "foreign" else []
    if draw.coin(0.4):
        clauses.append(draw.condition(edge.local))
    clauses.append(draw.join(edge, scoped=placement != "local"))
    return {"compound": {"filter": clauses}}, (edge,)


def _antijoin(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    clauses = [draw.scope(edge.local)]
    if draw.coin(0.4):
        clauses.append(draw.condition(edge.local))
    return {"compound": {"filter": clauses, "mustNot": [draw.join(edge, scoped=draw.coin())]}}, (edge,)


def _two_joins(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    other = draw.partner(edge)
    local_scope = draw.coin()
    clauses = [draw.scope(edge.local)] if local_scope else []
    clauses += [draw.join(edge, scoped=not local_scope), draw.join(other, scoped=draw.coin())]
    return {"compound": {"filter": clauses}}, (edge, other)


def _semi_anti(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    other = draw.partner(edge)
    local_scope = draw.coin()
    clauses = [draw.scope(edge.local)] if local_scope else []
    clauses.append(draw.join(edge, scoped=not local_scope))
    return {"compound": {"filter": clauses, "mustNot": [draw.join(other, scoped=draw.coin())]}}, (edge, other)


def _nested(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    other = draw.partner(edge)
    inner = {"compound": {"filter": [draw.join(edge, scoped=draw.coin())], "mustNot": [draw.join(other, scoped=draw.coin())]}}
    return {"compound": {"filter": [draw.scope(edge.local), inner]}}, (edge, other)


def _scored(draw: _Draw, edge: Edge) -> tuple[dict[str, Any], tuple[Edge, ...]]:
    query = {
        "compound": {
            "must": [draw.predicate(edge.local)],
            "filter": [draw.scope(edge.local), draw.join(edge, scoped=draw.coin())],
        }
    }
    return query, (edge,)


SHAPES: dict[str, Callable[[_Draw, Edge], tuple[dict[str, Any], tuple[Edge, ...]]]] = {
    "semijoin": _semijoin,
    "antijoin": _antijoin,
    "two-joins": _two_joins,
    "semi+anti": _semi_anti,
    "nested": _nested,
    "scored": _scored,
}


@dataclass(frozen=True)
class Check:
    number: int
    shape: str
    edges: tuple[str, ...]
    entity: str
    query: dict[str, Any]
    expected: tuple[str, ...]


def plan_checks(
    pool: Pool,
    index_names: Mapping[str, str],
    *,
    count: int,
    rng: random.Random,
    unscoped_foreign: frozenset[str] = frozenset(),
) -> list[Check]:
    """``count`` queries cycling through every (shape, edge) pair in a shuffled order."""
    if not pool.by_account:
        raise ValueError("the verification pool has no accounts")
    oracle = Oracle(pool.documents, index_names)
    combos = [(shape, edge) for shape in SHAPES for edge in EDGES]
    rng.shuffle(combos)
    account_ids = list(pool.by_account)
    checks: list[Check] = []
    for number in range(count):
        shape, edge = combos[number % len(combos)]
        scope_ids = rng.sample(account_ids, rng.randint(1, len(account_ids)))
        draw = _Draw(rng, pool, index_names, scope_ids, unscoped_foreign)
        node, edges = SHAPES[shape](draw, edge)
        if not oracle.is_scoped(edge.local, node):
            raise AssertionError(f"{shape} over {edge.name} is not confined to the pool: {node}")
        query = {**node, "returnStoredSource": True}
        checks.append(
            Check(
                number=number + 1,
                shape=shape,
                edges=tuple(item.name for item in edges),
                entity=edge.local,
                query=query,
                expected=tuple(oracle.matching_ids(edge.local, query)),
            )
        )
    return checks


@dataclass
class Outcome:
    check: Check
    returned: int = 0
    missing: list[str] = field(default_factory=list)
    unexpected: list[str] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def ok(self) -> bool:
        return not (self.missing or self.unexpected or self.duplicates or self.stale or self.error)

    def only_missing(self) -> bool:
        return bool(self.missing) and not (self.unexpected or self.duplicates or self.stale or self.error)

    def to_dict(self) -> dict[str, Any]:
        check = self.check
        out: dict[str, Any] = {
            "check": check.number,
            "shape": check.shape,
            "edges": list(check.edges),
            "index": check.entity,
            "expected": len(check.expected),
            "returned": self.returned,
        }
        for name in ("missing", "unexpected", "duplicates", "stale"):
            ids = getattr(self, name)
            if ids:
                out[name] = {"count": len(ids), "ids": ids[:MAX_LISTED_IDS]}
        if self.error:
            out["error"] = self.error
        out["query"] = check.query
        return out


def hit_document(hit: Mapping[str, Any]) -> dict[str, Any]:
    source = hit.get("storedSource")
    if isinstance(source, dict):
        if "_id" not in source and "_id" in hit:
            return {"_id": hit["_id"], **source}
        return source
    return {key: value for key, value in hit.items() if key not in _HIT_META}


def compare(check: Check, hits: Sequence[Mapping[str, Any]], documents: Mapping[str, dict[str, Any]]) -> Outcome:
    """Exact set comparison by ``_id``, plus stored source equal to the regenerated document."""
    docs = [hit_document(hit) for hit in hits]
    counts = Counter(str(doc.get("_id")) for doc in docs)
    expected = set(check.expected)
    stale: list[str] = []
    for doc in docs:
        doc_id = doc.get("_id")
        if doc_id in expected and doc != documents[doc_id] and doc_id not in stale:
            stale.append(doc_id)
    return Outcome(
        check,
        returned=len(docs),
        missing=[doc_id for doc_id in check.expected if doc_id not in counts],
        unexpected=sorted(doc_id for doc_id in counts if doc_id not in expected),
        duplicates=sorted(doc_id for doc_id, n in counts.items() if n > 1),
        stale=stale,
    )


def _describe(exc: BaseException) -> str:
    details = getattr(exc, "details", None)
    code = getattr(exc, "code", None)
    if callable(details) and callable(code):
        return f"{code().name}: {details()}"
    return f"{type(exc).__name__}: {exc}"


def _execute(check: Check, searcher: Searcher, index_ids: Mapping[str, str], documents: Mapping[str, dict[str, Any]]) -> Outcome:
    try:
        hits = searcher(index_ids[check.entity], check.query)
    except Exception as exc:
        return Outcome(check, error=_describe(exc))
    return compare(check, hits, documents)


def await_pool(
    searcher: Searcher,
    index_ids: Mapping[str, str],
    pool: Pool,
    *,
    timeout: float,
    poll: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> list[Outcome]:
    """Wait until each index holds exactly the pool's documents for the sampled accounts."""
    account_ids = list(pool.by_account)
    documents = pool.by_id()
    checks = [
        Check(
            number=0,
            shape="pool",
            edges=(),
            entity=entity,
            query={"in": {"path": SCOPE_PATH[entity], "value": account_ids}, "returnStoredSource": True},
            expected=tuple(doc["_id"] for doc in pool.documents[entity]),
        )
        for entity in ENTITY_KEYS
    ]
    deadline = clock() + timeout
    while True:
        outcomes = [_execute(check, searcher, index_ids, documents) for check in checks]
        settling = [outcome for outcome in outcomes if not outcome.ok]
        if not settling or clock() >= deadline or not all(o.only_missing() for o in settling):
            return outcomes
        sleep(poll)


def run_checks(
    checks: Sequence[Check],
    searcher: Searcher,
    index_ids: Mapping[str, str],
    pool: Pool,
    *,
    progress: bool = True,
) -> list[Outcome]:
    documents = pool.by_id()
    outcomes: list[Outcome] = []
    for check in tqdm(checks, unit="query", dynamic_ncols=True, disable=not progress):
        outcomes.append(_execute(check, searcher, index_ids, documents))
    return outcomes


def _tally(outcomes: Sequence[Outcome], key: Callable[[Outcome], Sequence[str]]) -> dict[str, dict[str, int]]:
    table: dict[str, dict[str, int]] = {}
    for outcome in outcomes:
        for name in key(outcome):
            row = table.setdefault(name, {"run": 0, "passed": 0, "failed": 0, "nonempty": 0})
            row["run"] += 1
            row["passed" if outcome.ok else "failed"] += 1
            row["nonempty"] += bool(outcome.check.expected)
    return dict(sorted(table.items()))


def _failures(outcomes: Sequence[Outcome]) -> tuple[list[dict[str, Any]], int]:
    failed = [outcome.to_dict() for outcome in outcomes if not outcome.ok]
    return failed[:MAX_LISTED_FAILURES], max(0, len(failed) - MAX_LISTED_FAILURES)


def verify_crm(
    spec: CrmSpec,
    *,
    index_ids: Mapping[str, str],
    index_names: Mapping[str, str],
    searcher: Searcher,
    verify_seed: int,
    pool_accounts: int = 20,
    queries: int = 200,
    timeout: float = 30.0,
    progress: bool = True,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Check the pool is loaded, then run ``queries`` join checks. ``failed`` counts every failing check."""
    if spec.accounts < 1:
        raise ValueError("verification needs at least one account")
    if pool_accounts < 1 or queries < 1:
        raise ValueError("pool_accounts and queries must be >= 1")
    rng = random.Random(verify_seed)
    pool = sample_pool(spec, pool_accounts, rng)
    report: dict[str, Any] = {
        "seed": spec.seed,
        "verify_seed": verify_seed,
        "pool_accounts": list(pool.accounts),
        "pool_documents": {entity: len(docs) for entity, docs in pool.documents.items()},
    }

    loaded = await_pool(searcher, index_ids, pool, timeout=timeout, sleep=sleep)
    report["pool_loaded"] = all(outcome.ok for outcome in loaded)
    if not report["pool_loaded"]:
        failures, omitted = _failures(loaded)
        report.update(queries=0, passed=0, failed=len(failures) + omitted, failures=failures)
        return report

    totals = spec.document_counts()
    unscoped = frozenset(entity for entity, total in totals.items() if total <= UNSCOPED_FOREIGN_LIMIT)
    checks = plan_checks(pool, index_names, count=queries, rng=rng, unscoped_foreign=unscoped)
    outcomes = run_checks(checks, searcher, index_ids, pool, progress=progress)
    failures, omitted = _failures(outcomes)
    passed = sum(outcome.ok for outcome in outcomes)
    report.update(
        queries=len(outcomes),
        passed=passed,
        failed=len(outcomes) - passed,
        nonempty=sum(bool(outcome.check.expected) for outcome in outcomes),
        shapes=_tally(outcomes, lambda outcome: (outcome.check.shape,)),
        edges=_tally(outcomes, lambda outcome: outcome.check.edges),
        failures=failures,
    )
    if omitted:
        report["failures_omitted"] = omitted
    return report


def mongot_searcher(service: Any = None, *, page_size: int = 1000, max_batches: int = 50) -> Searcher:
    """Drain every page of a search; refuse to compare a truncated result."""
    if service is None:
        from mong.service import MongotService

        service = MongotService()

    def search(index_id: str, query: dict[str, Any]) -> list[dict[str, Any]]:
        page = service.search(index_id, query, batch_size=page_size, drain=True, max_batches=max_batches)
        if page.get("truncated"):
            raise RuntimeError(f"more than {page_size * max_batches} hits; result truncated")
        return page["results"]

    return search
