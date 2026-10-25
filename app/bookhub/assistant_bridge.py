"""Same-origin client adapter for the separate Rust assistant core.

The core authenticates its own account and authorizes every action. A Family Hub
profile stores its linked core session server-side, never in browser storage.
"""
import ipaddress
import hmac
import json
import re
from urllib.parse import urlsplit

import requests
from flask import Blueprint, current_app, jsonify, make_response, request, session

from .api import fail, profile_only
from .secure_sessions import rotate_session, view_context

bp = Blueprint("assistant_bridge", __name__, url_prefix="/api/assistant")


def endpoint():
    url = current_app.hub.config.assistant_core_url
    parts = urlsplit(url)
    if not parts.hostname or parts.port == 0 or any(ord(char) <= 32 for char in url):
        raise ValueError("Invalid assistant address")
    try:
        local = parts.hostname == "localhost" or ipaddress.ip_address(parts.hostname or "").is_loopback
    except ValueError:
        local = False
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("Invalid assistant address")
    if parts.scheme not in ("http", "https") or (parts.scheme == "http" and not local):
        raise ValueError("Assistant HTTP must use loopback; remote connections require HTTPS")
    return url.rstrip("/")


def usable_profile():
    if session.get("via_admin"):
        return fail("Sign in directly to your own profile to use the assistant.", 403)
    expected = request.headers.get("X-Assistant-Context", "")
    if not re.fullmatch(r"[a-f0-9]{64}", expected) or not hmac.compare_digest(expected, view_context() or ""):
        return jsonify({"error": "Your sign-in changed. Reload Family Hub before using the assistant.",
                        "code": "assistant_session_changed"}), 409
    return None


def call(method, path, data=None, login=False):
    token = session.get("assistant_token")
    if not login and not token:
        return fail("Sign in to your assistant account.", 401)
    try:
        # Fixed endpoint and explicit paths; never an agent-controlled proxy URL.
        headers = {"X-Household-Request": "1"}
        if token and not login:
            headers["Cookie"] = "household_session=" + token
        # Do not send loopback credentials through environment proxies, or attach
        # unrelated .netrc credentials to this dedicated core connection.
        with requests.Session() as client:
            client.trust_env = False
            response = client.request(method, endpoint() + "/api/" + path, json=data,
                                      headers=headers, timeout=(3, 5 if path == "logout" else 35), allow_redirects=False)
        if response.status_code == 401 and not login:
            session.pop("assistant_token", None)
            session.pop("assistant_user", None)
        if 300 <= response.status_code < 400:
            return fail("The assistant address redirected unexpectedly.", 502)
        if not response.ok:
            messages = {400: "The assistant rejected that request.", 401: "Sign in to your assistant account.",
                        403: "Your assistant account cannot perform that action.", 404: "That assistant item was not found.",
                        409: "That assistant item changed. Refresh and try again.", 413: "That request is too large.",
                        429: "The assistant is busy. Try again shortly."}
            return fail(messages.get(response.status_code, "The assistant could not complete that request."),
                        response.status_code if response.status_code in messages else 502)
        payload = response.json()
        if not isinstance(payload, dict):
            return fail("The assistant returned an invalid response.", 502)
        if login and response.ok:
            token = response.cookies.get("household_session")
            if not token or not re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token):
                return fail("The assistant did not create a session.", 502)
            fields = ("id", "name", "login", "private_space")
            if not isinstance(payload, dict) or not all(isinstance(payload.get(field), str) and 0 < len(payload[field]) <= 1024 for field in fields):
                return fail("The assistant returned an invalid account.", 502)
            payload = {field: payload[field] for field in fields}
            if token in json.dumps(payload):
                return fail("The assistant returned an invalid account.", 502)
            session["assistant_token"] = token
            session["assistant_user"] = payload
            rotate_session()
            return jsonify({"user": payload, "context": view_context()})
        if token and token in json.dumps(payload):
            return fail("The assistant returned an invalid response.", 502)
        return jsonify(payload), response.status_code
    except (requests.RequestException, requests.cookies.CookieConflictError, ValueError):
        # Exceptions can include URL/header details; never send them to the browser.
        return fail("The assistant is unavailable. Check its server and connection settings.", 503)


@bp.get("/status")
@profile_only
def status(who):
    denied = usable_profile()
    if denied:
        return denied
    return jsonify({"configured": bool(current_app.hub.config.assistant_core_url),
                    "signed_in": bool(session.get("assistant_token")),
                    "user": session.get("assistant_user")})


@bp.post("/login")
@profile_only
def login(who):
    denied = usable_profile()
    if denied:
        return denied
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {"login", "password"} or not all(isinstance(v, str) and 0 < len(v) <= 1024 for v in data.values()):
        return fail("Enter your assistant account and password.")
    disconnect()
    response = make_response(call("POST", "login", data, login=True))
    # A failed reconnect can still disconnect and rotate the old account. Let
    # this initiating view retry; unrelated tabs keep their old binding.
    payload = response.get_json()
    payload["context"] = view_context()
    response.set_data(current_app.json.dumps(payload))
    return response


def disconnect():
    connected = bool(session.get("assistant_token"))
    if connected:
        call("POST", "logout", {})
    session.pop("assistant_token", None)
    session.pop("assistant_user", None)
    if connected:
        rotate_session()


@bp.post("/logout")
@profile_only
def logout(who):
    denied = usable_profile()
    if denied:
        return denied
    disconnect()
    return jsonify({"ok": True, "context": view_context()})


# Explicit path allowlist. No generic URL, arbitrary route or credential forwarding tool.
@bp.route("/state", methods=["GET"])
@bp.route("/conversations", methods=["POST"])
@bp.route("/conversations/<string:item>", methods=["GET"])
@bp.route("/conversations/<string:item>/messages", methods=["POST"])
@bp.route("/jobs/<string:item>/stop", methods=["POST"])
@bp.route("/approvals/<string:item>", methods=["POST"])
@bp.route("/responsibilities/<string:item>", methods=["POST"])
@bp.route("/policies", methods=["POST"])
@profile_only
def forward(who, item=None):
    denied = usable_profile()
    if denied:
        return denied
    if item is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item):
        return fail("Invalid item reference.")
    if request.content_length and request.content_length > 32768:
        return fail("That request is too large.", 413)
    body = request.get_json(silent=True) if request.method != "GET" else None
    if request.method != "GET" and not isinstance(body, dict):
        return fail("Expected an object.")
    path = request.path.removeprefix("/api/assistant/")
    return call(request.method, path, body)
