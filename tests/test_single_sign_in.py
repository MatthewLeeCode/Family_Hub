"""One first-party credential, explicit identity links, and inert orphan sessions."""
import copy
import hashlib
import json
import sqlite3
import time

import pytest
import requests

from test_app import app, client, login  # noqa: F401
from bookhub import assistant_identity, secure_sessions


@pytest.fixture
def linked(app, tmp_path, monkeypatch):
    with app.app_context():
        profiles = {p['name']: dict(p) for p in app.hub.profiles()}
        binding_rows = [{'profile_id': profiles[name]['id'], 'binding_id': 'profile-' + name.lower(),
                         'core_user_id': user, 'profile_stamp': secure_sessions.profile_stamp(profiles[name])}
                        for name, user in [('Matt', 'user-matt'), ('Nicky', 'user-alex')]]
        document = {'version': 1, 'instance_id': app.extensions['assistant_identity']['instance_id'], 'bindings': binding_rows}
        path = tmp_path / 'identity-bindings.json'
        path.write_text(json.dumps(document), encoding='utf-8')
        app.hub.config.assistant_identity_bindings = path
        assistant_identity.install(app)
    control = {'calls': [], 'during': None, 'status': 200, 'exception': None, 'payload_change': None}

    def exchange(transport, method, url, **kwargs):
        assert transport.trust_env is False
        assert kwargs.get('allow_redirects') is False
        control['calls'].append((method, url, copy.deepcopy(kwargs)))
        if control['exception']:
            raise control['exception']
        response = requests.Response()
        response.status_code = control['status']
        response.headers['Content-Type'] = 'application/json'
        if url.endswith('/family/login'):
            body = kwargs['json']
            assert set(body) == {'binding_id', 'password', 'parent_session_hash', 'parent_expires_at'}
            assert kwargs['headers'] == {'X-Household-Request': '1'}
            assert len(body['parent_session_hash']) == 64
            with sqlite3.connect(app.hub.config.db_path) as con:
                assert con.execute('SELECT COUNT(*) FROM web_sessions WHERE token_hash=?', (body['parent_session_hash'],)).fetchone()[0] == 0
            nicky = body['binding_id'] == 'profile-nicky'
            token = ('b' if nicky else 'a') * 64
            payload = {'id': 'user-alex' if nicky else 'user-matt', 'login': 'nicky' if nicky else 'matt',
                       'name': 'Nicky' if nicky else 'Matt', 'private_space': 'space-alex' if nicky else 'space-matt',
                       'expires_at': body['parent_expires_at']}
            if control['payload_change']:
                control['payload_change'](payload)
            response.cookies.set('household_session', token)
            if control['during']:
                control['during']()
        else:
            assert url.endswith('/logout')
            payload = {'ok': True}
        response._content = json.dumps(payload).encode()
        return response

    monkeypatch.setattr(requests.Session, 'request', exchange)
    return control, profiles


def bind_context(client):
    state = client.get('/api/state').get_json()
    client.environ_base['HTTP_X_ASSISTANT_CONTEXT'] = state.get('assistant_context') or ''
    return state


def test_one_password_installs_exact_parent_without_exposing_core_token(app, client, linked):
    control, _ = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    state = bind_context(client)
    assert state['me']['name'] == 'Matt'
    assert next(p for p in state['profiles'] if p['name'] == 'Matt')['sign_in_method'] == 'account'
    response = client.get('/api/assistant/status')
    assert response.get_json()['signed_in'] is True
    assert response.get_json()['sign_in_mode'] == 'family'
    assert response.get_json()['user']['id'] == 'user-matt'
    assert 'a' * 64 not in response.get_data(as_text=True)
    request_body = control['calls'][0][2]['json']
    with app.app_context():
        row = app.hub.con().execute('SELECT document,expires_at FROM web_sessions WHERE token_hash=?', (request_body['parent_session_hash'],)).fetchone()
        parent = json.loads(row['document'])
        assert parent['assistant_token'] == 'a' * 64
        assert parent['authentication_method'] == 'core'
        assert parent['assistant_binding_id'] == 'profile-matt'
        assert parent['via_admin'] is False
        assert row['expires_at'] * 1000 == request_body['parent_expires_at']
        assert 'demo-matt' not in row['document']
    calls = len(control['calls'])
    assert client.get('/api/assistant/status').status_code == 200
    assert client.post('/api/assistant/login', json={'login': 'nicky', 'password': 'x'}).status_code == 403
    assert len(control['calls']) == calls


def test_accounts_and_unlinked_profiles_do_not_share_children(app, client, linked):
    control, _ = linked
    other = app.test_client()
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    assert login(other, 'Nicky', 'demo-nicky').status_code == 200
    bind_context(client); bind_context(other)
    assert client.get('/api/assistant/status').get_json()['user']['id'] == 'user-matt'
    assert other.get('/api/assistant/status').get_json()['user']['id'] == 'user-alex'
    nan = app.test_client()
    calls = len(control['calls'])
    assert login(nan, 'Nan').status_code == 200
    bind_context(nan)
    assert nan.get('/api/assistant/status').get_json()['linked'] is False
    assert len(control['calls']) == calls


def test_linked_profiles_cannot_fall_back_to_pin_or_admin_override(client, linked):
    control, profiles = linked
    control['status'] = 401
    assert login(client, 'Matt', '1234').status_code == 403
    count = len(control['calls'])
    assert client.post('/api/login', json={'profile_id': profiles['Nicky']['id'], 'admin_id': profiles['Matt']['id'], 'admin_passcode': '1234'}).status_code == 403
    assert client.post('/api/login', json={'profile_id': profiles['Matt']['id']}).status_code == 403
    assert len(control['calls']) == count
    assert client.get('/api/state').get_json()['me'] is None


def test_core_outage_does_not_revoke_existing_family_identity(client, linked):
    control, _ = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    control['exception'] = requests.Timeout('synthetic transport details')
    response = login(client, 'Nicky', 'demo-nicky')
    assert response.status_code == 503
    assert 'synthetic transport' not in response.get_data(as_text=True)
    assert client.get('/api/state').get_json()['me']['name'] == 'Matt'


@pytest.mark.parametrize('change', [lambda p: p.update(id='user-other'), lambda p: p.update(expires_at=0), lambda p: p.update(extra='private')])
def test_invalid_core_response_never_creates_family_parent(client, linked, change):
    control, _ = linked
    control['payload_change'] = change
    assert login(client, 'Matt', 'demo-matt').status_code == 502
    assert client.get('/api/state').get_json()['me'] is None


def test_profile_change_during_exchange_leaves_orphan_inert(app, client, linked):
    control, profiles = linked
    def revoke():
        with sqlite3.connect(app.hub.config.db_path) as con:
            con.execute("UPDATE profiles SET passcode_hash='changed' WHERE id=?", (profiles['Matt']['id'],))
    control['during'] = revoke
    response = login(client, 'Matt', 'demo-matt')
    assert response.status_code == 409
    assert 'Set-Cookie' not in response.headers
    with sqlite3.connect(app.hub.config.db_path) as con:
        assert con.execute('SELECT COUNT(*) FROM web_sessions').fetchone()[0] == 0


def test_logout_during_exchange_cannot_restore_retired_parent(app, client, linked):
    control, _ = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    def revoke():
        with sqlite3.connect(app.hub.config.db_path) as con:
            con.execute('DELETE FROM web_sessions')
    control['during'] = revoke
    response = login(client, 'Nicky', 'demo-nicky')
    assert response.status_code == 409
    assert 'Set-Cookie' not in response.headers
    assert client.get('/api/state').get_json()['me'] is None


def test_role_revoke_restore_cannot_revive_old_parent(app, client, linked):
    _, profiles = linked
    other = app.test_client()
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    assert login(other, 'Nicky', 'demo-nicky').status_code == 200
    cookie = other.get_cookie('bookhub').value
    pid = profiles['Nicky']['id']
    assert client.patch('/api/profiles/' + str(pid), json={'role': 'admin'}).status_code == 200
    assert client.patch('/api/profiles/' + str(pid), json={'role': 'member'}).status_code == 200
    assert other.get('/api/state').get_json()['me'] is None
    with sqlite3.connect(app.hub.config.db_path) as con:
        assert con.execute('SELECT COUNT(*) FROM web_sessions WHERE token_hash=?', (hashlib.sha256(cookie.encode()).hexdigest(),)).fetchone()[0] == 0


def test_bound_login_lockout_counts_before_network(client, linked):
    control, _ = linked
    control['status'] = 401
    for _ in range(5):
        assert login(client, 'Matt', 'wrong').status_code == 403
    calls = len(control['calls'])
    assert login(client, 'Matt', 'demo-matt').status_code == 429
    assert len(control['calls']) == calls


def test_final_session_cas_rejects_login_losing_after_initial_validation(app, client, linked, monkeypatch):
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    original = secure_sessions.current_session_unchanged
    def lose_race():
        assert original() is True
        with sqlite3.connect(app.hub.config.db_path) as con:
            con.execute('DELETE FROM web_sessions')
        return True
    monkeypatch.setattr(secure_sessions, 'current_session_unchanged', lose_race)
    response = login(client, 'Nicky', 'demo-nicky')
    assert response.status_code == 409
    assert 'Set-Cookie' not in response.headers
    assert client.get('/api/state').get_json()['me'] is None
    with sqlite3.connect(app.hub.config.db_path) as con:
        assert con.execute('SELECT COUNT(*) FROM web_sessions').fetchone()[0] == 0


def test_removing_linked_profile_password_never_enables_passwordless_fallback(app, client, linked):
    control, profiles = linked
    with sqlite3.connect(app.hub.config.db_path) as con:
        con.execute('UPDATE profiles SET passcode_hash=NULL WHERE id=?', (profiles['Matt']['id'],))
    assert login(client, 'Matt', 'demo-matt').status_code == 403
    assert control['calls'] == []
    assert client.get('/api/state').get_json()['me'] is None


def test_logout_retires_parent_even_when_core_cannot_acknowledge(app, client, linked):
    control, _ = linked
    assert login(client, 'Matt', 'demo-matt').status_code == 200
    control['exception'] = requests.Timeout('offline')
    response = client.post('/api/logout')
    assert response.status_code == 200 and response.get_json()['core_revocation'] == 'unconfirmed'
    with sqlite3.connect(app.hub.config.db_path) as con:
        assert con.execute('SELECT COUNT(*) FROM web_sessions').fetchone()[0] == 0
    assert client.get('/api/state').get_json()['me'] is None
