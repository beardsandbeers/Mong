"""NoMongo-T (standalone mongot) client helpers."""

from __future__ import annotations

import os
from pathlib import Path

from mongot_standalone import Client

DEFAULT_ADDRESS = "localhost:27029"
DEFAULT_CREDENTIALS_DIR = Path(".nomongo-t")


def credentials_dir() -> Path:
    """Resolve credential directory from env or project-local default."""
    override = os.environ.get("NOMONGOT_CREDENTIALS_DIR")
    return Path(override) if override else DEFAULT_CREDENTIALS_DIR


def address() -> str:
    return os.environ.get("NOMONGOT_ADDRESS", DEFAULT_ADDRESS)


def create_client(
    *,
    host: str | None = None,
    creds: Path | None = None,
) -> Client:
    """Create a TLS-authenticated client for the local nomongo-t container."""
    base = creds or credentials_dir()
    ca_file = base / "server.crt"
    token_file = base / "admin.token"

    if not ca_file.is_file():
        raise FileNotFoundError(
            f"Missing TLS certificate at {ca_file}. "
            "Export it with: docker cp nomongo-t:/var/lib/mongot/config/server.crt .nomongo-t/server.crt"
        )
    if not token_file.is_file():
        raise FileNotFoundError(
            f"Missing admin token at {token_file}. "
            "Export it with: docker cp nomongo-t:/var/lib/mongot/config/admin.token .nomongo-t/admin.token"
        )

    return Client(
        host or address(),
        ca_file=str(ca_file),
        token_file=str(token_file),
    )
