"""Opaque, revocable browser sessions. Provider/core tokens remain on the server."""
import hashlib
import json
import re
import secrets
import time
from urllib.parse import urlsplit

from flask import current_app, jsonify, request, session
from flask.sessions import SessionInterface, SessionMixin
from werkzeug.datastructures import CallbackDict

LIFETIME = 12 * 60 * 60


class ServerSession(CallbackDict, SessionMixin):
    def __init__(self, data=None, sid=None, revision=0):
        super().__init__(data, lambda obj: setattr(obj, "modified", True))
        self.sid = sid or secrets.token_urlsafe(32)
        self.original_sid = sid
        self.revision = revision
        self.modified = False


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def view_context():
    """Public view binding, not a bearer credential; changes with every rotation."""
    if not session.get("pid"):
        return None
    # Domain-separated from the stored cookie hash. This value cannot be used as
    # the opaque browser cookie or to recover it, and grants no authority itself.
    return _hash("family-hub/assistant-view/v1:" + session.sid)


def _credential_stamp(app, pid):
    if pid == "guest":
        return "guest"
    profile = app.hub.profile(pid)
    if profile is None:
        return None
    return profile_stamp(profile)


def profile_stamp(profile):
    """Bind to the exact credentials/role that were actually authenticated."""
    return _hash(str(profile["passcode_hash"]) + ":" + profile["role"])


def _valid_credentials(app, data):
    if not isinstance(data, dict):
        return False
    pid = data.get("pid")
    if pid and data.get("_credential_stamp") != _credential_stamp(app, pid):
        return False
    if data.get("via_admin"):
        admin_id = data.get("_authenticator_id")
        admin = app.hub.profile(admin_id) if admin_id else None
        if admin is None or admin["role"] != "admin" or data.get("_authenticator_stamp") != profile_stamp(admin):
            return False
    return True


class Store(SessionInterface):
    def open_session(self, app, request):
        sid = request.cookies.get(self.get_cookie_name(app), "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", sid):
            return ServerSession()
        row = app.hub.con().execute("SELECT document,expires_at,revision FROM web_sessions WHERE token_hash=?", (_hash(sid),)).fetchone()
        if row is None or row["expires_at"] <= int(time.time()):
            return ServerSession()
        try:
            data = json.loads(row["document"])
        except (ValueError, TypeError):
            return ServerSession()
        if not _valid_credentials(app, data):
            app.hub.con().execute("DELETE FROM web_sessions WHERE token_hash=?", (_hash(sid),))
            app.hub.con().commit()
            return ServerSession()
        return ServerSession(data, sid, row["revision"])

    def save_session(self, app, value, response):
        if not value.modified:
            return
        con = app.hub.con()
        name = self.get_cookie_name(app)
        if not value:
            if value.original_sid:
                con.execute("DELETE FROM web_sessions WHERE token_hash=?", (_hash(value.original_sid),))
            con.commit()
            response.delete_cookie(name, path="/", samesite="Strict", secure=app.config["SESSION_COOKIE_SECURE"], httponly=True)
            return
        now = int(time.time())
        created = value.get("_created", now)
        value["_created"] = created
        expires = created + LIFETIME
        # Take the write lock before checking credentials. A request loaded before
        # logout/rotation or credential revocation must never resurrect that row.
        if not con.in_transaction:
            con.execute("BEGIN IMMEDIATE")
        with con:
            if expires <= now or not _valid_credentials(app, dict(value)):
                if value.original_sid:
                    con.execute("DELETE FROM web_sessions WHERE token_hash=?", (_hash(value.original_sid),))
                return
            document = json.dumps(dict(value))
            if value.original_sid:
                row = con.execute("SELECT document FROM web_sessions WHERE token_hash=? AND revision=? AND expires_at>?",
                                  (_hash(value.original_sid), value.revision, now)).fetchone()
                if row is None or not _valid_credentials(app, json.loads(row["document"])):
                    return  # no Set-Cookie: do not overwrite a newer browser login
                if value.sid == value.original_sid:
                    con.execute("UPDATE web_sessions SET document=?,expires_at=?,revision=revision+1 WHERE token_hash=? AND revision=?",
                                (document, expires, _hash(value.original_sid), value.revision))
                else:
                    con.execute("DELETE FROM web_sessions WHERE token_hash=? AND revision=?", (_hash(value.original_sid), value.revision))
                    con.execute("INSERT INTO web_sessions(token_hash,document,expires_at,revision) VALUES(?,?,?,0)", (_hash(value.sid), document, expires))
            else:
                con.execute("INSERT INTO web_sessions(token_hash,document,expires_at,revision) VALUES(?,?,?,0)", (_hash(value.sid), document, expires))
            con.execute("DELETE FROM web_sessions WHERE expires_at<=?", (now,))
        response.set_cookie(name, value.sid, max_age=max(0, expires-int(time.time())), path="/", httponly=True,
                            secure=app.config["SESSION_COOKIE_SECURE"], samesite="Strict")
        response.headers.add("Vary", "Cookie")


def rotate_session():
    session.sid = secrets.token_urlsafe(32)
    session.modified = True


def establish_session(pid, via_admin=False, target_stamp=None, authenticator=None):
    session.clear()
    rotate_session()
    session["pid"] = pid
    session["via_admin"] = via_admin
    session["_credential_stamp"] = target_stamp or _credential_stamp(current_app, pid)
    if authenticator is not None:
        session["_authenticator_id"] = authenticator["id"]
        session["_authenticator_stamp"] = profile_stamp(authenticator)
    session["authenticated_at"] = int(time.time())


def install(app):
    app.hub.con().execute("CREATE TABLE IF NOT EXISTS web_sessions(token_hash TEXT PRIMARY KEY,document TEXT NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0)")
    if "revision" not in {row["name"] for row in app.hub.con().execute("PRAGMA table_info(web_sessions)")}:
        app.hub.con().execute("ALTER TABLE web_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
    app.hub.con().commit()
    app.session_interface = Store()
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False

    @app.before_request
    def same_origin_mutations():
        if not request.path.startswith("/api/") or request.method in ("GET", "HEAD", "OPTIONS"):
            return None
        # Browser JSON requests cannot come from other origins without preflight.
        # Forms/uploads carry Origin or Fetch Metadata, checked independently.
        origin = request.headers.get("Origin")
        if origin:
            try:
                parsed, expected = urlsplit(origin), urlsplit(request.host_url)
                valid = (parsed.scheme in ("http", "https") and parsed.scheme == expected.scheme
                         and parsed.netloc == expected.netloc and not parsed.path and not parsed.query
                         and not parsed.fragment and parsed.username is None and parsed.password is None)
            except ValueError:
                valid = False
            if not valid:
                return jsonify({"error": "This action must come from Family Hub."}), 403
        if request.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
            return jsonify({"error": "This action must come from Family Hub."}), 403
        return None

    @app.after_request
    def private_responses(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response
