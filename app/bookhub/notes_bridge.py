"""Fixed Notes adapter. Rust owns records, memberships and command validation."""
import hmac
import json
import re

import requests
from flask import Blueprint, current_app, jsonify, request, session

from .api import profile_only
from .secure_sessions import view_context

bp = Blueprint("notes_bridge", __name__, url_prefix="/api/notes")
MAX_RESPONSE_BYTES = 256 * 1024
MAX_REQUEST_BYTES = 128 * 1024
MESSAGES = {
    "validation_error": ("Check the note title, text and request fields.", 400),
    "not_found": ("That note was not found.", 404),
    "access_denied": ("This connection cannot access those notes.", 403),
    "revision_conflict": ("This note changed. Load the latest version before applying your edits.", 409),
    "idempotency_conflict": ("This request ID was already used for different changes.", 409),
    "domain_inactive": ("Notes is not enabled for this household yet.", 503),
    "domain_unavailable": ("Notes is unavailable. Try again shortly.", 503),
}


def fail(code):
    message, status = MESSAGES.get(code, MESSAGES["domain_unavailable"])
    return jsonify({"code": code if code in MESSAGES else "domain_unavailable", "error": message}), status


def guard():
    if session.get("via_admin"):
        return fail("access_denied")
    context = request.headers.get("X-Assistant-Context", "")
    if not re.fullmatch(r"[a-f0-9]{64}", context) or not hmac.compare_digest(context, view_context() or ""):
        return jsonify({"code": "assistant_session_changed", "error": "Your sign-in changed. Reload Family Hub before continuing."}), 409
    return None


def configured():
    config = current_app.hub.config
    return bool(config.family_notes_port and config.family_notes_credentials)


def call(who, method, path, body=None, query=None):
    config = current_app.hub.config
    try:
        # No URL from either browser or model. This development profile is local only.
        port = config.family_notes_port
        if not isinstance(port, int) or not 1 <= port <= 65535:
            return fail("domain_unavailable")
        credential = config.family_notes_credentials / f"profile-{int(who['id'])}.credential"
        if credential.is_symlink() or not credential.is_file() or credential.stat().st_size != 64:
            return fail("domain_unavailable")
        token = credential.read_text(encoding="ascii")
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            return fail("domain_unavailable")
        with requests.Session() as transport:
            transport.trust_env = False
            with transport.request(method, f"http://127.0.0.1:{port}/v1/{path}", json=body, params=query,
                                   headers={"Authorization": "Bearer " + token, "X-Family-Profile": str(who["id"])},
                                   allow_redirects=False, timeout=(3, 10), stream=True) as response:
                if 300 <= response.status_code < 400:
                    return fail("domain_unavailable")
                content = bytearray()
                for chunk in response.iter_content(chunk_size=4096):
                    content.extend(chunk)
                    if len(content) > MAX_RESPONSE_BYTES:
                        return fail("domain_unavailable")
                if token.encode() in content:
                    return fail("domain_unavailable")
                payload = json.loads(content)
                if not isinstance(payload, dict):
                    return fail("domain_unavailable")
                if not response.ok:
                    return fail(payload.get("code", "domain_unavailable"))
                return jsonify(payload)
    except (requests.RequestException, OSError, ValueError, TypeError, AttributeError):
        return fail("domain_unavailable")


@bp.get("/status")
@profile_only
def status(who):
    denied = guard()
    if denied:
        return denied
    if not configured():
        return jsonify({"configured": False, "active": False, "reason": "Notes has not been connected yet."})
    if not current_app.hub.config.family_notes_active:
        return jsonify({"configured": True, "active": False, "reason": "Notes is not enabled for this household yet."})
    result = call(who, "GET", "status")
    if isinstance(result, tuple):
        return result
    payload = result.get_json()
    if payload.get("kind") != "ui" or payload.get("profile_id") != who["id"] or not isinstance(payload.get("active"), bool):
        return fail("domain_unavailable")
    return jsonify({"configured": True, "active": payload["active"],
                    "reason": "" if payload["active"] else "Notes is not enabled for this household yet."})


@bp.get("/scopes")
@bp.route("/scopes/<string:space>/notes", methods=["GET", "POST"])
@bp.route("/scopes/<string:space>/notes/<string:item>", methods=["GET", "PUT", "DELETE"])
@profile_only
def forward(who, space=None, item=None):
    denied = guard()
    if denied:
        return denied
    if not configured() or not current_app.hub.config.family_notes_active:
        return fail("domain_inactive")
    if any(value is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) for value in (space, item)):
        return fail("validation_error")
    body = None
    if request.method != "GET":
        if request.content_length and request.content_length > MAX_REQUEST_BYTES:
            return fail("validation_error")
        body = request.get_json(silent=True)
        fields = {"request_id", "revision"} if request.method == "DELETE" else {"request_id", "title", "body"}
        if request.method == "PUT":
            fields.add("revision")
        if not isinstance(body, dict) or set(body) != fields:
            return fail("validation_error")
    query = None
    if request.method == "GET" and space and not item:
        if set(request.args) - {"q", "cursor"} or any(len(request.args.getlist(k)) != 1 for k in request.args):
            return fail("validation_error")
        query = request.args.to_dict()
        if len(query.get("q", "").encode()) > 200 or len(query.get("cursor", "")) > 160:
            return fail("validation_error")
    elif request.args:
        return fail("validation_error")
    path = "scopes" + (f"/{space}/notes" if space else "") + (f"/{item}" if item else "")
    return call(who, request.method, path, body, query)
