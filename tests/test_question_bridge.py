"""Question input boundaries. All upstream traffic is mocked and all accounts synthetic."""
import copy

import pytest
import requests

from test_auth_bridge import app, client, fake_core, core_response, core_token, link, login  # noqa: F401
from test_responsibility_bridge import snapshot, followup
from bookhub import assistant_question_contract as contract

BASE = "/api/assistant/questions/question-1"
READ = BASE + "?space_id=space-matt"
DIGEST = "b4" * 32


def question(**changes):
    return {"id": "question-1", "job_id": "job-1", "conversation_id": "chat-1", "space_id": "space-matt",
            "owner_id": "user-matt", "prompt": "Which inbox should I summarise?",
            "options": [{"id": "work", "label": "Work inbox"}, {"id": "personal", "label": "Personal inbox"}],
            "status": "pending", "revision": 1, "question_digest": DIGEST, "created_at": 2000000000000,
            "expires_at": 2000003600000, "choice_id": None, "answered_at": None, "job_status": "waiting_input",
            "can_answer": True, **changes}


def answer(choice="work", **changes):
    return {"space_id": "space-matt", "expected_revision": 1, "question_digest": DIGEST, "choice_id": choice, **changes}


def saved(choice="work", **changes):
    return question(**{"status": "declined" if choice is None else "answered", "choice_id": choice,
                       "answered_at": 2000000001000, "revision": 2, "can_answer": False, **changes})


def test_question_snapshot_and_direct_read_strip_private_metadata(client, fake_core):
    link(client)
    expected = question()
    upstream = copy.deepcopy(expected)
    upstream.update(creation_receipt={"grant": "private-marker"}, session_authority="private-marker")
    upstream["options"][0]["capability"] = "private-marker"
    state = snapshot(followup(current_job={"id": "job-1", "status": "waiting_input", "block_reason": None}))
    state["questions"] = [upstream]
    fake_core["response"] = core_response(state)
    response = client.get("/api/assistant/state")
    assert response.status_code == 200 and response.get_json()["questions"] == [expected]
    assert "private-marker" not in response.get_data(as_text=True)
    assert response.headers["Cache-Control"] == "no-store"
    fake_core["response"] = core_response(upstream)
    response = client.get(READ, headers={"Authorization": "Bearer private-marker"})
    assert response.status_code == 200 and response.get_json() == expected
    sent = fake_core["calls"][-1]
    assert sent["url"].endswith("/api/questions/question-1?space_id=space-matt")
    assert sent["headers"] == {"X-Household-Request": "1", "Cookie": "household_session=" + core_token()}
    assert sent["json"] is None


def test_old_snapshot_without_question_collection_is_compatible(client, fake_core):
    link(client)
    state = snapshot(); state.pop("questions")
    fake_core["response"] = core_response(state)
    response = client.get("/api/assistant/state")
    assert response.status_code == 200 and response.get_json()["questions"] == []


def test_question_projection_rejects_malformed_and_foreign_rows(client, fake_core):
    link(client)
    invalid = [question(id="other-id"), question(space_id="other-private"), question(owner_id="user-nicky"),
               question(status="future"), question(job_status="future"), question(can_answer=1), question(revision=True),
               question(revision=0), question(question_digest="B" * 64), question(prompt=""), question(prompt="界" * 667),
               question(prompt="  \t\n"), question(prompt="hidden\0text"), question(job_status="queued"),
               question(options=[]), question(options=[{"id": "work", "label": "one"}] * 2),
               question(options=[{"id": "work", "label": "x" * 161}, {"id": "other", "label": "two"}]),
               question(options=[{"id": "bad id", "label": "one"}, {"id": "other", "label": "two"}]),
               question(options=[{"id": "work", "label": "\t"}, {"id": "other", "label": "two"}]),
               question(options=[{"id": "work", "label": "one\0"}, {"id": "other", "label": "two"}]),
               question(options=[{"id": str(i), "label": "Option"} for i in range(7)]), question(conversation_id=False),
               question(choice_id="work"), question(answered_at=0), question(created_at=True), question(expires_at=0),
               saved(can_answer=True), saved(choice_id="unknown"), saved(answered_at=None), question(status="declined"),
               question(status="cancelled", answered_at=2000000001000)]
    for row in invalid:
        fake_core["response"] = core_response(row)
        assert client.get(READ).status_code == 502, row
    for collection in [None, {}, [question(), question()], [question(owner_id="user-nicky")], [question(space_id="foreign")],
                       [question(id="question-" + str(i)) for i in range(101)]]:
        state = snapshot(); state["questions"] = collection
        fake_core["response"] = core_response(state)
        assert client.get("/api/assistant/state").status_code == 502


@pytest.mark.parametrize("choice", ["work", None])
def test_question_answer_relays_only_exact_decision_and_accepts_full_terminal_result(client, fake_core, choice):
    link(client)
    expected = saved(choice)
    fake_core["response"] = core_response({**expected, "private_receipt": "private-marker"})
    response = client.post(BASE + "/answer", json=answer(choice))
    assert response.status_code == 200 and response.get_json() == expected
    sent = fake_core["calls"][-1]
    assert sent["method"] == "POST" and sent["url"].endswith("/api/questions/question-1/answer")
    assert sent["json"] == answer(choice)
    # Deliberate exact replay is relayed unchanged; idempotency belongs to core.
    assert client.post(BASE + "/answer", json=answer(choice)).get_json() == expected
    assert fake_core["calls"][-1]["json"] == answer(choice)


def test_question_answer_rejects_extra_fields_missing_decline_and_invalid_types_before_dispatch(client, fake_core):
    link(client)
    invalid = [None, [], {}, {key: value for key, value in answer().items() if key != "choice_id"},
               answer(True), answer("bad id"), answer("x" * 33), answer(expected_revision=True), answer(expected_revision=0),
               answer(question_digest="bad"), answer(space_id="../other"), answer(owner_id="user-nicky"),
               answer(approve=True), answer(permission_mode="allow")]
    before = len(fake_core["calls"])
    for body in invalid:
        assert client.post(BASE + "/answer", json=body).status_code == 400
    assert client.post(BASE + "/answer?space_id=space-matt", json=answer()).status_code == 400
    assert client.post(BASE + "/answer", data="x" * 4097, content_type="application/json").status_code == 413
    assert len(fake_core["calls"]) == before


def test_question_read_requires_one_exact_scope_and_safe_reference(client, fake_core):
    link(client)
    before = len(fake_core["calls"])
    for path in [BASE, READ + "&space_id=space-shared", READ + "&url=https://example.test", BASE + "?space_id=../other",
                 "/api/assistant/questions/bad%20id?space_id=space-matt"]:
        assert client.get(path).status_code == 400
    assert len(fake_core["calls"]) == before


def test_question_terminal_response_must_match_posted_decision_and_exact_success_status(client, fake_core):
    link(client)
    for body, status in [(saved(), 201), ({"ok": True}, 200), (question(), 200), (saved("personal"), 200),
                         (saved(None), 200), (saved(owner_id="user-nicky"), 200), (saved(space_id="space-shared"), 200),
                         (saved(question_digest="a" * 64), 200), (saved(revision=1), 200), (saved(revision=3), 200), ([], 200)]:
        fake_core["response"] = core_response(body, status)
        assert client.post(BASE + "/answer", json=answer()).status_code == 502


def test_question_read_and_answer_require_live_family_context(client, fake_core):
    link(client)
    client.environ_base["HTTP_X_ASSISTANT_CONTEXT"] = "0" * 64
    before = len(fake_core["calls"])
    assert client.get(READ).status_code == 409
    assert client.post(BASE + "/answer", json=answer()).status_code == 409
    assert len(fake_core["calls"]) == before


def test_guest_and_override_sessions_cannot_read_or_answer_questions(client, fake_core):
    assert client.post("/api/login", json={"guest": True}).status_code == 200
    assert client.get(READ).status_code == 403
    assert client.post(BASE + "/answer", json=answer()).status_code == 403
    ids = {profile["name"]: profile["id"] for profile in client.get("/api/state").get_json()["profiles"]}
    assert client.post("/api/login", json={"profile_id": ids["Nicky"], "admin_id": ids["Matt"], "admin_passcode": "1234"}).status_code == 200
    assert client.get(READ).status_code == 403
    assert client.post(BASE + "/answer", json=answer()).status_code == 403
    assert fake_core["calls"] == []


def test_shared_question_still_belongs_only_to_its_assistant_owner(client, fake_core):
    link(client)
    state = snapshot(); state["spaces"].append({"id": "space-shared", "name": "Shared", "kind": "shared"})
    state["questions"] = [question(space_id="space-shared")]
    fake_core["response"] = core_response(state)
    assert client.get("/api/assistant/state").status_code == 200
    state["questions"][0]["owner_id"] = "user-nicky"
    fake_core["response"] = core_response(state)
    assert client.get("/api/assistant/state").status_code == 502


def test_question_failures_never_reflect_private_details_or_replay(client, fake_core):
    link(client)
    before = len(fake_core["calls"])
    fake_core["exception"] = requests.Timeout("private-marker " + core_token())
    response = client.post(BASE + "/answer", json=answer())
    assert response.status_code == 503 and "private-marker" not in response.get_data(as_text=True)
    assert len(fake_core["calls"]) == before + 1
    fake_core["exception"] = None
    fake_core["response"] = core_response({"error": "decision_conflict", "private": "private-marker"}, 409)
    response = client.post(BASE + "/answer", json=answer())
    assert response.status_code == 409 and response.get_json()["code"] == "decision_conflict"
    assert "private-marker" not in response.get_data(as_text=True)
    fake_core["response"] = core_response({"error": "private-marker"}, 409)
    response = client.get(READ)
    assert response.status_code == 409 and "private-marker" not in response.get_data(as_text=True)


def test_paused_question_can_accept_information_without_a_followup_or_grant_call(client, fake_core):
    link(client)
    pending = question(job_status="waiting_dependency")
    fake_core["response"] = core_response(pending)
    assert client.get(READ).get_json() == pending
    expected = saved(job_status="waiting_dependency")
    fake_core["response"] = core_response(expected)
    before = len(fake_core["calls"])
    assert client.post(BASE + "/answer", json=answer()).get_json() == expected
    assert len(fake_core["calls"]) == before + 1
    assert fake_core["calls"][-1]["url"].endswith("/questions/question-1/answer")
