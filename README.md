# Mong

Admin UI and Python client for a locally running [NoMongo-T](https://github.com/beardsandbeers/nomongo-t) (standalone mongot) Docker container.

## Prerequisites

- Docker with `nomongo-t` running and healthy on port `27029`
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

## Run the admin UI

```powershell
python -m mong
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050).

The UI can:

- show instance status and live indexes
- create collections
- create / edit / drop search and vector indexes
- browse all documents with cursor pagination (Browse mode has no query box)
- search / vector-search with a JSON expression
- upsert documents, delete by ID, and delete by query

## CRM sample data

Generate fake Accounts, Contacts, and Opportunities (JSON to stdout; no storage):

```powershell
python -m scripts.crm --accounts 10 --seed 42
```

Useful flags: `--contacts-min` / `--contacts-max`, `--opportunities-min` / `--opportunities-max`, `--entity accounts|contacts|opportunities|all`.

## API sketch

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Instance status (`?metrics=true` includes scrubbed metrics) |
| `GET/POST` | `/api/collections` | List / create collections |
| `GET` | `/api/collections/<id>` | Get collection |
| `GET/POST` | `/api/indexes` | List / create indexes |
| `GET/PUT/DELETE` | `/api/indexes/<id>` | Get / update / drop index |
| `POST` | `/api/collections/<id>/documents` | Upsert documents |
| `DELETE` | `/api/collections/<id>/documents/<doc_id>` | Delete document |
| `POST` | `/api/collections/<id>/delete-by-query` | Delete by search query |
| `GET` | `/api/collections/<id>/delete-by-query/<request_id>` | Delete-by-query status |
| `POST` | `/api/indexes/<id>/search` | Text or vector search (paged) |
| `POST` | `/api/indexes/<id>/browse` | Browse all documents (paged) |
| `POST` | `/api/query/more` | Fetch next cursor page |
| `DELETE` | `/api/query/cursors/<cursor_id>` | Kill a query cursor |

Optional overrides:

- `NOMONGOT_ADDRESS` (default `localhost:27029`)
- `NOMONGOT_CREDENTIALS_DIR` (default `.nomongo-t`)
- `MONG_REGISTRY_PATH` (default `.mong-admin/collections.json`)

## Test

```powershell
pytest
```
