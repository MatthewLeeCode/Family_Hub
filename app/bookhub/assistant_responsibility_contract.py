"""Public follow-up projection. Authority baselines and resume decisions stay in core."""
import re

MAX_INTEGER = 9007199254740991
STATUSES = {"active", "paused", "completed", "cancelled", "expired", "exhausted"}
AVAILABILITY = {"ready", "waiting", "blocked", "not_evaluated"}
REASONS = {"legacy_unbound", "connector_offline", "connector_checking", "connection_disabled",
           "connection_removed", "connection_changed", "operator_review_required", "catalog_changed", "grant_changed",
           "grant_unavailable", "grant_denied", "grant_manual", "grant_expired", "membership_changed",
           "owner_paused", "unresolved_effect", "responsibility_expired", "budget_exhausted"}
JOB_STATUSES = {"queued", "running", "waiting_approval", "waiting_dependency", "outcome_unknown",
                "cancelled", "failed", "succeeded"}
MODES = {"autonomous", "current_task", "conditional", "confirm", "manual", "unavailable"}
CHANGES = {"grant_changed", "catalog_changed", "membership_changed", "connection_changed"}
ERRORS = {
    400: {"invalid_request": "Check the follow-up request fields."},
    403: {"owner_required": "Only the owner can review or resume this follow-up."},
    404: {"not_found": "That follow-up is not available in this workspace."},
    409: {"responsibility_changed": "This follow-up changed. Reload its current state.",
          "dependency_review_changed": "The dependencies changed. Review them again before resuming.",
          "dependency_unavailable": "The required dependencies are not available. Review the current state.",
          "unresolved_effect": "An earlier action has an unresolved outcome. This follow-up cannot resume."},
}
FIELDS = ("id", "space_id", "owner_id", "title", "instruction", "reason", "stop_condition", "status",
          "next_check_at", "expires_at", "remaining_checks", "revision", "event_kind", "event_resource",
          "dependency_state", "availability", "block_reason", "dependencies", "next_probe_at", "current_job",
          "can_pause", "can_cancel", "can_review_resume")
SNAPSHOT_FIELDS = ("user", "spaces", "mailboxes", "emails", "assets", "notices", "preferences", "automations",
                   "conversations", "jobs", "drafts", "items", "members", "responsibilities", "approvals", "policies")
PUBLIC_ROWS = {
    "spaces": "id name kind", "mailboxes": "id space_id name address provider",
    "emails": "id space_id mailbox_id sender address subject body category important received_at",
    "assets": "id space_id name content_type size sha256 source_message source_attachment created_at",
    "notices": "id space_id title body asset_id read created_at", "preferences": "id text created_at",
    "automations": "id space_id name enabled", "conversations": "id space_id title updated_at",
    "jobs": "id space_id kind title status detail created_at", "drafts": "id space_id subject recipient body",
    "items": "id space_id kind title body date end_date start_time end_time timezone all_day completed assignee revision deleted start_at end_at",
    "members": "user_id space_id name",
    "approvals": "id job_id space_id capability arguments operation_key status created_at expires_at policy_reason action_digest policy_revision dependency_blocked",
    "policies": "space_id capability mode",
}


def reference(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def integer(value, minimum=0, maximum=MAX_INTEGER):
    return type(value) is int and minimum <= value <= maximum


def text(value, maximum):
    return isinstance(value, str) and len(value.encode("utf-8")) <= maximum


def reason(value):
    return value is None or (isinstance(value, str) and value in REASONS)


def available(value, block):
    if not isinstance(value, str) or value not in AVAILABILITY or not reason(block):
        return False
    if value == "ready":
        return block is None
    if value == "waiting":
        return block in {"connector_offline", "connector_checking"}
    return value != "blocked" or block is not None


def current_job(value):
    if value is None:
        return None
    if (not isinstance(value, dict) or not reference(value.get("id")) or value.get("status") not in JOB_STATUSES
            or "block_reason" not in value or not reason(value["block_reason"])):
        raise ValueError("Invalid current job")
    return {key: value[key] for key in ("id", "status", "block_reason")}


def dependencies(values, *, bound=True, review=False):
    if not isinstance(values, list) or not (1 <= len(values) <= 8 if bound else len(values) == 0):
        raise ValueError("Invalid dependency list")
    result = []
    for row in values:
        if (not isinstance(row, dict) or not isinstance(row.get("capability"), str)
                or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,127}", row["capability"])
                or "connection_id" not in row or (row["connection_id"] is not None and not reference(row["connection_id"]))
                or "reason_code" not in row or not available(row.get("availability"), row["reason_code"])):
            raise ValueError("Invalid dependency")
        public = {key: row[key] for key in ("capability", "connection_id", "availability", "reason_code")}
        if review:
            changes = row.get("changes")
            if (row.get("permission_mode") not in MODES or not isinstance(changes, list) or len(changes) > 4
                    or any(not isinstance(item, str) or item not in CHANGES for item in changes)
                    or len(changes) != len(set(changes))):
                raise ValueError("Invalid dependency review")
            public.update(permission_mode=row["permission_mode"], changes=list(changes))
        result.append(public)
    names = [row["capability"] for row in result]
    if names != sorted(set(names)):
        raise ValueError("Dependencies must be unique and sorted")
    return result


def responsibility(value, viewer, scopes):
    if not isinstance(value, dict) or any(key not in value for key in FIELDS):
        raise ValueError("Incomplete follow-up")
    if (not all(reference(value[key]) for key in ("id", "space_id", "owner_id")) or value["space_id"] not in scopes
            or value["status"] not in STATUSES or value["dependency_state"] not in {"bound", "legacy_unbound"}
            or not available(value["availability"], value["block_reason"])):
        raise ValueError("Invalid follow-up state")
    for key, maximum in (("title", 120), ("instruction", 4000), ("reason", 2000), ("stop_condition", 2000)):
        if not text(value[key], maximum):
            raise ValueError("Invalid follow-up text")
    if (value["event_kind"] not in {"", "mail.arrived"} or not isinstance(value["event_resource"], str)
            or (value["event_resource"] and not reference(value["event_resource"]))
            or not integer(value["revision"], 1) or not integer(value["remaining_checks"], 0, 20)
            or not integer(value["expires_at"])):
        raise ValueError("Invalid follow-up limits")
    for key in ("next_check_at", "next_probe_at"):
        if value[key] is not None and not integer(value[key]):
            raise ValueError("Invalid follow-up time")
    for key in ("can_pause", "can_cancel", "can_review_resume"):
        if type(value[key]) is not bool:
            raise ValueError("Invalid follow-up control")
    if ((value["can_pause"] and value["status"] != "active")
            or (value["can_cancel"] and value["status"] not in {"active", "paused"})
            or (value["can_review_resume"] and (value["status"] != "paused" or value["owner_id"] != viewer))):
        raise ValueError("Invalid follow-up controls")
    result = {key: value[key] for key in FIELDS}
    result["dependencies"] = dependencies(value["dependencies"], bound=value["dependency_state"] == "bound")
    result["current_job"] = current_job(value["current_job"])
    return result


def snapshot(payload, viewer):
    """Narrow the existing snapshot's public top level and deep-project follow-ups."""
    user, spaces, rows = payload.get("user"), payload.get("spaces"), payload.get("responsibilities")
    if (not isinstance(user, dict) or user.get("id") != viewer or not reference(viewer)
            or not isinstance(spaces, list) or len(spaces) > 1024 or not isinstance(rows, list) or len(rows) > 100):
        raise ValueError("Invalid follow-up snapshot")
    if any(not isinstance(space, dict) or not reference(space.get("id")) for space in spaces):
        raise ValueError("Invalid workspace")
    scopes = {space["id"] for space in spaces}
    if len(scopes) != len(spaces):
        raise ValueError("Duplicate workspace")
    def pick(row, fields):
        if not isinstance(row, dict):
            raise ValueError("Invalid public record")
        result = {key: row[key] for key in fields.split() if key in row}
        if any(type(value) not in (str, int, bool, type(None)) for value in result.values()):
            raise ValueError("Unexpected nested metadata")
        return result

    public = {"user": pick(user, "id name login private_space")}
    for key, fields in PUBLIC_ROWS.items():
        values = payload.get(key, [])
        if not isinstance(values, list):
            raise ValueError("Invalid public collection")
        public[key] = [pick(row, fields) for row in values]
        if key == "approvals" and any(type(row.get("dependency_blocked")) is not bool for row in values):
            raise ValueError("Invalid approval availability")
        if key == "emails":
            for row, value in zip(public[key], values):
                attachments = value.get("attachments", [])
                if not isinstance(attachments, list):
                    raise ValueError("Invalid attachments")
                row["attachments"] = [pick(attachment, "id message_id name content_type size") for attachment in attachments]
    public["responsibilities"] = [responsibility(row, viewer, scopes) for row in rows]
    if len({row["id"] for row in public["responsibilities"]}) != len(rows):
        raise ValueError("Duplicate follow-up")
    return public


def review(payload, item, space, viewer):
    keys = ("id", "space_id", "owner_id", "revision", "review_digest", "can_resume", "block_reason",
            "dependencies", "remaining_checks", "expires_at", "current_job")
    if (any(key not in payload for key in keys) or payload["id"] != item or payload["space_id"] != space
            or payload["owner_id"] != viewer or not integer(payload["revision"], 1)
            or not integer(payload["remaining_checks"], 0, 20) or not integer(payload["expires_at"])
            or type(payload["can_resume"]) is not bool or not reason(payload["block_reason"])):
        raise ValueError("Invalid resume review")
    eligible = payload["can_resume"]
    if ((eligible and (not digest(payload["review_digest"]) or payload["block_reason"] is not None))
            or (not eligible and (payload["review_digest"] is not None or payload["block_reason"] is None))):
        raise ValueError("Invalid review eligibility")
    result = {key: payload[key] for key in keys}
    result["dependencies"] = dependencies(payload["dependencies"], review=True)
    result["current_job"] = current_job(payload["current_job"])
    if eligible and any(row["availability"] != "ready" for row in result["dependencies"]):
        raise ValueError("Unready eligible review")
    return result


def control(body):
    if (not isinstance(body, dict) or not isinstance(body.get("status"), str)
            or body["status"] not in {"active", "paused", "cancelled"} or not integer(body.get("revision"), 1)):
        return False
    if set(body) == {"status", "revision"}:
        return True
    return (body["status"] == "active" and set(body) == {"status", "revision", "dependency_review_digest"}
            and digest(body["dependency_review_digest"]))


def acknowledgement(payload):
    if payload != {"ok": True} or type(payload.get("ok")) is not bool:
        raise ValueError("Unconfirmed follow-up action")
    return {"ok": True}
