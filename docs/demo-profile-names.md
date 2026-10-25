# Demo profile names

A fresh Family Hub demo creates **Matt** (ID 1, admin), **Nicky** (ID 2, admin), and **Nan** (ID 3, restricted member). The existing sample PIN `1234`, sync password `demo`, colours, permissions, reading history and default household appearance are retained. Ordinary setup still lets a household choose its own profile names.

Starting an existing demo does not rename profiles. The optional offline helper accepts only the fixed original names `You`/`Partner` or the already-correct `Matt`/`Nicky` at IDs 1/2 with their expected admin roles. It refuses custom names, missing IDs and name collisions. Nan and any additional non-conflicting profiles are preserved.

## Explicit offline update

1. Stop Family Hub and related writers. For the integrated demo, stop core and the Notes domain too and check their processes/ports/owner locks. Back up the existing sample directory and related stores first.
2. From Family Hub's `app` directory, using its Python environment, run:

   ```text
   python -m bookhub.demo_profiles --demo-dir <existing-demo-directory> --services-stopped
   ```

3. The helper requires the original `data/bookhub.db` and `library/metadata.db` layout without redirected child paths. It reads the library in SQLite read-only mode and verifies all twelve synthetic titles/synopsis markers as positive legacy-demo proof. It does not modify Calibre or create a missing database.
4. Expected profile names and local web-session deletion commit in one database transaction. PIN hashes, roles, integer IDs, sync keys, appearance preferences, reading data and Notes credential stamps remain unchanged. Successful application clears all local Family browser sessions, including guest/admin-override sessions. A repeat returns `already_current` and leaves newly established sessions alone.
5. Restart and select Matt or Nicky. Unenrolled profiles still use their existing Family PIN; profiles enrolled for [single sign-in](assistant-authentication.md) use their core account password. KOReader and OPDS use the exact profile name as their username, so update those devices to `Matt` or `Nicky`; the sync password remains unchanged. There are no legacy username aliases.

`--services-stopped` is operator acknowledgement, not process detection or an operating-system lock. The SQLite transaction prevents partial writes; it cannot stop an active server from starting a new request. Do not run this helper against live services. It refuses an unsupported session schema rather than claiming to have revoked sessions it cannot clear.

Family profile renaming is separate from core account and Notes display-label migration. The stable binding IDs `user-matt`, `user-alex`, `space-matt` and `space-alex` do not change. Do not rotate Family PIN hashes or roles during the rename: Notes uses their credential stamps. Clearing Family web sessions does not revoke remote core sessions or cancel all background work. The root integration procedure must handle core revocation and its explicit credential migration separately.
