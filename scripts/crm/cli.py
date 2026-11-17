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
            "Prints NDJSON by default. --load streams batches into mongot search indexes "
            "or mongod collections (--target)."
        ),
    )
    shape = parser.add_argument_group("dataset shape")
    shape.add_argument(
        "--tenants",
        type=int,
        default=1,
        help="Number of tenants. Each tenant owns --accounts accounts (default: 1)",
    )
    shape.add_argument(
        "--accounts",
        type=int,
        default=5,
        help="Accounts per tenant (default: 5). Total accounts are tenants × accounts",
    )
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

    load = parser.add_argument_group("loading")
    load.add_argument(
        "--load",
        action="store_true",
        help="Create the destination and upsert documents into it",
    )
    load.add_argument(
        "--target",
        choices=("mongot", "mongod"),
        default="mongot",
        help=(
            "Where --load writes. mongot upserts standalone search indexes (default). "
            "mongod upserts collections in a MongoDB database."
        ),
    )
    load.add_argument("--batch-size", type=int, default=100, help="Docs per upsert call (default: 100)")
    load.add_argument(
        "--concern",
        choices=("indexed", "committed", "visible", "acknowledged", "journaled", "majority"),
        default=None,
        help=(
            "Write concern. mongot: indexed (default), committed, visible. "
            "mongod: acknowledged (default), journaled, majority."
        ),
    )
    load.add_argument(
        "--workers",
        type=int,
        default=None,
        help=(
            "Ingest processes. Each process has its own queue and writer and generates "
            "its own account slice (default: 1 per 32 accounts, max 8; under 32 accounts stays "
            "in-process)"
        ),
    )
    load.add_argument(
        "--index-suffix",
        default=None,
        help="Search index name suffix for either target (default: _search)",
    )
    load.add_argument(
        "--mongo-uri",
        default=None,
        help="mongod connection URI (default: MONGODB_URI, otherwise mongodb://127.0.0.1:27017)",
    )
    load.add_argument("--database", default=None, help="mongod database name (default: crm)")
    load.add_argument("--no-progress", action="store_true", help="Disable the progress bar")

    verify = parser.add_argument_group("verifying joins")
    verify.add_argument(
        "--verify",
        action="store_true",
        help=(
            "Run parent/child join queries against the loaded mongot indexes and check the exact "
            "documents returned. Requires --target mongot. Pass the same --seed and shape flags as "
            "the load; combine with --load to verify right after loading"
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

    if args.tenants < 0:
        parser.error("--tenants must be >= 0")
    if args.accounts < 0:
        parser.error("--accounts must be >= 0")
    if args.batch_size < 1:
        parser.error("--batch-size must be >= 1")
    if args.workers is not None and args.workers < 1:
        parser.error("--workers must be >= 1")
    if args.verify and args.target != "mongot":
        parser.error("--verify checks mongot join queries; it requires --target mongot")
    if args.verify and not args.load and args.seed is None:
        parser.error("--verify needs the --seed the data was loaded with")
    if args.verify_queries < 1 or args.verify_accounts < 1:
        parser.error("--verify-queries and --verify-accounts must be >= 1")
    if args.target == "mongot" and (args.mongo_uri is not None or args.database is not None):
        parser.error("--mongo-uri and --database apply only with --target mongod")
    if args.concern is not None:
        from scripts.ingest.concerns import concerns_for

        if args.concern not in concerns_for(args.target):
            allowed = ", ".join(concerns_for(args.target))
            parser.error(
                f"--concern {args.concern} is not valid for --target {args.target} ({allowed})"
            )
    if args.index_suffix is None:
        args.index_suffix = "_search"
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(2**31)
    try:
        spec = CrmSpec(
            seed=seed,
            accounts=args.accounts,
            tenants=args.tenants,
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
        from scripts.crm.targets import open_target

        try:
            target = open_target(
                args.target,
                index_suffix=args.index_suffix,
                mongo_uri=args.mongo_uri,
                database=args.database,
            )
        except ValueError as exc:
            parser.error(str(exc))
        concern = args.concern or target.default_concern
        _load(args, spec, seed, entities, target, concern)
    if args.verify:
        _verify(args, spec)


def _load(
    args: argparse.Namespace,
    spec: CrmSpec,
    seed: int,
    entities: tuple[str, ...],
    target: Any,
    concern: str,
) -> None:
    from scripts.crm.load import IngestFailed, default_worker_count, stream_crm_documents
    from scripts.ingest.mongod import IngestError

    workers = args.workers if args.workers is not None else default_worker_count(spec.run_accounts)
    database = f" database={target.database}" if target.key == "mongod" else ""
    print(
        f"seed={seed} target={target.key}{database} tenants={spec.tenants} "
        f"accounts_per_tenant={spec.accounts} accounts={spec.run_accounts} "
        f"start_account={spec.start_account} workers={workers} concern={concern}",
        flush=True,
    )
    try:
        prepared = target.prepare(entities, log=lambda line: print(line, flush=True))
    except IngestError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    except ImportError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    address_field = "index_id" if target.key == "mongot" else "collection"
    try:
        report: dict[str, Any] = stream_crm_documents(
            spec,
            index_ids=prepared.ids,
            client_factory=target.writer_factory(),
            entities=entities,
            batch_size=args.batch_size,
            concern=concern,
            progress=not args.no_progress,
            workers=workers,
            address_field=address_field,
        )
    except IngestFailed as exc:
        report = exc.report
        _annotate(report, target, prepared)
        print(json.dumps(report, indent=2))
        print(str(exc), file=sys.stderr)
        _print_resume(report, seed, spec, entities, target, prefix="Load failed.")
        sys.exit(1)
    _annotate(report, target, prepared)
    print(json.dumps(report, indent=2))
    if report["interrupted"]:
        _print_resume(report, seed, spec, entities, target, prefix="Interrupted.")
        sys.exit(130)


def _verify(args: argparse.Namespace, spec: CrmSpec) -> None:
    from mong.service import MongotService
    from scripts.crm.verify import mongot_searcher, verify_crm
    from scripts.ingest.mongot import find_search_index

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
        f"verify seed={spec.seed} verify_seed={verify_seed} pool_accounts={min(args.verify_accounts, spec.run_accounts)} "
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


def _annotate(report: dict[str, Any], target: Any, prepared: Any) -> None:
    report["target"] = target.key
    report["targets"] = prepared.details
    if target.key == "mongod":
        report["database"] = target.database


def _print_resume(
    report: dict[str, Any],
    seed: int,
    spec: CrmSpec,
    entities: tuple[str, ...],
    target: Any,
    *,
    prefix: str,
) -> None:
    from scripts.crm.targets import DEFAULT_INDEX_SUFFIX
    from scripts.ingest.mongod import DEFAULT_DATABASE, DEFAULT_MONGO_URI

    resume = report.get("resume_from_account")
    if resume is None:
        return
    flags = [
        f"--seed {seed}",
        f"--target {target.key}",
        f"--tenants {spec.tenants}",
        f"--accounts {spec.accounts}",
        f"--start-account {resume}",
    ]
    if entities != ENTITY_KEYS:
        flags.append(f"--entity {entities[0]}")
    if target.index_suffix != DEFAULT_INDEX_SUFFIX:
        flags.append(f"--index-suffix {target.index_suffix}")
    if target.key == "mongod" and target.database != DEFAULT_DATABASE:
        flags.append(f"--database {target.database}")
    message = f"{prefix} Resume with: " + " ".join(flags)
    if target.key == "mongod" and target.uri != DEFAULT_MONGO_URI:
        message += ". Reuse the same MongoDB URI."
    print(message, file=sys.stderr)


if __name__ == "__main__":
    main()
