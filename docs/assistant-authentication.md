# Assistant authentication boundary

Family Hub retains its existing profile login and permissions. The assistant core authenticates its own accounts and authorizes every assistant action. The first integration requires a direct Family Hub profile login and an explicit core account login. It does not treat a profile ID, administrator override or browser-supplied permission level as core authority.

## Sessions

`secure_sessions.py` replaces signed client-side session contents with an opaque random browser cookie and server-side SQLite records. The cookie is HttpOnly and SameSite Strict. Set `BOOKHUB_SECURE_COOKIES=true` behind HTTPS; the default supports the loopback development profile only.

Sessions expire after twelve hours. Login and assistant connection changes rotate the browser session ID. Logout removes the stored session. Credential or role changes invalidate it, including the credentials of an administrator who used the existing profile override feature. Revision-checked writes prevent an older in-flight request from restoring a logged-out session or overwriting newer session state.

Assistant use rejects guests and administrator override sessions. Direct sign-in to the person's own profile is required. This preserves the legacy book/media override without granting access to the person's assistant account.

### Views and shared browser cookies

Browser tabs share a session cookie. A chat opened before another tab signs in must not silently read or act as the new account. `/api/state` supplies `assistant_context`, a public, domain-separated digest of the current opaque session ID. It is not the stored cookie hash or an authentication credential. It changes whenever the session rotates.

Every `/api/assistant/` request requires that view's `X-Assistant-Context` header. The bridge compares it with the authenticated server session before returning account state or dispatching to the core. Missing or stale values receive HTTP 409 with `code: assistant_session_changed`. Login and logout responses provide their new `context` to the initiating view; a failed reconnect also supplies the context if it disconnected the previous account. Other tabs retain their previous binding until the user reloads.

Main and quick chat clear their transcripts, draft cache and selections when a session changes. A same-origin `BroadcastChannel` announces only that a login/logout occurred, so other tabs can clear promptly without exchanging account data. Server checks remain authoritative when that browser feature is unavailable or a notification is delayed. An in-flight operation already authorised and dispatched is not undone by a later account change.

## Core connection

Set `ASSISTANT_CORE_URL` to the fixed server address. HTTP is accepted only for loopback hosts. A remote address requires HTTPS. The bridge does not accept a URL from a chat message or tool call, and it forwards only its explicit route list. Redirects, environment proxies and implicit netrc authentication are disabled.

The browser submits a core login through the same-origin Family Hub endpoint. The bridge stores the returned core session in the server-side Family Hub session and returns only the account's safe display fields. It does not put the core token in browser storage, a readable cookie or a URL. Logout attempts to revoke the upstream session and removes the local connection even if the core is unavailable.

Disconnect, reconnect and Family profile changes return `core_revocation`: `confirmed` requires the core's exact successful acknowledgement; `unconfirmed` means the local connection was removed but remote revocation could not be established; `not_connected` means there was no current linked token. A timeout is not cancellation evidence. There is no durable retry queue in this version. A pending selected-mail request can remain eligible under its original core session until its bounded intent expires; independent authorized responsibilities have their own lifecycle.

Origin and Fetch Metadata checks reject cross-site browser mutations. API responses disable caching. These controls complement application authorization; they do not replace TLS, strong login or deployment-level access controls.

## Current limits

- Core tokens are trusted server data in the Family Hub SQLite database. Operating-system access to that database is sensitive. This is not an isolated credential vault.
- Failed disconnects or concurrent connection attempts can leave orphan upstream sessions until the core expires them. A later shared identity/session design must provide reliable global revocation.
- Existing profile PINs are not step-up authentication. Passkeys, enrollment, account recovery and stronger transaction confirmation remain core work.
- Revocation stops later authenticated requests; it cannot undo an operation already dispatched to another service.
- Existing SMTP/media credentials remain governed by their existing integrations. Connecting the assistant does not expose those credentials as tools.

`tests/test_auth_bridge.py` uses synthetic profiles and mocked core responses to cover session rotation, expiry, concurrent logout, credential and override revocation, profile isolation, guest denial, origin checks, endpoint validation, redirects, sanitized failures and safe login projection. Shared-cookie regressions check both Family profile switches and core account reconnects: stale views cannot read state, send shared-space messages, answer approvals, reconnect or log out the newer account. A public context cannot authenticate as a cookie. These tests do not connect a real account.
