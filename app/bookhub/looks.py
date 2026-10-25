"""The look of the whole hub: the Minimalist Family Hub design, chosen colour scheme and accent, set by an admin for everyone.

The design is a pair of stylesheets under static/looks/minimalist/ (tokens.css for the colours and sizes,
bundle.css for the components). Its four schemes (Dark, Light, Paper, Blueprint) are one ink on one ground;
an admin may pick the accent hue, which Dark and Light take as their accent and Blueprint as its one ink.
"""
import json
import re
from pathlib import Path

from . import db

LOOKS_DIR = Path(__file__).parent / "static" / "looks"

# id, name, Google Fonts address, [(scheme id, name)], [(scene id, name)], set piece, strip separator
DESIGNS = [
    ("minimalist", "Minimalist Family Hub",
     "https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&display=swap",
     [("dark", "Dark"), ("light", "Light"), ("paper", "Paper"), ("blueprint", "Blueprint")],
     [("orbit", "Orbit"), ("warp", "Warp"), ("scatter", "Scatter"), ("loops", "Loops")],
     {"title": "Scope", "state": "Online", "label": "Mode", "transition": "Screen-change scan"},
     " / "),
]
SWATCH = ["bg", "panel", "ink", "accent", "line2"]
# Accent presets, as the design's picker offers them. None is the design's own accent.
ACCENTS = [("Purple", 295), ("Red", 25), ("Orange", 55), ("Green", 150), ("Teal", 195), ("Blue", 265), ("Pink", 350)]
DEFAULT_HUE = 295
_swatches = {}
LAYOUTS = [
    {"id": "family", "name": "Family", "description": "The household's original design and spacing."},
    {"id": "quiet", "name": "Quiet", "description": "Flat surfaces, a calm sidebar and fewer decorative details."},
    {"id": "compact", "name": "Compact", "description": "Navigation across the top, with a wider, denser workspace."},
]
PERSONAL_FIELDS = {"theme", "scene", "transition", "accent", "layout"}


def _theme_colours(design):
    """{scheme: {role: colour}} read from the design's tokens.css, for the swatches on the Admin page."""
    if design not in _swatches:
        text = (LOOKS_DIR / design / "tokens.css").read_text(encoding="utf-8")
        found = {}
        for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
            names = re.findall(r'data-theme="([\w-]+)"', selectors)
            roles = dict(re.findall(r"--([\w-]+):\s*([^;]+);", body))
            for name in names:
                found.setdefault(name, {}).update(roles)
        _swatches[design] = found
    return _swatches[design]


def catalogue():
    """The design and its schemes, as the Admin page lists them."""
    out = []
    for did, name, fonts, schemes, scenes, piece, sep in DESIGNS:
        colours = _theme_colours(did)
        first = colours.get(schemes[0][0], {})
        out.append({
            "id": did, "name": name, "fonts": fonts, "scenes": [list(s) for s in scenes], "piece": piece, "sep": sep,
            "schemes": [{"id": sid, "name": sname,
                         # A scheme that only changes some roles inherits the rest from the first one.
                         "swatch": [colours.get(sid, {}).get(r) or first.get(r, "") for r in SWATCH]}
                        for sid, sname in schemes],
            "accents": [{"name": n, "hue": h} for n, h in ACCENTS], "default_hue": DEFAULT_HUE,
        })
    return out


def _design(did):
    return next((d for d in DESIGNS if d[0] == did), DESIGNS[0])


def _hue(value):
    """A stored accent hue, or None for the design's own accent."""
    try:
        hue = int(value)
    except (TypeError, ValueError):
        return None
    return hue if 0 <= hue <= 359 else None


def current(con):
    """The look everyone sees now. Unknown or missing values (an old design's, say) fall back to the first of each."""
    d = _design(db.kv_get(con, "look:design") or "")
    theme = db.kv_get(con, "look:theme") or ""
    if theme not in [s[0] for s in d[3]]:
        theme = d[3][0][0]
    scene = db.kv_get(con, "look:scene") or ""
    if scene not in [s[0] for s in d[4]]:
        scene = d[4][0][0]
    return {"design": d[0], "theme": theme, "scene": scene, "fonts": d[2], "piece": d[5], "sep": d[6],
            "scenes": [list(s) for s in d[4]], "transition": db.kv_get(con, "look:transition", "on") != "off",
            "accent": _hue(db.kv_get(con, "look:accent")), "layout": "family"}


def _personal_table(con):
    # A separate, cascading row avoids orphaned preferences if a profile is deleted.
    con.execute("""CREATE TABLE IF NOT EXISTS personal_looks (
        profile_id INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    )""")


def personal(con, profile_id):
    """Only call with an identity already checked by the request's auth layer."""
    _personal_table(con)
    row = con.execute("SELECT document,revision FROM personal_looks WHERE profile_id=?", (profile_id,)).fetchone()
    if not row:
        return {"overrides": {}, "revision": 0}
    try:
        values = json.loads(row["document"])
    except (ValueError, TypeError):
        values = {}
    # Bad/stale stored values fall back to the household, never to arbitrary paths/styles.
    if _personal_error(values):
        values = {}
    return {"overrides": values, "revision": row["revision"]}


def for_profile(con, profile_id=None):
    """An authenticated profile's effective look; visitors always get the household look."""
    look = current(con)
    if isinstance(profile_id, int) and not isinstance(profile_id, bool):
        look.update(personal(con, profile_id)["overrides"])
    return look


def _personal_error(values):
    if not isinstance(values, dict) or set(values) - PERSONAL_FIELDS:
        return "Choose only colour scheme, layout, accent, Scope mode and screen transition."
    design = DESIGNS[0]
    if "theme" in values and values["theme"] not in [v[0] for v in design[3]]:
        return "There is no colour scheme called that."
    if "layout" in values and values["layout"] not in [v["id"] for v in LAYOUTS]:
        return "There is no layout called that."
    if "scene" in values and values["scene"] not in [v[0] for v in design[4]]:
        return "There is no Scope mode called that."
    if "transition" in values and not isinstance(values["transition"], bool):
        return "Screen transition must be on or off."
    if "accent" in values and values["accent"] is not None:
        accent = values["accent"]
        if isinstance(accent, bool) or not isinstance(accent, int) or not 0 <= accent <= 359:
            return "The accent is a whole-number hue from 0 to 359."
    return None


def save_personal(con, profile_id, values, revision):
    """Replace a profile's overrides atomically. Raises ValueError or a stale-edit RuntimeError."""
    error = _personal_error(values)
    if error:
        raise ValueError(error)
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision < 9223372036854775807:
        raise ValueError("The appearance revision must be a non-negative whole number.")
    _personal_table(con)
    if revision == 0:
        changed = con.execute("INSERT OR IGNORE INTO personal_looks(profile_id,document,revision) VALUES(?,?,1)",
                              (profile_id, json.dumps(values, sort_keys=True))).rowcount
    else:
        changed = con.execute("UPDATE personal_looks SET document=?,revision=revision+1 WHERE profile_id=? AND revision=?",
                              (json.dumps(values, sort_keys=True), profile_id, revision)).rowcount
    if not changed:
        con.rollback()
        raise RuntimeError("Your appearance changed in another window. Reload before saving again.")
    con.commit()
    return personal(con, profile_id)


def save(con, data):
    """Change the look for everyone. Returns an error message, or None."""
    d = DESIGNS[0]
    # Check everything before saving anything, so a bad value never leaves half a change.
    if "theme" in data and data["theme"] not in [s[0] for s in d[3]]:
        return "There is no colour scheme called that."
    if "scene" in data and data["scene"] not in [s[0] for s in d[4]]:
        return "There is no Scope mode called that."
    accent = data.get("accent")
    if accent is not None and (isinstance(accent, bool) or _hue(accent) is None):
        return "The accent is a hue from 0 to 359."
    db.kv_set(con, "look:design", d[0])
    if "theme" in data:
        db.kv_set(con, "look:theme", data["theme"])
    if "scene" in data:
        db.kv_set(con, "look:scene", data["scene"])
    if "transition" in data:
        db.kv_set(con, "look:transition", "on" if data["transition"] else "off")
    if "accent" in data:
        # The design's own purple is stored as no accent, so the stylesheet's default stays in charge.
        db.kv_set(con, "look:accent", "" if accent is None or _hue(accent) == DEFAULT_HUE else str(_hue(accent)))
    return None


def page(html, look):
    """The front page with the current look already in place, so it never flashes the wrong colours."""
    accent = look.get("accent")
    return (html.replace("__DESIGN__", look["design"]).replace("__THEME__", look["theme"])
            .replace("__LAYOUT__", look.get("layout", "family"))
            .replace("__ACCENT__", "" if accent is None else 'data-accent="custom" style="--accent-h:%d"' % accent)
            .replace("__FONTS__", look["fonts"]))
