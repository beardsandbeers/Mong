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

```powershell
python -m mong
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050).

The UI can:

- show instance status and live indexes
- create / edit / drop search and vector indexes (names are instance-wide). The definition editor completes keys, field types, and analyzers for the selected index kind, and it flags definitions standalone mongot rejects. Ctrl+Enter submits the form.
- browse all documents with cursor pagination (Browse mode has no query box; the index must store source)
- search / vector-search with a JSON expression. The editor completes operators, field paths from the index definition and the fields mongot has actually indexed (`GET /api/indexes/<id>/mappings`), and index names. It flags mismatches such as `text` on a `token` field. An optional `"index"` key stays in sync with the index dropdown and is not sent to mongot. Explain (0.8) can be off, query planner, execution stats, or all plans. The planner returns the plan and no hits; execution levels return hits plus a cumulative explain document in Search meta.
- upsert documents, delete by ID, and delete by query (0.8). Delete by query takes a search expression, a vector metadata filter, or match-all, bounded by max matches (0 means the server default of 10,000). Dry run is the default and only counts matches. A real delete can apply a prefix if the call fails or new documents arrive during the pass.
- show per-index statistics (**Stats**): live and Lucene document counts, index and directory size, bytes per document, memory domains, and per-field disk attribution with the shared and unattributed storage buckets. Values marked `*` are partial measurements; hover for the method and omitted components. `—` means the server could not measure it.
- export a dynamic search index's observed mapping as a static definition (**Export mapping**). It loads into the create form as `<name>_static`; create it and reingest the documents.

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
| `GET/PUT/DELETE` | `/api/indexes/<id>` | Get / update / drop index |
| `GET` | `/api/indexes/<id>/mappings` | Export observed mapping as a static definition (search indexes only) |
| `GET` | `/api/indexes/<id>/stats` | Index statistics (`?refresh=true` starts a fresh collection) |
| `GET` | `/api/indexes/<id>/field-stats` | Per-field statistics page (`refresh`, repeated `path`, `page_size` ≤ 500, `page_token`) |
| `POST` | `/api/indexes/<id>/documents` | Upsert documents into the index |
| `DELETE` | `/api/indexes/<id>/documents/<doc_id>` | Delete a document by `_id` |
| `POST` | `/api/indexes/<id>/delete-by-query` | Dry-run or delete a bounded search query, vector filter, or match-all |
| `POST` | `/api/indexes/<id>/search` | Text or vector search (paged). Optional `explain`: `query_planner`, `execution_stats`, `all_plans_execution` |
| `POST` | `/api/indexes/<id>/browse` | Browse all documents (paged) |
| `POST` | `/api/query/more` | Fetch next cursor page |
| `DELETE` | `/api/query/cursors/<cursor_id>` | Kill a query cursor |

Optional overrides:

- `NOMONGOT_ADDRESS` (default `localhost:27029`)
- `NOMONGOT_CREDENTIALS_DIR` (default `.nomongo-t`)

The Python client dependency is `mongot-standalone-client` 0.8.0, matching the push-only mongot API (no collections), cross-index `join` filters, query explain, and delete-by-query. Bulk upserts default to write concern `indexed`. Delete-by-query defaults to `visible` and, in this admin API, to a dry run.

## Query editor bundle

The search box uses a vendored CodeMirror build at `src/mong/web/static/vendor/codemirror.js`. Rebuild it only when upgrading CodeMirror:

```powershell
cd frontend
npm install
npm run build:vendor
npm test
```

## Test

```powershell
pytest
cd frontend
npm test
```
