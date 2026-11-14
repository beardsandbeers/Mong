# Mong

Admin UI and Python client for a locally running [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot) Docker container.

## Prerequisites

- Docker with `nomongo-t` running `mybyte/nomongo-t:0.5.0` and healthy on port `27029`
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

0.3.x, 0.4.x, and 0.5.x share the push API and data directory, so an upgrade keeps indexes, documents, and credentials as long as the new container mounts the same `/var/lib/mongot` volume:

```powershell
$volume = (docker inspect nomongo-t --format '{{json .Mounts}}' | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_.Destination -eq '/var/lib/mongot' }).Name
docker pull mybyte/nomongo-t:0.5.0
docker stop nomongo-t
docker rename nomongo-t nomongo-t-old
docker run -d --name nomongo-t -p 27029:27029 -v "${volume}:/var/lib/mongot" mybyte/nomongo-t:0.5.0
```

Keep the server image and `mongot-standalone-client` on the same version. Collection-backed 0.2.x data directories are not compatible.

## Run the admin UI

```powershell
python -m mong
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050).

The UI can:

- show instance status and live indexes
- create / edit / drop search and vector indexes (names are instance-wide)
- browse all documents with cursor pagination (Browse mode has no query box; the index must store source)
- search / vector-search with a JSON expression. The editor completes operators, field paths from the index definition and the fields mongot has actually indexed (`GET /api/indexes/<id>/mappings`), and index names. It flags mismatches such as `text` on a `token` field. An optional `"index"` key stays in sync with the index dropdown and is not sent to mongot.
- upsert documents and delete by ID
- show per-index statistics (**Stats**): live and Lucene document counts, index and directory size, bytes per document, memory domains, and per-field disk attribution with the shared and unattributed storage buckets. Values marked `*` are partial measurements; hover for the method and omitted components. `—` means the server could not measure it.
- export a dynamic search index's observed mapping as a static definition (**Export mapping**). It loads into the create form as `<name>_static`; create it and reingest the documents.

Documents live in the index. Updating an index definition rebuilds an empty generation, so the previous documents have to be loaded again. There is no collection catalog and no delete-by-query.

## CRM sample data

Generate fake Accounts, Contacts, and Opportunities and stream them into mongot:

```powershell
python -m scripts.crm --accounts 1000 --contacts-min 2 --contacts-max 5 --opportunities-min 1 --opportunities-max 3 --seed 42 --load
```

Without `--load` the documents are printed as NDJSON (`{"entity": ..., "document": ...}` per line).

`--load`:

1. Ensures `accounts_search` / `contacts_search` / `opportunities_search` indexes exist (dynamic mappings, stored source, and `_id` plus relationship fields indexed as `token` so `equals` lookups work). The suffix comes from `--index-suffix`. An existing index with the same definition is reused. A different definition is updated, which rebuilds an empty generation before the load reingests it.
2. Generates account by account and upserts each index every `--batch-size` docs (default 100), with a tqdm progress bar. Memory stays bounded by one account's links plus one batch per index.

Shape: `--accounts` sets the account count; contacts and opportunities are drawn per account from `--contacts-min/max` and `--opportunities-min/max` (set min = max for a fixed ratio).

Determinism: every id and document is derived from `(seed, entity, account index, child index)`, so

- the same `--seed` always produces the same documents (re-runs upsert in place);
- `--entity contacts` alone still produces `account_id` / `opportunity_ids` that match the other indexes;
- `--start-account N` continues the same dataset from account `N` (resume or extend). On Ctrl+C the loader prints the exact resume command.

Other flags: `--concern committed|indexed|visible` (default `committed`), `--index-suffix`, `--anchor-date` (reference "now" for generated dates), `--no-progress`. If `--seed` is omitted a random one is chosen and printed.

Expected throughput is bounded by nomongo-t writes (~70 docs/s on a local container, regardless of batch size, concern, or parallelism).

Example relationship lookup in the admin UI search box (with `returnStoredSource` to get documents back):

```json
{ "equals": { "path": "account_id", "value": "<account _id>" }, "returnStoredSource": true }
```

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
| `POST` | `/api/indexes/<id>/search` | Text or vector search (paged) |
| `POST` | `/api/indexes/<id>/browse` | Browse all documents (paged) |
| `POST` | `/api/query/more` | Fetch next cursor page |
| `DELETE` | `/api/query/cursors/<cursor_id>` | Kill a query cursor |

Optional overrides:

- `NOMONGOT_ADDRESS` (default `localhost:27029`)
- `NOMONGOT_CREDENTIALS_DIR` (default `.nomongo-t`)

The Python client dependency is `mongot-standalone-client` 0.5.0, matching the push-only mongot API (no collections).

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
