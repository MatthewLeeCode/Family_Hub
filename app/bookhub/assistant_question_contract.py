"""Public single-choice questions. Answers are input, never permission grants."""
import re

from .assistant_responsibility_contract import digest, integer, reference, text

STATUSES = {"pending", "answered", "declined", "expired", "cancelled"}
JOB_STATUSES = {"queued", "running", "waiting_approval", "waiting_input", "waiting_dependency",
                "outcome_unknown", "succeeded", "failed", "cancelled", "interrupted"}
FIELDS = ("id", "job_id", "conversation_id", "space_id", "owner_id", "prompt", "options", "status",
          "revision", "question_digest", "created_at", "expires_at", "choice_id", "answered_at",
          "job_status", "can_answer")
ERRORS = {
    400: {"invalid_request": "Check the question response fields."},
    401: {"sign_in_required": "Sign in again before answering this question."},
    404: {"not_found": "That question is not available in this workspace."},
    409: {"question_changed": "This question changed. Reload its current state.",
          "question_expired": "This question expired. Reload its current state.",
          "question_closed": "This question is closed. Reload its current state.",
          "decision_conflict": "A different response was already recorded. Reload the saved answer.",
          "unresolved_effect": "An earlier action has an unresolved outcome. This question cannot be answered now."},
    500: {"operation_failed": "The response could not be confirmed. Reload the question before continuing."},
}


def option_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", value) is not None


def nonempty_text(value, maximum):
    return text(value, maximum) and bool(value.strip()) and "\0" not in value


def question(value, viewer, *, item=None, space=None, scopes=None):
    if not isinstance(value, dict) or any(key not in value for key in FIELDS):
        raise ValueError("Incomplete question")
    if (not all(reference(value[key]) for key in ("id", "job_id", "space_id", "owner_id"))
            or not reference(viewer) or value["owner_id"] != viewer
            or (item is not None and value["id"] != item)
            or (space is not None and value["space_id"] != space)
            or (scopes is not None and value["space_id"] not in scopes)
            or (value["conversation_id"] is not None and not reference(value["conversation_id"]))):
        raise ValueError("Invalid question identity")
    if (not isinstance(value["status"], str) or value["status"] not in STATUSES
            or not isinstance(value["job_status"], str) or value["job_status"] not in JOB_STATUSES
            or not integer(value["revision"], 1) or not digest(value["question_digest"])
            or not nonempty_text(value["prompt"], 2000)
            or not integer(value["created_at"]) or not integer(value["expires_at"])
            or value["expires_at"] <= value["created_at"] or type(value["can_answer"]) is not bool
            or (value["can_answer"] and (value["status"] != "pending" or value["job_status"] not in {"waiting_input", "waiting_dependency"}))):
        raise ValueError("Invalid question state")
    options = value["options"]
    if not isinstance(options, list) or not 2 <= len(options) <= 6:
        raise ValueError("Invalid question options")
    public_options = []
    for option in options:
        if (not isinstance(option, dict) or not option_id(option.get("id"))
                or not nonempty_text(option.get("label"), 160)):
            raise ValueError("Invalid question option")
        public_options.append({"id": option["id"], "label": option["label"]})
    ids = {option["id"] for option in public_options}
    if len(ids) != len(options):
        raise ValueError("Duplicate question option")
    choice, answered = value["choice_id"], value["answered_at"]
    if value["status"] == "answered":
        if not option_id(choice) or choice not in ids or not integer(answered):
            raise ValueError("Invalid saved answer")
    elif value["status"] == "declined":
        if choice is not None or not integer(answered):
            raise ValueError("Invalid declined answer")
    elif choice is not None or answered is not None:
        raise ValueError("Unexpected saved answer")
    result = {key: value[key] for key in FIELDS}
    result["options"] = public_options
    return result


def collection(values, viewer, scopes):
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError("Invalid question collection")
    rows = [question(value, viewer, scopes=scopes) for value in values]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate question")
    return rows


def answer(body):
    return (isinstance(body, dict) and set(body) == {"space_id", "expected_revision", "question_digest", "choice_id"}
            and reference(body["space_id"]) and integer(body["expected_revision"], 1)
            and digest(body["question_digest"]) and (body["choice_id"] is None or option_id(body["choice_id"])))


def decision(value, viewer, item, body):
    public = question(value, viewer, item=item, space=body["space_id"])
    if (public["question_digest"] != body["question_digest"] or public["choice_id"] != body["choice_id"]
            or public["revision"] != body["expected_revision"] + 1
            or public["status"] != ("declined" if body["choice_id"] is None else "answered")):
        raise ValueError("Unexpected saved decision")
    return public
