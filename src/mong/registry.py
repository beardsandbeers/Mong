"""Local cache of known collections (mongot has no ListCollections RPC)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

DEFAULT_REGISTRY_PATH = Path(".mong-admin") / "collections.json"


def registry_path() -> Path:
    override = os.environ.get("MONG_REGISTRY_PATH")
    return Path(override) if override else DEFAULT_REGISTRY_PATH


class CollectionRegistry:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or registry_path()
        self._lock = Lock()

    def _read(self) -> dict[str, dict[str, Any]]:
        if not self.path.is_file():
            return {}
        with self.path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list):
            return {item["collection_id"]: item for item in data if "collection_id" in item}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return sorted(self._read().values(), key=lambda item: (item.get("database", ""), item.get("name", "")))

    def upsert(self, collection: dict[str, Any]) -> dict[str, Any]:
        collection_id = collection["collection_id"]
        with self._lock:
            data = self._read()
            data[collection_id] = {
                "collection_id": collection_id,
                "database": collection.get("database", ""),
                "name": collection.get("name", ""),
                "accepted_sequence": collection.get("accepted_sequence", 0),
            }
            self._write(data)
            return data[collection_id]

    def get(self, collection_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._read().get(collection_id)

    def merge_from_indexes(self, indexes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Ensure collection IDs seen on indexes appear in the registry."""
        with self._lock:
            data = self._read()
            changed = False
            for index in indexes:
                collection_id = index.get("collection_id")
                if not collection_id or collection_id in data:
                    continue
                data[collection_id] = {
                    "collection_id": collection_id,
                    "database": "",
                    "name": "",
                    "accepted_sequence": 0,
                }
                changed = True
            if changed:
                self._write(data)
            return sorted(data.values(), key=lambda item: (item.get("database", ""), item.get("name", "")))
