"""Independent adversarial checks for the local first-party sign-in bridge."""
import hashlib
import json
import sqlite3

from flask import request

from test_app import app, client, login  # noqa: F401
from test_single_sign_in import bind_context, linked  # noqa: F401
from bookhub import secure_sessions


def session_rows(app):
    with sqlite3.connect(app.hub.config.db_path) as con:
        return {row[0]: json.loads(row[1]) for row in con.execute(
            'SELECT token_hash,document FROM web_sessions')}


def test_role_retirement_uses_locked_current_role_not_stale_profile(app, client, linked, monkeypatch):
    _, profiles = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    target = profiles['Nan']['id']
    promoted = app.test_client()
    original = app.hub.profile
    raced = []

    def concurrent_promotion(profile_id):
        row = original(profile_id)
        if (profile_id == target and request.method == 'PATCH'
                and request.path == '/api/profiles/' + str(target) and not raced):
            raced.append(True)
            assert row['role'] == 'member'
            # Another completed writer promoted this profile after this request
            # read its initial snapshot, and a new browser signed in afterward.
            with sqlite3.connect(app.hub.config.db_path) as con:
                con.row_factory = sqlite3.Row
                con.execute("UPDATE profiles SET role='admin' WHERE id=?", (target,))
                secure_sessions.retire_profile_sessions(con, target)
            assert login(promoted, 'Nan').status_code == 200
        return row

    monkeypatch.setattr(app.hub, 'profile', concurrent_promotion)
    response = client.patch('/api/profiles/' + str(target), json={'role': 'member'})
    assert response.status_code == 200
    assert raced == [True]
    parent_hash = hashlib.sha256(promoted.get_cookie('bookhub').value.encode()).hexdigest()
    # This must be durable before the retired browser makes another request.
    assert parent_hash not in session_rows(app)
    assert promoted.get('/api/state').get_json()['me'] is None


def test_linked_admin_pin_override_stays_limited_to_unlinked_family_profile(client, linked):
    control, profiles = linked
    response = client.post('/api/login', json={
        'profile_id': profiles['Nan']['id'], 'admin_id': profiles['Matt']['id'],
        'admin_passcode': '1234'})
    assert response.status_code == 200
    state = bind_context(client)
    assert state['me']['name'] == 'Nan' and state['me']['via_admin'] is True
    assert client.get('/api/assistant/status').status_code == 403
    assert client.post('/api/assistant/login', json={
        'login': 'matt', 'password': 'demo-matt'}).status_code == 403
    assert client.post('/api/login', json={
        'profile_id': profiles['Nicky']['id'], 'admin_id': profiles['Matt']['id'],
        'admin_passcode': '1234'}).status_code == 403
    assert control['calls'] == []


def test_slow_switch_cannot_replace_newer_browser_login(app, client, linked):
    control, _ = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    newer = app.test_client()
    newer.set_cookie('bookhub', client.get_cookie('bookhub').value)
    captured = []

    def competing_login():
        control['during'] = None
        response = login(newer, 'Matt', 'demo-matt')
        assert response.status_code == 200
        captured.append(newer.get_cookie('bookhub').value)

    control['during'] = competing_login
    response = login(client, 'Nicky', 'demo-nicky')
    assert response.status_code == 409 and 'Set-Cookie' not in response.headers
    rows = session_rows(app)
    assert set(rows) == {hashlib.sha256(captured[0].encode()).hexdigest()}
    assert next(iter(rows.values()))['assistant_user']['id'] == 'user-matt'
    assert newer.get('/api/state').get_json()['me']['name'] == 'Matt'
    assert client.get('/api/state').get_json()['me'] is None


def test_authenticator_role_change_retires_legacy_override_parent(app, client, linked):
    _, profiles = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    override = app.test_client()
    assert override.post('/api/login', json={
        'profile_id': profiles['Nan']['id'], 'admin_id': profiles['Matt']['id'],
        'admin_passcode': '1234'}).status_code == 200
    parent_hash = hashlib.sha256(override.get_cookie('bookhub').value.encode()).hexdigest()
    assert parent_hash in session_rows(app)
    # Preserve another administrator so demoting Matt is a permitted edit.
    assert client.patch('/api/profiles/' + str(profiles['Nan']['id']),
                        json={'role': 'admin'}).status_code == 200
    # The preceding target-role edit already retires this Nan parent. Create a
    # fresh override to isolate retirement through its authenticator reference.
    assert override.post('/api/login', json={
        'profile_id': profiles['Nan']['id'], 'admin_id': profiles['Matt']['id'],
        'admin_passcode': '1234'}).status_code == 200
    parent_hash = hashlib.sha256(override.get_cookie('bookhub').value.encode()).hexdigest()
    assert parent_hash in session_rows(app)
    assert client.patch('/api/profiles/' + str(profiles['Matt']['id']),
                        json={'role': 'member'}).status_code == 200
    assert parent_hash not in session_rows(app)
    assert override.get('/api/state').get_json()['me'] is None
