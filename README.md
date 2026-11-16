# Mong

Admin UI and Python client for a locally running [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot) Docker container.

## Prerequisites

- Docker with `nomongo-t` running `mybyte/nomongo-t:0.8.0` and healthy on port `27029`
- Python 3.11+

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

Export TLS credentials from the container (once; reused across restarts):

```powershell
New-Item -ItemType Directory -Force -Path .nomongo-t | Out-Null
docker cp nomongo-t:/var/lib/mongot/config/server.crt .nomongo-t/server.crt
docker cp nomongo-t:/var/lib/mongot/config/admin.token .nomongo-t/admin.token
```

`.nomongo-t/` is gitignored — keep the admin token private.

### Upgrading the container

0.3.x through 0.8.x share the push API and data directory, so an upgrade keeps indexes, documents, and credentials as long as the new container mounts the same `/var/lib/mongot` volume. A fresh volume regenerates `server.crt` and `admin.token` — re-copy them into `.nomongo-t/` after that. 0.7 and later store `lucene.standard` for an omitted analyzer; that is the same definition, not a change. 0.8 adds query explain and delete-by-query; both need this client.

```powershell
$volume = (docker inspect nomongo-t --format '{{json .Mounts}}' | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_.Destination -eq '/var/lib/mongot' }).Name
docker pull mybyte/nomongo-t:0.8.0
docker stop nomongo-t
docker rename nomongo-t nomongo-t-old
docker run -d --name nomongo-t -p 27029:27029 -v "${volume}:/var/lib/mongot" mybyte/nomongo-t:0.8.0
```

Keep the server image and `mongot-standalone-client` on the same version. Collection-backed 0.2.x data directories are not compatible.

## Run the admin UI

The UI is a static Vite + TypeScript + Lit app that Flask serves on the same origin as the API. The build output (`src/mong/web/dist/`) is gitignored, so build it once after cloning and again after frontend changes:

```powershell
cd frontend
npm install
npm run build
cd ..
python -m mong
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050). Without a build, `/` shows these instructions. The previous UI stays available at [/legacy/](http://127.0.0.1:5050/legacy/) until the new one replaces it.

Options: `--port` (or `MONG_PORT`, default 5050) and `--debug` (or `MONG_DEBUG=1`; turns on the Flask debugger and reloader, off by default).

For frontend development, run Flask and `npm run dev` in `frontend/`, then open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to Flask on port 5050 and rewrites `Origin` so writes pass the server's origin check.

The UI has four areas:

- **Dashboard**: instance health (management readiness, failure message, free disk), live tiles and charts for queries per second, failed queries, batch latency, ingest rate, RPCs in flight and queued, merges, and open cursors, an index health table, and alerts. Charts cover 5 minutes, 15 minutes, or 1 hour and mark restarts and rebuilds. History comes from a server-side sampler and is lost when Flask restarts.
- **Indexes**: a list, a create wizard (dynamic search, static mapping, vector, a clone of an existing index, or an index's observed fields), and a page per index with these tabs:
  - **Overview**: state, revisions, generation, and the index's charts.
  - **Definition**: the definition editor with a diff against the loaded revision. Saving rebuilds an empty generation, so it asks you to type the index name. **Export observed mapping** creates a static copy.
  - **Fields**: definition and observed mapping merged, with per-field disk and memory.
  - **Storage**: counts, sizes, memory domains, and the shared and unattributed buckets. Values marked `*` are partial measurements; `—` means the server could not measure it. Statistics load on demand and are never polled.
  - **Data**: Explore scoped to the index.
  - **Danger zone**: delete by query (a dry-run count first, then the delete as a job), delete all documents (a job), and drop.
- **Explore**: Browse, Search, and Vector modes, enabled by what the index supports. Browse needs stored source; Vector needs a vector index.
  - **Query editor**: completes operators, field paths from the definition and the observed mapping, and index names, and flags mismatches such as `text` on a `token` field. An optional `"index"` key stays in sync with the index picker and is not sent to mongot. Drag the grip under it to resize; the height is remembered.
  - **Results**: table, tree, or raw view, with load-more cursor paging, Count matches (adds `count: {type: "lowerBound"}`), and explain (plan, timings, or all plans) rendered as a tree.
  - **Search meta**: the results header shows hits loaded, matches, and end-to-end and mongot latency per page. A Search meta card shows the full metadata (count, facets).
  - **Document drawer**: edit (only when the index stores full source, since upsert replaces the document), delete, and **Find similar**, which builds a vector query from the document's stored embedding.
  - **Also**: history and saved queries, a shareable URL, upsert, NDJSON or JSON-array import streamed from the browser, bulk delete of selected rows, and export of the loaded rows or of all matches as a job.
- **Jobs**: clearing an index, large deletes by query, and exports run as server-side jobs with progress and cancel. They survive closing the tab but not a Flask restart, and only one mutating job runs per index at a time.

Ctrl+K opens a command palette for jumping to indexes and actions. The Activity page is a placeholder.

Documents travel as relaxed Extended JSON: `ObjectId`, dates, `Decimal128`, integers beyond 2^53, and whole-number doubles are tagged (`{"$oid"}`, `{"$date"}`, `{"$numberDouble"}`, ...) so an edited document keeps its types when it is written back.

Documents live in the index. Updating an index definition rebuilds an empty generation, so the previous documents have to be loaded again. There is no collection catalog. Delete-by-query (0.8) selects ids and deletes them in batches; it is not a single atomic query.

## CRM sample data

Generate fake Accounts, Contacts, and Opportunities and stream them into mongot:

```powershell
python -m scripts.crm --accounts 1000 --contacts-min 2 --contacts-max 5 --opportunities-min 1 --opportunities-max 3 --seed 42 --load
```

Without `--load` the documents are printed as NDJSON (`{"entity": ..., "document": ...}` per line).

`--load`:

1. Ensures `accounts_search` / `contacts_search` / `opportunities_search` indexes exist (dynamic mappings, stored source, and `_id` plus relationship fields indexed as `token` so `equals` lookups work). The suffix comes from `--index-suffix`. An existing index with the same definition is reused. A different definition is updated, which rebuilds an empty generation before the load reingests it.
2. Splits the account range across `--workers` processes (default: 1 per 32 accounts, max 8; fewer than 32 accounts stays in one process). Each process has its own queue and mongot client and generates that slice itself. Each account document is upserted before that account's contacts and opportunities. Child documents are upserted every `--batch-size` docs (default 100). Account ids are a hash of `(seed, account index)`, so workers do not share a counter. Writes use `--concern indexed` by default, which returns when the batch is indexed. One tqdm bar tracks the combined writes.

Shape: `--accounts` sets the account count; contacts and opportunities are drawn per account from `--contacts-min/max` and `--opportunities-min/max` (set min = max for a fixed ratio).

Determinism: every id and document is derived from `(seed, entity, account index, child index)`, so

- the same `--seed` always produces the same documents (re-runs upsert in place);
- `--entity contacts` alone still produces `account_id` / `opportunity_ids` that match the other indexes;
- `--start-account N` continues the same dataset from account `N` (resume or extend). On Ctrl+C the loader prints the exact resume command.

Other flags: `--concern indexed|committed|visible` (default `indexed`), `--workers`, `--index-suffix`, `--anchor-date` (reference "now" for generated dates), `--no-progress`. If `--seed` is omitted a random one is chosen and printed. One upsert still targets one index; workers write concurrently, including across indexes.

Example relationship lookup in the admin UI search box (with `returnStoredSource` to get documents back):

```json
{ "equals": { "path": "account_id", "value": "<account _id>" }, "returnStoredSource": true }
```

Cross-index join (0.6+): keep contacts that match a text query whose related account is in Berlin. Join keys must be explicit `token` fields, or native `objectId` fields including `_id` with a matching mapping (0.8). The CRM loader maps `_id` / `account_id` / link fields as `token`. Place `join` only in `compound.filter` or `compound.mustNot`; omit `from` for a self-join:

```json
{
  "compound": {
    "must": [{ "text": { "path": "title", "query": "architect" } }],
    "filter": [{
      "join": {
        "from": "accounts_search",
        "localField": "account_id",
        "foreignField": "_id",
        "operator": { "text": { "path": "name", "query": "Systems" } }
      }
    }]
  },
  "returnStoredSource": true
}
```

Joins are membership filters only — they do not attach foreign documents or change local scores.

### Verifying joins

`--verify` fires randomized join queries at the loaded indexes and checks that each one returns exactly the right documents. Pass the same `--seed` and shape flags as the load (or add `--verify` to the `--load` command):

```powershell
python -m scripts.crm --accounts 1000 --contacts-min 2 --contacts-max 5 --opportunities-min 1 --opportunities-max 3 --seed 42 --verify
```

1. Samples `--verify-accounts` accounts (default 20) and regenerates every document they own.
2. Waits up to `--verify-timeout` seconds until each index holds exactly those documents, with stored source equal to the regenerated ones. Extra documents for a sampled account (for example from a load with different shape flags) fail this step at once.
3. Runs `--verify-queries` queries (default 200), cycling through every pair of query shape and relationship. The shapes are semijoin, antijoin (`mustNot`), two joins, semijoin plus antijoin, a nested `compound` under `filter`, and a scored local `must` with a join filter. The relationships cover child to parent, parent to children, array keys on either side (`contact_ids`, `opportunity_ids`), `primary_contact_id`, and self-joins with and without `from`. Foreign predicates are `text` on categorical fields, `range` on numbers, and `equals` on `is_primary`, usually anchored on a sampled document so results are not empty.
4. Computes each expected result with an in-memory reference evaluator and compares by `_id`. A check fails on missing, unexpected, or duplicate hits, on stored source that differs from the generated document, or on a server error.

Every query is restricted to some of the sampled accounts with an `in` clause, on the local side or on a required join's operator. Link fields only hold ids from one account, so that restriction makes the sampled-account answer exact for the whole dataset. A foreign side is left unrestricted only when the spec has at most 50,000 documents of that entity, because mongot rejects joins that collect more than 100,000 keys. For large accounts, keep the pool small (for example `--verify-accounts 2`).

The JSON report has pass/fail counts per shape and per relationship, plus up to 25 failures with their query and id differences. The command exits 1 on any failure. `--verify-seed` (printed when random) replays the same pool and queries.

## API sketch

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Instance status (`?metrics=true` includes scrubbed metrics) |
| `GET/POST` | `/api/indexes` | List / create indexes |
| `GET/PUT/DELETE` | `/api/indexes/<id>` | Get / update / drop index. Update and drop require `expected_revision`, the revision the client loaded |
| `GET` | `/api/indexes/<id>/mappings` | Export observed mapping as a static definition (search indexes only) |
| `GET` | `/api/indexes/<id>/stats` | Index statistics (`?refresh=true` starts a fresh collection) |
| `GET` | `/api/indexes/<id>/field-stats` | Per-field statistics page (`refresh`, repeated `path`, `page_size` ≤ 500, `page_token`) |
| `POST` | `/api/indexes/<id>/documents` | Upsert documents into the index |
| `DELETE` | `/api/indexes/<id>/documents/<doc_id>` | Delete a document by `_id` |
| `POST` | `/api/indexes/<id>/documents/delete` | Delete a list of `ids` (Extended JSON values) |
| `POST` | `/api/indexes/<id>/delete-by-query` | Dry-run or delete a bounded search query, vector filter, or match-all |
| `POST` | `/api/indexes/<id>/search` | Text or vector search (paged). Optional `explain`: `query_planner`, `execution_stats`, `all_plans_execution` |
| `POST` | `/api/indexes/<id>/browse` | Browse all documents (paged) |
| `POST` | `/api/query/more` | Fetch next cursor page |
| `DELETE` | `/api/query/cursors/<cursor_id>` | Kill a query cursor |
| `GET` | `/api/metrics/summary` | Current derived metrics per instance and index, plus alerts (`?refresh=true` samples now) |
| `GET` | `/api/metrics/series` | Sampled history (`index`, `since` in epoch seconds) with restart and rebuild annotations |
| `GET/POST` | `/api/jobs` | List jobs / start one (`kind`: `clear_index`, `delete_by_query`, `export`) |
| `GET` | `/api/jobs/<id>` | Job progress and result |
| `POST` | `/api/jobs/<id>/cancel` | Cancel a job |
| `GET` | `/api/jobs/<id>/download` | Download a finished export (NDJSON or CSV) |

gRPC errors map to HTTP statuses (for example `NOT_FOUND` is 404, and `ABORTED` and `FAILED_PRECONDITION` are 409, which is what a stale `expected_revision` returns) with the gRPC code in `code`.

The server only answers loopback `Host` headers, which blocks DNS rebinding, and refuses writes with a foreign `Origin` or `Sec-Fetch-Site: cross-site`. There is no authentication, so keep it on `127.0.0.1`.

Optional overrides:

- `NOMONGOT_ADDRESS` (default `localhost:27029`)
- `NOMONGOT_CREDENTIALS_DIR` (default `.nomongo-t`)
- `MONG_PORT` (default `5050`) and `MONG_DEBUG` (default off)
- `MONG_ALLOWED_HOSTS`: comma-separated extra hostnames to accept besides loopback

The Python client dependency is `mongot-standalone-client` 0.8.0, matching the push-only mongot API (no collections), cross-index `join` filters, query explain, and delete-by-query. Bulk upserts default to write concern `indexed`. Delete-by-query defaults to `visible` and, in this admin API, to a dry run.

## Frontend layout

`frontend/src/` holds the app: `views/` (pages), `components/` (shared Lit elements, which render into light DOM so CodeMirror styles apply), `editors/` (the CodeMirror query, definition, and JSON editors, imported from npm), `lib/` (API client, Extended JSON, formatting, state), and `styles/`. `npm run build` type-checks and writes `src/mong/web/dist/`.

The legacy UI at `/legacy/` still uses the vendored CodeMirror bundle at `src/mong/web/static/vendor/codemirror.js`; `npm run build:vendor` rebuilds it.

## Test

```powershell
pytest
cd frontend
npm test
npm run typecheck
```

`npm test` runs Vitest (editor completion and lint, the importer, and the editor resize grip).
