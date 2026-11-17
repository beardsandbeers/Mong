# Mong

Admin UI and Python client for a locally running [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot) Docker container.

## Prerequisites

- Docker with `nomongo-t` running `mybyte/nomongo-t:0.10.0` and healthy on port `27029`
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

0.3.x through 0.10.x share the push API and data directory, so an upgrade keeps indexes, documents, and credentials as long as the new container mounts the same `/var/lib/mongot` volume. A fresh volume regenerates `server.crt` and `admin.token` — re-copy them into `.nomongo-t/` after that. 0.7 and later store `lucene.standard` for an omitted analyzer; that is the same definition, not a change. 0.8 adds query explain and delete-by-query. 0.10 adds metadata-only search, direct reads of replicated indexes, and definition updates that can keep documents. Those need this client.

```powershell
$volume = (docker inspect nomongo-t --format '{{json .Mounts}}' | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_.Destination -eq '/var/lib/mongot' }).Name
docker pull mybyte/nomongo-t:0.10.0
docker stop nomongo-t
docker rename nomongo-t nomongo-t-old
docker run -d --name nomongo-t -p 27029:27029 -v "${volume}:/var/lib/mongot" mybyte/nomongo-t:0.10.0
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

Options: `--host` (or `MONG_HOST`, default 127.0.0.1), `--port` (or `MONG_PORT`, default 5050), and `--debug` (or `MONG_DEBUG=1`; turns on the Flask debugger and reloader, off by default).

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

Documents live in the index. Updating an index definition can rebuild an empty generation, or keep the documents when you choose Keep documents and the server accepts the change. There is no collection catalog. Delete-by-query (0.8) selects ids and deletes them in batches; it is not a single atomic query. Search meta (0.10) runs the same query for facet and count metadata without returning hits.

### MongoDB-managed indexes

nomongo-t also serves search indexes that MongoDB manages: the ones created with `createSearchIndex` on a collection, such as the `--target mongod` CRM indexes. Its standalone API does not list them, so when `MONGODB_URI` is set Mong reads them through mongod instead. They appear next to standalone indexes as `database.collection/index`, with a **MongoDB** source badge and a source filter on the Indexes page.

- **Listing**: `$listSearchIndexes` on every collection outside `admin`, `config`, `local`, and MongoDB's internal search database, refreshed with the summary poll. The status, queryable flag, and definition version come from MongoDB. Documents is the collection's estimated count. nomongo-t reports no size, rate, or latency metrics for these indexes.
- **Querying**: Search and Vector run `$search` and `$vectorSearch` on the collection with the same expression the editor builds for standalone indexes; Mong sets `index`. Hits are full collection documents unless the query sets `returnStoredSource`. Count matches runs `$searchMeta`. Explain shows mongot's plan, with mongod's pipeline stages under `mongod`. Browse reads the collection with `find`, so it needs no stored source and works for vector indexes. Results page through server-side cursors that close after 10 minutes idle.
- **Read-only**: documents change in the collection, and definitions change with `updateSearchIndex`. Mong refuses upserts, deletes, definition edits, drops, mapping export, and storage statistics for these indexes (`400`, code `READ_ONLY`). Clone copies a definition into a new standalone index.
- **Field suggestions**: Explore and query completion combine explicit mappings with fields inferred from up to 100 sampled collection documents (two-second server timeout). Suggestions follow the index's dynamic scopes and type sets; explicit mappings keep their configured types. Sampled fields are labelled as such, and fields absent from the sample remain queryable under dynamic mappings. This is not an observed mapping export. Reload to refresh the sample; if sampling fails, explicit field suggestions remain available.

If mongod is unreachable, the dashboard shows a **MongoDB is unreachable** alert and the last listed indexes stay visible.

## Run in Docker

`compose.yaml` runs the admin UI next to the `mongo-search` stack from `~/mongo-deployment` (MongoDB plus NoMongo-T), which must be running first. The container joins that stack's `mongo-search_default` network:

- The search API is reached at `nomongo-t:27028`. That port is not published to the host.
- `gibbidy.lokalho.st` resolves to the MongoDB container through the stack's network alias, so a URI that works on the host works unchanged in the container, including the TLS hostname check. `localhost` or `127.0.0.1` in the URI would point at the Mong container itself.
- The admin token and the internal CA certificate are mounted read-only from the stack's `mongo-search_nomongo-secrets` volume; nothing is copied into `.nomongo-t/`. The image runs as uid 10001, which owns those files.

Compose reads `MONGO_URI` from `.env` and passes it to the container as `MONGODB_URI`, which `--target mongod` and the [MongoDB-managed indexes](#mongodb-managed-indexes) use. `.env` is never copied into the image. `docker compose config` prints the resolved URI, password included.

```sh
docker compose up -d --build --wait
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050), or `http://<host>:5050` from another machine. Compose publishes the port on `MONG_BIND_IP` (default `0.0.0.0`, all interfaces; set `127.0.0.1` to keep it local), and `MONG_PORT` changes the host port. Mong answers only loopback names and the ones in `MONG_ALLOWED_HOSTS`, so list the hostnames and addresses other machines use in `.env`, for example `MONG_ALLOWED_HOSTS=gibbidy.lokalho.st,192.168.11.220`. Any other name gets a 403. Inside the container Flask listens on all interfaces (`MONG_HOST=0.0.0.0`), so other containers on the `mongo-search` network can reach it too.

The API has no authentication. Anyone who can reach the port can read every collection `MONGO_URI` can read, and can create, change, and drop standalone indexes. Docker-published ports bypass host firewalls such as ufw, so limit access on the network or bind `MONG_BIND_IP` to a specific interface.

The image builds the UI in a Node stage. `MONG_BUILD_TARGET=server` skips it: `/` then shows the build instructions, and the API and `/legacy/` work as usual.

```sh
MONG_BUILD_TARGET=server docker compose up -d --build --wait
```

The CRM loader runs from the same image:

```sh
docker compose run --rm mong python -m scripts.crm --accounts 1000 --seed 42 --load --target mongod
docker compose run --rm mong python -m scripts.crm --accounts 1000 --seed 42 --load
```

## CRM sample data

Generate fake Accounts, Contacts, and Opportunities. Without `--load` the documents are printed as NDJSON (`{"entity": ..., "document": ...}` per line). `--load` streams the same documents into either standalone mongot or a mongod. `--target` chooses the destination (`mongot` by default).

```powershell
python -m scripts.crm --accounts 1000 --contacts-min 2 --contacts-max 5 --opportunities-min 1 --opportunities-max 3 --seed 42 --load
python -m scripts.crm --accounts 1000 --contacts-min 2 --contacts-max 5 --opportunities-min 1 --opportunities-max 3 --seed 42 --load --target mongod
```

Generation, sharding, and batching are shared. `--target` only changes where each batch is written. Every id and document is derived from `(seed, entity, account index, child index)`, so

- the same `--seed` always produces the same documents, and a re-run upserts those `_id`s in place;
- `--entity contacts` alone still produces `account_id` / `opportunity_ids` that match the other entities;
- `--start-account N` continues the same dataset from account `N`. On Ctrl+C the loader prints a resume command that includes `--target`.

Shape: `--tenants` (default 1) sets how many tenants to generate, and `--accounts` sets how many accounts each tenant owns. `--tenants 10000 --accounts 10000` is 100,000,000 accounts. Accounts of one tenant share a `tenant_id`, a UUID derived from `(seed, tenant index)`; the same id is copied onto that account's contacts and opportunities. The next block of `--accounts` accounts gets the next tenant. Contacts and opportunities per account are drawn from `--contacts-min/max` and `--opportunities-min/max` (set min = max for a fixed ratio). `--anchor-date` is the reference "now" for generated dates. If `--seed` is omitted a random one is chosen and printed. `--start-account` is an index into the full `tenants × accounts` sequence, so a resume keeps the same `--tenants` and `--accounts`.

Both targets split the account range across `--workers` processes (default: 1 per 32 accounts, max 8; fewer than 32 accounts stays in one process). Each process has its own queue and its own client, and generates that slice itself. Account ids are a hash of `(seed, account index)`, so workers do not share a counter. Each account document is written before that account's contacts and opportunities. Child documents are written every `--batch-size` docs (default 100). One upsert still targets one index or one collection; workers write concurrently, including across entities. One tqdm bar tracks the combined writes and shows an ETA. Pass `--no-progress` to disable it. Runs of more than 100,000 accounts skip the up-front document count; the bar then counts accounts, which is known immediately, and the per-entity document totals stay in the bar's suffix. The summary still reports how many documents were written.

### `--target mongot` (default)

1. Ensures `accounts_search` / `contacts_search` / `opportunities_search` indexes exist (dynamic mappings, stored source, and `_id` plus relationship fields indexed as `token` so `equals` lookups work). The suffix comes from `--index-suffix`. An existing index with the same definition is reused. A different definition is updated, which rebuilds an empty generation before the load reingests it.
2. Upserts each batch with `--concern indexed` (the default), `committed`, or `visible`. `indexed` returns when the batch is indexed and is the fast bulk path.

### `--target mongod`

Upserts each batch into collections named `accounts`, `contacts`, and `opportunities` in `--database` (default `crm`). Connect with `--mongo-uri`, or with `MONGODB_URI` in the environment; otherwise the loader uses `mongodb://127.0.0.1:27017`. This path needs pymongo:

```powershell
pip install "mong[mongod]"
```

The loader creates a missing collection, ensures ordinary indexes on the relationship fields (`tenant_id`, `account_id`, `contact_ids`, `opportunity_ids`, `primary_contact_id`), and creates a search index with the same definition the mongot target uses: dynamic mappings, stored source, and those fields indexed as `token`. The search index name is the collection plus `--index-suffix` (`accounts_search` by default). An existing search index with the same definition is reused. A different definition is replaced; the collection documents stay in place. `_id` stays the generator's string id. Each batch is a bulk replace keyed by `_id`, so a re-run updates documents in place.

`--concern` for mongod is `acknowledged` (default; write concern `w: 1`), `journaled` (`j: true`), or `majority`.

`--verify` checks mongot join queries and only runs with `--target mongot`.

The printed JSON summary includes `target`. Each entity reports an `index_id` on mongot and a `collection` on mongod. A mongod run also includes `database`.

Relationship lookup in the admin UI against a `--target mongot` load (with `returnStoredSource` to get documents back):

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

`--verify` fires randomized join queries at the loaded mongot indexes and checks that each one returns exactly the right documents. It requires `--target mongot` (the default), including when combined with `--load`. Pass the same `--seed` and shape flags as the load:

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
| `GET` | `/api/indexes/<id>/field-suggestions` | Editor field hints: sampled collection types for MongoDB indexes, observed mapping for standalone indexes |
| `GET` | `/api/indexes/<id>/stats` | Index statistics (`?refresh=true` starts a fresh collection) |
| `GET` | `/api/indexes/<id>/field-stats` | Per-field statistics page (`refresh`, repeated `path`, `page_size` ≤ 500, `page_token`) |
| `POST` | `/api/indexes/<id>/documents` | Upsert documents into the index |
| `DELETE` | `/api/indexes/<id>/documents/<doc_id>` | Delete a document by `_id` |
| `POST` | `/api/indexes/<id>/documents/delete` | Delete a list of `ids` (Extended JSON values) |
| `POST` | `/api/indexes/<id>/delete-by-query` | Dry-run or delete a bounded search query, vector filter, or match-all |
| `POST` | `/api/indexes/<id>/search` | Text or vector search (paged). Optional `explain`: `query_planner`, `execution_stats`, `all_plans_execution` |
| `POST` | `/api/indexes/<id>/browse` | Browse all documents (paged). `count: true` adds a document count |
| `POST` | `/api/query/more` | Fetch next cursor page |
| `DELETE` | `/api/query/cursors/<cursor_id>` | Kill a query cursor |
| `GET` | `/api/metrics/summary` | Current derived metrics per instance and index, plus alerts (`?refresh=true` samples now) |
| `GET` | `/api/metrics/series` | Sampled history (`index`, `since` in epoch seconds) with restart and rebuild annotations |
| `GET/POST` | `/api/jobs` | List jobs / start one (`kind`: `clear_index`, `delete_by_query`, `export`) |
| `GET` | `/api/jobs/<id>` | Job progress and result |
| `POST` | `/api/jobs/<id>/cancel` | Cancel a job |
| `GET` | `/api/jobs/<id>/download` | Download a finished export (NDJSON or CSV) |

gRPC errors map to HTTP statuses (for example `NOT_FOUND` is 404, and `ABORTED` and `FAILED_PRECONDITION` are 409, which is what a stale `expected_revision` returns) with the gRPC code in `code`.

MongoDB-managed indexes use ids of the form `mongod:<database>:<collection>:<index>` (each part percent-encoded), and their cursor ids start with `mongod-`. The same routes read them. `/api/metrics/summary` lists them after the standalone indexes and adds a `mongod` object (`enabled`, `connected`, `error`). mongod failures use codes such as `MONGOD_UNAVAILABLE` (503) and `MONGOD_ERROR` (400, a rejected query).

The server only answers loopback `Host` headers, which blocks DNS rebinding, and refuses writes with a foreign `Origin` or `Sec-Fetch-Site: cross-site`. There is no authentication, so keep it on `127.0.0.1`.

Optional overrides:

- `NOMONGOT_ADDRESS` (default `localhost:27029`)
- `NOMONGOT_CREDENTIALS_DIR` (default `.nomongo-t`)
- `MONG_HOST` (default `127.0.0.1`), `MONG_PORT` (default `5050`), and `MONG_DEBUG` (default off)
- `MONG_ALLOWED_HOSTS`: comma-separated extra hostnames to accept besides loopback
- `MONGODB_URI`: lists and queries [MongoDB-managed indexes](#mongodb-managed-indexes) (off when unset)

The Python client dependency is `mongot-standalone-client` 0.10.0, matching the push-only mongot API, cross-index `join` filters (including integer keys), query explain, delete-by-query, metadata-only search, and direct reads of replicated indexes. Bulk upserts default to write concern `indexed`. Delete-by-query defaults to `visible` and, in this admin API, to a dry run. Definition saves default to rebuilding an empty generation; `update_mode: preserve` keeps documents when the server can.

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
