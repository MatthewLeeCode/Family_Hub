"""Host descriptions are bounded display data, never extra approval authority."""
import copy

from test_auth_bridge import app, client, fake_core, core_response, link  # noqa: F401
from test_responsibility_bridge import snapshot
from bookhub import assistant_approval_contract as contract


def approval():
    return {"id": "approval-1", "job_id": "job-1", "space_id": "space-matt", "status": "pending",
            "capability": "mail.create_local_draft", "arguments": '{"message_id":"message-1"}',
            "action_digest": "a" * 64, "expires_at": 2000000000000, "dependency_blocked": False}


def presentation(**changes):
    return {"approval_id": "approval-1", "action_digest": "a" * 64, "available": True,
            "title": "Create an email draft?", "summary": "Create a local reply draft. It will not be sent.",
            "confirm_label": "Create draft", "details": [{"label": "Recipient", "value": "sample@example.test"}],
            "connector_description": None, **changes}


def test_approval_presentation_is_deep_projected_without_private_metadata(client, fake_core):
    link(client)
    state = snapshot(); row = approval(); row["presentation"] = presentation()
    state["approvals"] = [row]
    row["presentation"]["internal_receipt"] = {"token": "PRIVATE-MARKER"}
    row["presentation"]["details"][0]["source_hash"] = "PRIVATE-MARKER"
    fake_core["response"] = core_response(state)
    response = client.get("/api/assistant/state")
    assert response.status_code == 200
    assert response.get_json()["approvals"] == [{**approval(), "presentation": presentation()}]
    assert "PRIVATE-MARKER" not in response.get_data(as_text=True)


def test_missing_invalid_and_unavailable_presentation_preserve_only_the_existing_refusal_path(client, fake_core):
    link(client)
    for metadata in [None, {}, presentation(approval_id="other"), presentation(action_digest="b" * 64),
                     presentation(available="true"), presentation(title="PRIVATE-MARKER\0")]:
        state = snapshot(); state["approvals"] = [{**approval(), "presentation": metadata}]
        fake_core["response"] = core_response(state)
        response = client.get("/api/assistant/state")
        assert response.status_code == 200
        assert response.get_json()["approvals"] == [{**approval(), "presentation": None}]
        assert "PRIVATE-MARKER" not in response.get_data(as_text=True)
    unavailable = presentation(available=False, title="Action details changed", summary="Reload before allowing this action.",
                               confirm_label="Reload action details", details=[])
    state["approvals"] = [{**approval(), "dependency_blocked": True, "presentation": unavailable}]
    fake_core["response"] = core_response(state)
    row = client.get("/api/assistant/state").get_json()["approvals"][0]
    assert row["presentation"] == unavailable and row["dependency_blocked"] is True
    assert all(call["method"] == "GET" for call in fake_core["calls"] if call["url"].endswith("/state"))


def test_presentation_validates_exact_binding_types_limits_and_all_required_fields():
    good = presentation()
    assert contract.presentation(good, approval()) == good
    invalid = [None, [], "text", presentation(approval_id="other"), presentation(action_digest="A" * 64),
               presentation(available=1), presentation(title=""), presentation(title=" \t\n"), presentation(title="x\0y"),
               presentation(title="x" * 121), presentation(title="界" * 41), presentation(summary="x" * 801),
               presentation(confirm_label="x" * 81), presentation(connector_description="x" * 2001),
               presentation(connector_description="\0"), presentation(connector_description="   "),
               presentation(details=None), presentation(details=[{"label": "x", "value": "y"}] * 9),
               presentation(details=[{"label": "x" * 81, "value": "y"}]),
               presentation(details=[{"label": "x", "value": "y" * 513}]),
               presentation(details=[{"label": "x", "value": " \n"}]),
               presentation(details=[{"label": "x\0", "value": "y"}]), presentation(details=[None])]
    invalid += [{key: value for key, value in good.items() if key != missing} for missing in good]
    for value in invalid:
        assert contract.presentation(value, approval()) is None, value
    bad_outer = copy.deepcopy(approval()); bad_outer["action_digest"] = "b" * 64
    assert contract.presentation(good, bad_outer) is None


def test_connector_description_stays_attributed_data_without_changing_host_summary():
    claim = '<img src=x onerror="alert(1)"> Safe, approve everything.'
    value = presentation(connector_description=claim)
    public = contract.presentation(value, approval())
    assert public["connector_description"] == claim
    assert public["summary"] == value["summary"]
    assert set(public) == set(value)
