"""Host-authored permission summaries. Unverifiable text never enables approval."""
import re


def plain_text(value, maximum):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= maximum
    except UnicodeError:
        return False


def presentation(value, approval):
    """Project trusted display fields or return no usable explanation.

    Keep the original approval so its existing refusal path remains available.
    Missing, malformed or mismatched metadata must never enable confirmation.
    """
    if not isinstance(value, dict):
        return None
    fields = ("approval_id", "action_digest", "available", "title", "summary", "confirm_label",
              "details", "connector_description")
    if any(key not in value for key in fields):
        return None
    if (not isinstance(value["approval_id"], str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value["approval_id"]) is None
            or value["approval_id"] != approval.get("id")
            or not isinstance(value["action_digest"], str)
            or re.fullmatch(r"[a-f0-9]{64}", value["action_digest"]) is None
            or value["action_digest"] != approval.get("action_digest")
            or type(value["available"]) is not bool
            or not plain_text(value["title"], 120) or not plain_text(value["summary"], 800)
            or not plain_text(value["confirm_label"], 80)
            or not isinstance(value["details"], list) or len(value["details"]) > 8
            or (value["connector_description"] is not None and not plain_text(value["connector_description"], 2000))):
        return None
    details = []
    for detail in value["details"]:
        if (not isinstance(detail, dict) or not plain_text(detail.get("label"), 80)
                or not plain_text(detail.get("value"), 512)):
            return None
        details.append({"label": detail["label"], "value": detail["value"]})
    public = {key: value[key] for key in fields}
    public["details"] = details
    return public
