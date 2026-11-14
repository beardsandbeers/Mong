# Overview

Mong is a local admin console for [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot).

## Layout

- `src/mong/client.py` — TLS client to `localhost:27029` using `.nomongo-t/` credentials (`mongot-standalone-client` 0.3)
- `src/mong/service.py` — index, document, and query operations. Writes go to an index id; there is no collection catalog
- `src/mong/web/` — Flask app, REST API, and static admin UI
- `scripts/crm/` — deterministic fake CRM generator (`generate.py`), streaming batch loader that creates one search index per entity (`load.py`), CLI (`cli.py`)

## Browse vs search

- **Browse** lists all documents through a fixed server-side `exists` on `_id` with `returnStoredSource`, and the UI shows each full document. The UI does not show a query editor. Stored source is present only when the index definition sets `storedSource`.
- **Search** / **Vector** send a JSON mongot expression and paginate with cursors (`/api/query/more`).
- **Writes** upsert and delete by `_id` on one index. Delete-by-query is not part of the 0.3 API. Changing an index definition starts an empty generation.

## Credentials

Copy `server.crt` and `admin.token` from the `nomongo-t` container into `.nomongo-t/`. Never commit that directory.

See the root [README](../README.md) for setup, API routes, and CRM generator flags.
