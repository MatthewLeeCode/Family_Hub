"""Appearance follows the authenticated profile without changing household defaults."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from bookhub import create_app, demo, looks  # noqa: E402
from bookhub.config import Config  # noqa: E402


@pytest.fixture()
def app(tmp_path, monkeypatch):
    folders = demo.build(tmp_path / "demo")
    for name, path in {"CALIBRE_LIBRARY": folders["library"], "BOOKHUB_DATA_DIR": folders["data"],
                       "DOWNLOADS_DIR": tmp_path / "downloads", "INGEST_DIR": tmp_path / "ingest",
                       "INBOX_DIR": tmp_path / "inbox", "ATTENTION_DIR": tmp_path / "attention"}.items():
        monkeypatch.setenv(name, str(path))
    monkeypatch.setenv("BACKGROUND_JOBS", "false")
    for name in ("PROWLARR_URL", "PROWLARR_API_KEY", "QBITTORRENT_URL"):
        monkeypatch.delenv(name, raising=False)
    app = create_app(Config())
    with app.app_context():
        demo.seed(app.hub)
    return app


@pytest.fixture()
def client(app):
    return app.test_client()


def login(client, name):
    profiles = client.get("/api/state").get_json()["profiles"]
    pid = next(p["id"] for p in profiles if p["name"] == name)
    assert client.post("/api/login", json={"profile_id": pid, "passcode": "1234"}).status_code == 200
    return pid


def save(client, overrides, revision=0):
    return client.post("/api/personal-look", json={"overrides": overrides, "revision": revision})


def test_requires_a_real_profile(client):
    assert client.get("/api/personal-look").status_code == 401
    assert save(client, {"layout": "quiet"}).status_code == 401
    assert client.post("/api/login", json={"guest": True}).status_code == 200
    assert client.get("/api/personal-look").status_code == 403
    assert save(client, {"layout": "quiet"}).status_code == 403


def test_personal_choice_inherits_and_does_not_change_partner(client):
    login(client, "You")
    assert client.post("/api/admin/look", json={"theme": "paper", "scene": "loops", "accent": 150}).status_code == 200
    before = client.get("/api/personal-look").get_json()
    assert before["overrides"] == {} and before["revision"] == 0
    assert before["look"]["theme"] == "paper" and before["look"]["layout"] == "family"
    saved = save(client, {"theme": "dark", "layout": "quiet", "transition": False}).get_json()
    assert saved["revision"] == 1
    assert saved["look"]["scene"] == "loops" and saved["look"]["accent"] == 150
    assert client.get("/api/state").get_json()["look"]["layout"] == "quiet"
    assert 'data-layout="quiet"' in client.get("/").get_data(as_text=True)
    client.post("/api/logout")
    assert 'data-layout="family"' in client.get("/").get_data(as_text=True)
    login(client, "Partner")
    partner = client.get("/api/personal-look").get_json()
    assert partner["overrides"] == {} and partner["look"]["theme"] == "paper"
    assert partner["look"]["layout"] == "family"
    assert save(client, {"layout": "compact"}).status_code == 200
    login(client, "You")
    # Explicit overrides stay fixed, inherited fields follow subsequent family changes.
    assert client.post("/api/admin/look", json={"theme": "light", "scene": "warp", "accent": 25}).status_code == 200
    mine = client.get("/api/personal-look").get_json()
    assert mine["look"]["theme"] == "dark" and mine["look"]["scene"] == "warp" and mine["look"]["accent"] == 25
    assert mine["household"]["theme"] == "light"
    assert save(client, {}, revision=1).get_json()["look"]["theme"] == "light"
    login(client, "Partner")
    assert client.get("/api/personal-look").get_json()["look"]["layout"] == "compact"


def test_restricted_member_can_style_but_not_change_permissions(client):
    login(client, "Nan")
    before = client.get("/api/books").get_json()
    for theme in ("dark", "light", "paper", "blueprint"):
        for layout in ("family", "quiet", "compact"):
            revision = client.get("/api/personal-look").get_json()["revision"]
            assert save(client, {"theme": theme, "layout": layout}, revision).status_code == 200
    assert client.get("/api/books").get_json() == before
    assert client.get("/api/discover/search?q=austen").status_code == 403
    assert client.post("/api/admin/look", json={"theme": "paper"}).status_code == 403


@pytest.mark.parametrize("overrides", [None, [], "quiet", {"profile_id": 2}, {"layout": "../../other"},
    {"layout": None}, {"theme": "unknown"}, {"theme": ["dark"]}, {"scene": "unknown"}, {"transition": "false"},
    {"accent": True}, {"accent": 3.5}, {"accent": "195"}, {"accent": -1}, {"accent": 360},
    {"theme": "light", "role": "admin"}])
def test_invalid_preferences_are_atomic(client, overrides):
    login(client, "Partner")
    assert save(client, {"theme": "dark", "layout": "quiet"}).status_code == 200
    before = client.get("/api/personal-look").get_json()
    assert save(client, overrides, revision=1).status_code == 400
    assert client.get("/api/personal-look").get_json() == before


@pytest.mark.parametrize("revision", [-1, True, "1", 1.5, None, 10**100])
def test_invalid_revision_is_rejected(client, revision):
    login(client, "Partner")
    assert save(client, {"layout": "quiet"}, revision).status_code == 400
    assert client.get("/api/personal-look").get_json()["revision"] == 0


def test_cannot_supply_a_different_identity_even_as_admin(client):
    login(client, "You")
    for body in ({"profile_id": 2, "overrides": {"layout": "quiet"}, "revision": 0},
                 {"overrides": {"profile_id": 2}, "revision": 0}, [], None):
        assert client.post("/api/personal-look", json=body).status_code == 400
    login(client, "Partner")
    assert client.get("/api/personal-look").get_json()["overrides"] == {}


def test_stale_tab_cannot_overwrite_save_or_reset(client):
    login(client, "You")
    assert save(client, {"layout": "quiet"}).status_code == 200
    assert save(client, {"layout": "compact"}).status_code == 409
    assert save(client, {}, revision=1).get_json()["revision"] == 2
    assert save(client, {"theme": "light"}, revision=1).status_code == 409
    assert save(client, {"theme": "paper"}, revision=0).status_code == 409
    current = client.get("/api/personal-look").get_json()
    assert current["revision"] == 2 and current["overrides"] == {}


def test_explicit_default_accent_differs_from_inheritance(client):
    login(client, "You")
    client.post("/api/admin/look", json={"accent": 195})
    assert save(client, {"accent": None}).get_json()["look"]["accent"] is None
    assert save(client, {}, revision=1).get_json()["look"]["accent"] == 195


def test_preferences_persist_and_profile_delete_cascades(app, client):
    partner = login(client, "Partner")
    assert save(client, {"layout": "compact", "theme": "paper"}).status_code == 200
    other = app.test_client()
    login(other, "Partner")
    assert other.get("/api/personal-look").get_json()["overrides"] == {"layout": "compact", "theme": "paper"}
    login(client, "You")
    assert client.delete("/api/profiles/%d" % partner).status_code == 200
    assert app.hub.con().execute("SELECT 1 FROM personal_looks WHERE profile_id=?", (partner,)).fetchone() is None
    assert other.get("/api/personal-look").status_code == 401


def test_invalid_stored_styles_fall_back_safely(app, client):
    pid = login(client, "You")
    save(client, {"layout": "quiet"})
    con = app.hub.con()
    for document in ('not json', json.dumps({"layout": "quiet", "fonts": "https://untrusted.invalid"}), '[]'):
        con.execute("UPDATE personal_looks SET document=? WHERE profile_id=?", (document, pid))
        con.commit()
        state = client.get("/api/personal-look").get_json()
        assert state["overrides"] == {} and state["look"]["layout"] == "family"
    assert looks.for_profile(con, True)["layout"] == "family"
