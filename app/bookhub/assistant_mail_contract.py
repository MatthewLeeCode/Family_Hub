"""Public selected-mail task DTOs. Core owns the evidence and authorization."""
import re
import uuid

ERRORS = {
    400: {"invalid_request": "Check the draft request fields."},
    401: {"invalid_session": "Sign in to your assistant account."},
    403: {"action_denied": "Your current permissions do not allow this draft request."},
    404: {"not_found": "That message or draft request is not available to this account."},
    409: {"source_changed": "The message changed. Review it again before requesting a draft.",
          "request_conflict": "This request reference was already used for a different request."},
    500: {"operation_failed": "The draft request could not be confirmed. Check its status before trying again."},
}
STATUSES = {"queued", "running", "waiting_approval", "completed", "cancelled", "expired", "stale", "failed", "outcome_unknown"}
OUTCOMES = {"draft_created", "cancelled", "intent_expired", "session_revoked", "source_changed", "policy_changed",
            "catalog_changed", "action_denied", "invalid_intent", "agent_finished_without_draft", "execution_failed", "outcome_unknown"}


def reference(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None


def request_id(value):
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def string(value, limit):
    return isinstance(value, str) and len(value.encode("utf-8")) <= limit


def timestamp(value):
    return type(value) is int and 0 <= value <= 8640000000000000


def preview(payload, message):
    if (payload.get("kind") != "mail.local_draft.v1" or payload.get("effect") != "local_draft_only"
            or payload.get("message_id") != message or not reference(payload.get("space_id"))
            or not digest(payload.get("source_digest")) or type(payload.get("can_request")) is not bool):
        raise ValueError("Invalid preview")
    eligibility = payload.get("eligibility")
    if eligibility not in {"allowed", "approval_required", "denied", "manual", "authentication_required"}:
        raise ValueError("Invalid eligibility")
    if payload["can_request"] != (eligibility in {"allowed", "approval_required"}):
        raise ValueError("Invalid eligibility control")
    source = payload.get("source")
    if (not isinstance(source, dict) or not all(string(source.get(key), 1024) for key in ("sender", "address", "subject"))
            or not reference(source.get("mailbox_id")) or not string(source.get("body"), 128 * 1024)
            or not timestamp(source.get("received_at"))):
        raise ValueError("Invalid source")
    result = {key: payload[key] for key in ("kind", "message_id", "space_id", "source_digest", "effect", "can_request", "eligibility")}
    result["source"] = {key: source[key] for key in ("sender", "address", "subject", "body", "mailbox_id", "received_at")}
    return result


def summary(payload, identifier, message=None):
    if payload.get("request_id") != identifier or not request_id(identifier):
        raise ValueError("Unexpected request")
    if message is not None and payload.get("message_id") != message:
        raise ValueError("Unexpected source")
    if not all(reference(payload.get(key)) for key in ("message_id", "space_id", "conversation_id", "job_id")):
        raise ValueError("Invalid task reference")
    if payload.get("status") not in STATUSES or not timestamp(payload.get("expires_at")):
        raise ValueError("Invalid task state")
    outcome, draft = payload.get("outcome_code"), payload.get("draft_id")
    if outcome is not None and outcome not in OUTCOMES:
        raise ValueError("Invalid outcome")
    active = payload["status"] in {"queued", "running", "waiting_approval"}
    if active != (outcome is None):
        raise ValueError("Outcome does not match lifecycle")
    if (payload["status"] == "outcome_unknown") != (outcome == "outcome_unknown"):
        raise ValueError("Uncertain outcome mismatch")
    if (payload["status"] == "completed") != (outcome == "draft_created"):
        raise ValueError("Completion mismatch")
    if draft is not None and not reference(draft):
        raise ValueError("Invalid draft reference")
    if payload["status"] == "completed" and (not draft or outcome != "draft_created"):
        raise ValueError("Unconfirmed draft")
    if draft is not None and payload["status"] != "completed":
        raise ValueError("Unexpected draft")
    return {key: payload.get(key) for key in ("request_id", "message_id", "space_id", "conversation_id", "job_id", "status", "draft_id", "outcome_code", "expires_at")}
