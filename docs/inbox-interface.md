# Inbox interface

Family Hub presents mail held by the assistant service. The Inbox destination uses the existing authenticated same-origin bridge; it does not own mailbox credentials, run mail tools or decide agent permissions.

The current preview contains synthetic Gmail and Outlook mailboxes. It supports multiple inboxes, private and shared workspaces, search, an importance filter, plain-text reading, attachment filing status and local draft inspection. It does not connect real mail providers, send messages, edit drafts or download attachments from this view. A saved attachment means that the assistant snapshot contains a matching asset in the same workspace, for the same message and attachment.

## Identity and lifecycle

Each view captures the signed-in Family profile's opaque assistant context. Both the initial status request and subsequent state requests send `X-Assistant-Context`; the bridge verifies this context before forwarding to core. Core supplies the authorized snapshot. The view filters within those returned workspaces and cannot add access to another workspace.

Inbox data stays in memory. Navigating away releases the view. Profile/account changes, cross-tab session notices and authentication failures clear the view and invalidate in-flight requests. A changed core subject cannot replace the old subject's view in place. A request completed after navigation or identity change is discarded. Administrator impersonation and guest sessions cannot open Inbox.

The page refreshes every ten seconds while visible. A temporary transport failure retains the last authorized view with a stale-data notice. It does not convert that cached data into authority for a write. Search text, keyboard focus and selection are retained across refreshes where the selected message still belongs to the filtered view. Workspace/mailbox changes clear the reader immediately. Message text is rendered with `textContent`; HTML, attachment names and sender text are never executed.

## Next action slice

The future “Draft a reply” control must submit the selected source message to a dedicated authenticated intent route. It must not simply send prose to chat and infer authority from that prose. The core plan specifies source binding, a persisted capability ceiling, grant revision, session freshness, one-use consumption and recovery. Until that route is implemented and tested, Inbox remains read-only.

Real provider connections require OAuth brokerage and scoped ingestion in core. Serving an attachment requires an authenticated same-origin binary route with core scope checks and safe content headers. Do not expose the core session cookie, cross-port asset URLs or arbitrary server fetch URLs to the browser as a shortcut.

## Verification

The application still has no JavaScript build step. `package.json` provides only development test dependencies. With Node 20 or newer:

```text
npm ci --ignore-scripts
npm run test:ui
```

On Windows the tests use installed Edge. On Linux, install the test browser once with `npx playwright install --with-deps chromium`. `INBOX_TEST_BROWSER_CHANNEL` can select another installed Playwright-compatible channel. Each test uses a fresh browser context and intercepts every request against a reserved `.invalid` hostname; it neither starts nor accesses a live Family Hub server.

The regression suite exercises workspace/mailbox filters, plain-text rendering, delayed requests, account changes, logout, authentication failures, keyboard focus and a narrow viewport. An independent manual check covered the four existing colour schemes and the Family, Quiet and Compact layouts with a custom accent. The demo profile's Quiet dark appearance was restored afterward.
