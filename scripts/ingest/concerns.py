"""Write-concern names shared by the mock-data targets."""

from __future__ import annotations

MONGOT_CONCERNS = ("indexed", "committed", "visible")
MONGOT_DEFAULT_CONCERN = "indexed"
MONGOD_CONCERNS = ("acknowledged", "journaled", "majority")
MONGOD_DEFAULT_CONCERN = "acknowledged"

_BY_TARGET = {
    "mongot": MONGOT_CONCERNS,
    "mongod": MONGOD_CONCERNS,
}
_DEFAULTS = {
    "mongot": MONGOT_DEFAULT_CONCERN,
    "mongod": MONGOD_DEFAULT_CONCERN,
}


def concerns_for(target: str) -> tuple[str, ...]:
    try:
        return _BY_TARGET[target]
    except KeyError:
        raise ValueError(f"unknown target: {target}") from None


def default_concern_for(target: str) -> str:
    try:
        return _DEFAULTS[target]
    except KeyError:
        raise ValueError(f"unknown target: {target}") from None
