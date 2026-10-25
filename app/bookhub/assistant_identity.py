"""First-party core sign-in for explicitly enrolled local Family profiles.

The core validates the password and every child session. This module keeps the
password transient and commits the exact parent session expected by the core.
"""
import hashlib
import hmac
import json
import math
import re
import secrets
import time
import uuid

import requests
from flask import current_app, jsonify, session

from . import secure_sessions


def install(app):
    con = app.hub.con()
    con.execute("CREATE TABLE IF NOT EXISTS assistant_installation(id INTEGER PRIMARY KEY CHECK(id=1),instance_id TEXT NOT NULL UNIQUE)")
    row = con.execute("SELECT instance_id FROM assistant_installation WHERE id=1").fetchone()
    if row is None:
        instance = str(uuid.uuid4())
        con.execute("INSERT INTO assistant_installation VALUES(1,?)", (instance,))
    else:
        instance = row["instance_id"]
        if str(uuid.UUID(instance)) != instance:
            raise ValueError("Invalid Family installation identity")
    con.commit()
    path = getattr(app.hub.config, "assistant_identity_bindings", None)
    bindings = {}
    if path:
        raw = path.read_bytes()
        if len(raw) > 65536:
            raise ValueError("Invalid Assistant identity configuration")
        data = json.loads(raw)
        if (not isinstance(data, dict) or set(data) != {"version", "instance_id", "bindings"}
                or type(data["version"]) is not int or data["version"] != 1
                or data["instance_id"] != instance or not isinstance(data["bindings"], list)
                or not 1 <= len(data["bindings"]) <= 64):
            raise ValueError("Invalid Assistant identity configuration")
        seen_ids, seen_users = set(), set()
        for value in data["bindings"]:
            if (not isinstance(value, dict)
                    or set(value) != {"profile_id", "binding_id", "core_user_id", "profile_stamp"}
                    or type(value["profile_id"]) is not int or value["profile_id"] <= 0
                    or any(not isinstance(value[key], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value[key])
                           for key in ("binding_id", "core_user_id"))
                    or not isinstance(value["profile_stamp"], str)
                    or not re.fullmatch(r"[a-f0-9]{64}", value["profile_stamp"])
                    or value["profile_id"] in bindings or value["binding_id"] in seen_ids
                    or value["core_user_id"] in seen_users):
                raise ValueError("Invalid Assistant identity binding")
            bindings[value["profile_id"]] = dict(value)
            seen_ids.add(value["binding_id"])
            seen_users.add(value["core_user_id"])
    app.extensions["assistant_identity"] = {"enabled": bool(path), "instance_id": instance, "bindings": bindings}


def configured(app=None):
    return (app or current_app).extensions.get("assistant_identity", {}).get("enabled", False)


def binding(profile_id, app=None):
    if type(profile_id) is not int:
        return None
    return (app or current_app).extensions.get("assistant_identity", {}).get("bindings", {}).get(profile_id)


def valid_profile(profile, enrolled):
    return bool(profile is not None and profile["passcode_hash"]
                and hmac.compare_digest(secure_sessions.profile_stamp(profile), enrolled["profile_stamp"]))


def valid_parent(app, data):
    enrolled = binding(data.get("pid"), app)
    if not enrolled:
        return not configured(app) or not data.get("assistant_token")
    profile = app.hub.profile(enrolled["profile_id"])
    user = data.get("assistant_user")
    return (valid_profile(profile, enrolled) and data.get("authentication_method") == "core"
            and data.get("via_admin") is False and data.get("assistant_binding_id") == enrolled["binding_id"]
            and isinstance(user, dict) and user.get("id") == enrolled["core_user_id"]
            and isinstance(data.get("assistant_token"), str)
            and re.fullmatch(r"[a-f0-9]{64}", data["assistant_token"]) is not None)


def sign_in(target, password):
    """Return a normal login response. Caller already reserved a lockout try."""
    from .api import fail
    from .assistant_bridge import disconnect, endpoint
    enrolled = binding(target["id"])
    if not enrolled or not valid_profile(target, enrolled):
        return fail("This profile's account link needs to be set up again.", 403)
    if not isinstance(password, str) or not 0 < len(password) <= 1024:
        return fail("Enter your account password.", 400)
    sid = secrets.token_urlsafe(32)
    created = int(time.time())
    parent_expires = (created + secure_sessions.LIFETIME) * 1000
    body = {"binding_id": enrolled["binding_id"], "password": password,
            "parent_session_hash": hashlib.sha256(sid.encode()).hexdigest(),
            "parent_expires_at": parent_expires}
    try:
        with requests.Session() as transport:
            transport.trust_env = False
            result = transport.post(endpoint() + "/api/family/login", json=body,
                                    headers={"X-Household-Request": "1"},
                                    timeout=(3, 15), allow_redirects=False)
        if result.status_code in (401, 403):
            return fail("That account password or profile link is not valid.", 403)
        if result.status_code == 429:
            return fail("Too many sign-in attempts. Wait a minute and try again.", 429)
        if result.status_code != 200:
            return fail("Sign-in is unavailable while the assistant server is offline. Try again shortly.", 503)
        payload = result.json()
        fields = ("id", "name", "login", "private_space")
        token = result.cookies.get("household_session")
        if (not isinstance(payload, dict) or set(payload) != {*fields, "expires_at"}
                or any(not isinstance(payload.get(key), str) or not 0 < len(payload[key]) <= 1024 for key in fields)
                or payload["id"] != enrolled["core_user_id"]
                or not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token)
                or type(payload["expires_at"]) is not int
                or not int(time.time() * 1000) < payload["expires_at"] <= parent_expires
                or token in json.dumps(payload)):
            return fail("The account server returned an invalid sign-in.", 502)
    except (requests.RequestException, requests.cookies.CookieConflictError, ValueError, TypeError):
        return fail("Sign-in is unavailable while the assistant server is offline. Try again shortly.", 503)
    finally:
        body.pop("password", None)
    # No Family write transaction spans the core request. Re-read current state
    # before revoking the old connection or installing this prospective parent.
    current = current_app.hub.profile(target["id"])
    if not valid_profile(current, enrolled) or not secure_sessions.current_session_unchanged():
        return fail("Your sign-in changed. Reload Family Hub and try again.", 409)
    revocation = disconnect()
    secure_sessions.establish_session(target["id"], target_stamp=enrolled["profile_stamp"],
                                      sid=sid, created_at=created)
    session["assistant_token"] = token
    session["assistant_user"] = {key: payload[key] for key in fields}
    session["assistant_binding_id"] = enrolled["binding_id"]
    session["authentication_method"] = "core"
    session["_assistant_expires"] = math.ceil(payload["expires_at"] / 1000)
    session.pending_primary_login = True
    return jsonify({"ok": True, "core_revocation": revocation})
