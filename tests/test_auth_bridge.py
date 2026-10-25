"""Authentication and core-adapter boundary tests; no real core/network access."""
import hashlib
import json
import time

import pytest
import requests
from flask import Response, request

from test_app import app, client, login as family_login  # noqa: F401
from bookhub import assistant_bridge, secure_sessions


def core_response(payload, status=200, token=None):
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(payload).encode()
    response.headers["Content-Type"] = "application/json"
    if token:
        response.cookies.set("household_session", token)
    return response


def user(login_name):
    return {"id": "user-" + login_name, "name": login_name.title(), "login": login_name,
            "private_space": "space-" + login_name}


def core_token(login_name="matt"):
    return "synthetic-core-session-token-" + login_name


@pytest.fixture(autouse=True)
def fake_core(monkeypatch):
    calls = []
    control = {"response": None, "exception": None}

    def invoke(transport, method, url, **kwargs):
        assert transport.trust_env is False
        calls.append({"method": method, "url": url, **kwargs})
        if control["exception"]:
            raise control["exception"]
        if control["response"] is not None:
            return control["response"]
        if url.endswith("/login"):
            account = kwargs["json"]["login"]
            return core_response(user(account), token=core_token(account))
        return core_response({"ok": True})

    monkeypatch.setattr(assistant_bridge.requests.Session, "request", invoke)
    control["calls"] = calls
    return control


def bind_view(client):
    context = client.get("/api/state").get_json()["assistant_context"]
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = context or ""
    return context


def login(client, profile, passcode="1234"):
    result = family_login(client, profile, passcode)
    if result.status_code == 200:
        bind_view(client)  # The browser navigates through /api/state after sign-in.
    return result


def connect(client, account="matt", password="synthetic-password"):
    result = client.post("/api/assistant/login", json={"login": account, "password": password})
    if result.get_json().get("context"):
        client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = result.get_json()["context"]
    return result


def link(client, profile="You", account="matt"):
    assert login(client, profile).status_code == 200
    result = connect(client, account)
    assert result.status_code == 200
    return result


def test_permission_routes_forward_only_a_single_safe_workspace(client, fake_core):
    link(client)
    assert client.get("/api/assistant/grants?space_id=space-matt").status_code == 200
    assert fake_core["calls"][-1]["url"] == "http://127.0.0.1:4280/api/grants?space_id=space-matt"
    before = len(fake_core["calls"])
    for suffix in ["", "?space_id=space-matt&space_id=space-alex", "?space_id=../private", "?space_id=space-matt&url=https://example.test"]:
        assert client.get("/api/assistant/grants" + suffix).status_code == 400
    assert len(fake_core["calls"]) == before
    body = {"space_id": "space-matt", "capability": "mail.search", "expected_revision": 1,
            "mode": "ask", "expires_at": None, "resources": None, "destinations": [], "auto_destinations": []}
    assert client.post("/api/assistant/grants", json=body).status_code == 200
    assert fake_core["calls"][-1]["json"] == body
    assert fake_core["calls"][-1]["url"].endswith("/api/grants")


def test_permission_routes_reject_stale_context_before_core_dispatch(client, fake_core):
    link(client)
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = "0" * 64
    before = len(fake_core["calls"])
    assert client.get("/api/assistant/grants?space_id=space-matt").status_code == 409
    assert client.post("/api/assistant/grants", json={"mode": "allow"}).status_code == 409
    assert len(fake_core["calls"]) == before


def sid(client):
    return client.get_cookie("bookhub").value


def saved(app, cookie):
    return app.hub.con().execute("SELECT * FROM web_sessions WHERE token_hash=?",
                                 (hashlib.sha256(cookie.encode()).hexdigest(),)).fetchone()


def replay(app, cookie):
    old = app.test_client()
    old.set_cookie("bookhub", cookie)
    return old


def stale_session(app, cookie):
    with app.test_request_context(headers={"Cookie": "bookhub=" + cookie}):
        return app.session_interface.open_session(app, request)


def test_core_token_is_server_only_and_login_rotates_cookie(app, client):
    assert login(client, "You").status_code == 200
    before = sid(client)
    response = connect(client)
    after = sid(client)
    assert before != after
    assert len(after) == 43
    assert core_token() not in response.get_data(as_text=True)
    assert core_token() not in response.headers.get("Set-Cookie", "")
    assert "HttpOnly" in response.headers["Set-Cookie"]
    assert "SameSite=Strict" in response.headers["Set-Cookie"]
    document = json.loads(saved(app, after)["document"])
    assert document["assistant_token"] == core_token()
    assert "synthetic-password" not in json.dumps(document)
    assert saved(app, before) is None
    assert replay(app, before).get("/api/assistant/status").status_code == 401
    status = client.get("/api/assistant/status")
    assert status.get_json()["signed_in"] is True
    assert core_token() not in status.get_data(as_text=True)
    assert status.headers["Cache-Control"] == "no-store"


def test_logout_revokes_core_and_old_browser_cookie(app, client, fake_core):
    link(client)
    before = sid(client)
    assert client.post("/api/logout").status_code == 200
    assert saved(app, before) is None
    assert replay(app, before).get("/api/books").status_code == 401
    assert fake_core["calls"][-1]["url"].endswith("/api/logout")
    assert fake_core["calls"][-1]["headers"]["Cookie"] == "household_session=" + core_token()


def test_assistant_logout_rotates_and_preserves_family_profile(app, client):
    link(client)
    before = sid(client)
    response = client.post("/api/assistant/logout", json={})
    assert response.status_code == 200
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = response.get_json()["context"]
    assert sid(client) != before
    assert client.get("/api/state").get_json()["me"]["name"] == "You"
    assert client.get("/api/assistant/status").get_json()["signed_in"] is False
    assert replay(app, before).get("/api/books").status_code == 401


def test_stale_request_cannot_resurrect_a_logged_out_session(app, client):
    link(client)
    before = sid(client)
    stale = stale_session(app, before)
    client.post("/api/logout")
    stale["assistant_token"] = core_token("resurrect")
    response = Response()
    with app.app_context():
        app.session_interface.save_session(app, stale, response)
    assert saved(app, before) is None
    assert "Set-Cookie" not in response.headers
    assert replay(app, before).get("/api/assistant/status").status_code == 401


def test_stale_request_cannot_overwrite_rotated_or_newer_session(app, client):
    link(client)
    before = sid(client)
    stale = stale_session(app, before)
    assert login(client, "Partner").status_code == 200
    after = sid(client)
    stale["assistant_token"] = core_token("old")
    with app.app_context():
        response = Response()
        app.session_interface.save_session(app, stale, response)
    assert "Set-Cookie" not in response.headers
    assert saved(app, before) is None
    assert json.loads(saved(app, after)["document"])["pid"] != stale["pid"]
    first = stale_session(app, after)
    second = stale_session(app, after)
    first["assistant_token"] = core_token("first")
    second["assistant_token"] = core_token("stale")
    with app.app_context():
        app.session_interface.save_session(app, first, Response())
        app.session_interface.save_session(app, second, Response())
    assert json.loads(saved(app, after)["document"])["assistant_token"] == core_token("first")


@pytest.mark.parametrize("change", ["passcode_hash='changed'", "role='member'"])
def test_credentials_or_role_change_revokes_loaded_and_saved_sessions(app, client, change):
    link(client)
    before = sid(client)
    stale = stale_session(app, before)
    app.hub.con().execute("UPDATE profiles SET " + change + " WHERE id=?", (stale["pid"],))
    app.hub.con().commit()
    stale["assistant_token"] = core_token("late")
    with app.app_context():
        app.session_interface.save_session(app, stale, Response())
    assert saved(app, before) is None
    assert client.get("/api/assistant/status").status_code == 401


def test_guest_and_admin_override_cannot_access_assistant(app, client, fake_core):
    client.post("/api/login", json={"guest": True})
    for path in ["status", "state"]:
        assert client.get("/api/assistant/" + path).status_code == 403
    assert client.post("/api/assistant/login", json={"login": "matt", "password": "x"}).status_code == 403
    ids = {p["name"]: p["id"] for p in client.get("/api/state").get_json()["profiles"]}
    client.post("/api/login", json={"profile_id": ids["Partner"], "admin_id": ids["You"], "admin_passcode": "1234"})
    assert client.get("/api/assistant/status").status_code == 403
    assert client.post("/api/assistant/logout", json={}).status_code == 403
    assert fake_core["calls"] == []
    app.hub.con().execute("UPDATE profiles SET passcode_hash='revoked' WHERE id=?", (ids["You"],))
    app.hub.con().commit()
    assert client.get("/api/books").status_code == 401


def test_two_users_have_independent_core_tokens_and_profile_switch_clears_link(app, client, fake_core):
    wife = app.test_client()
    link(client, "You", "matt")
    link(wife, "Partner", "wife")
    client.get("/api/assistant/state")
    assert fake_core["calls"][-1]["headers"]["Cookie"] == "household_session=" + core_token("matt")
    wife.get("/api/assistant/state")
    assert fake_core["calls"][-1]["headers"]["Cookie"] == "household_session=" + core_token("wife")
    login(client, "Partner")
    assert client.get("/api/assistant/status").get_json()["signed_in"] is False
    assert wife.get("/api/assistant/status").get_json()["user"]["login"] == "wife"


@pytest.mark.parametrize("switch", ["family_profile", "assistant_account"])
def test_old_tab_cannot_read_or_act_with_a_new_tabs_shared_cookie(app, client, fake_core, switch):
    link(client, "You", "matt")
    old_context = client.environ_base["HTTP_X_ASSISTANT_CONTEXT"]
    old_tab = app.test_client()
    old_tab.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = old_context
    old_tab.set_cookie("bookhub", sid(client))
    assert old_tab.get("/api/assistant/status").get_json()["user"]["login"] == "matt"

    if switch == "family_profile":
        link(client, "Partner", "wife")
    else:
        assert connect(client, "wife").status_code == 200
    assert client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] != old_context
    # Browser tabs share cookies, but each rendered view retains its own context.
    old_tab.set_cookie("bookhub", sid(client))
    before = len(fake_core["calls"])
    for method, path, body in [
        ("GET", "status", None), ("GET", "state", None),
        ("GET", "conversations/chat-shared", None),
        ("POST", "conversations", {"space_id": "space-shared"}),
        ("POST", "conversations/chat-shared/messages", {"text": "old private draft"}),
        ("POST", "approvals/pending-shared", {"decision": "allow"}),
        ("POST", "logout", {}),
        ("POST", "login", {"login": "matt", "password": "old-view-password"}),
    ]:
        response = old_tab.open("/api/assistant/" + path, method=method, json=body)
        assert response.status_code == 409
        assert response.get_json()["code"] == "assistant_session_changed"
        assert "wife" not in response.get_data(as_text=True)
        assert "Set-Cookie" not in response.headers
    assert len(fake_core["calls"]) == before
    assert client.get("/api/assistant/status").get_json()["user"]["login"] == "wife"
    bind_view(old_tab)  # Explicit reload acknowledges the new session.
    assert old_tab.get("/api/assistant/status").get_json()["user"]["login"] == "wife"


def test_view_context_is_required_and_is_not_an_authentication_cookie(app, client, fake_core):
    link(client)
    context = client.environ_base["HTTP_X_ASSISTANT_CONTEXT"]
    assert context != hashlib.sha256(sid(client).encode()).hexdigest()
    count = len(fake_core["calls"])
    for value in ("", "wrong", "A" * 64, "f" * 64):
        response = client.post("/api/assistant/conversations", json={"space_id": "space-shared"},
                               headers={"X-Assistant-Context": value})
        assert response.status_code == 409
    attacker = replay(app, context)
    attacker.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = context
    assert attacker.get("/api/assistant/state").status_code == 401
    assert len(fake_core["calls"]) == count


@pytest.mark.parametrize("origin", ["https://evil.invalid", "null", "http://localhost/path", "http://localhost?x=1", "http://[", "http://localhost#fragment"])
def test_cross_origin_or_malformed_origin_is_rejected(client, fake_core, origin):
    link(client)
    count = len(fake_core["calls"])
    result = client.post("/api/assistant/conversations", json={"space_id": "space-matt"}, headers={"Origin": origin})
    assert result.status_code == 403
    assert len(fake_core["calls"]) == count


def test_fetch_metadata_rejects_neighbor_site_and_same_origin_works(client, fake_core):
    link(client)
    for site in ["cross-site", "same-site"]:
        assert client.post("/api/logout", headers={"Sec-Fetch-Site": site}).status_code == 403
    result = client.post("/api/assistant/conversations", json={"space_id": "space-matt"},
                         headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"})
    assert result.status_code == 200
    assert fake_core["calls"][-1]["url"].endswith("/api/conversations")


def test_proxy_allowlist_preserves_seed_ids_and_does_not_forward_browser_headers(client, fake_core):
    link(client)
    result = client.get("/api/assistant/conversations/chat-space-matt?url=https://evil.invalid", headers={"Authorization": "Bearer browser-token"})
    assert result.status_code == 200
    call = fake_core["calls"][-1]
    assert call["url"] == "http://127.0.0.1:4280/api/conversations/chat-space-matt"
    assert call["headers"] == {"X-Household-Request": "1", "Cookie": "household_session=" + core_token()}
    assert call["allow_redirects"] is False
    count = len(fake_core["calls"])
    for path in ["http", "admin", "conversations/id/credentials", "conversations/..", "conversations/a;b"]:
        assert client.get("/api/assistant/" + path).status_code in (400, 404)
    assert len(fake_core["calls"]) == count
    assert client.post("/api/assistant/conversations/chat-space-matt/messages", json={"text": "x" * 40000}).status_code == 413
    assert len(fake_core["calls"]) == count


@pytest.mark.parametrize("status", [300, 301, 302, 304, 307, 308])
def test_redirects_are_never_followed_or_exposed(client, fake_core, status):
    link(client)
    fake_core["response"] = core_response({"token": core_token()}, status)
    fake_core["response"].headers["Location"] = "https://evil.invalid/" + core_token()
    response = client.get("/api/assistant/state")
    assert response.status_code == 502
    assert "Location" not in response.headers
    assert core_token() not in response.get_data(as_text=True)
    assert fake_core["calls"][-1]["allow_redirects"] is False


def test_errors_and_token_echo_are_sanitized_and_401_disconnects(client, fake_core):
    link(client)
    fake_core["exception"] = requests.ConnectionError("private URL password=" + core_token())
    response = client.get("/api/assistant/state")
    assert response.status_code == 503
    assert core_token() not in response.get_data(as_text=True)
    fake_core["exception"] = None
    fake_core["response"] = core_response({"error": "headers " + core_token()}, 500)
    response = client.get("/api/assistant/state")
    assert response.status_code == 502
    assert core_token() not in response.get_data(as_text=True)
    fake_core["response"] = core_response({"debug": core_token()})
    assert client.get("/api/assistant/state").status_code == 502
    fake_core["response"] = core_response({"error": core_token()}, 401)
    assert client.get("/api/assistant/state").status_code == 401
    assert client.get("/api/assistant/status").get_json()["signed_in"] is False


def test_login_projects_user_fields_and_rejects_invalid_token(client, fake_core):
    login(client, "You")
    fake_core["response"] = core_response({**user("matt"), "secret": "do-not-display"}, token=core_token())
    response = connect(client, password="x")
    assert response.get_json() == {"user": user("matt"), "context": bind_view(client)}
    assert "do-not-display" not in response.get_data(as_text=True)
    fake_core["response"] = core_response(user("matt"), token="bad;other=credential")
    assert connect(client, password="x").status_code == 502
    assert client.get("/api/assistant/status").get_json()["signed_in"] is False


def test_malformed_upstream_payloads_and_duplicate_cookies_are_safe(client, fake_core):
    link(client)
    fake_core["response"] = core_response(["unexpected", core_token()])
    assert client.get("/api/assistant/state").status_code == 502
    fake_core["response"]._content = ("<html>" + core_token() + "</html>").encode()
    response = client.get("/api/assistant/state")
    assert response.status_code == 503
    assert core_token() not in response.get_data(as_text=True)
    response = core_response(user("matt"))
    response.cookies.set("household_session", core_token(), path="/")
    response.cookies.set("household_session", core_token("other"), path="/api")
    fake_core["response"] = response
    result = connect(client, password="x")
    assert result.status_code == 503
    assert core_token() not in result.get_data(as_text=True)


@pytest.mark.parametrize("address", ["http://remote.invalid:4280", "https://name:password@example.invalid", "https://example.invalid/path", "https://", "http://127.0.0.1:0", "http://[broken"])
def test_invalid_configured_address_is_not_requested(app, client, fake_core, address):
    login(client, "You")
    app.hub.config.assistant_core_url = address
    response = connect(client, password="x")
    assert response.status_code == 503
    assert fake_core["calls"] == []
    assert address not in response.get_data(as_text=True)


def test_expiry_and_malformed_session_fail_closed(app, client, monkeypatch):
    login(client, "You")
    before = sid(client)
    stale = stale_session(app, before)
    now = int(time.time())
    monkeypatch.setattr(secure_sessions.time, "time", lambda: now + secure_sessions.LIFETIME + 1)
    stale["late"] = True
    with app.app_context():
        app.session_interface.save_session(app, stale, Response())
    assert client.get("/api/books").status_code == 401
    cookie = "A" * 43
    app.hub.con().execute("INSERT INTO web_sessions(token_hash,document,expires_at,revision) VALUES(?,?,?,0)",
                         (hashlib.sha256(cookie.encode()).hexdigest(), "[]", now + secure_sessions.LIFETIME * 2))
    app.hub.con().commit()
    assert replay(app, cookie).get("/api/books").status_code == 401
