"""Create CRM search indexes and stream faker documents into mongot.

Indexes are instance-wide. A definition change replaces the index with an empty
generation, so the following upsert reingests the documents.

Ingest fans the account range out to worker processes. Each worker has its own
input queue and its own mongot client, generates the accounts it is given, and
upserts one index at a time. ``upsert_many`` cannot mix indexes, so a worker
fills a same-index batch of contacts or opportunities while other workers write
concurrently. Each account document is sent as soon as it is generated, before
that account's children. ``batch_size`` 1 sends every document on its own.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import signal
import threading
from dataclasses import dataclass, field
from queue import Empty
from typing import Any, Callable, Protocol, Sequence

from tqdm import tqdm

from mong.service import MongotService
from scripts.crm.generate import ENTITY_KEYS, CrmGenerator, CrmSpec

# Datasets smaller than this stay in-process: spawning workers costs more than it saves.
_INLINE_ACCOUNT_LIMIT = 32
_MAX_WORKERS = 8

RELATIONSHIP_FIELDS: dict[str, tuple[str, ...]] = {
    "accounts": ("_id",),
    "contacts": ("_id", "account_id", "opportunity_ids"),
    "opportunities": ("_id", "account_id", "contact_ids", "primary_contact_id"),
}


def search_definition(entity: str) -> dict[str, Any]:
    """Dynamic mapping plus token-indexed id fields so `equals`/`in` lookups can follow links."""
    return {
        "mappings": {
            "dynamic": True,
            "fields": {path: {"type": "token"} for path in RELATIONSHIP_FIELDS.get(entity, ("_id",))},
        },
        "storedSource": True,
    }


class Upserter(Protocol):
    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> Any: ...


def find_search_index(service: MongotService, name: str) -> dict[str, Any] | None:
    for index in service.list_indexes():
        if index.get("name") == name and str(index.get("type", "")).upper() == "SEARCH":
            return index
    return None


# 0.7 and later write these when a definition omits them. They are not a definition change.
_DEFAULT_ANALYZER = "lucene.standard"


def definitions_match(stored: Any, wanted: dict[str, Any]) -> bool:
    """True when ``stored`` is ``wanted``, ignoring server-filled default analyzers."""
    if stored == wanted:
        return True
    if not isinstance(stored, dict):
        return False
    normalized = dict(stored)
    for key in ("analyzer", "searchAnalyzer"):
        if key not in wanted and normalized.get(key) == _DEFAULT_ANALYZER:
            normalized.pop(key)
    return normalized == wanted


def ensure_search_index(
    service: MongotService,
    *,
    name: str,
    definition: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Return (index, action) where action is 'created', 'updated', or 'existing'.

    ``updated`` means UpdateIndex replaced the index with an empty generation.
    Callers must reingest documents after that.
    """
    existing = find_search_index(service, name)
    if existing is None:
        index = service.create_index(
            name=name,
            index_type="SEARCH",
            definition=definition,
        )
        return index, "created"
    if not definitions_match(existing.get("definition"), definition):
        return service.update_index(existing["index_id"], definition=definition), "updated"
    return existing, "existing"


def ensure_targets(
    service: MongotService,
    *,
    entities: Sequence[str],
    index_suffix: str = "_search",
    log: Callable[[str], None] = print,
) -> dict[str, dict[str, Any]]:
    targets: dict[str, dict[str, Any]] = {}
    for entity in entities:
        index_name = f"{entity}{index_suffix}"
        index, index_action = ensure_search_index(
            service,
            name=index_name,
            definition=search_definition(entity),
        )
        note = ""
        if index_action == "updated":
            note = "; definition change rebuilt an empty generation"
        log(f"{index_name}: index {index['index_id']} ({index_action}{note})")
        targets[entity] = {
            "index_id": index["index_id"],
            "index_name": index_name,
            "index_action": index_action,
        }
    return targets


class IngestFailed(RuntimeError):
    """A worker failed. ``report`` includes ``resume_from_account`` when any prefix is durable."""

    def __init__(self, message: str, report: dict[str, Any]):
        super().__init__(message)
        self.report = report


def default_worker_count(accounts: int) -> int:
    """How many ingest processes to start when ``--workers`` is omitted.

    One process per 32 accounts, capped at 8 and at the machine's CPU count.
    Fewer than 32 accounts stays at one process so process startup is not the whole run.
    """
    cpus = min(_MAX_WORKERS, os.cpu_count() or 1)
    if accounts < _INLINE_ACCOUNT_LIMIT:
        return 1
    return min(cpus, max(1, accounts // _INLINE_ACCOUNT_LIMIT))


def _close_client(client: Any) -> None:
    close = getattr(client, "close", None)
    if close is not None:
        close()


def _default_client_factory() -> Upserter:
    from mong.client import create_client

    return create_client()


class _ListUpserter:
    """Test double. Records ``(pid, index_id, concern, ids)`` on a manager list."""

    def __init__(self, calls: Any) -> None:
        self._calls = calls

    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> None:
        self._calls.append(
            (os.getpid(), index_id, concern, tuple(doc["_id"] for doc in documents))
        )


def _list_upserter_factory(calls: Any) -> _ListUpserter:
    return _ListUpserter(calls)


@dataclass
class _Buffer:
    index_id: str
    documents: list[dict[str, Any]] = field(default_factory=list)
    first_account: int | None = None
    written: int = 0
    batches: int = 0


class _IngestSession:
    """Per-index batches for one worker. Account ranges are consumed in order.

    ``completed_until`` is the first account that is not fully generated.
    ``watermark`` is the first account that is not fully written: the older of
    that cursor and the oldest document still sitting in a buffer. Upserts are
    idempotent, so resuming there is safe.
    """

    def __init__(
        self,
        upserter: Upserter,
        *,
        index_ids: dict[str, str],
        entities: Sequence[str],
        batch_size: int,
        concern: str,
        completed_until: int,
    ) -> None:
        self.upserter = upserter
        self.entities = tuple(entities)
        self.batch_size = batch_size
        self.concern = concern
        self.completed_until = completed_until
        self.interrupted = False
        self.on_flush: Callable[[str, int], None] | None = None
        self.buffers = {entity: _Buffer(index_ids[entity]) for entity in self.entities}

    def watermark(self) -> int:
        pending = [buf.first_account for buf in self.buffers.values() if buf.first_account is not None]
        if not pending:
            return self.completed_until
        return min(self.completed_until, min(pending))

    def snapshot(self) -> dict[str, Any]:
        return {
            "watermark": self.watermark(),
            "written": {entity: buf.written for entity, buf in self.buffers.items()},
            "batches": {entity: buf.batches for entity, buf in self.buffers.items()},
            "interrupted": self.interrupted,
        }

    def ingest_accounts(
        self,
        generator: CrmGenerator,
        start: int,
        count: int,
        stop: Callable[[], bool] | None = None,
    ) -> bool:
        """Generate ``[start, start + count)``. Return True when stopped early."""
        range_end = start + count
        try:
            for account in range(start, range_end):
                if stop is not None and stop():
                    self.completed_until = account
                    return True
                # Accounts before this one are fully generated. This one is not, until we move on.
                self.completed_until = account
                for entity, document in generator.iter_account(account, self.entities):
                    if stop is not None and stop():
                        return True
                    self._add(account, entity, document)
        except KeyboardInterrupt:
            self.interrupted = True
            return True
        self.completed_until = range_end
        return False

    def _add(self, account: int, entity: str, document: dict[str, Any]) -> None:
        buf = self.buffers[entity]
        if buf.first_account is None:
            buf.first_account = account
        buf.documents.append(document)
        # One account can have thousands of children. Holding its document until
        # batch_size accounts exist leaves accounts at 0 while contacts and
        # opportunities flush. Send the account before generating those children.
        if entity == "accounts" or len(buf.documents) >= self.batch_size:
            self.flush(entity)

    def flush(self, entity: str) -> None:
        buf = self.buffers[entity]
        if not buf.documents:
            return
        docs = buf.documents
        count = len(docs)
        self.upserter.upsert_many(buf.index_id, docs, concern=self.concern)
        buf.written += count
        buf.batches += 1
        buf.documents = []
        buf.first_account = None
        if self.on_flush is not None:
            self.on_flush(entity, count)

    def flush_all(self) -> None:
        for entity in self.entities:
            self.flush(entity)


def _report(
    spec: CrmSpec,
    *,
    entities: Sequence[str],
    index_ids: dict[str, str],
    totals: dict[str, int],
    written: dict[str, int],
    batches: dict[str, int],
    workers: int,
    interrupted: bool,
    resume_from: int | None,
    error: str | None = None,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "seed": spec.seed,
        "start_account": spec.start_account,
        "accounts": spec.accounts,
        "interrupted": interrupted,
        "resume_from_account": resume_from,
        "workers": workers,
        "entities": {
            entity: {
                "index_id": index_ids[entity],
                "expected": totals[entity],
                "written": written.get(entity, 0),
                "batches": batches.get(entity, 0),
            }
            for entity in entities
        },
    }
    if error:
        report["error"] = error
    return report


def _empty_counts(entities: Sequence[str]) -> dict[str, int]:
    return {entity: 0 for entity in entities}


def _resume_from(shards: Sequence[tuple[int, int]], watermarks: Sequence[int]) -> int | None:
    """First account that is not fully written, or None when every shard finished.

    A worker only owns its own shard, so a watermark below that shard's start
    does not rewind earlier shards.
    """
    for watermark, (start, count) in zip(watermarks, shards, strict=True):
        cursor = max(watermark, start)
        if cursor < start + count:
            return cursor
    return None


def _shards(spec: CrmSpec, workers: int) -> list[tuple[int, int]]:
    """Contiguous ``(start, count)`` slices, one per worker. Earlier slices absorb the remainder."""
    workers = min(workers, spec.accounts)
    base, extra = divmod(spec.accounts, workers)
    shards: list[tuple[int, int]] = []
    start = spec.start_account
    for index in range(workers):
        count = base + (1 if index < extra else 0)
        shards.append((start, count))
        start += count
    return shards


def _chunk(start: int, count: int, job_accounts: int) -> list[tuple[int, int]]:
    jobs: list[tuple[int, int]] = []
    offset = 0
    while offset < count:
        step = min(job_accounts, count - offset)
        jobs.append((start + offset, step))
        offset += step
    return jobs


def _worker_main(
    worker_id: int,
    in_q: Any,
    out_q: Any,
    spec: CrmSpec,
    entities: tuple[str, ...],
    index_ids: dict[str, str],
    batch_size: int,
    concern: str,
    client_factory: Callable[[], Upserter],
    stop: Any,
    shard_start: int,
) -> None:
    # Ctrl+C belongs to the parent, which sets ``stop``. Ignoring it here lets the
    # worker finish the current upsert and publish its watermark.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    upserter: Upserter | None = None
    session: _IngestSession | None = None
    error: str | None = None
    try:
        upserter = client_factory()
        session = _IngestSession(
            upserter,
            index_ids=index_ids,
            entities=entities,
            batch_size=batch_size,
            concern=concern,
            completed_until=shard_start,
        )

        def on_flush(_entity: str, _count: int, session: _IngestSession = session) -> None:
            out_q.put(("progress", worker_id, session.snapshot()))

        session.on_flush = on_flush
        generator = CrmGenerator(spec)
        draining = False
        while True:
            job = in_q.get()
            if job is None:
                break
            if draining or stop.is_set():
                draining = True
                continue
            start, count = job
            if session.ingest_accounts(generator, start, count, stop.is_set):
                draining = True
        if not session.interrupted:
            session.flush_all()
    except KeyboardInterrupt:
        if session is not None:
            session.interrupted = True
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            if session is not None:
                out_q.put(("progress", worker_id, session.snapshot()))
            if error:
                out_q.put(("error", worker_id, error))
            out_q.put(("bye", worker_id))
        finally:
            if upserter is not None:
                _close_client(upserter)


def _stream_inline(
    spec: CrmSpec,
    *,
    upserter: Upserter,
    index_ids: dict[str, str],
    entities: Sequence[str],
    totals: dict[str, int],
    batch_size: int,
    concern: str,
    progress: bool,
    workers: int,
) -> dict[str, Any]:
    session = _IngestSession(
        upserter,
        index_ids=index_ids,
        entities=entities,
        batch_size=batch_size,
        concern=concern,
        completed_until=spec.start_account,
    )
    bar = tqdm(
        total=sum(totals.values()),
        unit="doc",
        unit_scale=True,
        dynamic_ncols=True,
        disable=not progress,
    )

    def on_flush(_entity: str, count: int) -> None:
        bar.update(count)
        bar.set_postfix(
            at_account=session.watermark(),
            **session.snapshot()["written"],
            refresh=False,
        )

    session.on_flush = on_flush
    end = spec.start_account + spec.accounts
    try:
        if spec.accounts:
            session.ingest_accounts(CrmGenerator(spec), spec.start_account, spec.accounts)
        if not session.interrupted:
            session.flush_all()
    except KeyboardInterrupt:
        session.interrupted = True
    finally:
        bar.close()

    snap = session.snapshot()
    resume = snap["watermark"] if session.interrupted and snap["watermark"] < end else None
    return _report(
        spec,
        entities=entities,
        index_ids=index_ids,
        totals=totals,
        written=snap["written"],
        batches=snap["batches"],
        workers=workers,
        interrupted=session.interrupted,
        resume_from=resume,
    )


def _stream_parallel(
    spec: CrmSpec,
    *,
    client_factory: Callable[[], Upserter],
    index_ids: dict[str, str],
    entities: Sequence[str],
    totals: dict[str, int],
    batch_size: int,
    concern: str,
    progress: bool,
    workers: int,
) -> dict[str, Any]:
    """One process per shard. A feeder thread fills each process's queue while the parent collects."""
    shards = _shards(spec, workers)
    job_lists = [_chunk(start, count, max(batch_size, 1)) for start, count in shards]
    ctx = mp.get_context("spawn")
    out_q: Any = ctx.Queue()
    stop = ctx.Event()
    in_queues = [ctx.Queue() for _ in shards]
    processes: list[Any] = []
    for worker_id, jobs in enumerate(job_lists):
        process = ctx.Process(
            target=_worker_main,
            name=f"crm-ingest-{worker_id}",
            args=(
                worker_id,
                in_queues[worker_id],
                out_q,
                spec,
                tuple(entities),
                index_ids,
                batch_size,
                concern,
                client_factory,
                stop,
                shards[worker_id][0],
            ),
        )
        process.start()
        processes.append(process)

    def feed() -> None:
        for worker_id, jobs in enumerate(job_lists):
            if not stop.is_set():
                for job in jobs:
                    if stop.is_set():
                        break
                    in_queues[worker_id].put(job)
            in_queues[worker_id].put(None)

    feeder = threading.Thread(target=feed, name="crm-ingest-feed", daemon=True)
    feeder.start()

    bar = tqdm(
        total=sum(totals.values()),
        unit="doc",
        unit_scale=True,
        dynamic_ncols=True,
        disable=not progress,
    )
    latest = [
        {
            "watermark": start,
            "written": _empty_counts(entities),
            "batches": _empty_counts(entities),
            "interrupted": False,
        }
        for start, _count in shards
    ]
    seen = [0 for _ in shards]
    byes: set[int] = set()
    errors: list[str] = []
    interrupted = False
    deadline: float | None = None

    def note_progress(worker_id: int, snap: dict[str, Any]) -> None:
        total = sum(snap["written"].values())
        delta = total - seen[worker_id]
        seen[worker_id] = total
        if delta:
            bar.update(delta)
        latest[worker_id] = snap
        written = _empty_counts(entities)
        for item in latest:
            for entity, count in item["written"].items():
                written[entity] += count
        bar.set_postfix(at_account=min(item["watermark"] for item in latest), **written, refresh=False)

    try:
        while len(byes) < len(processes):
            try:
                message = out_q.get(timeout=0.5)
            except Empty:
                if interrupted and deadline is not None and _now() >= deadline:
                    break
                if all(not process.is_alive() for process in processes):
                    break
                continue
            except KeyboardInterrupt:
                interrupted = True
                stop.set()
                if deadline is None:
                    deadline = _now() + 30
                continue
            kind = message[0]
            worker_id = message[1]
            if kind == "progress":
                note_progress(worker_id, message[2])
                if message[2]["interrupted"]:
                    interrupted = True
            elif kind == "error":
                errors.append(f"worker {worker_id}: {message[2]}")
                stop.set()
            elif kind == "bye":
                byes.add(worker_id)
    finally:
        stop.set()
        bar.close()
        feeder.join(timeout=5)
        for process in processes:
            process.join(timeout=5)
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)
        for queue in (*in_queues, out_q):
            queue.cancel_join_thread()
            queue.close()

    for worker_id, process in enumerate(processes):
        if worker_id in byes:
            continue
        code = process.exitcode
        if code not in (0, None):
            errors.append(f"worker {worker_id} exited with code {code}")

    watermarks = [item["watermark"] for item in latest]
    written = _empty_counts(entities)
    batches = _empty_counts(entities)
    for item in latest:
        for entity in entities:
            written[entity] += item["written"].get(entity, 0)
            batches[entity] += item["batches"].get(entity, 0)
        if item["interrupted"]:
            interrupted = True
    resume = _resume_from(shards, watermarks)
    error = "; ".join(errors) if errors else None
    report = _report(
        spec,
        entities=entities,
        index_ids=index_ids,
        totals=totals,
        written=written,
        batches=batches,
        workers=len(shards),
        interrupted=interrupted or error is not None,
        resume_from=None if resume is None else resume,
        error=error,
    )
    # A finished watermark on every shard means the durable prefix is the whole run.
    if _resume_from(shards, watermarks) is None:
        report["resume_from_account"] = None
        if error is None:
            report["interrupted"] = False
    if error:
        raise IngestFailed(error, report)
    return report


def _now() -> float:
    import time

    return time.monotonic()


def stream_crm_documents(
    spec: CrmSpec,
    *,
    index_ids: dict[str, str],
    upserter: Upserter | None = None,
    client_factory: Callable[[], Upserter] | None = None,
    entities: Sequence[str] = ENTITY_KEYS,
    batch_size: int = 100,
    concern: str = "indexed",
    progress: bool = True,
    workers: int | None = None,
) -> dict[str, Any]:
    """Generate the spec and upsert it.

    ``workers`` 1 (the default for small datasets and for an injected ``upserter``)
    runs in this process. More workers spawn one process per account shard; each
    process reads account ranges from its own queue and writes through its own client.

    On interrupt, ``resume_from_account`` is the lowest account index whose
    documents may not all have been written.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    if workers is not None and workers < 1:
        raise ValueError("workers must be >= 1")
    if upserter is not None and client_factory is not None:
        raise ValueError("pass either upserter or client_factory")
    if workers is None:
        workers = 1 if upserter is not None else default_worker_count(spec.accounts)
    if upserter is not None and workers != 1:
        raise ValueError("an in-process upserter supports one worker; pass client_factory to fan out")

    totals = spec.document_counts(entities)
    own_client = False
    if workers == 1 or sum(totals.values()) == 0:
        if upserter is None and sum(totals.values()) > 0:
            upserter = (client_factory or _default_client_factory)()
            own_client = True
        if upserter is None:
            upserter = _NoopUpserter()
        try:
            return _stream_inline(
                spec,
                upserter=upserter,
                index_ids=index_ids,
                entities=entities,
                totals=totals,
                batch_size=batch_size,
                concern=concern,
                progress=progress,
                workers=1 if sum(totals.values()) else 0,
            )
        finally:
            if own_client:
                _close_client(upserter)
    return _stream_parallel(
        spec,
        client_factory=client_factory or _default_client_factory,
        index_ids=index_ids,
        entities=entities,
        totals=totals,
        batch_size=batch_size,
        concern=concern,
        progress=progress,
        workers=workers,
    )


class _NoopUpserter:
    def upsert_many(self, index_id: str, documents: list[dict[str, Any]], *, concern: str) -> None:
        return None
