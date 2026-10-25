"""Profile-local appearance. The authenticated session selects the owner."""
from flask import Blueprint, jsonify, request

from . import looks
from .api import fail, hub, profile_only

bp = Blueprint("personal_looks", __name__, url_prefix="/api/personal-look")


@bp.get("")
@profile_only
def read(who):
    con = hub().con()
    return jsonify({**looks.personal(con, who["id"]), "look": looks.for_profile(con, who["id"]),
                    "household": looks.current(con), "designs": looks.catalogue(), "layouts": looks.LAYOUTS})


@bp.post("")
@profile_only
def write(who):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or set(data) != {"revision", "overrides"}:
        return fail("Send an appearance revision and overrides only.")
    # Do not accept a profile_id, even for an admin. Admin impersonation is handled
    # explicitly by the app's existing authentication flow, never by this endpoint.
    try:
        saved = looks.save_personal(hub().con(), who["id"], data["overrides"], data["revision"])
    except ValueError as error:
        return fail(str(error))
    except RuntimeError as error:
        return fail(str(error), 409)
    return jsonify({**saved, "look": looks.for_profile(hub().con(), who["id"])})
