# Notes interface

**Notes** opens in Family Hub's main area from the left navigation. The Rust household domain service owns the records; the browser displays them through the fixed same-origin `/api/notes/` bridge. There is no browser database or legacy Notes fallback.

## Activation and access

The page checks `/api/notes/status` before requesting content. It presents an unavailable message until the service is configured and active. Activation follows the export/import/retirement process for the previous core Notes store; the UI cannot enable two authoritative stores.

Workspaces, names, private/shared labels and viewer/editor roles come from `/api/notes/scopes`. A viewer can read and search, but gets no create, save or delete controls. The service independently enforces every request. Guests and administrator-override sessions cannot use Notes.

Each view captures `assistant_context` from Family Hub state and sends `X-Assistant-Context` with every Notes request. It never silently adopts a later browser cookie. Profile changes, login/logout in this tab, cross-tab session notifications, expired authentication and rejected contexts clear the editor and temporary drafts. Cross-tab changes present **Reload Family Hub**. Leaving Notes removes its previous contents immediately, including while the next page is loading.

## Reading and writing

- Browse and search the selected workspace. The list follows server cursors and merges each note only once when loading additional pages.
- Create a plain-text note, change its title/body, or soft-delete it through the inline delete confirmation. Delete removes the note from the list; this first UI does not yet expose a trash or restore screen.
- Save explicitly using **Create note**, **Save changes**, or Ctrl/Cmd+S while editing. Unsaved edits and one unfinished new note per workspace remain in memory while navigating within this open page. Reloading or closing the page discards them; they are not written to local storage.
- Switching notes replaces the previous editor with a loading state until the requested note arrives. An older response cannot replace a more recently selected note or workspace.
- Titles and bodies are displayed as text, never interpreted as HTML or Markdown. The editor enforces the service's UTF-8 size limits: a trimmed nonempty title up to 240 bytes and a body up to 16,000 bytes. Historical missing authors or creation timestamps are not invented; the UI currently displays the recorded last-update time.

## Conflicts and uncertain responses

Every create/update/delete attempt gets a new UUID `request_id`. That ID and the exact submitted payload remain fixed until the outcome is resolved. Duplicate clicks are suppressed. If the connection loses a result, the editor locks that payload and offers **Retry same change**; retry uses the same ID rather than creating a second action. An acknowledgement received after ordinary navigation can update the temporary draft only while the captured account/context is still current.

Updates and deletes carry the last-read revision. A `revision_conflict` preserves the local edit and offers **Read latest version**. The latest saved content appears beside the retained edit. The user may load that version or keep the local edit for review against its revision; saving again is a separate explicit action. The UI never automatically overwrites another revision.

An `idempotency_conflict` locks the attempt and requires a page reload to inspect saved state before another change. An unavailable service cannot cause a switch to a second notes store.

## Looks and quick chat

The same controls and command paths are used in Dark, Light, Paper and Blueprint, including Family, Quiet and Compact layouts. Styles use the existing colour tokens. Narrow screens stack the list above the editor. Quick chat remains available at the bottom right and can coexist with Notes; no conversation panel is added to Notes.

## Validation

Syntax checks:

```powershell
node --check app/bookhub/static/notes.js
node --check app/bookhub/static/app.js
```

Browser checks were run against a disposable local fixture implementing the agreed service contract, using synthetic data only. They verified create/update/soft-delete, search and cursor pagination, viewer controls, private/shared draft separation, navigation with unsaved edits, plain-text rendering of HTML/script-shaped input, lost-response retry with one actual creation, explicit conflict review/reapply, cross-tab clearing alongside quick chat, and keyboard focus after actions. The four colour schemes and a 360-pixel mobile view were inspected; the mobile page had no horizontal content overflow. The tests found and fixed the stale editable-note loading race.

Inactive status was checked separately: it renders no editor or alternate Notes store. JavaScript syntax checks and the scoped diff whitespace check passed. The disposable fixture and browser tabs were stopped after validation.

The combined Family Hub Python suite passed **167 tests**, including the **12 Notes bridge tests** and **30 appearance regression tests**. The Rust Notes domain suite passed **11 tests**. These checks cover their respective authorization, persistence and mutation contracts; the bridge and appearance counts are subsets of the 167, not additional tests.

On 2026-10-25, Notes was also activated and verified against the actual local services using synthetic demo data. The existing `Demo: Ubuntu setup` note moved through an offline immutable export, core retirement and domain import with its ID, revision, text and recorded timestamp preserved. The core retirement and domain activation gates are active. The Family Hub UI on port 4290 displayed the imported note in its editor without changing its contents. Requests to write Notes through the retired core path were rejected; existing event and task functionality remained available.

Live HTTP checks verified two users' separate private scopes, a 404 for access to the other user's private note, shared-note editing by the second user, a 409 for a stale revision, and create/delete replay without duplicate effects. QA notes were soft-deleted after checking them.

Quick chat's **List my notes** request waited for approval of the exact MCP action, then resumed and returned the correct list. A separate read-note approval survived a core restart and was approved afterward. The resumed assistant returned the preserved title, complete body and source ID in quick chat, with no remaining permission request or active job.

These are local synthetic-demo checks. They do not establish production deployment readiness, access to real external accounts, or recovery from hardware failure.
