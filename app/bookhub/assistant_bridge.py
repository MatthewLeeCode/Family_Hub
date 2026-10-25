"""Same-origin client adapter for the separate Rust assistant core.

The core authenticates its own account and authorizes every action. A Family Hub
profile stores its linked core session server-side, never in browser storage.
"""
import ipaddress
import hmac
import json
import re
from urllib.parse import urlsplit, urlencode

import requests
from flask import Blueprint, current_app, jsonify, make_response, request, session

from .api import fail, profile_only
from .secure_sessions import rotate_session, view_context
from . import assistant_mail_contract as mail_contract
from . import assistant_responsibility_contract as responsibility_contract, assistant_identity

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


def call(method, path, data=None, login=False, project=None, error_codes=None, expected_status=None):
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
            if error_codes:
                try:
                    code = response.json().get("error")
                    message = error_codes.get(response.status_code, {}).get(code) if isinstance(code, str) else None
                except (ValueError, AttributeError):
                    message = None
                if message:
                    return jsonify({"error": message, "code": code}), response.status_code
            messages = {400: "The assistant rejected that request.", 401: "Sign in to your assistant account.",
                        403: "Your assistant account cannot perform that action.", 404: "That assistant item was not found.",
                        409: "That assistant item changed. Refresh and try again.", 413: "That request is too large.",
                        422: "Check the fields in that assistant request.",
                        429: "The assistant is busy. Try again shortly."}
            return fail(messages.get(response.status_code, "The assistant could not complete that request."),
                        response.status_code if response.status_code in messages else 502)
        if expected_status is not None and response.status_code != expected_status:
            return fail("The assistant returned an invalid response.", 502)
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
        if project:
            try:
                payload = project(payload)
            except (KeyError, TypeError, ValueError):
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
    if assistant_identity.configured():
        enrolled = assistant_identity.binding(who["id"])
        return jsonify({"configured": bool(current_app.hub.config.assistant_core_url),
                        "signed_in": bool(session.get("assistant_token")),
                        "user": session.get("assistant_user"), "sign_in_mode": "family",
                        "linked": enrolled is not None})
    return jsonify({"configured": bool(current_app.hub.config.assistant_core_url),
                    "signed_in": bool(session.get("assistant_token")),
                    "user": session.get("assistant_user")})


@bp.post("/login")
@profile_only
def login(who):
    denied = usable_profile()
    if denied:
        return denied
    if assistant_identity.configured():
        return fail("Sign in through your Family Hub profile to use the assistant.", 403)
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {"login", "password"} or not all(isinstance(v, str) and 0 < len(v) <= 1024 for v in data.values()):
        return fail("Enter your assistant account and password.")
    revocation = disconnect()
    response = make_response(call("POST", "login", data, login=True))
    # A failed reconnect can still disconnect and rotate the old account. Let
    # this initiating view retry; unrelated tabs keep their old binding.
    payload = response.get_json()
    payload["context"] = view_context()
    payload["core_revocation"] = revocation
    response.set_data(current_app.json.dumps(payload))
    return response


def disconnect():
    connected = bool(session.get("assistant_token"))
    revocation = "not_connected"
    if connected:
        response = make_response(call("POST", "logout", {}))
        payload = response.get_json(silent=True)
        # Clearing this browser's connection is not evidence that a remote
        # revocation committed. Never turn an ambiguous timeout into success.
        acknowledged = isinstance(payload, dict) and set(payload) == {"ok"} and payload["ok"] is True
        revocation = "confirmed" if response.status_code == 200 and acknowledged else "unconfirmed"
    session.pop("assistant_token", None)
    session.pop("assistant_user", None)
    if connected:
        rotate_session()
    return revocation


@bp.post("/logout")
@profile_only
def logout(who):
    denied = usable_profile()
    if denied:
        return denied
    revocation = disconnect()
    if assistant_identity.configured():
        session.clear()
    return jsonify({"ok": True, "context": view_context(), "core_revocation": revocation})


def connection_payload(payload, space_id, item=None):
    """Project only the public health contract; never forward connector config."""
    def row(value):
        if not isinstance(value, dict):
            raise ValueError("Invalid connection")
        if not isinstance(value.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["id"]):
            raise ValueError("Invalid reference")
        if value.get("space_id") != space_id or (item is not None and value["id"] != item):
            raise ValueError("Unexpected scope")
        if value.get("status") not in {"ready", "offline", "review_required", "disabled", "checking"}:
            raise ValueError("Invalid status")
        for name in ("enabled", "operator_disabled", "user_disabled", "can_retry", "can_enable", "can_disable"):
            if type(value.get(name)) is not bool:
                raise ValueError("Invalid control")
        if value["enabled"] != (not value["operator_disabled"] and not value["user_disabled"]):
            raise ValueError("Invalid enabled state")
        if (value["status"] == "disabled") == value["enabled"] or (value["operator_disabled"] and value["can_enable"]):
            raise ValueError("Invalid status controls")
        for name, minimum in (("revision", 1), ("tool_count", 0)):
            if type(value.get(name)) is not int or not minimum <= value[name] <= 9007199254740991:
                raise ValueError("Invalid counter")
        checked = value.get("last_checked_at")
        if checked is not None and (type(checked) is not int or not 0 <= checked <= 8640000000000000):
            raise ValueError("Invalid timestamp")
        reasons = {"ready", "checking", "disabled_by_user", "disabled_by_operator", "not_reviewed",
                   "artifact_review_required", "tool_review_required", "artifact_unavailable",
                   "discovery_failed", "probe_timeout", "not_configured"}
        fields = ("id", "space_id", "status", "reason_code", "revision", "enabled", "operator_disabled",
                  "user_disabled", "last_checked_at", "tool_count", "can_retry", "can_enable", "can_disable")
        public = {name: value.get(name) for name in fields}
        public["reason_code"] = value.get("reason_code") if isinstance(value.get("reason_code"), str) and value["reason_code"] in reasons else "unavailable"
        return public

    if item is not None:
        return row(payload)
    values = payload.get("connections")
    if not isinstance(values, list) or len(values) > 1024:
        raise ValueError("Invalid connections")
    rows = [row(value) for value in values]
    if len({value["id"] for value in rows}) != len(rows):
        raise ValueError("Duplicate connection")
    return {"connections": rows}


@bp.get("/connections")
@bp.post("/connections/<string:item>/control")
@profile_only
def connections(who, item=None):
    denied = usable_profile()
    if denied:
        return denied
    if item is None:
        if set(request.args) != {"space_id"} or len(request.args.getlist("space_id")) != 1:
            return fail("Choose a workspace.")
        space_id = request.args["space_id"]
        body = None
    else:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item) or request.args:
            return fail("Invalid connection reference.")
        if request.content_length and request.content_length > 4096:
            return fail("That request is too large.", 413)
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {"space_id", "expected_revision", "action"}:
            return fail("Expected a connection action and its revision.")
        if body["action"] not in ("retry", "enable", "disable") or type(body["expected_revision"]) is not int or not 1 <= body["expected_revision"] <= 9007199254740991:
            return fail("Invalid connection action or revision.")
        space_id = body["space_id"]
    if not isinstance(space_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", space_id):
        return fail("Choose a workspace.")
    path = "connections/" + item + "/control" if item else "connections?" + urlencode({"space_id": space_id})
    return call(request.method, path, body, project=lambda payload: connection_payload(payload, space_id, item))


@bp.get("/mail/<string:item>/draft-intent")
@bp.post("/mail/<string:item>/draft-runs")
@bp.get("/mail/draft-runs/<string:identifier>")
@profile_only
def mail_intent(who, item=None, identifier=None):
    denied = usable_profile()
    if denied:
        return denied
    if request.args:
        return fail("Unexpected request fields.")
    if identifier is not None:
        if not mail_contract.request_id(identifier):
            return fail("Invalid draft request reference.")
        return call("GET", "mail/draft-runs/" + identifier,
                    project=lambda payload: mail_contract.summary(payload, identifier), error_codes=mail_contract.ERRORS)
    if not mail_contract.reference(item):
        return fail("Invalid message reference.")
    if request.method == "GET":
        return call("GET", "mail/" + item + "/draft-intent",
                    project=lambda payload: mail_contract.preview(payload, item), error_codes=mail_contract.ERRORS)
    if request.content_length and request.content_length > 4096:
        return fail("That request is too large.", 413)
    body = request.get_json(silent=True)
    if (not isinstance(body, dict) or set(body) != {"request_id", "expected_source_digest"}
            or not mail_contract.request_id(body["request_id"]) or not mail_contract.digest(body["expected_source_digest"])):
        return fail("Expected a draft request reference and the reviewed source.")
    return call("POST", "mail/" + item + "/draft-runs", body,
                project=lambda payload: mail_contract.summary(payload, body["request_id"], item), error_codes=mail_contract.ERRORS)


@bp.get("/state")
@profile_only
def assistant_state(who):
    denied = usable_profile()
    if denied:
        return denied
    if request.args:
        return fail("Unexpected request fields.")
    viewer = (session.get("assistant_user") or {}).get("id")
    return call("GET", "state", project=lambda payload: responsibility_contract.snapshot(payload, viewer), expected_status=200)


@bp.get("/responsibilities/<string:item>/resume-review")
@bp.post("/responsibilities/<string:item>")
@profile_only
def responsibility_control(who, item):
    denied = usable_profile()
    if denied:
        return denied
    if not responsibility_contract.reference(item):
        return fail("Invalid follow-up reference.")
    if request.method == "GET":
        if set(request.args) != {"space_id"} or len(request.args.getlist("space_id")) != 1 or not responsibility_contract.reference(request.args["space_id"]):
            return fail("Choose a workspace.")
        space = request.args["space_id"]
        viewer = (session.get("assistant_user") or {}).get("id")
        return call("GET", "responsibilities/" + item + "/resume-review?" + urlencode({"space_id": space}),
                    project=lambda payload: responsibility_contract.review(payload, item, space, viewer),
                    error_codes=responsibility_contract.ERRORS, expected_status=200)
    if request.args:
        return fail("Unexpected request fields.")
    if request.content_length and request.content_length > 4096:
        return fail("That request is too large.", 413)
    body = request.get_json(silent=True)
    if not responsibility_contract.control(body):
        return fail("Expected a follow-up action and its current revision.")
    return call("POST", "responsibilities/" + item, body, project=responsibility_contract.acknowledgement,
                error_codes=responsibility_contract.ERRORS, expected_status=200)


# Explicit path allowlist. No generic URL, arbitrary route or credential forwarding tool.
@bp.route("/conversations", methods=["POST"])
@bp.route("/conversations/<string:item>", methods=["GET"])
@bp.route("/conversations/<string:item>/messages", methods=["POST"])
@bp.route("/jobs/<string:item>/stop", methods=["POST"])
@bp.route("/approvals/<string:item>", methods=["POST"])
@bp.route("/policies", methods=["POST"])
@bp.route("/grants", methods=["GET", "POST"])
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
    if path == "grants" and request.method == "GET":
        if set(request.args) != {"space_id"} or len(request.args.getlist("space_id")) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request.args["space_id"]):
            return fail("Choose a workspace.")
        path += "?" + urlencode({"space_id": request.args["space_id"]})
    return call(request.method, path, body)
