"""Command line entry point for the CRM faker scripts."""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from typing import Any

from scripts.crm.generate import DEFAULT_ANCHOR, CrmGenerator, CrmSpec, resolve_entities


def _anchor(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid ISO date: {value}") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.crm",
        description=(
            "Deterministically generate fake CRM Accounts, Contacts, and Opportunities. "
            "Prints NDJSON by default; --load creates search indexes and streams batches into mongot."
        ),
    )
    shape = parser.add_argument_group("dataset shape")
    shape.add_argument("--accounts", type=int, default=5, help="Number of accounts (default: 5)")
    shape.add_argument("--contacts-min", type=int, default=1, help="Min contacts per account (default: 1)")
    shape.add_argument("--contacts-max", type=int, default=4, help="Max contacts per account (default: 4)")
    shape.add_argument(
        "--opportunities-min", type=int, default=0, help="Min opportunities per account (default: 0)"
    )
    shape.add_argument(
        "--opportunities-max", type=int, default=3, help="Max opportunities per account (default: 3)"
    )
    shape.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Seed for ids and content; same seed => same documents (default: random, printed)",
    )
    shape.add_argument(
        "--start-account",
        type=int,
        default=0,
        help="First account index; use to resume or extend a dataset (default: 0)",
    )
    shape.add_argument(
        "--anchor-date",
        type=_anchor,
        default=DEFAULT_ANCHOR,
        help=f"Reference 'now' for generated dates (default: {DEFAULT_ANCHOR.date().isoformat()})",
    )
    shape.add_argument(
        "--entity",
        choices=("all", "accounts", "contacts", "opportunities"),
        default="all",
        help="Which entity set to print/load (default: all)",
    )

    load = parser.add_argument_group("loading into mongot")
    load.add_argument("--load", action="store_true", help="Create search indexes and upsert documents into them")
    load.add_argument("--batch-size", type=int, default=100, help="Docs per upsert call (default: 100)")
    load.add_argument(
        "--concern",
        choices=("committed", "indexed", "visible"),
        default="committed",
        help="Upsert write concern; 'visible' waits for search visibility per batch (default: committed)",
    )
    load.add_argument("--index-suffix", default="_search", help="Search index name suffix (default: _search)")
    load.add_argument("--no-progress", action="store_true", help="Disable the progress bar")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**31)
    try:
        spec = CrmSpec(
            seed=seed,
            accounts=args.accounts,
            contacts_per_account=(args.contacts_min, args.contacts_max),
            opportunities_per_account=(args.opportunities_min, args.opportunities_max),
            start_account=args.start_account,
            anchor=args.anchor_date,
        )
    except ValueError as exc:
        parser.error(str(exc))
    entities = resolve_entities(args.entity)

    if not args.load:
        for _, entity, document in CrmGenerator(spec).iter_documents(entities):
            sys.stdout.write(json.dumps({"entity": entity, "document": document}) + "\n")
        return

    from mong.client import create_client
    from mong.service import MongotService
    from scripts.crm.load import ensure_targets, stream_crm_documents

    print(f"seed={seed} accounts={spec.accounts} start_account={spec.start_account}", flush=True)
    targets = ensure_targets(
        MongotService(),
        entities=entities,
        index_suffix=args.index_suffix,
        log=lambda line: print(line, flush=True),
    )
    with create_client() as client:
        report: dict[str, Any] = stream_crm_documents(
            spec,
            upserter=client,
            index_ids={entity: target["index_id"] for entity, target in targets.items()},
            entities=entities,
            batch_size=args.batch_size,
            concern=args.concern,
            progress=not args.no_progress,
        )
    report["targets"] = targets
    print(json.dumps(report, indent=2))
    if report["interrupted"]:
        print(
            f"Interrupted. Resume with: --seed {seed} "
            f"--start-account {report['resume_from_account']} "
            f"--accounts {spec.start_account + spec.accounts - report['resume_from_account']}",
            file=sys.stderr,
        )
        sys.exit(130)


if __name__ == "__main__":
    main()
