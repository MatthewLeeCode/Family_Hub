# Synthetic Notes profile labels

The first two accounts are Matt and Nicky. The existing demonstration retains
`user-alex` and `space-alex` as stable internal identifiers. They are not login
aliases. Changing these IDs would break existing ownership and reviewed MCP
bindings.

Stop Family Hub, the core and the Notes daemon, then back up their complete data
stores before migrating. The Notes command is:

```powershell
./family-domaind.exe rename-demo-profiles `
  --database <existing-notes.sqlite> `
  --profiles-db <existing-bookhub.db> `
  --services-stopped
```

This explicit command uses the same exclusive ownership lock as the Notes
daemon. The flag confirms the operator has also stopped Family Hub; it does not
provide a lock against that separate service. Never run it against active
services. Do not call initialization or provisioning to rename existing data.

The command accepts only the fixed two-profile synthetic mapping, its three
workspaces, four editor memberships and six scoped credential bindings. Family
profiles must be either You/Partner or Matt/Nicky, with their original credential
stamps and administrator roles. A custom name, conflicting profile, changed
binding or different mapping fails without modifying Notes data.

Only `space-alex`'s display label changes from `Alex · private` to
`Nicky · private`. Credentials, their expiry and revocation, memberships, note
IDs and revisions, request receipts and import provenance stay unchanged. An
already-current store returns `applied: false` without changing any rows. No
credential is printed or renewed. The command does not migrate core logins or
Family profile names, launch an MCP process, schedule work or recover jobs.

The three stores are separate. Complete their migrations and compare preserved
data before restarting; this is not one transaction across services. Update
the private provisioning example's display name for future setups, while
retaining existing IDs and credential files. This is a same-account development
profile, not OS confinement or production identity enrollment.
