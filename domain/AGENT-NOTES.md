# Agent-created Notes

Status: create-only implementation and synthetic verification, 2026-10-25. No live writer connection is enrolled by this change. Existing reader executables, connections, credentials and permissions remain read-only.

## One narrow operation

`family-notes-writer` exposes only `notes_create` with exact arguments `{title, body}`. It cannot list, read, edit or delete notes. The fixed binding controls the Family profile and private/shared workspace. Tool arguments cannot supply identity, scope, request IDs, credentials, URLs or paths.

| Bound | Rule |
| --- | --- |
| Title | Raw input at most 1,024 UTF-8 bytes; trimmed value 1–240 bytes; no NUL. |
| Body | At most 16,000 UTF-8 bytes; no NUL; stored exactly. |
| Operation context | Host-supplied metadata, strict version 1, canonical UUID and lowercase SHA-256; at most 512 serialized bytes. |
| Result | Complete original creation result in identical JSON text and structured content; maximum 256 KiB including framing. |

The reviewed core connection opts into `operation_context: "family_notes_create_v1"` and declares `notes_create` as `local_write`. The host supplies its persisted action ID only after the ordinary permission gate admits dispatch. The default permission remains Ask; enrollment never creates an automatic allow grant.

The writer reads SDK `RequestContext.meta["io.github.matthewleecode/operation"]`. A nested `_meta` tool argument is rejected. The digest is SHA-256 over compact JSON of the array `["family-notes-create/1", raw_title, body]`. It binds exact input, including title whitespace, and grants no permission by itself.

## What commits together

The daemon obtains an immediate Notes transaction, then reads the current Family credential/role stamp. It rechecks binding mode, expiry, revocation, membership and private ownership before looking up a receipt.

1. A new `(binding_id, operation_id)` creates one note and one immutable receipt in the same transaction.
2. The same key and raw-input digest return the original result. Human edits, soft deletion and process restart do not rewrite that history.
3. A changed digest returns `idempotency_conflict` without old note text.
4. Current access is required on every replay. A receipt does not preserve a revoked caller's access.

New notes use revision 1 and the binding's Family profile. Provenance contains `source: "assistant"`, the host operation ID, the domain binding ID and `imported_from: null`.

The Family stamp is a fresh admission check across two databases, not a distributed transaction. Revocation committed before that check denies admission. Work admitted before a later revocation may finish. Household logout alone does not revoke independently authorized background work.

## Explicit offline setup

Stop the daemon and any service that can alter Family profile authority before these operations. `--services-stopped` records this operator acknowledgement; the Notes ownership lock also prevents a second cooperating daemon. It does not enforce OS confinement or stop an unrelated same-account process.

Fresh `init-demo` stores use schema 2. An existing schema-1 store must be backed up and migrated explicitly; normal startup never migrates it:

```text
family-domaind migrate-agent-notes --database <existing-notes.sqlite> --services-stopped
```

The single transaction adds `bindings.mcp_create` defaulting to 0 and `agent_note_receipts`, with immutable-update/delete triggers. Existing notes, bindings, token hashes, memberships, human receipts and import receipts remain intact. Exact expected DDL and foreign keys are checked. Unknown/custom schemas fail closed. A repeat reports `{"schema_version":2,"applied":false}` without modifying rows. An older daemon rejects version 2.

Enroll a fresh writer only for an existing current reader mapping with editor access:

```text
family-domaind enroll-notes-writer --database <existing-notes.sqlite> --profiles-db <bookhub.db> --profile <numeric-profile> --subject <core-user-id> --space <core-space-id> --binding <new-connection-id> --staging <private-staging-parent> --program <absolute-family-notes-writer-executable> --port <notes-port> --services-stopped
```

Output is `{"manifest":"<path>"}`. The generated files are:

```text
<private-staging-parent>/<new-connection-id>/family-domain.credential
<private-staging-parent>/<new-connection-id>/notes-writer-connection.json
```

The manifest is an array containing one connection. The credential is a new random token, valid for seven days in this synthetic setup. Existing bindings or files are never overwritten. Files left by a failed enrollment are inert if the database commit failed; preserve them for inspection and choose a fresh binding/staging location. Token values never enter command arguments, manifests or output.

Installation still requires operator artifact review, reserving the new connection ID, installing its credential in the reserved working directory, and exact tool review. Do not replace the existing read binary or install a credential over another binding. A reviewed writer's fixed arguments are `--port`, `--binding`, `--subject` and `--space` only. It reads the fixed credential file from its working directory and uses loopback HTTP with no proxy, redirects or automatic retries.

## Lost acknowledgement and operator evidence

A failure after dispatch can hide a committed write. Core must keep an uncertain outcome across restart and must not automatically retry, generate a new operation ID or treat an MCP error as proof that nothing happened.

After stopping the daemon, an operator can inspect one exact receipt:

```text
family-domaind inspect-agent-note-receipt --database <existing-notes.sqlite> --profiles-db <bookhub.db> --binding <writer-binding> --operation <canonical-operation-uuid> --services-stopped
```

`status: "committed"` returns only binding ID, operation ID, digest, note ID, creation revision and commit time. `status: "not_found"` contains only the lookup references. Neither result exposes note text or changes rows. A missing receipt is not proof that an external effect did not occur and does not authorize a retry. This command does not settle core uncertainty; reconciliation remains a separate future feature.

Deduplication applies to one durable operation. A genuinely different authorized operation may create another note with the same content.

## Verification

Use only disposable synthetic profiles and stores. The separate build target avoids replacing running reviewed artifacts:

```text
cargo fmt --manifest-path domain/Cargo.toml --check
cargo test --manifest-path domain/Cargo.toml --target-dir domain/target/notes-verification --locked --offline
cargo clippy --manifest-path domain/Cargo.toml --target-dir domain/target/notes-verification --locked --offline --all-targets -- -D warnings
```

Coverage includes digest vectors, byte limits, private/shared rights, current mode/stamp checks, a deterministic Family-stamp change while waiting for the Notes lock, atomic note/receipt rollback, schema-allocation failure rollback, strict DDL checks, immutable original replay, simultaneous duplicate calls, real native stdio metadata and restart, maximum escaped result framing, credential echo rejection, redirects, malformed results and zero automatic POST retries. Separate root integration exercises the real core permission gate and lost-acknowledgement quarantine; its observed results are recorded in the core work log.

The unchanged browser Notes routes show agent-created notes through the same authoritative store. No browser mutation envelope, secret broker, real external provider write or production OS confinement is introduced.
