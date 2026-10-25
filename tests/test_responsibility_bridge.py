"""Dependency follow-up boundaries. Core HTTP is mocked; no live accounts or services."""
import copy
import json

import pytest
import requests

from test_auth_bridge import app, client, fake_core, core_response, core_token, link, login  # noqa: F401
from bookhub import assistant_responsibility_contract as contract

BASE = "/api/assistant/responsibilities/followup-1"
REVIEW = BASE + "/resume-review?space_id=space-matt"
DIGEST = "ac" * 32


def dependency(**changes):
    return {"capability": "mail.search", "connection_id": None, "availability": "ready", "reason_code": None, **changes}


def followup(**changes):
    return {"id": "followup-1", "space_id": "space-matt", "owner_id": "user-matt", "title": "Check for a reply",
            "instruction": "Read the synthetic inbox", "reason": "A reply is expected", "stop_condition": "A reply arrives",
            "status": "paused", "next_check_at": None, "expires_at": 2000000000000, "remaining_checks": 2,
            "revision": 3, "event_kind": "mail.arrived", "event_resource": "", "dependency_state": "bound",
            "availability": "blocked", "block_reason": "owner_paused", "dependencies": [dependency()],
            "next_probe_at": None, "current_job": None, "can_pause": False, "can_cancel": True, "can_review_resume": True, **changes}


def review(**changes):
    return {"id": "followup-1", "space_id": "space-matt", "owner_id": "user-matt", "revision": 3,
            "review_digest": DIGEST, "can_resume": True, "block_reason": None,
            "dependencies": [dependency(permission_mode="current_task", changes=["grant_changed"])],
            "remaining_checks": 2, "expires_at": 2000000000000, "current_job": None, **changes}


def snapshot(row=None):
    result = {key: [] for key in contract.SNAPSHOT_FIELDS if key != "user"}
    result.update(user={"id": "user-matt", "name": "Matt", "login": "matt", "private_space": "space-matt"},
                  spaces=[{"id": "space-matt", "name": "Matt", "kind": "private"}], responsibilities=[row or followup()])
    return result


def safe_failure(response, expected=502):
    assert response.status_code == expected
    assert "private-marker" not in response.get_data(as_text=True)
    assert core_token() not in response.get_data(as_text=True)


def test_snapshot_and_review_project_only_the_public_contract(client, fake_core):
    link(client)
    public = snapshot()
    upstream = copy.deepcopy(public)
    upstream.update(private_baselines={"secret": "private-marker"}, review_digest=DIGEST)
    upstream["user"]["session_hash"] = "private-marker"
    upstream["responsibilities"][0].update(review_digest=DIGEST, grant_id="private-marker", authority_generation=8)
    upstream["responsibilities"][0]["dependencies"][0]["catalog_binding"] = "private-marker"
    fake_core["response"] = core_response(upstream)
    response = client.get("/api/assistant/state")
    assert response.status_code == 200 and response.get_json() == public
    assert response.headers["Cache-Control"] == "no-store"
    assert DIGEST not in response.get_data(as_text=True)
    current = review()
    upstream = copy.deepcopy(current)
    upstream["private_generation"] = "private-marker"
    upstream["dependencies"][0]["grant_record"] = {"secret": "private-marker"}
    fake_core["response"] = core_response(upstream)
    response = client.get(REVIEW, headers={"Authorization": "Bearer private-marker"})
    assert response.status_code == 200 and response.get_json() == current
    call = fake_core["calls"][-1]
    assert call["method"] == "GET" and call["json"] is None
    assert call["url"].endswith("/api/responsibilities/followup-1/resume-review?space_id=space-matt")
    assert call["headers"] == {"X-Household-Request": "1", "Cookie": "household_session=" + core_token()}


def test_sibling_snapshot_records_cannot_carry_hidden_followup_metadata():
    payload = snapshot()
    payload["jobs"] = [{"id": "job-1", "space_id": "space-matt", "kind": "agent", "title": "Check", "status": "running",
                        "detail": "Working", "created_at": 1, "assignment": {"saved_grant": "private-marker"}}]
    payload["emails"] = [{"id": "mail-1", "body": "Known text", "attachments": [{"id": "attachment-1", "baseline": "private-marker"}]}]
    result = contract.snapshot(payload, "user-matt")
    assert "private-marker" not in json.dumps(result)
    assert result["emails"][0]["attachments"] == [{"id": "attachment-1"}]
    payload["jobs"][0]["detail"] = {"baseline": "private-marker"}
    with pytest.raises(ValueError):
        contract.snapshot(payload, "user-matt")


def test_snapshot_rejects_bad_scope_states_controls_and_nullable_fields(client, fake_core):
    link(client)
    invalid = [followup(space_id="other-private"), followup(status="future-state"), followup(dependency_state="inferred"),
               followup(availability="ready", block_reason="grant_changed"), followup(availability="waiting", block_reason="grant_denied"),
               followup(availability="blocked", block_reason=None), followup(revision=True), followup(revision=0),
               followup(remaining_checks=21), followup(next_probe_at=True), followup(expires_at=-1), followup(can_pause=1),
               followup(can_pause=True), followup(owner_id="user-nicky"), followup(status="expired"),
               followup(dependencies=[]), followup(dependencies=[dependency()] * 2),
               followup(dependencies=[dependency(capability="z.tool"), dependency(capability="a.tool")]),
               followup(dependencies=[dependency(capability="https://private-marker")]),
               followup(dependencies=[dependency(connection_id="private/path")]),
               followup(dependencies=[dependency(reason_code="private-marker")]), followup(current_job={"id": "job", "status": "unknown"})]
    for key in ("dependency_state", "block_reason", "current_job", "next_probe_at"):
        value = followup(); del value[key]; invalid.append(value)
    for row in invalid:
        fake_core["response"] = core_response(snapshot(row))
        safe_failure(client.get("/api/assistant/state"))
    for change in ({"user": {"id": "user-nicky"}}, {"responsibilities": [followup()] * 2}, {"responsibilities": None}, {"spaces": []}):
        fake_core["response"] = core_response({**snapshot(), **change})
        safe_failure(client.get("/api/assistant/state"))


def test_legacy_waiting_terminal_and_charged_zero_budget_states_remain_distinct():
    cases = [followup(dependency_state="legacy_unbound", dependencies=[], availability="not_evaluated", block_reason="legacy_unbound"),
             followup(dependency_state="legacy_unbound", dependencies=[], block_reason="unresolved_effect", can_review_resume=False,
                      current_job={"id": "old-job", "status": "cancelled", "block_reason": "unresolved_effect"}),
             followup(status="active", availability="waiting", block_reason="connector_offline", can_pause=True, can_review_resume=False,
                      dependencies=[dependency(connection_id="notes-matt", availability="waiting", reason_code="connector_offline")], next_probe_at=1),
             followup(remaining_checks=0, current_job={"id": "charged-job", "status": "waiting_dependency", "block_reason": "grant_changed"}),
             followup(status="completed", availability="not_evaluated", block_reason=None, can_cancel=False, can_review_resume=False)]
    for row in cases:
        assert contract.responsibility(row, "user-matt", {"space-matt"}) == row


def test_incomplete_check_remains_paused_and_owner_can_review_before_resuming(client, fake_core):
    link(client)
    row = followup(block_reason="check_incomplete", next_check_at=None)
    fake_core["response"] = core_response(snapshot(row))
    response = client.get("/api/assistant/state")
    assert response.status_code == 200
    assert response.get_json()["responsibilities"] == [row]
    assert row["status"] == "paused" and row["can_review_resume"] is True
    current = review(dependencies=[dependency(permission_mode="confirm", changes=[])])
    fake_core["response"] = core_response(current)
    response = client.get(REVIEW)
    assert response.status_code == 200 and response.get_json() == current
    body = {"status": "active", "revision": row["revision"], "dependency_review_digest": current["review_digest"]}
    fake_core["response"] = core_response({"ok": True})
    response = client.post(BASE, json=body)
    assert response.status_code == 200 and response.get_json() == {"ok": True}
    assert fake_core["calls"][-1]["json"] == body


def test_owner_review_rejects_wrong_identity_scope_digest_and_inconsistent_eligibility(client, fake_core):
    link(client)
    invalid = [review(id="another"), review(space_id="other-private"), review(owner_id="user-nicky"),
               review(revision=True), review(can_resume=1), review(review_digest=None), review(review_digest=DIGEST.upper()),
               review(block_reason="grant_changed"), review(can_resume=False), review(dependencies=[]),
               review(dependencies=[dependency(permission_mode="future-mode", changes=[])]),
               review(dependencies=[dependency(permission_mode="confirm", changes=["grant_changed", "grant_changed"])]),
               review(dependencies=[dependency(permission_mode="confirm", changes=["private-marker"])]),
               review(dependencies=[dependency(permission_mode="confirm", changes=[], availability="waiting", reason_code="connector_offline")])]
    for row in invalid:
        fake_core["response"] = core_response(row)
        safe_failure(client.get(REVIEW))
    ineligible = review(can_resume=False, review_digest=None, block_reason="grant_denied",
                        dependencies=[dependency(availability="blocked", reason_code="grant_denied", permission_mode="unavailable", changes=[])])
    fake_core["response"] = core_response(ineligible)
    assert client.get(REVIEW).get_json() == ineligible


def test_followup_routes_reject_arbitrary_inputs_before_core_dispatch(client, fake_core):
    link(client)
    before = len(fake_core["calls"])
    invalid = [None, [], {}, {"status": [], "revision": 1}, {"status": "active", "revision": True},
               {"status": "active", "revision": 0}, {"status": "active", "revision": 1, "owner_id": "other"},
               {"status": "paused", "revision": 1, "dependency_review_digest": DIGEST},
               {"status": "active", "revision": 1, "dependency_review_digest": None},
               {"status": "active", "revision": 1, "dependency_review_digest": DIGEST.upper()},
               {"status": "active", "revision": 1, "session": "private-marker"}]
    for body in invalid:
        safe_failure(client.post(BASE, json=body), 400)
    for suffix in ("", "?space_id=space-matt&space_id=space-matt", "?space_id=../private", "?space_id=space-matt&owner_id=other"):
        safe_failure(client.get(BASE + "/resume-review" + suffix), 400)
    assert client.post(BASE + "?space_id=space-matt", json={"status": "paused", "revision": 1}).status_code == 400
    assert client.get("/api/assistant/state?url=https://example.invalid").status_code == 400
    assert client.post(BASE, data="x" * 4097, content_type="application/json").status_code == 413
    assert len(fake_core["calls"]) == before


def test_control_requires_exact_acknowledgement_and_never_retries_uncertain_result(client, fake_core):
    link(client)
    for body in ({"status": "paused", "revision": 3}, {"status": "cancelled", "revision": 3},
                 {"status": "active", "revision": 3}, {"status": "active", "revision": 3, "dependency_review_digest": DIGEST}):
        fake_core["response"] = core_response({"ok": True})
        assert client.post(BASE, json=body).get_json() == {"ok": True}
        assert fake_core["calls"][-1]["json"] == body
    body = {"status": "active", "revision": 3, "dependency_review_digest": DIGEST}
    for payload, status in (({"ok": 1}, 200), ({"ok": True, "debug": "private-marker"}, 200), ({"ok": False}, 200), ({"ok": True}, 201), ({"ok": True}, 202)):
        fake_core["response"] = core_response(payload, status)
        safe_failure(client.post(BASE, json=body))
    fake_core["exception"] = requests.Timeout("private-marker")
    before = len(fake_core["calls"])
    safe_failure(client.post(BASE, json=body), 503)
    assert len(fake_core["calls"]) == before + 1


def test_fixed_errors_and_stale_context_are_safe(client, fake_core):
    link(client)
    for status, codes in contract.ERRORS.items():
        for code in codes:
            fake_core["response"] = core_response({"error": code, "internal": "private-marker"}, status)
            response = client.get(REVIEW)
            assert response.status_code == status and response.get_json()["code"] == code
            assert "private-marker" not in response.get_data(as_text=True)
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = "0" * 64
    before = len(fake_core["calls"])
    assert client.get(REVIEW).get_json()["code"] == "assistant_session_changed"
    assert client.post(BASE, json={"status": "paused", "revision": 1}).status_code == 409
    assert len(fake_core["calls"]) == before


def test_guest_and_admin_override_cannot_reach_followup_routes(client, fake_core):
    client.post("/api/login", json={"guest": True})
    assert client.get(REVIEW).status_code == 403
    assert client.post(BASE, json={"status": "active", "revision": 1}).status_code == 403
    ids = {profile["name"]: profile["id"] for profile in client.get("/api/state").get_json()["profiles"]}
    client.post("/api/login", json={"profile_id": ids["Nicky"], "admin_id": ids["Matt"], "admin_passcode": "1234"})
    assert client.get(REVIEW).status_code == 403
    assert client.post(BASE, json={"status": "active", "revision": 1, "dependency_review_digest": DIGEST}).status_code == 403
    assert fake_core["calls"] == []


def test_snapshot_requires_boolean_approval_dependency_state_and_preserves_its_identity(client, fake_core):
    link(client)
    payload = snapshot()
    approval = {"id": "approval-1", "job_id": "job-1", "space_id": "space-matt", "status": "pending",
                "capability": "mail.search", "arguments": '{"resource":"synthetic"}', "action_digest": DIGEST,
                "expires_at": 2000000000000, "dependency_blocked": True}
    payload["approvals"] = [approval]
    for blocked in (True, False):
        approval["dependency_blocked"] = blocked
        fake_core["response"] = core_response(payload)
        response = client.get("/api/assistant/state")
        assert response.status_code == 200
        assert response.get_json()["approvals"] == [{**approval, "presentation": None}]
    for value in (None, 0, 1, "false", [], {}):
        approval["dependency_blocked"] = value
        fake_core["response"] = core_response(payload)
        safe_failure(client.get("/api/assistant/state"))
    del approval["dependency_blocked"]
    fake_core["response"] = core_response(payload)
    safe_failure(client.get("/api/assistant/state"))
