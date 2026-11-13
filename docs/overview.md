# Overview

Mong is a local admin console for [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot).

## Layout

- `src/mong/client.py` — TLS client to `localhost:27029` using `.nomongo-t/` credentials
- `src/mong/service.py` — catalog, document, and query operations
- `src/mong/web/` — Flask app, REST API, and static admin UI
- `scripts/crm/` — fake CRM dataset generator (stdout JSON)

## Browse vs search

- **Browse** lists all documents through a fixed server-side `exists` on `_id`. The UI does not show a query editor.
- **Search** / **Vector** send a JSON mongot expression and paginate with cursors (`/api/query/more`).

## Credentials

Copy `server.crt` and `admin.token` from the `nomongo-t` container into `.nomongo-t/`. Never commit that directory.

See the root [README](../README.md) for setup, API routes, and CRM generator flags.
