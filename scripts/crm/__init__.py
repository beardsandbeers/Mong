"""Deterministic fake CRM generators (Accounts, Contacts, Opportunities)."""

from scripts.crm.generate import (
    AccountPlan,
    CrmGenerator,
    CrmSpec,
    account_id,
    contact_id,
    generate_crm_dataset,
    opportunity_id,
)

__all__ = [
    "AccountPlan",
    "CrmGenerator",
    "CrmSpec",
    "account_id",
    "contact_id",
    "generate_crm_dataset",
    "opportunity_id",
]
