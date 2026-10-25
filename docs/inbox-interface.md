# Inbox interface

Family Hub presents mail held by the assistant service. The Inbox destination uses the existing authenticated same-origin bridge; it does not own mailbox credentials, run mail tools or decide agent permissions.

The current preview contains synthetic Gmail and Outlook mailboxes. It supports multiple inboxes, private and shared workspaces, search, an importance filter, plain-text reading, attachment filing status and local draft inspection. It does not connect real mail providers, send messages, edit drafts or download attachments from this view. A saved attachment means that the assistant snapshot contains a matching asset in the same workspace, for the same message and attachment.

## Identity and lifecycle

Each view captures the signed-in Family profile's opaque assistant context. Both the initial status request and subsequent state requests send `X-Assistant-Context`; the bridge verifies this context before forwarding to core. Core supplies the authorized snapshot. The view filters within those returned workspaces and cannot add access to another workspace.

Message contents stay in memory. Navigating away releases the view. Profile/account changes, cross-tab session notices and authentication failures clear the view and invalidate in-flight requests. A changed core subject cannot replace the old subject's view in place. A request completed after navigation or identity change is discarded. Administrator impersonation and guest sessions cannot open Inbox.

The page refreshes every ten seconds while visible. A temporary transport failure retains the last authorized view with a stale-data notice. It does not convert that cached data into authority for a write. Search text, keyboard focus and selection are retained across refreshes where the selected message still belongs to the filtered view. Workspace/mailbox changes clear the reader immediately. Message text is rendered with `textContent`; HTML, attachment names and sender text are never executed.

## Selected-email local draft

Selecting a message fetches `/api/assistant/mail/{message_id}/draft-intent`. The reader displays that authoritative sender, address, subject, mailbox, time and plain-text body. Its opaque source digest belongs to that exact display, never the older snapshot body. The **Draft reply** control is enabled only for an eligible current preview; core checks permissions again at admission and dispatch.

- A deliberate click sends only a fresh request UUID and the displayed source digest to the fixed `draft-runs` route. It does not send a conversation, actor, tool, grant or arbitrary arguments.
- Core atomically creates the bounded job and its dedicated conversation. A matching current-task grant can run it; confirm mode waits for the ordinary exact Chat approval. Manual/denied modes remain blocked. The action creates one **local draft only**, without sending or touching a mail provider.
- The UI shows queued/running/waiting/terminal state using actor-scoped status lookup. Conversation links use the host-returned conversation ID. **View local draft** selects the exact returned draft ID after a fresh authorized snapshot; a newer unrelated draft cannot substitute.
- An ambiguous response triggers status lookup for the original UUID. A deliberate transport retry, offered only after a missing result, replays the same UUID/digest. It never automatically mints a new request. An uncertain outcome prohibits a replacement request.
- A known terminal outcome or definite rejection offers a separate **Review message for a new request** action. This loads a fresh preview; a subsequent deliberate Draft reply click is a new request.

Refresh recovery stores at most 20 request references in this tab's `sessionStorage`. Unresolved references do not expire by age and are never evicted to make room: reaching capacity blocks a fresh admission with a reconciliation notice. Loading may prune references older than 24 hours only after a validated known terminal result. A confirmed terminal request can also release its reference through deliberate review for a new request.

The record contains message/workspace IDs, request UUID, source digest, creation time and a small settled-state hint, bound to the exact opaque Family context and core owner. It contains no mail body, draft text, token or internal intent descriptor. Returning to the same still-visible message performs read-only status lookup; private identity changes clear the cache. Malformed rows are discarded individually, duplicate references are bounded, and future timestamps are rejected. If browser storage is unavailable, the UI explicitly limits recovery to the open view. This reference cache is not authorization and does not extend core expiry.

The originating core session, current grant and a maximum 15-minute bound constrain new execution. This slice is authenticated application-request evidence, not proof of a physical human click. The same-account development processes do not isolate agent access from human sessions. Family profile expiry/role changes do not yet propagate global revocation to already-admitted core work.

Family and Assistant sign-out/reconnection show a persistent, dismissible notice when upstream revocation is **unconfirmed**. Local connection removal is not proof of core cancellation; an already accepted bounded draft may still run until its original expiry. There is no durable disconnection retry and no claim that all background jobs stop. Existing general chat remains unchanged: free text cannot create this structured authority.

Real provider connections require OAuth brokerage and scoped ingestion in core. Serving an attachment requires an authenticated same-origin binary route with core scope checks and safe content headers. Do not expose the core session cookie, cross-port asset URLs or arbitrary server fetch URLs to the browser as a shortcut.

## Verification

The application still has no JavaScript build step. `package.json` provides only development test dependencies. With Node 20 or newer:

```text
npm ci --ignore-scripts
npm run test:ui
```

On Windows the tests use installed Edge. On Linux, install the test browser once with `npx playwright install --with-deps chromium`. `INBOX_TEST_BROWSER_CHANNEL` can select another installed Playwright-compatible channel. Each test uses a fresh browser context and intercepts every request against a reserved `.invalid` hostname; it neither starts nor accesses a live Family Hub server.

The regression suite exercises workspace/mailbox filters, plain-text rendering, delayed requests, account changes, logout, authentication failures, keyboard focus and a narrow viewport. Selected-mail tests additionally cover authoritative preview/digest binding, duplicate clicks, ambiguous POST reconciliation, same-reference retry, reload recovery, uncertain outcomes, exact draft/conversation correlation and shared scope. They exercise the real plain-JavaScript controller against fully mocked API responses; core execution remains separately verified.

An earlier independent manual check covered the four existing colour schemes and the Family, Quiet and Compact layouts with a custom accent. The demo profile's Quiet dark appearance was restored afterward. Selected-mail UI checks do not start or modify that live demo.
