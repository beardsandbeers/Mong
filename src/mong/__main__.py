"""Entry point for `python -m mong` — starts the admin UI server."""

from __future__ import annotations

from mong.web.app import main


if __name__ == "__main__":
    main()
