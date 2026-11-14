# Overview

Mong is a local admin console for [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot).

## Layout

- `src/mong/client.py` — TLS client to `localhost:27029` using `.nomongo-t/` credentials (`mongot-standalone-client` 0.5)
- `src/mong/service.py` — index, document, query, mapping-export, and statistics operations. Writes go to an index id; there is no collection catalog
- `src/mong/web/` — Flask app, REST API, and static admin UI
- `scripts/crm/` — deterministic fake CRM generator (`generate.py`), streaming batch loader that creates one search index per entity (`load.py`), CLI (`cli.py`)

## Browse vs search

- **Browse** lists all documents through a fixed server-side `exists` on `_id` with `returnStoredSource`, and the UI shows each full document. The UI does not show a query editor. Stored source is present only when the index definition sets `storedSource`.
- **Search** / **Vector** send a JSON mongot expression and paginate with cursors (`/api/query/more`). The query box is a `<mong-query-editor>`: it completes JSON, operators, field paths from the index definition and the exported dynamic mapping, and index names, and it underlines queries that do not match the index mapping (for example `text` on a `token` field). An optional top-level `"index"` names an index and is removed before the query is sent. A vector query is flat (`path`, `queryVector`, `limit`), and its `filter` is an MQL document on `filter` fields.
- **Writes** upsert and delete by `_id` on one index. Delete-by-query is not part of the push API. Changing an index definition starts an empty generation.

## Mapping export and statistics

- **Export mapping** (`GetIndexMappings`, 0.4+) merges the configured mapping with the field types Lucene has observed and returns a full definition with `dynamic: false` at every level. It is a snapshot: deleted field types can linger until merges, and null-only or empty values contribute nothing. Vector-search indexes are rejected.
- **Stats** (`GetIndexStats` / `GetIndexFieldStats`, 0.5+) report counts, sizes, memory, and per-field disk attribution for one pinned snapshot. `serialize.message_to_dict` keeps unset optional values as `null` because an absent value means "unavailable" while `0` is a real measurement. `MongotService.field_stats` polls while the server is collecting and never sets `refresh` on later pages, since page tokens bind to the first request's filters and page size. Shared postings and compressed stored source stay in named buckets, so field coverage is usually well below 100%.

## Credentials

Copy `server.crt` and `admin.token` from the `nomongo-t` container into `.nomongo-t/`. Never commit that directory.

See the root [README](../README.md) for setup, API routes, and CRM generator flags.
