"""Flask application factory for the NoMongo-T admin UI."""

from __future__ import annotations

import argparse
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, send_from_directory

# Windows maps .js to text/plain. Module scripts are refused unless this is JavaScript.
mimetypes.add_type("text/javascript", ".js")

from mong.web.api import api_bp

STATIC_DIR = Path(__file__).resolve().parent / "static"
DIST_DIR = Path(__file__).resolve().parent / "dist"

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

BUILD_MISSING_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Mong</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.5">
<h1>Mong UI is not built</h1>
<p>Build the frontend, then reload:</p>
<pre>cd frontend
npm install
npm run build</pre>
<p>The previous UI is still available at <a href="/legacy/">/legacy/</a>.</p>
</body></html>
"""


def _hostname(host: str) -> str:
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def allowed_hosts() -> set[str]:
    extra = {item.strip().lower() for item in os.environ.get("MONG_ALLOWED_HOSTS", "").split(",")}
    return LOOPBACK_HOSTS | {item for item in extra if item}


def _forbidden(message: str):
    return jsonify({"error": message, "code": "FORBIDDEN"}), 403


def guard_request():
    """Block DNS rebinding (unknown Host) and cross-site writes (foreign Origin)."""
    if _hostname(request.host.lower()) not in allowed_hosts():
        return _forbidden("Host not allowed. Add this hostname to MONG_ALLOWED_HOSTS.")
    if request.method not in UNSAFE_METHODS:
        return None
    if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
        return _forbidden("Cross-site request refused")
    origin = request.headers.get("Origin")
    if origin is None:
        return None
    if origin == "null" or urlsplit(origin).netloc.lower() != request.host.lower():
        return _forbidden("Origin not allowed")
    return None


def create_app() -> Flask:
    app = Flask(
        __name__,
        static_folder=str(STATIC_DIR),
        static_url_path="/static",
    )
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    app.before_request(guard_request)
    app.register_blueprint(api_bp)

    @app.get("/")
    def index():
        if not (DIST_DIR / "index.html").is_file():
            return BUILD_MISSING_PAGE, 503, {"Content-Type": "text/html; charset=utf-8"}
        return send_from_directory(DIST_DIR, "index.html")

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        return send_from_directory(DIST_DIR / "assets", filename, max_age=31536000)

    @app.get("/favicon.svg")
    def favicon():
        return send_from_directory(DIST_DIR, "favicon.svg")

    @app.get("/legacy/")
    def legacy():
        return send_from_directory(STATIC_DIR, "index.html")

    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Mong admin UI for NoMongo-T")
    parser.add_argument(
        "--host",
        default=os.environ.get("MONG_HOST", "127.0.0.1"),
        help="Interface to listen on (also MONG_HOST; default 127.0.0.1)",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("MONG_PORT", "5050")))
    parser.add_argument(
        "--debug",
        action="store_true",
        default=os.environ.get("MONG_DEBUG", "").lower() in {"1", "true", "yes"},
        help="Enable Flask debug mode and the reloader (also MONG_DEBUG=1)",
    )
    args = parser.parse_args(argv)
    app = create_app()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)
