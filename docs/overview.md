# Overview

Mong is a local admin console for [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot).

## Layout

- `src/mong/client.py` — TLS client to `localhost:27029` using `.nomongo-t/` credentials (`mongot-standalone-client` 0.8)
- `src/mong/service.py` — index, document, query, mapping-export, and statistics operations. Writes go to an index id; there is no collection catalog
- `src/mong/web/` — Flask app, REST API, and static admin UI
- `scripts/crm/` — deterministic fake CRM generator (`generate.py`), streaming batch loader that creates one search index per entity (`load.py`), join verifier that checks randomized parent/child join queries against an in-memory reference evaluator over a sampled account pool (`verify.py`), CLI (`cli.py`)

## Browse vs search

- **Browse** lists all documents through a fixed server-side `exists` on `_id` with `returnStoredSource`, and the UI shows each full document. The UI does not show a query editor. Stored source is present only when the index definition sets `storedSource`.
- **Search** / **Vector** send a JSON mongot expression and paginate with cursors (`/api/query/more`). The query box is a `<mong-query-editor>`: it completes JSON, operators, field paths from the index definition and the exported dynamic mapping, and index names, and it underlines queries that do not match the index mapping (for example `text` on a `token` field). An optional top-level `"index"` names an index and is removed before the query is sent. A vector query is flat (`path`, `queryVector`, `limit`), and its `filter` is an MQL document on `filter` fields. Explain (0.8) is a request option, not part of the expression: `query_planner` returns a plan and no cursor, and `execution_stats` / `all_plans_execution` return hits with a cumulative `explain` document on each page, including `GetMore`.
- **Join** (0.6+) is a semijoin predicate inside `compound.filter` or `compound.mustNot`: `{ "join": { "from": "<searchIndex>", "localField", "foreignField", "operator": { ... } } }`. Both key fields must be explicit `token` mappings, or native `objectId` mappings including `_id` (0.8). Omit `from` for a self-join. The editor completes foreign index names and token or objectId paths, and scopes the nested `operator` to the foreign index mapping. Results stay local documents — no foreign enrichment.
- **Index definitions** use a `<mong-definition-editor>` on the Indexes form. It completes keys, field types, analyzer names, and type set names for the selected index kind, and it underlines definitions standalone mongot rejects (invalid field types, missing vector options, unknown analyzers). `dynamic` is a boolean or `{ "typeSet" }`. Unknown keys are warnings, so a definition exported from mongot can still be submitted. Synonym sources are rejected because standalone mongot has no collection catalog. Ctrl+Enter submits the form.
- **Writes** upsert and delete by `_id` on one index. Delete-by-query (0.8) selects a bounded set of ids with a search query, a vector metadata filter, or match-all, then deletes them in batches. The admin API dry-runs unless `dry_run` is false. Changing an index definition starts an empty generation.

## Mapping export and statistics

- **Export mapping** (`GetIndexMappings`, 0.4+) merges the configured mapping with the field types Lucene has observed and returns a full definition with `dynamic: false` at every level. It is a snapshot: deleted field types can linger until merges, and null-only or empty values contribute nothing. Vector-search indexes are rejected.
- **Stats** (`GetIndexStats` / `GetIndexFieldStats`, 0.5+) report counts, sizes, memory, and per-field disk attribution for one pinned snapshot. `serialize.message_to_dict` keeps unset optional values as `null` because an absent value means "unavailable" while `0` is a real measurement. `MongotService.field_stats` polls while the server is collecting and never sets `refresh` on later pages, since page tokens bind to the first request's filters and page size. Shared postings and compressed stored source stay in named buckets, so field coverage is usually well below 100%.

## Credentials

Copy `server.crt` and `admin.token` from the `nomongo-t` container into `.nomongo-t/`. Never commit that directory.

See the root [README](../README.md) for setup, API routes, and CRM generator flags.
