"""Command line entry point for the CRM faker scripts."""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from typing import Any

from scripts.crm.generate import DEFAULT_ANCHOR, ENTITY_KEYS, CrmGenerator, CrmSpec, resolve_entities


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
        choices=("indexed", "committed", "visible"),
        default="indexed",
        help=(
            "Upsert write concern. 'indexed' returns when the batch is indexed and is the fast "
            "bulk path (default: indexed). 'visible' waits until the batch is searchable; "
            "'committed' waits until it is durable."
        ),
    )
    load.add_argument(
        "--workers",
        type=int,
        default=None,
        help=(
            "Ingest processes. Each process has its own queue and mongot client and generates "
            "its own account slice (default: 1 per 32 accounts, max 8; under 32 accounts stays "
            "in-process)"
        ),
    )
    load.add_argument("--index-suffix", default="_search", help="Search index name suffix (default: _search)")
    load.add_argument("--no-progress", action="store_true", help="Disable the progress bar")

    verify = parser.add_argument_group("verifying joins")
    verify.add_argument(
        "--verify",
        action="store_true",
        help=(
            "Run parent/child join queries against the loaded indexes and check the exact documents "
            "returned. Pass the same --seed and shape flags as the load; combine with --load to verify "
            "right after loading"
        ),
    )
    verify.add_argument("--verify-queries", type=int, default=200, help="Join queries to run (default: 200)")
    verify.add_argument(
        "--verify-accounts",
        type=int,
        default=20,
        help="Accounts sampled as the verification pool; every query is scoped to some of them (default: 20)",
    )
    verify.add_argument(
        "--verify-seed",
        type=int,
        default=None,
        help="Seed for the pool and query shapes; the same value replays the same queries (default: random, printed)",
    )
    verify.add_argument(
        "--verify-timeout",
        type=float,
        default=30.0,
        help="Seconds to wait for the pool's documents to become searchable (default: 30)",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")
    if args.workers is not None and args.workers < 1:
        parser.error("--workers must be >= 1")
    if args.verify and not args.load and args.seed is None:
        parser.error("--verify needs the --seed the data was loaded with")
    if args.verify_queries < 1 or args.verify_accounts < 1:
        parser.error("--verify-queries and --verify-accounts must be >= 1")
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

    if not args.load and not args.verify:
        for _, entity, document in CrmGenerator(spec).iter_documents(entities):
            sys.stdout.write(json.dumps({"entity": entity, "document": document}) + "\n")
        return
    if args.load:
        _load(args, spec, seed, entities)
    if args.verify:
        _verify(args, spec)


def _load(args: argparse.Namespace, spec: CrmSpec, seed: int, entities: tuple[str, ...]) -> None:
    from mong.service import MongotService
    from scripts.crm.load import IngestFailed, default_worker_count, ensure_targets, stream_crm_documents

    workers = args.workers if args.workers is not None else default_worker_count(spec.accounts)
    print(
        f"seed={seed} accounts={spec.accounts} start_account={spec.start_account} "
        f"workers={workers} concern={args.concern}",
        flush=True,
    )
    targets = ensure_targets(
        MongotService(),
        entities=entities,
        index_suffix=args.index_suffix,
        log=lambda line: print(line, flush=True),
    )
    try:
        report: dict[str, Any] = stream_crm_documents(
            spec,
            index_ids={entity: target["index_id"] for entity, target in targets.items()},
            entities=entities,
            batch_size=args.batch_size,
            concern=args.concern,
            progress=not args.no_progress,
            workers=workers,
        )
    except IngestFailed as exc:
        report = exc.report
        report["targets"] = targets
        print(json.dumps(report, indent=2))
        print(str(exc), file=sys.stderr)
        _print_resume(report, seed, spec, prefix="Load failed.")
        sys.exit(1)
    report["targets"] = targets
    print(json.dumps(report, indent=2))
    if report["interrupted"]:
        _print_resume(report, seed, spec, prefix="Interrupted.")
        sys.exit(130)


def _verify(args: argparse.Namespace, spec: CrmSpec) -> None:
    from mong.service import MongotService
    from scripts.crm.load import find_search_index
    from scripts.crm.verify import mongot_searcher, verify_crm

    service = MongotService()
    index_names = {entity: f"{entity}{args.index_suffix}" for entity in ENTITY_KEYS}
    index_ids: dict[str, str] = {}
    for entity, name in index_names.items():
        index = find_search_index(service, name)
        if index is None:
            print(f"{name}: search index not found; load the dataset first", file=sys.stderr)
            sys.exit(1)
        index_ids[entity] = index["index_id"]
    verify_seed = args.verify_seed if args.verify_seed is not None else random.SystemRandom().randrange(2**31)
    print(
        f"verify seed={spec.seed} verify_seed={verify_seed} pool_accounts={min(args.verify_accounts, spec.accounts)} "
        f"queries={args.verify_queries}",
        flush=True,
    )
    report = verify_crm(
        spec,
        index_ids=index_ids,
        index_names=index_names,
        searcher=mongot_searcher(service),
        verify_seed=verify_seed,
        pool_accounts=args.verify_accounts,
        queries=args.verify_queries,
        timeout=args.verify_timeout,
        progress=not args.no_progress,
    )
    print(json.dumps(report, indent=2))
    if not report["pool_loaded"]:
        print(
            "The sampled accounts' documents do not match this spec. Check --seed and the shape flags, "
            "or finish the load.",
            file=sys.stderr,
        )
        sys.exit(1)
    if report["failed"]:
        print(
            f"{report['failed']} of {report['queries']} join checks failed. "
            f"Replay with --verify-seed {verify_seed}",
            file=sys.stderr,
        )
        sys.exit(1)


def _print_resume(report: dict[str, Any], seed: int, spec: CrmSpec, *, prefix: str) -> None:
    resume = report.get("resume_from_account")
    if resume is None:
        return
    print(
        f"{prefix} Resume with: --seed {seed} "
        f"--start-account {resume} "
        f"--accounts {spec.start_account + spec.accounts - resume}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
