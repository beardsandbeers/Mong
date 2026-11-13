"""Generate fake CRM Accounts, Contacts, and Opportunities with relationship ids."""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from faker import Faker

fake = Faker()

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


def _new_id() -> str:
    return str(uuid4())


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _address() -> dict[str, str]:
    return {
        "street": fake.street_address(),
        "city": fake.city(),
        "state": fake.state_abbr(),
        "postal_code": fake.postcode(),
        "country": fake.country_code(representation="alpha-2"),
    }


def generate_account(*, seed: int | None = None) -> dict[str, Any]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    created = fake.date_time_between(start_date="-3y", end_date="-30d", tzinfo=timezone.utc)
    updated = fake.date_time_between(start_date=created, end_date="now", tzinfo=timezone.utc)
    company = fake.company()

    return {
        "_id": _new_id(),
        "name": company,
        "account_number": fake.bothify(text="ACC-######"),
        "type": random.choice(ACCOUNT_TYPES),
        "status": random.choice(ACCOUNT_STATUSES),
        "industry": random.choice(INDUSTRIES),
        "website": f"https://{fake.domain_name()}",
        "phone": fake.phone_number(),
        "annual_revenue": round(random.uniform(50_000, 50_000_000), 2),
        "employee_count": random.randint(5, 25_000),
        "billing_address": _address(),
        "shipping_address": _address(),
        "description": fake.catch_phrase(),
        "owner_name": fake.name(),
        "owner_email": fake.company_email(),
        "created_at": _iso(created),
        "updated_at": _iso(updated),
    }


def generate_accounts(count: int = 10, *, seed: int | None = None) -> list[dict[str, Any]]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)
    return [generate_account() for _ in range(count)]


def generate_contact(
    *,
    account_id: str,
    opportunity_ids: list[str] | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    created = fake.date_time_between(start_date="-3y", end_date="-14d", tzinfo=timezone.utc)
    updated = fake.date_time_between(start_date=created, end_date="now", tzinfo=timezone.utc)
    first = fake.first_name()
    last = fake.last_name()

    return {
        "_id": _new_id(),
        "account_id": account_id,
        "opportunity_ids": list(opportunity_ids or []),
        "first_name": first,
        "last_name": last,
        "full_name": f"{first} {last}",
        "email": fake.company_email(),
        "phone": fake.phone_number(),
        "mobile": fake.phone_number(),
        "title": fake.job(),
        "department": random.choice(DEPARTMENTS),
        "status": random.choice(CONTACT_STATUSES),
        "mailing_address": _address(),
        "is_primary": False,
        "owner_name": fake.name(),
        "owner_email": fake.company_email(),
        "created_at": _iso(created),
        "updated_at": _iso(updated),
    }


def generate_contacts(
    accounts: list[dict[str, Any]],
    *,
    per_account: tuple[int, int] = (1, 5),
    seed: int | None = None,
) -> list[dict[str, Any]]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    contacts: list[dict[str, Any]] = []
    for account in accounts:
        n = random.randint(per_account[0], per_account[1])
        for i in range(n):
            contact = generate_contact(account_id=account["_id"])
            contact["is_primary"] = i == 0
            contacts.append(contact)
    return contacts


def generate_opportunity(
    *,
    account_id: str,
    contact_ids: list[str],
    primary_contact_id: str | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    if not contact_ids:
        raise ValueError("opportunity requires at least one contact_id")

    created = fake.date_time_between(start_date="-2y", end_date="-7d", tzinfo=timezone.utc)
    updated = fake.date_time_between(start_date=created, end_date="now", tzinfo=timezone.utc)
    close_date = fake.date_time_between(start_date="-6m", end_date="+9m", tzinfo=timezone.utc)
    stage = random.choice(OPPORTUNITY_STAGES)
    amount = round(random.uniform(5_000, 2_500_000), 2)
    primary = primary_contact_id or contact_ids[0]

    return {
        "_id": _new_id(),
        "account_id": account_id,
        "contact_ids": list(contact_ids),
        "primary_contact_id": primary,
        "name": f"{fake.bs().title()} — {fake.company_suffix()}",
        "opportunity_number": fake.bothify(text="OPP-######"),
        "stage": stage,
        "probability": STAGE_PROBABILITY[stage],
        "amount": amount,
        "expected_revenue": round(amount * STAGE_PROBABILITY[stage] / 100, 2),
        "type": random.choice(OPPORTUNITY_TYPES),
        "close_date": _iso(close_date),
        "description": fake.paragraph(nb_sentences=2),
        "next_step": fake.sentence(nb_words=6),
        "owner_name": fake.name(),
        "owner_email": fake.company_email(),
        "created_at": _iso(created),
        "updated_at": _iso(updated),
    }


def generate_opportunities(
    accounts: list[dict[str, Any]],
    contacts: list[dict[str, Any]],
    *,
    per_account: tuple[int, int] = (0, 4),
    seed: int | None = None,
) -> list[dict[str, Any]]:
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    contacts_by_account: dict[str, list[dict[str, Any]]] = {}
    for contact in contacts:
        contacts_by_account.setdefault(contact["account_id"], []).append(contact)

    opportunities: list[dict[str, Any]] = []
    for account in accounts:
        account_contacts = contacts_by_account.get(account["_id"], [])
        if not account_contacts:
            continue
        n = random.randint(per_account[0], per_account[1])
        for _ in range(n):
            related = random.sample(
                account_contacts,
                k=min(len(account_contacts), random.randint(1, 3)),
            )
            contact_ids = [c["_id"] for c in related]
            primary = next((c["_id"] for c in related if c.get("is_primary")), contact_ids[0])
            opportunities.append(
                generate_opportunity(
                    account_id=account["_id"],
                    contact_ids=contact_ids,
                    primary_contact_id=primary,
                )
            )
    return opportunities


def _link_contacts_to_opportunities(
    contacts: list[dict[str, Any]],
    opportunities: list[dict[str, Any]],
) -> None:
    """Back-fill contact.opportunity_ids from opportunity.contact_ids."""
    opp_ids_by_contact: dict[str, list[str]] = {}
    for opp in opportunities:
        for contact_id in opp["contact_ids"]:
            opp_ids_by_contact.setdefault(contact_id, []).append(opp["_id"])
    for contact in contacts:
        contact["opportunity_ids"] = opp_ids_by_contact.get(contact["_id"], [])


def generate_crm_dataset(
    *,
    account_count: int = 10,
    contacts_per_account: tuple[int, int] = (1, 5),
    opportunities_per_account: tuple[int, int] = (0, 4),
    seed: int | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Generate a linked CRM dataset (in memory only — nothing is stored)."""
    if seed is not None:
        Faker.seed(seed)
        random.seed(seed)

    accounts = generate_accounts(account_count)
    contacts = generate_contacts(accounts, per_account=contacts_per_account)
    opportunities = generate_opportunities(
        accounts,
        contacts,
        per_account=opportunities_per_account,
    )
    _link_contacts_to_opportunities(contacts, opportunities)
    return {
        "accounts": accounts,
        "contacts": contacts,
        "opportunities": opportunities,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Generate fake CRM Accounts, Contacts, and Opportunities (no storage).",
    )
    parser.add_argument("--accounts", type=int, default=5, help="Number of accounts (default: 5)")
    parser.add_argument(
        "--contacts-min",
        type=int,
        default=1,
        help="Min contacts per account (default: 1)",
    )
    parser.add_argument(
        "--contacts-max",
        type=int,
        default=4,
        help="Max contacts per account (default: 4)",
    )
    parser.add_argument(
        "--opportunities-min",
        type=int,
        default=0,
        help="Min opportunities per account (default: 0)",
    )
    parser.add_argument(
        "--opportunities-max",
        type=int,
        default=3,
        help="Max opportunities per account (default: 3)",
    )
    parser.add_argument("--seed", type=int, default=None, help="RNG seed for reproducibility")
    parser.add_argument(
        "--entity",
        choices=("all", "accounts", "contacts", "opportunities"),
        default="all",
        help="Which entity set to print (default: all)",
    )
    args = parser.parse_args(argv)

    if args.contacts_min > args.contacts_max:
        parser.error("--contacts-min cannot exceed --contacts-max")
    if args.opportunities_min > args.opportunities_max:
        parser.error("--opportunities-min cannot exceed --opportunities-max")

    dataset = generate_crm_dataset(
        account_count=args.accounts,
        contacts_per_account=(args.contacts_min, args.contacts_max),
        opportunities_per_account=(args.opportunities_min, args.opportunities_max),
        seed=args.seed,
    )

    if args.entity == "all":
        payload: Any = {
            "counts": {k: len(v) for k, v in dataset.items()},
            **dataset,
        }
    else:
        payload = dataset[args.entity]

    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
