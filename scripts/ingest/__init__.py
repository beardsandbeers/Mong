"""Writers that put mock documents straight into mongot or mongod.

``mongot`` upserts a standalone search index. ``mongod`` bulk-upserts a MongoDB
collection and creates a search index on it. The batching pipeline only sees
``upsert_many``; the CRM loader picks a writer with ``--target``.
"""

from scripts.ingest.concerns import (
    MONGOD_CONCERNS,
    MONGOD_DEFAULT_CONCERN,
    MONGOT_CONCERNS,
    MONGOT_DEFAULT_CONCERN,
    concerns_for,
    default_concern_for,
)

__all__ = [
    "MONGOD_CONCERNS",
    "MONGOD_DEFAULT_CONCERN",
    "MONGOT_CONCERNS",
    "MONGOT_DEFAULT_CONCERN",
    "concerns_for",
    "default_concern_for",
]
