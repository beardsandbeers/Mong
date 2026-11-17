# Overview

Mong is a local admin console for [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot).

## Layout

- `src/mong/client.py` — TLS client to `localhost:27029` using `.nomongo-t/` credentials (`mongot-standalone-client` 0.10)
- `src/mong/service.py` — index, document, query, mapping-export, and statistics operations. Writes go to an index id; there is no collection catalog
- `src/mong/mongod.py` — MongoDB-managed search indexes through pymongo: `$listSearchIndexes` listing, `$search` / `$vectorSearch` / `$searchMeta` queries, collection browse, explain, server-side cursors, and summary alerts. Enabled by `MONGODB_URI`
- `src/mong/sources.py` — `SearchService`, the service the API and jobs use. `mongod:` index ids and `mongod-` cursor ids go to `mongod.py`; writes, statistics, and mapping export on those ids raise `READ_ONLY`
- `src/mong/serialize.py` — protobuf and BSON to JSON. Documents travel as relaxed Extended JSON
- `src/mong/metrics.py` — background `GetStatus` sampler: rates, interval latency, gauges, annotations, and alerts
- `src/mong/jobs.py` — in-process job runner for clearing an index, large deletes by query, and exports
- `src/mong/web/` — Flask app (request guard, serves the built UI from `dist/`) and REST API
- `frontend/` — Vite + TypeScript + Lit source for the UI (`src/views`, `src/components`, `src/editors`, `src/lib`). `npm run build` writes the gitignored `src/mong/web/dist/`
- `scripts/ingest/` — writers for mock data. `mongot.py` upserts a standalone search index; `mongod.py` bulk-upserts a MongoDB collection and creates a search index on it. The batching pipeline only sees `upsert_many`
- `Dockerfile`, `compose.yaml` — image with the built UI (target `app`) or without it (target `server`), run on the `mongo-search` stack's network
- `compose.standalone.yaml` — independent two-container NoMongo-T + Mong stack on port 5051, with its own network, persistent search data/credentials, and readiness checks
- `scripts/crm/` — deterministic fake CRM generator (`generate.py`), shared document shape (`schema.py`), `--target` wiring (`targets.py`), streaming loader (`load.py`), join verifier (`verify.py`), CLI (`cli.py`). Both targets create one search index per entity. `--target mongot` (the default) upserts documents into that index; `--target mongod` upserts them into the collection

## Browse vs search

- **Browse** lists all documents through a fixed server-side `exists` on `_id` with `returnStoredSource`, and the UI shows each full document. The UI does not show a query editor. Stored source is present only when the index definition sets `storedSource`.
- **Search** / **Vector** send a JSON mongot expression and paginate with cursors (`/api/query/more`). The query box is a `<mong-query-editor>`: it completes JSON, operators, field paths from the index definition and the exported dynamic mapping, and index names, and it underlines queries that do not match the index mapping (for example `text` on a `token` field). An optional top-level `"index"` names an index and is removed before the query is sent. A vector query is flat (`path`, `queryVector`, `limit`), and its `filter` is an MQL document on `filter` fields. Explain (0.8) is a request option, not part of the expression: `query_planner` returns a plan and no cursor, and `execution_stats` / `all_plans_execution` return hits with a cumulative `explain` document on each page, including `GetMore`. Explore keeps the newest explain document and records each page's end-to-end latency (measured in the browser) and mongot latency (`latency_ms` from the API).
- **Capabilities**: Explore derives what an index supports from its type and definition. Browse needs stored source, Vector needs a vector index, and editing a document needs `storedSource: true`, because upsert replaces the whole document and a partial stored source would drop the unstored fields.
- **Join** (0.6+) is a semijoin predicate inside `compound.filter` or `compound.mustNot`: `{ "join": { "from": "<searchIndex>", "localField", "foreignField", "operator": { ... } } }`. Both key fields must be explicit `token` mappings, or native `objectId` mappings including `_id` (0.8). Omit `from` for a self-join. The editor completes foreign index names and token or objectId paths, and scopes the nested `operator` to the foreign index mapping. Results stay local documents — no foreign enrichment.
- **Index definitions** use a `<mong-definition-editor>` on the Indexes form. It completes keys, field types, analyzer names, and type set names for the selected index kind, and it underlines definitions standalone mongot rejects (invalid field types, missing vector options, unknown analyzers). `dynamic` is a boolean or `{ "typeSet" }`. Unknown keys are warnings, so a definition exported from mongot can still be submitted. Synonym sources are rejected because standalone mongot has no collection catalog. Ctrl+Enter submits the form.
- **Writes** upsert and delete by `_id` on one index. Delete-by-query (0.8) selects a bounded set of ids with a search query, a vector metadata filter, or match-all, then deletes them in batches. The admin API dry-runs unless `dry_run` is false. Changing an index definition starts an empty generation. Update and drop require the `expected_revision` the client loaded, so a concurrent change fails with 409 instead of being overwritten.

## MongoDB-managed indexes

nomongo-t keeps two catalogs: standalone indexes (its gRPC API) and replicated indexes that MongoDB manages on collections. Each API sees only its own. Mong lists the second kind through mongod and names them `database.collection/index`. The frontend checks `capabilities(index).readOnly` (`source === "mongod"`):

- **Browse** reads the collection with `find` instead of searching `exists: _id`, so it needs no stored source.
- **Search** does not add `returnStoredSource`, so hits are the full collection documents.
- **Hidden**: writes (Add, Delete, Edit), the Fields, Storage, and Danger zone tabs, and the definition editor's save. The editor is read-only.
- **Overview** shows MongoDB's status, queryable flag, and definition version instead of mongot metrics.

## Extended JSON

Results are relaxed Extended JSON (`{"$oid"}`, `{"$date"}`, `{"$numberDecimal"}`). Inside documents, integers beyond 2^53 become `{"$numberLong"}` and whole-number doubles become `{"$numberDouble"}`, because JavaScript cannot tell `5.0` from `5`. Search metadata keys (`$`-prefixed) are not double-tagged. Writes, queries, and ids are parsed back with `bson.json_util`, so a document edited in the drawer keeps its types.

## Metrics and jobs

- **Sampler**: `MetricsSampler` polls `GetStatus` every 5 seconds and keeps 720 samples (about 1 hour) in memory. It starts on the first metrics request.
  - **Counters**: mongot counters are cumulative, so the sampler stores per-interval rates. A negative delta is a reset (mongot restart or a new generation) and yields no rate.
  - **Latency**: the mean for each interval comes from the timers' count and total deltas. The server's percentiles are rolling windows and are shown only as current values. Index latency is per result batch, not per query.
  - **Exclusions and annotations**: the sampler's own `GetStatus` calls are left out of the RPC series. Restarts, creates, rebuilds, and drops are recorded as annotations.
- **Alerts** use fixed thresholds:
  - mongot is unreachable, or management is not ready
  - free disk is under 10 GiB (warning) or 2 GiB (error)
  - RPCs are queued for 3 samples in a row
  - an index failed, is not READY, or is rebuilding, or its status code is an error or warning
  - initial-sync or steady-state exceptions rose in the last 5 minutes
  - deleted documents exceed 30% (on indexes with at least 1,000 documents)
  - replication lag is over 10 seconds
  - queries failed in the last 5 minutes
- **Jobs** run on daemon threads in the Flask process:
  - `clear_index` and `delete_by_query` loop delete-by-query in passes of 10,000.
  - `export` streams cursor pages to an NDJSON or CSV file in the system temp directory, downloaded from `/api/jobs/<id>/download`.
  - One mutating job runs per index at a time.
  - Up to 50 jobs are kept, and all are lost on restart.

## Request guard

`guard_request` in `src/mong/web/app.py` rejects requests whose `Host` is not loopback (or listed in `MONG_ALLOWED_HOSTS`). It also refuses writes that carry a foreign `Origin` or `Sec-Fetch-Site: cross-site`. The API has no authentication, so it must stay on `127.0.0.1`. Debug mode is off unless `--debug` or `MONG_DEBUG=1`.

## Mapping export and statistics

- **Export mapping** (`GetIndexMappings`, 0.4+) merges the configured mapping with the field types Lucene has observed and returns a full definition with `dynamic: false` at every level. It is a snapshot: deleted field types can linger until merges, and null-only or empty values contribute nothing. Vector-search indexes are rejected.
- **Stats** (`GetIndexStats` / `GetIndexFieldStats`, 0.5+) report counts, sizes, memory, and per-field disk attribution for one pinned snapshot. `serialize.message_to_dict` keeps unset optional values as `null` because an absent value means "unavailable" while `0` is a real measurement. `MongotService.field_stats` polls while the server is collecting and never sets `refresh` on later pages, since page tokens bind to the first request's filters and page size. Shared postings and compressed stored source stay in named buckets, so field coverage is usually well below 100%.

## Credentials

Copy `server.crt` and `admin.token` from the `nomongo-t` container into `.nomongo-t/`. Never commit that directory. In Docker, `compose.yaml` mounts both read-only from the existing stack's secrets volume. `compose.standalone.yaml` mounts only those two files from its own search volume after search finishes bootstrapping them.

See the root [README](../README.md) for setup, API routes, and CRM generator flags.
