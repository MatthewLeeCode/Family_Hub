"""Synthetic bridge transport tests; no real service or household credentials."""
import json
from pathlib import Path

import pytest
import requests

from test_app import app, client, login  # noqa: F401
from bookhub import notes_bridge


def response(payload, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(payload).encode()
    result._content_consumed = True
    return result


@pytest.fixture(autouse=True)
def notes(app, monkeypatch):
    directory = app.hub.config.data_dir / "notes-test-credentials"
    directory.mkdir()
    profiles = app.hub.profiles()
    for profile in profiles:
        (directory / f"profile-{profile['id']}.credential").write_text(str(profile["id"]) * 64, encoding="ascii")
    app.hub.config.family_notes_port = 4291
    app.hub.config.family_notes_credentials = directory
    app.hub.config.family_notes_active = True
    control = {"calls": [], "response": None, "exception": None}

    def invoke(transport, method, url, **kwargs):
        assert transport.trust_env is False
        control["calls"].append({"method": method, "url": url, **kwargs})
        if control["exception"]:
            raise control["exception"]
        if control["response"] is not None:
            return control["response"]
        if url.endswith("/status"):
            return response({"active": True, "kind": "ui", "profile_id": int(kwargs["headers"]["X-Family-Profile"])})
        return response({"notes": [], "next_cursor": None})

    monkeypatch.setattr(notes_bridge.requests.Session, "request", invoke)
    return control


def enter(client, name="Matt"):
    assert login(client, name).status_code == 200
    state = client.get("/api/state").get_json()
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = state["assistant_context"]
    return state


def test_status_and_fixed_routes_keep_credentials_on_server(client, notes):
    state = enter(client)
    result = client.get("/api/notes/status")
    assert result.get_json() == {"configured": True, "active": True, "reason": ""}
    token = str(state["me"]["id"]) * 64
    assert token not in result.get_data(as_text=True)
    result = client.get("/api/notes/scopes/shared/notes?q=hello", headers={"Authorization": "Bearer browser-secret", "X-Family-Profile": "99"})
    assert result.status_code == 200
    call = notes["calls"][-1]
    assert call["url"] == "http://127.0.0.1:4291/v1/scopes/shared/notes"
    assert call["params"] == {"q": "hello"}
    assert call["headers"] == {"Authorization": "Bearer " + token, "X-Family-Profile": str(state["me"]["id"])}
    assert call["allow_redirects"] is False
    assert result.headers["Cache-Control"] == "no-store"


def test_configuration_stays_inactive_and_rejects_data_without_requests(app, client, notes):
    enter(client)
    app.hub.config.family_notes_active = False
    assert client.get("/api/notes/status").get_json()["active"] is False
    assert client.get("/api/notes/scopes").get_json()["code"] == "domain_inactive"
    assert notes["calls"] == []
    app.hub.config.family_notes_credentials = None
    assert client.get("/api/notes/status").get_json()["configured"] is False


def test_cross_tab_view_binding_blocks_reads_and_mutations_before_dispatch(app, client, notes):
    old = enter(client)
    old_tab = app.test_client()
    old_tab.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = old["assistant_context"]
    enter(client, "Nicky")
    old_tab.set_cookie("bookhub", client.get_cookie("bookhub").value)
    for method, path in [("GET", "status"), ("GET", "scopes"), ("POST", "scopes/shared/notes"), ("DELETE", "scopes/shared/notes/note-a")]:
        result = old_tab.open("/api/notes/" + path, method=method, json={})
        assert result.status_code == 409
        assert result.get_json()["code"] == "assistant_session_changed"
    assert notes["calls"] == []


def test_guest_override_and_cross_origin_are_denied(app, client, notes):
    client.post("/api/login", json={"guest": True})
    assert client.get("/api/notes/status").status_code == 403
    state = client.get("/api/state").get_json()
    ids = {p["name"]: p["id"] for p in state["profiles"]}
    client.post("/api/login", json={"profile_id": ids["Nicky"], "admin_id": ids["Matt"], "admin_passcode": "1234"})
    assert client.get("/api/notes/scopes").status_code == 403
    enter(client)
    assert client.post("/api/notes/scopes/shared/notes", json={}, headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert notes["calls"] == []


def test_exact_command_shape_ids_and_request_ids_are_preserved(client, notes):
    enter(client)
    body = {"request_id": "88db7f1e-b428-4bd4-b5f3-0519fa00dd73", "title": "A note", "body": "Synthetic"}
    assert client.post("/api/notes/scopes/shared/notes", json=body).status_code == 200
    assert notes["calls"][-1]["json"] == body
    count = len(notes["calls"])
    for extra in ({"profile_id": 2}, {"url": "https://evil.invalid"}, {"space_id": "private"}):
        assert client.post("/api/notes/scopes/shared/notes", json={**body, **extra}).status_code == 400
    for path in ("scopes/shared/notes?url=https://evil.invalid", "scopes/shared/notes?q=a&q=b", "scopes/shared/notes/a;b", "scopes/shared/notes/a?token=anything"):
        assert client.get("/api/notes/" + path).status_code == 400
    assert len(notes["calls"]) == count


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_redirects_are_rejected_without_exposing_locations(client, notes, status):
    enter(client)
    notes["response"] = response({"secret": "should-not-display"}, status)
    notes["response"].headers["Location"] = "https://evil.invalid/secret"
    result = client.get("/api/notes/scopes")
    assert result.status_code == 503
    assert "Location" not in result.headers
    assert "should-not-display" not in result.get_data(as_text=True)


def test_safe_conflicts_and_offline_or_oversized_responses(client, notes):
    state = enter(client)
    token = str(state["me"]["id"]) * 64
    notes["response"] = response({"code": "revision_conflict", "error": "private details"}, 409)
    result = client.get("/api/notes/scopes")
    assert result.status_code == 409 and result.get_json()["code"] == "revision_conflict"
    assert "private details" not in result.get_data(as_text=True)
    for payload in ({"secret": token}, {"body": "x" * (notes_bridge.MAX_RESPONSE_BYTES + 1)}, ["wrong-shape"]):
        notes["response"] = response(payload)
        assert client.get("/api/notes/scopes").status_code == 503
    notes["response"] = None
    notes["exception"] = requests.ConnectionError("private token=" + token)
    result = client.get("/api/notes/scopes")
    assert result.status_code == 503 and token not in result.get_data(as_text=True)


def test_invalid_endpoint_or_missing_credentials_never_reaches_transport(app, client, notes):
    enter(client)
    for port in (0, -1, 65536, "https://evil.invalid"):
        app.hub.config.family_notes_port = port
        assert client.get("/api/notes/scopes").status_code == 503
    app.hub.config.family_notes_port = 4291
    app.hub.config.family_notes_credentials = Path("missing-credential-directory")
    assert client.get("/api/notes/scopes").status_code == 503
    assert notes["calls"] == []


def test_valid_escaped_note_and_large_list_are_not_truncated(client, notes):
    enter(client)
    note = {"id": "imported", "space_id": "shared", "title": "\x01" * 240,
            "body": "\x01" * 16000, "revision": 7, "updated_at": 123}
    for payload in ({"note": note}, {"notes": [{"id": str(i), "title": note["title"], "preview": "😀" * 160} for i in range(50)], "next_cursor": None}):
        notes["response"] = response(payload)
        assert 65536 < len(notes["response"].content) < notes_bridge.MAX_RESPONSE_BYTES
        result = client.get("/api/notes/scopes/shared/notes/imported")
        assert result.status_code == 200
        assert result.get_json() == payload
    notes["response"] = response({"note": note})
    body = {"request_id": "88db7f1e-b428-4bd4-b5f3-0519fa00dd73", "title": note["title"], "body": note["body"]}
    assert client.post("/api/notes/scopes/shared/notes", json=body).status_code == 200
    assert notes["calls"][-1]["json"] == body
