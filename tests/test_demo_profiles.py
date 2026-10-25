"""Synthetic offline rename checks. Never operate on a running demo directory."""
import sqlite3

import pytest
from werkzeug.security import check_password_hash

from test_app import app, client, login  # noqa: F401
from bookhub import demo, kosync, secure_sessions
from bookhub.demo_profiles import DemoProfileError, rename_demo_profiles


def root(app):
    return app.hub.config.data_dir.parent


def profiles(app):
    return [dict(row) for row in app.hub.con().execute("SELECT * FROM profiles ORDER BY id")]


def legacy(app):
    app.hub.con().executemany("UPDATE profiles SET name=? WHERE id=?", [("You", 1), ("Partner", 2)])
    app.hub.con().commit()


def other_tables(app):
    con = app.hub.con()
    names = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('profiles','web_sessions') ORDER BY name")]
    return {name: [tuple(row) for row in con.execute('SELECT * FROM "' + name.replace('"', '""') + '"')] for name in names}


def test_fresh_demo_names_preserve_ids_roles_pin_and_history(app, client):
    rows = profiles(app)
    assert [(row["id"], row["name"], row["role"]) for row in rows] == [(1, "Matt", "admin"), (2, "Nicky", "admin"), (3, "Nan", "member")]
    assert [row["color"] for row in rows] == ["#F0B04A", "#7FB2E5", "#9BD1A8"]
    assert all(check_password_hash(row["passcode_hash"], "1234") for row in rows)
    assert all(row["sync_key"] == kosync.sync_key_for("demo") for row in rows)
    for name in ("Matt", "Nicky", "Nan"):
        assert login(client, name).status_code == 200
    assert len(app.hub.con().execute("SELECT * FROM reading WHERE profile_id=2").fetchall()) > 0
    before = profiles(app), other_tables(app)
    demo.seed(app.hub)
    assert (profiles(app), other_tables(app)) == before


def test_offline_rename_preserves_profile_payloads_stamps_and_other_tables(app, client):
    legacy(app)
    assert login(client, "You").status_code == 200
    rows = profiles(app)
    stamps = [secure_sessions.profile_stamp(row) for row in rows]
    payloads = [{key: value for key, value in row.items() if key != "name"} for row in rows]
    others = other_tables(app)
    sessions = app.hub.con().execute("SELECT COUNT(*) FROM web_sessions").fetchone()[0]
    assert sessions > 0
    result = rename_demo_profiles(root(app), services_stopped=True)
    assert result == {"status": "applied", "renamed_profiles": 2, "cleared_web_sessions": sessions}
    renamed = profiles(app)
    assert [row["name"] for row in renamed] == ["Matt", "Nicky", "Nan"]
    assert [{key: value for key, value in row.items() if key != "name"} for row in renamed] == payloads
    assert [secure_sessions.profile_stamp(row) for row in renamed] == stamps
    assert other_tables(app) == others
    assert client.get("/api/state").json["me"] is None
    assert client.get("/kosync/users/auth", headers={"x-auth-user": "You", "x-auth-key": kosync.sync_key_for("demo")}).status_code == 401
    assert client.get("/kosync/users/auth", headers={"x-auth-user": "Matt", "x-auth-key": kosync.sync_key_for("demo")}).status_code == 200
    assert login(client, "Matt").status_code == 200
    retained_sessions = [tuple(row) for row in app.hub.con().execute("SELECT * FROM web_sessions")]
    assert rename_demo_profiles(root(app), services_stopped=True) == {"status": "already_current", "renamed_profiles": 0, "cleared_web_sessions": 0}
    assert [tuple(row) for row in app.hub.con().execute("SELECT * FROM web_sessions")] == retained_sessions
    assert client.get("/api/state").json["me"]["name"] == "Matt"


def test_existing_seed_never_auto_renames_and_partial_expected_rename_is_safe(app):
    legacy(app)
    before = profiles(app)
    demo.seed(app.hub)
    assert profiles(app) == before
    app.hub.con().execute("UPDATE profiles SET name='Matt' WHERE id=1")
    app.hub.con().commit()
    result = rename_demo_profiles(root(app), services_stopped=True)
    assert result["renamed_profiles"] == 1
    assert [row["name"] for row in profiles(app)] == ["Matt", "Nicky", "Nan"]


@pytest.mark.parametrize("change", ["UPDATE profiles SET name='Custom' WHERE id=1",
                                   "UPDATE profiles SET role='member' WHERE id=2",
                                   "UPDATE profiles SET name='nIcKy' WHERE id=3",
                                   "DELETE FROM profiles WHERE id=2"])
def test_custom_missing_or_conflicting_profiles_are_refused_atomically(app, change):
    legacy(app)
    app.hub.con().execute(change)
    app.hub.con().commit()
    before = profiles(app), other_tables(app)
    with pytest.raises(DemoProfileError):
        rename_demo_profiles(root(app), services_stopped=True)
    assert (profiles(app), other_tables(app)) == before


def test_requires_offline_ack_and_original_sample_library_proof(app):
    legacy(app)
    before = profiles(app)
    with pytest.raises(DemoProfileError):
        rename_demo_profiles(root(app))
    library = sqlite3.connect(root(app) / "library" / "metadata.db")
    library.execute("UPDATE comments SET text='A customized real library' WHERE book=1")
    library.commit()
    library.close()
    with pytest.raises(DemoProfileError):
        rename_demo_profiles(root(app), services_stopped=True)
    assert profiles(app) == before


def test_missing_session_schema_refuses_before_names_change(app):
    legacy(app)
    before = profiles(app)
    app.hub.con().execute("DROP TABLE web_sessions")
    app.hub.con().commit()
    with pytest.raises(sqlite3.Error):
        rename_demo_profiles(root(app), services_stopped=True)
    assert profiles(app) == before


def test_missing_demo_directory_never_creates_a_database(tmp_path):
    missing = tmp_path / "not-a-demo"
    with pytest.raises(OSError):
        rename_demo_profiles(missing, services_stopped=True)
    assert not missing.exists()
