"""Flask application factory for the NoMongo-T admin UI."""

from __future__ import annotations

from pathlib import Path

from flask import Flask, send_from_directory

from mong.web.api import api_bp

STATIC_DIR = Path(__file__).resolve().parent / "static"


def create_app() -> Flask:
    app = Flask(
        __name__,
        static_folder=str(STATIC_DIR),
        static_url_path="/static",
    )
    app.register_blueprint(api_bp)

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    return app


def main() -> None:
    app = create_app()
    app.run(host="127.0.0.1", port=5050, debug=True)
