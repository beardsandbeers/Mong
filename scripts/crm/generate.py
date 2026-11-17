"""Deterministic, streaming fake CRM generator (Accounts, Contacts, Opportunities).

Every document is a pure function of ``(seed, entity, account_index, child_index)``.

Accounts are packed into tenants: ``--accounts`` accounts share one ``tenant_id``,
then the next ``--accounts`` share the next id. ``tenant_id`` is a UUID derived
from ``(seed, tenant index)``, so the same seed rebuilds the same grouping.
The id is copied onto each account's contacts and opportunities.

- IDs are UUIDv5 values derived from those coordinates, so any entity can be
  generated (or re-generated) on its own and still reference valid ids in the
  other indexes. Re-running with the same seed upserts the same documents.
- Each account owns a plan (contact count, opportunity count, opportunity ->
  contact links) drawn from its own RNG streams, so no account depends on any
  other and memory stays bounded by a single account's link table.
"""

from __future__ import annotations

import hashlib
import random
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Sequence

from faker import Faker

ENTITY_KEYS = ("accounts", "contacts", "opportunities")
ID_NAMESPACE = uuid.UUID("6f1d3c2e-8b1a-4e57-9a43-2c6f0e7d9b10")
DEFAULT_ANCHOR = datetime(2026, 1, 1, tzinfo=timezone.utc)
MAX_CONTACTS_PER_OPPORTUNITY = 3

ACCOUNT_TYPES = ("Customer", "Prospect", "Partner", "Reseller")
ACCOUNT_STATUSES = ("Active", "Inactive", "On Hold")
INDUSTRIES = (
    "Technology",
    "Healthcare",
    "Finance",
    "Manufacturing",
    "Retail",
    "Education",
    "Energy",
    "Telecommunications",
    "Professional Services",
    "Media",
)

CONTACT_STATUSES = ("Active", "Inactive", "Left Company")
DEPARTMENTS = (
    "Sales",
    "Marketing",
    "Engineering",
    "Finance",
    "Operations",
    "Customer Success",
    "IT",
    "Executive",
)

OPPORTUNITY_STAGES = (
    "Prospecting",
    "Qualification",
    "Needs Analysis",
    "Proposal",
    "Negotiation",
    "Closed Won",
    "Closed Lost",
)
OPPORTUNITY_TYPES = ("New Business", "Upsell", "Renewal", "Cross-sell")
STAGE_PROBABILITY = {
    "Prospecting": 10,
    "Qualification": 20,
    "Needs Analysis": 40,
    "Proposal": 60,
    "Negotiation": 80,
    "Closed Won": 100,
    "Closed Lost": 0,
}


def resolve_entities(entity: str) -> tuple[str, ...]:
    if entity == "all":
        return ENTITY_KEYS
    if entity not in ENTITY_KEYS:
        raise ValueError(f"Unknown entity: {entity}")
    return (entity,)


def _derive(seed: int, *parts: Any) -> int:
    key = ":".join(str(part) for part in (seed, *parts)).encode()
    return int.from_bytes(hashlib.blake2b(key, digest_size=8).digest(), "big")


def tenant_id(seed: int, tenant: int) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{seed}:tenant:{tenant}"))


def account_id(seed: int, account: int) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{seed}:account:{account}"))


def contact_id(seed: int, account: int, contact: int) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{seed}:contact:{account}:{contact}"))


def opportunity_id(seed: int, account: int, opportunity: int) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{seed}:opportunity:{account}:{opportunity}"))


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _days_from(rng: random.Random, anchor: datetime, start_days: int, end_days: int) -> datetime:
    """Random instant between anchor+start_days and anchor+end_days."""
    return anchor + timedelta(seconds=rng.randint(start_days * 86_400, end_days * 86_400))


def _between(rng: random.Random, start: datetime, end: datetime) -> datetime:
    span = max(0, int((end - start).total_seconds()))
    return start + timedelta(seconds=rng.randint(0, span))


@dataclass(frozen=True)
class AccountPlan:
    index: int
    contact_count: int
    opportunity_contacts: tuple[tuple[int, ...], ...]

    @property
    def opportunity_count(self) -> int:
        return len(self.opportunity_contacts)

    def contact_opportunities(self) -> list[list[int]]:
        reverse: list[list[int]] = [[] for _ in range(self.contact_count)]
        for opp, contacts in enumerate(self.opportunity_contacts):
            for contact in contacts:
                reverse[contact].append(opp)
        return reverse


@dataclass(frozen=True)
class CrmSpec:
    seed: int
    accounts: int
    tenants: int = 1
    contacts_per_account: tuple[int, int] = (1, 4)
    opportunities_per_account: tuple[int, int] = (0, 3)
    start_account: int = 0
    anchor: datetime = DEFAULT_ANCHOR

    def __post_init__(self) -> None:
        for label, (lo, hi) in (
            ("contacts_per_account", self.contacts_per_account),
            ("opportunities_per_account", self.opportunities_per_account),
        ):
            if lo < 0 or lo > hi:
                raise ValueError(f"{label} must satisfy 0 <= min <= max, got {(lo, hi)}")
        if self.accounts < 0 or self.tenants < 0 or self.start_account < 0:
            raise ValueError("tenants, accounts, and start_account must be >= 0")

    @property
    def total_accounts(self) -> int:
        """Accounts in the full dataset: tenants × accounts per tenant."""
        return self.tenants * self.accounts

    @property
    def run_accounts(self) -> int:
        """Accounts this run emits, from ``start_account`` through the end of the dataset."""
        if self.start_account >= self.total_accounts:
            return 0
        return self.total_accounts - self.start_account

    def tenant_index(self, account: int) -> int:
        """Tenant that owns global account index ``account``.

        Accounts are packed in order: the first ``accounts`` belong to tenant 0,
        the next ``accounts`` to tenant 1, and so on.
        """
        if self.accounts < 1:
            raise ValueError("cannot place an account when accounts per tenant is 0")
        return account // self.accounts

    @property
    def account_range(self) -> range:
        return range(self.start_account, self.start_account + self.run_accounts)

    def counts(self, account: int) -> tuple[int, int]:
        """(contact_count, opportunity_count); opportunities need at least one contact."""
        rng = random.Random(_derive(self.seed, "counts", account))
        contacts = rng.randint(*self.contacts_per_account)
        opportunities = rng.randint(*self.opportunities_per_account)
        return contacts, opportunities if contacts else 0

    def plan(self, account: int) -> AccountPlan:
        contacts, opportunities = self.counts(account)
        rng = random.Random(_derive(self.seed, "links", account))
        links: list[tuple[int, ...]] = []
        for _ in range(opportunities):
            k = rng.randint(1, min(contacts, MAX_CONTACTS_PER_OPPORTUNITY))
            related = rng.sample(range(contacts), k)
            if 0 in related:
                related.remove(0)
                related.insert(0, 0)
            links.append(tuple(related))
        return AccountPlan(account, contacts, tuple(links))

    def document_counts(self, entities: Sequence[str] = ENTITY_KEYS) -> dict[str, int]:
        totals = {key: 0 for key in entities}
        for account in self.account_range:
            contacts, opportunities = self.counts(account)
            if "accounts" in totals:
                totals["accounts"] += 1
            if "contacts" in totals:
                totals["contacts"] += contacts
            if "opportunities" in totals:
                totals["opportunities"] += opportunities
        return totals


class CrmGenerator:
    def __init__(self, spec: CrmSpec, *, locale: str | None = None) -> None:
        self.spec = spec
        self.fake = Faker(locale) if locale else Faker()

    def _streams(self, *parts: Any) -> random.Random:
        seed = _derive(self.spec.seed, *parts)
        self.fake.seed_instance(seed)
        return random.Random(seed)

    def _address(self) -> dict[str, str]:
        fake = self.fake
        return {
            "street": fake.street_address(),
            "city": fake.city(),
            "state": fake.state_abbr(),
            "postal_code": fake.postcode(),
            "country": fake.country_code(representation="alpha-2"),
        }

    def account(self, account: int) -> dict[str, Any]:
        rng = self._streams("account", account)
        fake = self.fake
        anchor = self.spec.anchor
        created = _days_from(rng, anchor, -3 * 365, -30)
        updated = _between(rng, created, anchor)
        return {
            "_id": account_id(self.spec.seed, account),
            "tenant_id": tenant_id(self.spec.seed, self.spec.tenant_index(account)),
            "name": fake.company(),
            "account_number": fake.bothify(text="ACC-######"),
            "type": rng.choice(ACCOUNT_TYPES),
            "status": rng.choice(ACCOUNT_STATUSES),
            "industry": rng.choice(INDUSTRIES),
            "website": f"https://{fake.domain_name()}",
            "phone": fake.phone_number(),
            "annual_revenue": round(rng.uniform(50_000, 50_000_000), 2),
            "employee_count": rng.randint(5, 25_000),
            "billing_address": self._address(),
            "shipping_address": self._address(),
            "description": fake.catch_phrase(),
            "owner_name": fake.name(),
            "owner_email": fake.company_email(),
            "created_at": _iso(created),
            "updated_at": _iso(updated),
        }

    def contact(self, account: int, contact: int, opportunity_indexes: Sequence[int]) -> dict[str, Any]:
        rng = self._streams("contact", account, contact)
        fake = self.fake
        anchor = self.spec.anchor
        seed = self.spec.seed
        created = _days_from(rng, anchor, -3 * 365, -14)
        updated = _between(rng, created, anchor)
        first = fake.first_name()
        last = fake.last_name()
        return {
            "_id": contact_id(seed, account, contact),
            "tenant_id": tenant_id(seed, self.spec.tenant_index(account)),
            "account_id": account_id(seed, account),
            "opportunity_ids": [opportunity_id(seed, account, opp) for opp in opportunity_indexes],
            "first_name": first,
            "last_name": last,
            "full_name": f"{first} {last}",
            "email": fake.company_email(),
            "phone": fake.phone_number(),
            "mobile": fake.phone_number(),
            "title": fake.job(),
            "department": rng.choice(DEPARTMENTS),
            "status": rng.choice(CONTACT_STATUSES),
            "mailing_address": self._address(),
            "is_primary": contact == 0,
            "owner_name": fake.name(),
            "owner_email": fake.company_email(),
            "created_at": _iso(created),
            "updated_at": _iso(updated),
        }

    def opportunity(self, account: int, opportunity: int, contact_indexes: Sequence[int]) -> dict[str, Any]:
        if not contact_indexes:
            raise ValueError("opportunity requires at least one contact")
        rng = self._streams("opportunity", account, opportunity)
        fake = self.fake
        anchor = self.spec.anchor
        seed = self.spec.seed
        created = _days_from(rng, anchor, -2 * 365, -7)
        updated = _between(rng, created, anchor)
        close_date = _days_from(rng, anchor, -182, 273)
        stage = rng.choice(OPPORTUNITY_STAGES)
        amount = round(rng.uniform(5_000, 2_500_000), 2)
        contact_ids = [contact_id(seed, account, c) for c in contact_indexes]
        return {
            "_id": opportunity_id(seed, account, opportunity),
            "tenant_id": tenant_id(seed, self.spec.tenant_index(account)),
            "account_id": account_id(seed, account),
            "contact_ids": contact_ids,
            "primary_contact_id": contact_ids[0],
            "name": f"{fake.bs().title()} — {fake.company_suffix()}",
            "opportunity_number": fake.bothify(text="OPP-######"),
            "stage": stage,
            "probability": STAGE_PROBABILITY[stage],
            "amount": amount,
            "expected_revenue": round(amount * STAGE_PROBABILITY[stage] / 100, 2),
            "type": rng.choice(OPPORTUNITY_TYPES),
            "close_date": _iso(close_date),
            "description": fake.paragraph(nb_sentences=2),
            "next_step": fake.sentence(nb_words=6),
            "owner_name": fake.name(),
            "owner_email": fake.company_email(),
            "created_at": _iso(created),
            "updated_at": _iso(updated),
        }

    def iter_account(
        self,
        account: int,
        entities: Sequence[str] = ENTITY_KEYS,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        """Yield (entity, document) for one account; documents are built lazily."""
        if "accounts" in entities:
            yield "accounts", self.account(account)
        if "contacts" not in entities and "opportunities" not in entities:
            return
        plan = self.spec.plan(account)
        if "contacts" in entities:
            reverse = plan.contact_opportunities()
            for contact in range(plan.contact_count):
                yield "contacts", self.contact(account, contact, reverse[contact])
        if "opportunities" in entities:
            for opp, contacts in enumerate(plan.opportunity_contacts):
                yield "opportunities", self.opportunity(account, opp, contacts)

    def iter_documents(
        self,
        entities: Sequence[str] = ENTITY_KEYS,
    ) -> Iterator[tuple[int, str, dict[str, Any]]]:
        """Yield (account_index, entity, document) across the spec's account range."""
        for account in self.spec.account_range:
            for entity, document in self.iter_account(account, entities):
                yield account, entity, document


def generate_crm_dataset(
    *,
    account_count: int = 10,
    tenants: int = 1,
    contacts_per_account: tuple[int, int] = (1, 5),
    opportunities_per_account: tuple[int, int] = (0, 4),
    seed: int = 0,
) -> dict[str, list[dict[str, Any]]]:
    """Collect a small dataset in memory (tests / quick inspection only)."""
    spec = CrmSpec(
        seed=seed,
        accounts=account_count,
        tenants=tenants,
        contacts_per_account=contacts_per_account,
        opportunities_per_account=opportunities_per_account,
    )
    dataset: dict[str, list[dict[str, Any]]] = {key: [] for key in ENTITY_KEYS}
    for _, entity, document in CrmGenerator(spec).iter_documents():
        dataset[entity].append(document)
    return dataset
