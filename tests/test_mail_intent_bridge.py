"""Selected-mail bridge boundaries. All core traffic is mocked; no live services."""
import copy
import json

import pytest
import requests

from test_auth_bridge import (  # noqa: F401 -- imported pytest fixtures
    app, client, fake_core, bind_view, core_response, core_token, link, login,
)


REQUEST = "d1e90fa1-4f95-4cd5-afd5-27dd3f96502f"
OTHER_REQUEST = "773550d8-aa59-4c60-af0c-68b044349a8d"
MESSAGE = "mail-appointment"
DIGEST = "ab" * 32
BASE = "/api/assistant/mail/"
PREVIEW = BASE + MESSAGE + "/draft-intent"
ADMIT = BASE + MESSAGE + "/draft-runs"
LOOKUP = BASE + "draft-runs/" + REQUEST
BODY = {"request_id": REQUEST, "expected_source_digest": DIGEST}


def preview(**changes):
    return {"kind": "mail.local_draft.v1", "message_id": MESSAGE, "space_id": "space-matt",
            "source_digest": DIGEST, "effect": "local_draft_only", "can_request": True,
            "eligibility": "allowed", "source": {"sender": "Synthetic sender",
                "address": "sender@example.invalid", "subject": "A sample appointment",
                "body": "Synthetic message text", "mailbox_id": "mailbox-matt", "received_at": 1720000000000},
            **changes}


def summary(**changes):
    return {"request_id": REQUEST, "message_id": MESSAGE, "space_id": "space-matt",
            "conversation_id": "conversation-123", "job_id": "job-123", "status": "queued",
            "draft_id": None, "outcome_code": None, "expires_at": 1720000900000, **changes}


def assert_safe_failure(response, status=502):
    assert response.status_code == status
    assert "private-marker" not in response.get_data(as_text=True)
    assert core_token() not in response.get_data(as_text=True)


def test_fixed_routes_project_only_public_preview_and_summary(client, fake_core):
    link(client)
    public = preview()
    upstream = copy.deepcopy(public)
    upstream.update({"session_hash": "private-marker", "grant": {"revision": 1},
                     "arguments": {"actor": "someone-else"}, "capabilities": ["shell.execute"]})
    upstream["source"]["credential_reference"] = "private-marker"
    fake_core["response"] = core_response(upstream)
    response = client.get(PREVIEW, headers={"Authorization": "Bearer browser-private-marker"})
    assert response.status_code == 200
    assert response.get_json() == public
    assert response.headers["Cache-Control"] == "no-store"
    call = fake_core["calls"][-1]
    assert call["url"] == "http://127.0.0.1:4280/api/mail/" + MESSAGE + "/draft-intent"
    assert call["method"] == "GET" and call["json"] is None
    assert call["allow_redirects"] is False
    assert call["headers"] == {"X-Household-Request": "1", "Cookie": "household_session=" + core_token()}

    for status in (202, 200):
        public = summary()
        fake_core["response"] = core_response({**public, "session_reference": "private-marker",
                                                "intent_record": {"secret": "private-marker"}}, status)
        response = client.post(ADMIT, json=BODY)
        assert response.status_code == status
        assert response.get_json() == public
        call = fake_core["calls"][-1]
        assert call["url"].endswith("/api/mail/" + MESSAGE + "/draft-runs")
        assert call["method"] == "POST" and call["json"] == BODY
    fake_core["response"] = core_response({**summary(), "internal_action": "private-marker"})
    assert client.get(LOOKUP).get_json() == summary()
    assert fake_core["calls"][-1]["url"].endswith("/api/mail/draft-runs/" + REQUEST)


def test_inputs_and_routes_cannot_select_identity_tools_or_an_upstream(client, fake_core):
    link(client)
    before = len(fake_core["calls"])
    invalid = [None, [], {}, {"request_id": REQUEST}, {**BODY, "actor_id": "user-wife"},
               {**BODY, "space_id": "space-wife"}, {**BODY, "kind": "shell.v1"},
               {**BODY, "arguments": {}}, {**BODY, "url": "https://private-marker.invalid"},
               {**BODY, "request_id": True}, {**BODY, "request_id": OTHER_REQUEST.replace("-", "")},
               {**BODY, "request_id": REQUEST.upper()}, {**BODY, "request_id": "not-a-uuid"},
               {**BODY, "expected_source_digest": True}, {**BODY, "expected_source_digest": DIGEST.upper()},
               {**BODY, "expected_source_digest": "a" * 63}]
    for body in invalid:
        assert client.post(ADMIT, json=body).status_code == 400, body
    for path in (PREVIEW, ADMIT, LOOKUP):
        response = client.post(path + "?actor_id=user-wife", json=BODY) if path == ADMIT else client.get(path + "?space_id=space-wife")
        assert response.status_code == 400
    for item in ("bad;message", "a" * 129, "..", "https%3A%2F%2Fevil.invalid"):
        assert client.get(BASE + item + "/draft-intent").status_code in (400, 404)
    for identifier in ("not-a-uuid", REQUEST.upper(), REQUEST.replace("-", "")):
        assert client.get(BASE + "draft-runs/" + identifier).status_code == 400
    for path in (BASE + MESSAGE + "/send", BASE + MESSAGE + "/config", BASE + "../credentials"):
        assert client.post(path, json=BODY).status_code == 404
    assert client.post(ADMIT, data="x" * 4097, content_type="application/json").status_code == 413
    assert client.post(ADMIT, data="{broken", content_type="application/json").status_code == 400
    assert len(fake_core["calls"]) == before


def test_preview_rejects_wrong_source_effect_and_unusable_controls(client, fake_core):
    link(client)
    invalid = [preview(message_id="other-message"), preview(kind="mail.send.v1"),
               preview(effect="send_mail"), preview(space_id="../private-marker"),
               preview(source_digest="private-marker"), preview(can_request=1),
               preview(eligibility="private-marker"), preview(can_request=True, eligibility="denied"),
               preview(can_request=False, eligibility="allowed"), preview(source=[])]
    for field, value in (("sender", []), ("address", "x" * 1025), ("subject", "é" * 513),
                         ("body", "x" * (128 * 1024 + 1)), ("mailbox_id", "../private-marker"),
                         ("received_at", True), ("received_at", -1), ("received_at", "private-marker")):
        candidate = preview()
        candidate["source"][field] = value
        invalid.append(candidate)
    for payload in invalid:
        fake_core["response"] = core_response(payload)
        assert_safe_failure(client.get(PREVIEW))


def test_all_preview_policy_modes_have_consistent_public_controls(client, fake_core):
    link(client)
    for eligibility in ("allowed", "approval_required", "denied", "manual", "authentication_required"):
        payload = preview(eligibility=eligibility, can_request=eligibility in ("allowed", "approval_required"))
        fake_core["response"] = core_response(payload)
        response = client.get(PREVIEW)
        assert response.status_code == 200
        assert response.get_json() == payload


def test_summary_rejects_wrong_request_message_and_malformed_task_ids(client, fake_core):
    link(client)
    invalid = [summary(request_id=OTHER_REQUEST), summary(message_id="other-message"),
               summary(space_id="../private-marker"), summary(conversation_id=""),
               summary(job_id=["job-123"]), summary(status="private-marker"),
               summary(expires_at=True), summary(expires_at=-1), summary(outcome_code="private-marker"),
               summary(draft_id="draft-123"), summary(status="completed", outcome_code="draft_created"),
               summary(status="completed", draft_id="draft-123", outcome_code="cancelled")]
    for payload in invalid:
        fake_core["response"] = core_response(payload)
        assert_safe_failure(client.post(ADMIT, json=BODY))
    fake_core["response"] = core_response(summary(request_id=OTHER_REQUEST))
    assert_safe_failure(client.get(LOOKUP))


def test_summary_state_and_outcome_must_agree(client, fake_core):
    link(client)
    inconsistent = [summary(status="queued", outcome_code="draft_created"),
                    summary(status="running", outcome_code="execution_failed"),
                    summary(status="waiting_approval", outcome_code="cancelled"),
                    summary(status="cancelled", outcome_code=None),
                    summary(status="expired", outcome_code="draft_created"),
                    summary(status="outcome_unknown", outcome_code=None)]
    for payload in inconsistent:
        fake_core["response"] = core_response(payload)
        assert_safe_failure(client.get(LOOKUP))


def test_completed_and_negative_outcomes_preserve_host_result_references(client, fake_core):
    link(client)
    outcomes = [("queued", None), ("running", None), ("waiting_approval", None),
                ("completed", "draft_created"), ("cancelled", "cancelled"),
                ("cancelled", "session_revoked"), ("expired", "intent_expired"),
                ("stale", "source_changed"), ("stale", "policy_changed"), ("stale", "catalog_changed"),
                ("failed", "action_denied"), ("failed", "invalid_intent"),
                ("failed", "agent_finished_without_draft"), ("failed", "execution_failed"),
                ("outcome_unknown", "outcome_unknown")]
    for status, outcome in outcomes:
        payload = summary(status=status, outcome_code=outcome, draft_id="draft-123" if status == "completed" else None)
        fake_core["response"] = core_response(payload)
        response = client.get(LOOKUP)
        assert response.status_code == 200, (status, outcome)
        assert response.get_json() == payload


def test_private_fields_and_echoed_core_token_never_reach_browser(client, fake_core):
    link(client)
    for payload, path in (({**preview(), "session_token": core_token()}, PREVIEW),
                          ({**summary(), "debug": {"core_token": core_token()}}, LOOKUP),
                          (preview(source={**preview()["source"], "body": core_token()}), PREVIEW)):
        fake_core["response"] = core_response(payload)
        assert_safe_failure(client.get(path))
    for payload in ([], "private-marker", None):
        fake_core["response"] = core_response(payload)
        assert_safe_failure(client.get(PREVIEW))


def test_only_status_matched_known_error_codes_survive_projection(client, fake_core):
    link(client)
    for status, code in ((400, "invalid_request"), (403, "action_denied"), (404, "not_found"),
                         (409, "source_changed"), (409, "request_conflict"), (500, "operation_failed")):
        fake_core["response"] = core_response({"error": code, "details": "private-marker", "token": core_token()}, status)
        response = client.post(ADMIT, json=BODY)
        assert response.status_code == status
        assert response.get_json()["code"] == code
        assert response.get_json()["error"] != code
        assert set(response.get_json()) == {"error", "code"}
        assert "private-marker" not in response.get_data(as_text=True)
        assert core_token() not in response.get_data(as_text=True)
    for status, payload in ((409, {"error": "action_denied", "code": "source_changed"}),
                            (403, {"error": "source_changed"}),
                            (409, {"error": "private-marker"}), (409, {"error": ["source_changed"]}),
                            (409, ["private-marker"]), (500, {"error": "private-marker"})):
        fake_core["response"] = core_response(payload, status)
        response = client.post(ADMIT, json=BODY)
        assert_safe_failure(response, status if status != 500 else 502)
        assert "code" not in response.get_json()


def test_upstream_unauthorized_clears_link_and_preserves_safe_code(client, fake_core):
    link(client)
    fake_core["response"] = core_response({"error": "invalid_session", "private": "private-marker"}, 401)
    response = client.get(LOOKUP)
    assert_safe_failure(response, 401)
    assert response.get_json()["code"] == "invalid_session"
    assert client.get("/api/assistant/status").get_json()["signed_in"] is False


def test_redirect_and_transport_failures_are_not_replayed_or_disclosed(client, fake_core):
    link(client)
    fake_core["response"] = core_response({"private": "private-marker"}, 307)
    fake_core["response"].headers["Location"] = "https://private-marker.invalid/"
    before = len(fake_core["calls"])
    assert_safe_failure(client.post(ADMIT, json=BODY))
    assert len(fake_core["calls"]) == before + 1
    fake_core["response"] = None
    fake_core["exception"] = requests.Timeout("private-marker: Cookie=" + core_token())
    before = len(fake_core["calls"])
    assert_safe_failure(client.post(ADMIT, json=BODY), 503)
    assert len(fake_core["calls"]) == before + 1


def test_stale_view_context_blocks_all_routes_before_core(client, fake_core):
    link(client)
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = "0" * 64
    before = len(fake_core["calls"])
    for path in (PREVIEW, LOOKUP):
        response = client.get(path)
        assert response.status_code == 409
        assert response.get_json()["code"] == "assistant_session_changed"
    assert client.post(ADMIT, json=BODY).status_code == 409
    assert len(fake_core["calls"]) == before


def test_guest_override_and_unlinked_profiles_cannot_forward_mail_requests(client, fake_core):
    def rejected(status):
        before = len(fake_core["calls"])
        assert client.get(PREVIEW).status_code == status
        assert client.get(LOOKUP).status_code == status
        assert client.post(ADMIT, json=BODY).status_code == status
        assert len(fake_core["calls"]) == before

    rejected(401)
    assert client.post("/api/login", json={"guest": True}).status_code == 200
    rejected(403)
    profiles = {p["name"]: p["id"] for p in client.get("/api/state").get_json()["profiles"]}
    assert client.post("/api/login", json={"profile_id": profiles["Nicky"], "admin_id": profiles["Matt"], "admin_passcode": "1234"}).status_code == 200
    bind_view(client)
    rejected(403)
    assert login(client, "Matt").status_code == 200
    rejected(401)


def test_cross_origin_and_neighbor_site_mutations_never_reach_core(client, fake_core):
    link(client)
    before = len(fake_core["calls"])
    for headers in ({"Origin": "https://private-marker.invalid"}, {"Origin": "null"},
                    {"Origin": "http://localhost/path"}, {"Sec-Fetch-Site": "same-site"}):
        assert client.post(ADMIT, json=BODY, headers=headers).status_code == 403
    assert len(fake_core["calls"]) == before
    fake_core["response"] = core_response(summary(), 202)
    assert client.post(ADMIT, json=BODY, headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"}).status_code == 202


def test_two_profiles_forward_only_their_server_owned_core_session(app, client, fake_core):
    other = app.test_client()
    link(client, "Matt", "matt")
    link(other, "Nicky", "wife")
    for browser, name in ((client, "matt"), (other, "wife")):
        fake_core["response"] = core_response(preview(space_id="space-" + name))
        assert browser.get(PREVIEW).status_code == 200
        assert fake_core["calls"][-1]["headers"]["Cookie"] == "household_session=" + core_token(name)
    assert core_token("wife") not in json.dumps(client.get("/api/assistant/status").get_json())
