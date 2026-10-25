# Clear permission requests

A permission request explains the action before asking for a decision. Main chat, Quick chat and Background use the same card and existing decision endpoint.

## Visible information

- A plain-language action question and a short statement of the effect.
- The selected workspace and specific resource, recipient or connector supplied by the host.
- A specific button, such as **Create draft** or **Save attachment**, plus **Don't allow**.
- A visible reminder that confirmation applies once and does not change standing permissions.
- The original expiry and any paused/dependency-wait explanation.

**Technical details** contains the capability identifier, exact arguments and task context. Empty arguments say **No additional arguments**. A connector's description is labelled separately and is explicitly not a host guarantee about safety or access.

Routine updates remain quiet text lines, with a colon between title and body. Stored messages and prior notification contents are not rewritten. When the active job is waiting for a question answer, the composer says **Waiting for your answer** rather than implying that the agent is still working.

## Host facts, not inferred reassurance

The optional `Approval.presentation` contains an approval ID, action digest, availability boolean, title, summary, confirmation label, bounded label/value details and nullable connector description. Core supplies built-in semantics and resolves resources in the owner's workspace. For MCP, effect wording comes from currently matching operator-reviewed facts.

Neither the UI nor the bridge infers safety from a capability name, job title, model explanation or connector annotation. A connector claiming no external access is still making a connector claim; this slice does not establish OS confinement.

`assistant_approval_contract.py` deep-projects only the public presentation fields. Text is nonblank, NUL-free and bounded in UTF-8 bytes. Approval ID and digest must match the outer record exactly. Malformed, mismatched or absent presentation becomes null, keeping the existing approval row available for refusal while withholding positive confirmation. Unknown nested metadata is discarded.

## Decisions and stale state

- The browser independently validates the same bounds and binding.
- Confirmation requires a valid available presentation, an unexpired pending approval and all existing owner, context, workspace and dependency checks.
- A connected old button cannot confirm after the current presentation changes. Detached controls and old workspace callbacks also remain fenced.
- Missing, invalid or unavailable presentation offers **Reload action details**. Reload only reads state and preserves keyboard focus when the replacement card appears.
- **Don't allow** remains subject to the existing lifecycle checks. In particular, a dependency-blocked request cannot be decided through this presentation change.
- The endpoint and body are unchanged: `POST /api/assistant/approvals/{id}` with `{approve:true}` or `{approve:false}`. Presentation is display data, not new authority or a standing grant.

## Appearance

Quiet adds flat accent tints to user messages, assistant identity labels, question cards and active status text. Permission cards use a restrained amber tint and an explicit **Permission request** label. There are no gradients or decorative side stripes. Main and quick chat share these styles. Selecting the original Family layout restores its own palette and component styling.

## Validation

The focused bridge suite passed **28 tests** across approval presentation, responsibilities and durable questions. The full browser suite passed **112 tests**, followed by **two final geometry/colour checks** after settling screenshot transitions and explicitly restoring Quiet on Quick chat navigation in the fixture. Browser regressions cover all three card surfaces, missing/malformed metadata, exact action binding, connector-claim attribution, read-only reload focus, stale connected buttons and the question-wait footer.

Main and Quick chat screenshots were inspected at 1265 × 712 and 390 × 844. Geometry and text-contrast checks exercise Dark, Light, Paper and Blueprint with Teal, Purple, Blue and Orange accents. The tested user text, role labels and permission labels retain at least 4.5:1 contrast. The original Family card background is checked separately. These are intercepted synthetic browser tests; they do not approve or reject the live user's pending request.

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_approval_presentation.py tests/test_responsibility_bridge.py tests/test_question_bridge.py --basetemp .test-runs/approval-contract-check
node --test tests/test_inbox_ui.cjs
```
