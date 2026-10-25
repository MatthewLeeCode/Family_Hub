"""Family Hub: a family front end for the home server: books, films and TV, and more to come."""
import secrets
from datetime import timedelta
from pathlib import Path

from flask import Flask, jsonify

from . import looks
from .config import Config
from .hub import Hub, start_background

__version__ = "0.1.0"


def _secret_key(data_dir):
    """A random key, created once and kept with the data so sign-ins survive restarts."""
    path = Path(data_dir) / "secret.key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(32), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def create_app(config=None):
    config = config or Config()
    static = Path(__file__).parent / "static"
    app = Flask(__name__, static_folder=str(static), static_url_path="/static")
    app.config.update(
        SECRET_KEY=_secret_key(config.data_dir),
        SESSION_COOKIE_NAME="bookhub",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        SESSION_COOKIE_SECURE=config.secure_cookies,
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        MAX_CONTENT_LENGTH=64 * 1024 * 1024,
    )
    app.hub = Hub(config)

    from . import api, kosync, opds, secure_sessions, assistant_bridge, personal_looks, notes_bridge
    secure_sessions.install(app)
    app.register_blueprint(api.bp)
    app.register_blueprint(personal_looks.bp)
    app.register_blueprint(assistant_bridge.bp)
    app.register_blueprint(notes_bridge.bp)
    app.register_blueprint(kosync.bp)
    app.register_blueprint(opds.bp)

    @app.get("/")
    def index():
        html = (static / "index.html").read_text(encoding="utf-8")
        who = api.me()
        look = looks.for_profile(app.hub.con(), who["id"] if who not in (None, "guest") else None)
        return looks.page(html, look), 200, {"Cache-Control": "no-store"}

    @app.teardown_appcontext
    def finish_db(exc):
        from . import db
        db.finish(app.hub.config.db_path, failed=exc is not None)

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "version": __version__, "library": app.hub.library.available})

    with app.app_context():
        app.hub.load_tagpacks()
        app.hub.sort_new_books()
    if config.background_jobs:
        start_background(app.hub, app)
    return app
