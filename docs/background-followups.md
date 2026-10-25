# Background follow-ups

Background lives under **Assistant controls**. It uses the same account, workspace, polling controller and quick-chat state as the rest of Assistant. The Rust core owns every follow-up, dependency check, permission decision and budget; Family Hub displays its public state.

## Reading a follow-up

The compact card shows its status, host-owned reason, next useful time, remaining checks, expiry and available actions. **Scope, tools and limits** contains the instruction, the assistant's scheduling explanation, stopping condition, event trigger and required tools.

- **Waiting for connection** means a temporary availability problem. Waiting before queueing preserves the check budget and pending events.
- **Paused** means work needs attention or was deliberately paused. Restoring a permission or enabling a connection does not accept a new authority baseline automatically.
- A suspended check continues where it stopped. The disclosure explains its already-spent budget entry, retained event input and receipts. A last suspended check can resume with zero *new* checks remaining when core permits it.
- **Waiting for your permission** remains distinct from connection waiting. Existing exact-action approvals retain their own deadlines.
- If an approval's required tool becomes unavailable, its original arguments and deadline remain visible with a waiting explanation. Allow/Deny are unavailable until core reports `dependency_blocked=false`. Missing or malformed availability fails closed; recovery does not renew expiry. A racing conflict reloads current state without repeating the decision.
- An unresolved earlier action remains visible even when its containing job has a terminal label. Resume cannot clear an uncertain outcome.
- **Dependencies not recorded** identifies older follow-ups. They retain their existing scheduling and direct owner Resume behavior; the interface never invents a dependency list from their instructions.

The displayed scheduler recheck reads saved status. It does not reconnect an MCP service. Connection recovery and permission changes use the separate Connections and Permissions views; operator software/tool review stays on the assistant server.

## Reviewing a bound follow-up

For a newly bound follow-up, the owner selects **Review dependencies**. The current review shows required tools, availability, permission behavior, relevant changes, remaining budget and expiry. Only an eligible review offers **Resume follow-up**.

Resuming accepts the displayed compatible changes. It cannot grant a new permission, add checks, extend expiry, clear uncertainty or provide a verified current-request intent. A tool set to Ask or verified current request can still need its own exact-action approval later. Shared members may pause/cancel when core allows; only the owner may review/resume.

The review is kept in memory. A workspace, account, profile, view-context, revision, dependency-state or expiry change invalidates it. Polling never silently replaces a displayed review or accepts a new digest. If a control response is lost or rejected, the interface reloads current state and does not repeat the mutation automatically. A fresh bound Resume requires another displayed review and deliberate action.

## Bridge contract

The companion core specification is `docs/architecture/dependency-followup-contract.md` in the personal-assistant repository.

| Same-origin route | Behavior |
| --- | --- |
| `GET /api/assistant/state` | Public snapshot projection; follow-up state, limits, dependency lists and controls are strictly validated. Unknown metadata is omitted from public records. |
| `GET /api/assistant/responsibilities/{id}/resume-review?space_id={scope}` | Read-only current owner review for a bound follow-up. Captured scope occurs exactly once. |
| `POST /api/assistant/responsibilities/{id}` | Exact pause/cancel or legacy-resume body `{status,revision}`; bound resume additionally requires `dependency_review_digest`. |

All routes require direct Family profile sign-in, the captured `X-Assistant-Context` and a linked core account. Guests and admin-override sessions cannot use them. The bridge forwards only the configured core route and its server-held session; it does not forward arbitrary browser credentials, URLs, identity fields or tool configuration. Every projected approval must carry an actual JSON boolean `dependency_blocked`; integers and missing values are rejected.

The Python projection explicitly strips private baseline metadata from responsibilities, dependencies, current-job summaries and sibling snapshot records. A digest appears only in the owner review response. Invalid states, mismatched IDs/scopes, malformed nullable fields, duplicate or oversized dependency lists, inappropriate control flags and unsafe numbers fail closed. An invalid snapshot removes Background controls; a failed separate review leaves ordinary permission requests available.

Success requires exact HTTP 200 `{ok:true}`. Fixed errors are mapped to safe messages. An ambiguous response is not reported as success and is not retried automatically.

## Interface guarantees and limits

- Background, Memory and Activity clear old content synchronously when the workspace changes. Old detached controls and late responses cannot affect the new scope, including a later visit to the original workspace.
- Main and quick chat retain the same controller and drafts. Suspended job status is shown as waiting for dependencies instead of ordinary working status.
- Text is escaped. Existing theme tokens, expanded disclosures, keyboard focus and narrow layouts are retained. No new theme, gradient or external frontend dependency is introduced.
- These controls convey authenticated account evidence. They do not prove a physical human click while an unrestricted agent shares the same OS account. Production isolation remains a separate release requirement.

## Validation

Focused mocked tests cover strict projection and exact acknowledgement; bound and legacy controls; stale context, owner, scope and revision; temporary waiting versus approval; a last suspended check at zero remaining budget; expired/malformed reviews; lost response and conflict reconciliation; cross-tab invalidation; escaped text; focus; all four themes and a narrow viewport. Browser traffic is fully intercepted and no live account is used.

At the initial dependency-review milestone, the complete Family Python suite passed **222 tests**, including the previous 213 checks and nine new bridge/projection tests. The isolated browser suite passed **55 tests**, preserving all 42 existing checks and adding 13 dependency-review cases. These are historical milestone counts, not current repository totals. All 11 frozen public host fixtures passed projection. The four theme screenshots and 390-pixel layout were inspected; JavaScript syntax and `git diff --check` passed.

After the additive `dependency_blocked` approval field was introduced, **10 focused bridge tests** and **five approval browser tests** passed. These cover strict boolean projection, recovery with the same ID/deadline, expired waiting requests, detached and still-connected stale controls, and conflict reconciliation without replay. The waiting-approval card was also inspected visually. These targeted results followed the earlier baseline above; they are not a statement of the latest full-suite results.

This evidence uses mocked core HTTP. Core integration and scheduler/transaction guarantees require the companion Rust tests and explicit live integration; browser mocks do not establish them.
