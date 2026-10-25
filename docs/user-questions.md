# Durable single-choice questions

An agent can ask for information and wait for an answer later. Questions are separate from permission approvals: choosing an inbox, for example, does not approve reading it or creating a draft. The core checks each later tool action against its existing gates.

## Interface

- Main chat and Quick chat show pending questions from the selected workspace, including questions raised by background work or another conversation. Background uses the same card and decision path.
- A card contains the prompt, two to six radio options, workspace context, expiry, **Submit answer** and **Decline**. No option is preselected. Submit stays disabled until the user selects an option.
- Answers and declines become small inline updates. Ordinary progress remains compact text; input cards are reserved for decisions that need the user.
- The original Family look and optional layouts use the same controls. Text is escaped, and colours follow the chosen theme.
- Main/quick navigation retains an unsent choice in page memory. Workspace changes discard unsent choices; profile or account changes also discard pending browser operation state. No question text, choice or credential is written to browser storage.

Questions are visible only to their owner, even in a shared workspace. The agent may use the answer in later shared task output; this is not a promise that information supplied to a shared task will remain private forever.

## Waiting and expiry

The host's `can_answer` flag is authoritative. A pending question may accept an answer while its job is waiting for input or a dependency. Answering a paused job records the information but does not resume that job. Owner review, scheduling rules and permissions still apply.

Expiry disables the form even without a new snapshot. An expired, cancelled or otherwise unavailable question cannot accept a new decision. A response which was already recorded can still be recovered through the core's exact idempotent retry contract.

The host returns up to 100 question rows, prioritising pending, unexpired questions before history. It permits at most 20 pending questions per owner and five questions per job. Direct lookup remains available by exact question and workspace ID. This slice has no free-text, upload, password or payment-information field.

## Unknown network outcomes

An answer is submitted once with the displayed revision and digest. Main and quick chat share the in-flight guard, so expanding or reopening a surface cannot submit a second decision.

If the response is lost or malformed:

1. The form locks its choices and offers **Reload status**. There is no automatic POST retry.
2. An exact GET checks the saved question. A confirmed terminal result clears the browser's uncertainty.
3. If the same original question is still pending, **Retry answer** or **Retry decline** deliberately resubmits the identical body. The user cannot change the choice while the original decision is unresolved.
4. Changed question bindings remain locked for reconciliation. A delayed GET cannot replace a newer confirmed answer with pending controls.

This recovery guard lasts for the current page/account lifetime. A browser reload obtains current host state; the browser does not retain a durable outbox of submitted answers. The core retains the actual question and decision and rejects a conflicting answer.

## Bridge and identity boundary

The browser uses only these same-origin routes:

| Route | Purpose |
| --- | --- |
| `GET /api/assistant/state` | Public snapshot, including owner questions |
| `GET /api/assistant/questions/{id}?space_id=…` | Exact status reconciliation |
| `POST /api/assistant/questions/{id}/answer` | Answer or decline |

The POST body has exactly `space_id`, `expected_revision`, `question_digest` and `choice_id`. An explicit `null` choice declines. A successful response must be HTTP 200 with the full validated question, matching identity, workspace, digest and decision, and revision `expected_revision + 1`.

`assistant_question_contract.py` projects only public fields. It validates owner identity against the server-held Assistant account, accessible spaces, known states, option bounds and uniqueness, digest and timestamp types, and terminal-state invariants. Empty or NUL-containing prompts/labels, foreign rows and malformed present collections fail closed. An absent `questions` collection becomes an empty list for compatibility with older hosts.

Every route requires the captured `X-Assistant-Context`, an ordinary signed-in Family profile and a valid core session. Guests and administrator-override sessions are rejected. Safe fixed errors replace upstream diagnostics. Unknown fields, credentials and internal metadata do not pass through this projection.

View handlers check captured identity, context, workspace, scope epoch, question binding and attached controls. Old cards clear immediately when scope changes. Late responses cannot reveal the prior account's question or replace the new workspace. These browser checks supplement the core's authoritative session and membership checks.

## Validation

The full Family suite passed **255 Python tests** and **101 isolated browser tests**. Focused validation passed **24 Python tests** across the question and responsibility bridge modules, and **17 browser tests** for this slice. Coverage includes explicit answer/decline, no default choice, main/quick/Background parity, shared owner isolation, stale scope/context, malformed responses, expiry, paused replies, duplicate suppression, lost-response reconciliation and unchanged-body retry. A delayed GET regression prevents a newer confirmed answer from reverting to pending.

The browser fixtures intercept every API request and use synthetic data. Question cards were inspected at 1265 × 712 and 390 × 844 in Dark, Light, Paper and Blueprint, with no horizontal overflow and the action buttons/composer visible. An independent source review found no blocking issue in the projection, identity checks or reply recovery.

A separate disposable integration check used the actual Family Flask handlers, Rust server and tiny test agent. It passed owner exclusion in shared space, restart recovery, answer and exact replay, conflicting-decision rejection, explicit null decline, and logout followed by recovery through a fresh session. It did not change the live users' requests or establish production confinement.

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_question_bridge.py tests/test_responsibility_bridge.py --basetemp .test-runs/question-check
node --test --test-name-pattern="durable question" tests/test_inbox_ui.cjs
```
