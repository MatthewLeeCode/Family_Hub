"""Local disconnect must never manufacture a remote revocation receipt."""
import pytest
import requests

from test_auth_bridge import app, client, core_response, core_token, fake_core, link, login, sid, saved  # noqa: F401


@pytest.mark.parametrize("outcome", ["timeout", "redirect", "rejected", "invalid", "truthy", "extra", "accepted"])
def test_remote_revocation_requires_exact_success(client, fake_core, outcome):
    link(client)
    if outcome == "timeout":
        fake_core["exception"] = requests.Timeout("sensitive transport detail")
    else:
        code, payload = {
            "redirect": (302, {"ok": True}),
            "rejected": (401, {"error": "invalid_session"}),
            "invalid": (200, []),
            "truthy": (200, {"ok": 1}),
            "extra": (200, {"ok": True, "private": "not public"}),
            "accepted": (202, {"ok": True}),
        }[outcome]
        fake_core["response"] = core_response(payload, code)
    result = client.post("/api/assistant/logout", json={})
    assert result.status_code == 200
    assert result.json["core_revocation"] == "unconfirmed"
    assert core_token() not in result.text and "sensitive" not in result.text
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = result.json["context"]
    assert client.get("/api/assistant/status").json["signed_in"] is False
    # No retained token, silent retry or invented durable revocation task.
    previous_calls = len(fake_core["calls"])
    again = client.post("/api/assistant/logout", json={})
    assert again.json["core_revocation"] == "not_connected"
    assert len(fake_core["calls"]) == previous_calls


def test_acknowledged_revocation_is_distinct_from_local_logout(client, fake_core):
    link(client)
    result = client.post("/api/assistant/logout", json={})
    assert result.json["core_revocation"] == "confirmed"
    assert fake_core["calls"][-1]["timeout"] == (3, 5)


def test_family_signout_reports_unconfirmed_without_retaining_session(app, client, fake_core):
    link(client)
    before = sid(client)
    fake_core["exception"] = requests.Timeout()
    result = client.post("/api/logout")
    assert result.status_code == 200
    assert result.json["core_revocation"] == "unconfirmed"
    assert saved(app, before) is None
    assert client.get("/api/books").status_code == 401


def test_profile_switch_reports_old_account_revocation(client, fake_core):
    link(client)
    fake_core["exception"] = requests.Timeout()
    result = login(client, "Partner")
    assert result.json["core_revocation"] == "unconfirmed"
    assert client.get("/api/state").json["me"]["name"] == "Partner"
    assert client.get("/api/assistant/status").json["signed_in"] is False


def test_reconnect_retains_old_revocation_result_on_success_and_failure(client, fake_core, monkeypatch):
    link(client)
    from bookhub import assistant_bridge
    original = assistant_bridge.requests.Session.request

    def invoke(transport, method, url, **kwargs):
        if url.endswith("/logout"):
            raise requests.Timeout()
        return original(transport, method, url, **kwargs)

    monkeypatch.setattr(assistant_bridge.requests.Session, "request", invoke)
    result = client.post("/api/assistant/login", json={"login": "alex", "password": "synthetic"})
    assert result.status_code == 200
    assert result.json["core_revocation"] == "unconfirmed"
    assert result.json["user"]["id"] == "user-alex"
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = result.json["context"]
    fake_core["response"] = core_response({"error": "invalid_session"}, 401)
    result = client.post("/api/assistant/login", json={"login": "matt", "password": "invalid"})
    assert result.status_code == 401
    assert result.json["core_revocation"] == "unconfirmed"
    assert "context" in result.json and core_token("alex") not in result.text
