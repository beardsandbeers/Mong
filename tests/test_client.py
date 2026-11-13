from pathlib import Path

import pytest

from mong.client import create_client, credentials_dir


def test_credentials_dir_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NOMONGOT_CREDENTIALS_DIR", raising=False)
    assert credentials_dir() == Path(".nomongo-t")


def test_create_client_missing_cert(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="TLS certificate"):
        create_client(creds=tmp_path)
