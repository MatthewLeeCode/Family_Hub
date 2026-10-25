# Assistant authentication boundary

Family Hub can use one sign-in for explicitly enrolled local profiles. The Rust core verifies the account password; Family holds the resulting token in its server-side session. Core still authorizes every assistant action. A profile ID, administrator override or browser-supplied permission level does not confer core authority.

Without `ASSISTANT_IDENTITY_BINDINGS`, the earlier two-login integration remains available. Unlinked profiles retain their Family PIN behavior, but cannot connect an assistant account when single sign-in is configured.

## Local enrollment

1. Start Family once so it creates its persistent `assistant_installation` UUID, then stop Family and core. Back up both stores.
2. Run the core's offline `assistantd family-auth enroll` command for each intended profile. Supply `--data-dir`, `--family-profiles-db`, `--binding-id`, `--profile-id`, `--core-user-id` and `--core-login`. Existing conflicting bindings and a running core are rejected. Repeating an identical enrollment is safe.
3. Copy the returned public binding fields into an operator-owned JSON file. Keep one matching installation UUID and omit the returned core login from each file entry:

```json
{
  "version": 1,
  "instance_id": "<returned installation UUID>",
  "bindings": [{
    "profile_id": 1,
    "binding_id": "profile-matt",
    "core_user_id": "user-matt",
    "profile_stamp": "<returned credential/role stamp>"
  }]
}
```

4. Start core with `--family-profiles-db` pointing to that exact local Family SQLite file. Set Family's `ASSISTANT_IDENTITY_BINDINGS` to the JSON file and start Family.
5. Select the enrolled profile and enter its core account password. Its former PIN and administrator override are not fallback credentials. Existing incompatible Family sessions require a new sign-in.

Names do not select the account. Nicky's existing immutable core identity remains `user-alex`; her canonical login is `nicky`. Preserve PIN hashes when enrolling so existing Notes bindings remain valid. A changed role or PIN makes the link stale while its stamp differs. Restoring the original role permits a fresh password login, but never revives deleted parents. There is no automatic relinking or credential recovery in this version.

This adapter requires both services to access the same trusted local Family database. It is a development integration, not a remote identity protocol or a credential vault.

## Sessions

`secure_sessions.py` replaces signed client-side session contents with an opaque random browser cookie and server-side SQLite records. The cookie is HttpOnly and SameSite Strict. Set `BOOKHUB_SECURE_COOKIES=true` behind HTTPS; the default supports the loopback development profile only.

Sessions expire after twelve hours. Login and legacy assistant connection changes rotate the browser session ID. Logout removes the stored session. Credential or role changes delete affected parent sessions in the same transaction, including administrator override sessions. Changing a value back does not restore those sessions. Revision-checked writes prevent an older in-flight request from restoring a logged-out row or overwriting newer session state.

For an enrolled profile:

- Family selects the parent session ID before asking core to verify the password.
- The child token cannot authenticate until that exact parent row has committed with its matching token, account, profile stamp and deadline.
- Core checks a fresh, consistent, read-only parent snapshot on authentication. Selected-mail authority and sensitive gateway mutations check again at their admission boundary.
- Missing, expired or replaced parents fail closed. Losing the Family save race leaves an inert child and returns a failed sign-in, without replacing the browser cookie.
- No password is retained, and there is no refresh token or silent credential retry.

Assistant use rejects guests and administrator override sessions. Direct sign-in to the person's own profile is required. This preserves the legacy book/media override without granting access to the person's assistant account.

### Views and shared browser cookies

Browser tabs share a session cookie. A chat opened before another tab signs in must not silently read or act as the new account. `/api/state` supplies `assistant_context`, a public, domain-separated digest of the current opaque session ID. It is not the stored cookie hash or an authentication credential. It changes whenever the session rotates.

Every `/api/assistant/` request requires that view's `X-Assistant-Context` header. The bridge compares it with the authenticated server session before returning account state or dispatching to core. Missing or stale values receive HTTP 409 with `code: assistant_session_changed`. Legacy assistant login/logout responses provide the new `context`; a failed reconnect also supplies it if it disconnected the previous account. The primary `/api/login` flow refreshes `/api/state` after success. Other tabs retain their previous binding until the user reloads.

Main and quick chat clear their transcripts, draft cache and selections when a session changes. A same-origin `BroadcastChannel` announces only that a login/logout occurred, so other tabs can clear promptly without exchanging account data. Server checks remain authoritative when that browser feature is unavailable or a notification is delayed. An in-flight operation already authorised and dispatched is not undone by a later account change.

## Core connection

Set `ASSISTANT_CORE_URL` to the fixed server address. HTTP is accepted only for loopback hosts. A remote address requires HTTPS. The bridge does not accept a URL from a chat message or tool call, and it forwards only its explicit route list. Redirects, environment proxies and implicit netrc authentication are disabled.

For enrolled profiles, the browser submits its password through the ordinary same-origin Family login. Family resolves the explicit binding and calls core's dedicated `/api/family/login`; it verifies the returned immutable account before saving the parent. The second assistant login is disabled. Legacy installations retain their manual connection flow.

The bridge returns only safe account fields. It does not put the core token in browser storage, a readable cookie or a URL. Logout attempts core revocation and removes the local parent even when core is unavailable.

Disconnect, reconnect and profile changes return `core_revocation`: `confirmed` requires core's exact acknowledgement; `unconfirmed` records an unacknowledged remote result; `not_connected` means there was no token. There is no durable retry queue. For enrolled child sessions, deletion of the parent independently rejects future fresh core validation, including current-task mail work. Legacy ordinary tokens may remain eligible until expiry when remote revocation fails. Autonomous responsibilities keep their own standing grants and lifecycle.

Origin and Fetch Metadata checks reject cross-site browser mutations. API responses disable caching. These controls complement application authorization; they do not replace TLS, strong login or deployment-level access controls.

## Current limits

- Core tokens are trusted server data in the Family Hub SQLite database. Operating-system access to that database is sensitive. This is not an isolated credential vault.
- Orphan enrolled child rows remain inert until expiry. Legacy manual connections do not have the live parent relationship.
- Parent snapshot reads define admission; an operation admitted before a later independent Family write may finish. This is not a cross-database transaction or a promise that logout undoes effects.
- Core outage prevents a new enrolled sign-in. There is no PIN fallback or offline password cache.
- Existing profile PINs are not step-up authentication. Passkeys, enrollment, account recovery and stronger transaction confirmation remain core work.
- Revocation stops later authenticated requests; it cannot undo an operation already dispatched to another service.
- Existing SMTP/media credentials remain governed by their existing integrations. Connecting the assistant does not expose those credentials as tools.

`tests/test_auth_bridge.py` uses synthetic profiles and mocked core responses to cover session rotation, expiry, concurrent logout, credential and override revocation, profile isolation, guest denial, origin checks, endpoint validation, redirects, sanitized failures and safe login projection. Shared-cookie regressions check both Family profile switches and core account reconnects: stale views cannot read state, send shared-space messages, answer approvals, reconnect or log out the newer account. A public context cannot authenticate as a cookie. These tests do not connect a real account.

`tests/test_single_sign_in.py` adds exact-parent commits, malformed responses, no PIN/override fallback, lockout, delayed exchanges, lost revision races, offline logout and role-change/restore tests. Core independently tests committed WAL revocation, queued authority, selected-mail dispatch, restart and missing adapters. Its real HTTP test also exercises both accounts and the offline enrollment CLI.
