# Notes domain development slice

Family Hub owns the Rust Notes module in `domain/`. `family-domaind` is the only process that opens the authoritative Notes SQLite store. The Flask bridge and native `family-domain-mcp` adapter call its fixed loopback HTTP interface. Neither the core nor the browser opens that database.

Humans can list, read, create, edit and delete plain-text notes. Updates and deletion require the current revision. Creates, updates and deletion use durable request IDs: the same profile, request ID and exact payload return the original receipt after restart; reuse with changed arguments fails. A receipt and its note change commit in one SQLite transaction. Notes have stable IDs, revisions, authorship, timestamps and provenance. The first MCP adapter exposes only `notes_list` and `notes_read`.

## Development trust model

This is a trusted, same-account Windows/Linux development profile. It does not confine a worker, hide files from another process under the same OS account, or provide a production credential vault. Do not use real private notes or provider credentials until service identities, worker confinement, credential provisioning and backup recovery are implemented and tested.

The existing Family Hub profile database remains the profile authority. The Rust daemon opens it read-only and checks each binding's profile ID and credential/role stamp against its current row. A changed passcode or role, deleted profile, expired/revoked binding or removed scope membership denies later access. The daemon does not accept a password or create a second profile login system. Replacing/restoring the profile database requires stopping the daemon and reviewing bindings before restart.

The daemon stores only hashes of random connection tokens. Each UI credential identifies one Family profile and can edit only scopes where that profile is currently an editor. A separate MCP credential is read-only and bound to one Family profile, one core subject and one scope. The adapter's reviewed native arguments name its expected binding, subject and scope; changing a credential file cannot silently change that scope. The service checks the binding again on every request. Tool arguments contain only a query, cursor or note ID. They cannot set identity, workspace, credentials, a filesystem path or an endpoint.

Tokens are trusted local service data, never model context. The Flask bridge reads its profile credential from a private operator-selected directory, rejects guest and administrator-override sessions, and requires the view-context header described in `assistant-authentication.md`. It forwards only explicit Notes routes. The native adapter reads `family-domain.credential` from the core's per-connection working directory. Neither uses environment proxies or follows redirects. Errors and results are bounded and a direct credential echo is rejected. No token is placed in process arguments, browser storage, generated MCP configuration or ordinary output.

HTTP request bodies are limited to 128 KiB and domain responses to 256 KiB, allowing valid UTF-8 and escaped note text without truncation. MCP carries the full result once in `structuredContent` with a short fixed text explanation; it does not duplicate the entire note/list in the text block. MCP clients must consume `structuredContent`; the text fallback contains no note data. The worst accepted escaped single note and 50-note list are tested against the core's 256 KiB serialized tool-result limit.

The mutable credential file is independent operator state, outside the MCP executable hash. Rotation must preserve the immutable binding identity; moving authority to a new subject or scope requires a new binding/connection ID and core review. Current provisioning is deliberately limited to synthetic demo profiles and seven-day credentials. Automated rotation, production enrollment and account recovery are not implemented.

## Authority activation

Both the daemon and Flask default to inactive. `FAMILY_NOTES_ACTIVE=false` prevents the UI bridge from loading records; the daemon also rejects all data operations without its explicit `--active` flag. Authenticated status remains available.

Do not enable this store alongside writable core Notes. The core must first retire its legacy `workspace_items` Notes write path and stop presenting those records as editable. Export and retire using the core's offline command, then run `family-domaind import-core-notes --database <notes.sqlite> --profiles-db <bookhub.db> --export <export.json>` while the Notes daemon is stopped. The importer holds the store's exclusive ownership lock, validates the exact `personal-assistant-notes-export/1` envelope and SHA-256 of its payload string, and commits notes, tombstones and its import receipt in one transaction. The hash detects corruption; it is not a signature or proof of the source's authority. Import only the operator-selected export from the retired core profile.

Imported IDs, revisions, text, scopes and last-update times are preserved. Historical creation times and authors remain null when the source did not record them. Provenance retains the source ID, export ID, source export time and export digest. Unknown scopes, collisions with existing Notes IDs, duplicate IDs or invalid content reject the entire batch. Replaying the same export ID/digest returns its receipt without overwriting subsequent human edits; altered content under an existing export ID fails. There is no dual-write or fallback Notes store. Calendar and tasks are outside this slice.

The activation switches are operator controls, not cryptographic proof that another process has retired its store. Deployment tooling and integration tests must enforce that sequence. Restoring a backup requires the same authority review. The existing Family Hub book-data JSON export does not cover the new Notes store; full Notes backup/restore is a separate release gate. Do not copy a live SQLite database without its journal; use SQLite backup or stop the daemon before copying.

## Build and synthetic setup

Run from the Family Hub checkout:

```powershell
cargo build --manifest-path domain/Cargo.toml --bins --offline
cargo test --manifest-path domain/Cargo.toml --offline
cargo clippy --manifest-path domain/Cargo.toml --all-targets --offline -- -D warnings
```

Create an operator mapping JSON file using the actual numeric IDs in the synthetic Family Hub profile database. Do not match by display name or accept mappings from an agent. Example only:

```json
{
  "profiles": [
    {"profile_id": 1, "core_subject": "user-matt", "private_space": "space-matt", "name": "Matt"},
    {"profile_id": 2, "core_subject": "user-alex", "private_space": "space-alex", "name": "Nicky"}
  ],
  "shared_space": "space-household",
  "shared_name": "Household"
}
```

Invoke `family-domaind init-demo` with `--database`, `--profiles-db`, `--mapping`, `--ui-credentials`, `--mcp-root`, `--mcp-program` and `--port 4291`. Paths are operator arguments to the provisioning command; they are not MCP arguments. The database and credential files must not already exist. The command prints only the generated connection-manifest path, never token values. Files created before an interrupted initialization are inert unless the database commit succeeded; initialization refuses to overwrite them. Preserve the failed staging directory for review and use a new empty directory rather than resetting an existing store.

**Use a separate private staging directory for `--mcp-root`.** The core rejects unknown pre-existing MCP working directories. Installation order is:

1. Generate credentials under private staging and review the generated `notes-mcp-connections.json`.
2. Use the core's `inspect-artifact` / exact-digest `accept-artifact` workflow to reserve each connection ID for its owner and scope.
3. Install only that connection's `family-domain.credential` into its reserved `core-data/mcp/<connection-id>/` directory. Do not replace another binding's credential or copy a database into the directory.
4. Start the daemon and use `inspect-tools` / exact-digest `accept-tools`. Tool discovery requires the daemon to be reachable and the staged binding to match. Discovery can run while Notes data access is inactive.
5. Stop the Notes daemon, export-and-retire core Notes, and import the immutable export. Verify its import receipt before enabling the daemon and Flask together. Then verify both users' private/shared scopes.

The generated MCP arguments are only `--port=4291`, `--binding=<id>`, `--subject=<core-user>` and `--space=<core-space>`. They fit the current native-only executable profile. The binary never depends on its executable directory, `HOME`, `PATH`, environment credentials or a copied database. Current-directory credential access continues to work when the core executes a reviewed artifact snapshot.

Start the daemon with `family-domaind serve --database <notes.sqlite> --profiles-db <bookhub.db> --port 4291`; add `--active` only after the activation checks. Configure Flask with:

```text
FAMILY_NOTES_PORT=4291
FAMILY_NOTES_CREDENTIALS=<absolute private UI credential directory>
FAMILY_NOTES_ACTIVE=false
```

The daemon binds only `127.0.0.1`. Remote HTTP/TLS deployment is not supported by this adapter. SQLite uses WAL and synchronous FULL; missing, empty or unknown-version databases fail instead of being silently initialized. A sibling ownership lock prevents another daemon or offline importer opening the store simultaneously. This is cooperative local-process ownership, not OS confinement or protection against another same-account program ignoring that lock.

## Browser contract

Every `/api/notes/` request requires `X-Assistant-Context` from the view's captured `/api/state` response. A stale view receives 409 `assistant_session_changed` before any domain request. Browser tabs must clear drafts and note content on account changes.

| Method and path | Request / result |
| --- | --- |
| GET `/status` | `{configured, active, reason}` |
| GET `/scopes` | `{scopes:[{id,name,kind,role}]}` |
| GET `/scopes/{space}/notes?q=&cursor=` | `{notes:[{id,space_id,title,preview,revision,created_at,updated_at}],next_cursor}`; up to 50 rows |
| GET `/scopes/{space}/notes/{id}` | `{note}` |
| POST `/scopes/{space}/notes` | `{request_id,title,body}` → `{note}` |
| PUT `/scopes/{space}/notes/{id}` | `{request_id,revision,title,body}` → `{note}` |
| DELETE `/scopes/{space}/notes/{id}` | `{request_id,revision}` → `{id,revision,deleted:true}` |

Titles contain 1–240 UTF-8 bytes after trimming; body text contains at most 16,000 UTF-8 bytes. Timestamps are Unix milliseconds; imported historical `created_at`, `created_by` and `updated_by` can be null. `provenance` is an object; text is plain text, never executable HTML. A request ID is a UUID generated once per attempted edit. Retain the exact ID and payload after an ambiguous transport failure. Editing that payload requires a new request ID; a revision conflict must first be reviewed against the latest note.

Stable error codes are `validation_error` (400), `access_denied` (403), `not_found` (404), `revision_conflict` and `idempotency_conflict` (409), and `domain_inactive` / `domain_unavailable` (503). Unavailable or cross-scope note IDs are indistinguishable. A failed response does not authorize the browser to assume that a mutation did not commit.

## Validation

Rust tests cover two-user isolation, shared edits, read-only MCP credentials, mismatched binding scope/subject, profile revocation, inactive authority, stale revisions, idempotent replay after reopening, bounded listing, offline import rollback/replay and a real loopback daemon/native stdio child interaction with a clean environment. Python bridge tests cover view-context binding, guest/override rejection, same-origin enforcement, fixed routes, credential isolation, redirects, malformed/oversized responses and offline errors. Tests use only synthetic temporary data.

The core still owns whether an agent may read a particular connection. The domain separately verifies the connection's current scope membership. Agent-written notes remain disabled until a host-supplied durable operation identity and reconciliation contract exist; an agent-generated JSON field is not a substitute for those controls.

## Protocol compatibility and CI

The adapter returns identical complete JSON in `structuredContent` and a text block, following the [MCP structured content recommendation](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content), checked 2026-10-25. Clients can read either form. The serialized tool response, including JSON escaping and both representations, stays below 256 KiB with envelope headroom. A list may contain fewer than 50 notes to fit that budget. Its cursor resumes after the last included record, including when the original domain page had no cursor; titles and previews are not shortened further. A single note is returned completely or fails with a fixed error. Worst-case escaping and real stdio tests verify equal data, bounds and pagination without skipped or duplicated notes. This does not claim compatibility with every MCP transport or client feature.

Local stdio is also not an isolation boundary when a trusted host can spawn arbitrary processes. The current adapter fixes its executable, arguments and scope; OS sandboxing remains separate work. [MCP local server and proxy security](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices#stdio-transport-security-in-proxy-scenarios).

`domain/rust-toolchain.toml` pins Rust 1.92.0. The Rust domain workflow runs formatting, locked tests, clippy and binary builds on Windows and Ubuntu. A configured workflow is not evidence that a hosted run completed; local verification results are recorded separately.
