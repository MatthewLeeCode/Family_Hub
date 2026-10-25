//! Create-only agent writes, durable operation receipts and explicit offline migration.
//! A transport operation identifies a retry; the stored writer binding grants access.
use crate::*;

pub const OPERATION_META_KEY: &str = "io.github.matthewleecode/operation";
const IMPORT_SCHEMA: &str = "CREATE TABLE imported_exports(export_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,note_count INTEGER NOT NULL,source_created_at INTEGER NOT NULL,imported_at INTEGER NOT NULL)";
const MIGRATION: &str = r#"
ALTER TABLE bindings ADD COLUMN mcp_create INTEGER NOT NULL DEFAULT 0 CHECK(mcp_create IN (0,1) AND (mcp_create=0 OR kind='mcp'));
CREATE TABLE agent_note_receipts(binding_id TEXT NOT NULL REFERENCES bindings(id),operation_id TEXT NOT NULL,request_digest TEXT NOT NULL,result TEXT NOT NULL,committed_at INTEGER NOT NULL,PRIMARY KEY(binding_id,operation_id));
CREATE TRIGGER agent_note_receipts_no_update BEFORE UPDATE ON agent_note_receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER agent_note_receipts_no_delete BEFORE DELETE ON agent_note_receipts BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
PRAGMA user_version=2;
"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationContext {
    pub version: u8,
    pub operation_id: String,
    pub request_digest: String,
}
impl OperationContext {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !canonical_uuid(&self.operation_id)
            || self.request_digest.len() != 64
            || !self
                .request_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || serde_json::to_vec(self)?.len() > 512
        {
            return Err(DomainError::invalid());
        }
        Ok(())
    }
}
pub fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentNoteInput {
    pub title: String,
    pub body: String,
}
impl AgentNoteInput {
    pub fn validate(&self) -> Result<String> {
        if self.title.len() > 1024 {
            return Err(DomainError::invalid());
        }
        validate_text(self.title.clone(), &self.body)
    }
    pub fn request_digest(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(&(
            "family-notes-create/1",
            &self.title,
            &self.body,
        ))?))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentNoteEnvelope {
    pub operation: OperationContext,
    pub note: AgentNoteInput,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentNoteResult {
    pub operation_id: String,
    pub request_digest: String,
    pub note: Note,
}

impl Store {
    pub fn create_agent_note(
        &mut self,
        who: &Principal,
        space: &str,
        operation: OperationContext,
        input: AgentNoteInput,
    ) -> Result<AgentNoteResult> {
        self.enabled()?;
        if who.access != AccessMode::McpCreate {
            return Err(DomainError::denied());
        }
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // Read the current Family credential stamp only after obtaining the Notes write lock.
        Self::current_principal_db(&tx, &self.profiles, who)?;
        writer_access(&tx, who, space)?;
        operation.validate()?;
        let title = input.validate()?;
        if input.request_digest()? != operation.request_digest {
            return Err(DomainError::invalid());
        }
        let previous: Option<(String,String)> = tx.query_row(
            "SELECT request_digest,result FROM agent_note_receipts WHERE binding_id=? AND operation_id=?",
            params![who.binding, operation.operation_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((stored, result)) = previous {
            if stored != operation.request_digest {
                return Err(DomainError::new(
                    "idempotency_conflict",
                    "This operation was already used for different note content.",
                    409,
                ));
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let committed_at = now();
        let note = Note {
            id: uuid::Uuid::new_v4().to_string(),
            space_id: space.into(),
            title,
            body: input.body,
            revision: 1,
            created_at: Some(committed_at),
            updated_at: committed_at,
            created_by: Some(who.profile),
            updated_by: Some(who.profile),
            provenance: json!({"source":"assistant","source_id":operation.operation_id,"binding_id":who.binding,"imported_from":null}),
        };
        tx.execute(
            "INSERT INTO notes(id,space_id,document,revision,updated_at) VALUES(?,?,?,?,?)",
            params![
                note.id,
                space,
                serde_json::to_string(&note)?,
                note.revision,
                committed_at
            ],
        )?;
        let result = AgentNoteResult {
            operation_id: operation.operation_id,
            request_digest: operation.request_digest,
            note,
        };
        tx.execute(
            "INSERT INTO agent_note_receipts VALUES(?,?,?,?,?)",
            params![
                who.binding,
                result.operation_id,
                result.request_digest,
                serde_json::to_string(&result)?,
                committed_at
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }

    /// Content-free offline evidence. This never authorizes a core retry or settlement.
    pub fn inspect_agent_note_receipt(
        &self,
        binding: &str,
        operation_id: &str,
    ) -> anyhow::Result<Value> {
        anyhow::ensure!(
            !self.active,
            "Inspect receipts only while the daemon is stopped"
        );
        anyhow::ensure!(
            valid_id(binding) && canonical_uuid(operation_id),
            "Invalid receipt reference"
        );
        let row: Option<(String,String,i64)> = self.db.query_row(
            "SELECT request_digest,result,committed_at FROM agent_note_receipts WHERE binding_id=? AND operation_id=?",
            params![binding, operation_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        match row {
            None => {
                Ok(json!({"status":"not_found","binding_id":binding,"operation_id":operation_id}))
            }
            Some((hash, document, at)) => {
                let result: AgentNoteResult = serde_json::from_str(&document)?;
                anyhow::ensure!(
                    result.operation_id == operation_id
                        && result.request_digest == hash
                        && result.note.provenance["binding_id"] == binding,
                    "Invalid receipt correlation"
                );
                Ok(
                    json!({"status":"committed","binding_id":binding,"operation_id":operation_id,"request_digest":hash,"note_id":result.note.id,"revision":result.note.revision,"committed_at":at}),
                )
            }
        }
    }

    /// Existing stores are changed only by this explicit offline command.
    pub fn migrate_agent_notes(path: &Path) -> anyhow::Result<Value> {
        let _ownership = owner_lock(path)?;
        let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
        )?;
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        let applied = migrate_db(&mut db)?;
        Ok(json!({"schema_version":2,"applied":applied}))
    }
}

pub(crate) fn writer_access(db: &Connection, who: &Principal, space: &str) -> Result<()> {
    if who.access != AccessMode::McpCreate {
        return Err(DomainError::denied());
    }
    if !valid_id(space) || who.space.as_deref() != Some(space) {
        return Err(DomainError::missing());
    }
    let allowed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM memberships m JOIN spaces s ON s.id=m.space_id WHERE m.profile_id=? AND m.space_id=? AND m.role='editor' AND (s.kind='shared' OR (s.kind='private' AND s.owner_profile=?)))",
        params![who.profile, space, who.profile], |r| r.get(0))?;
    if !allowed {
        return Err(DomainError::denied());
    }
    Ok(())
}

fn schema_rows(db: &Connection) -> anyhow::Result<Vec<(String, String, String)>> {
    let mut q = db.prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    )?;
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Compare SQLite's stored DDL exactly. Normalizing quoted literals would
    // accidentally accept customized constraints or trigger bodies.
    Ok(rows)
}
pub(crate) fn validate_schema(db: &Connection, version: i64) -> anyhow::Result<()> {
    anyhow::ensure!([1, 2].contains(&version), "Unsupported Notes schema");
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    let imported: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='imported_exports')",
        [],
        |r| r.get(0),
    )?;
    if imported {
        expected.execute_batch(IMPORT_SCHEMA)?;
    }
    if version == 2 {
        expected.execute_batch(MIGRATION)?;
    }
    anyhow::ensure!(
        schema_rows(db)? == schema_rows(&expected)?,
        "Unexpected Notes schema; no migration was applied"
    );
    let violations: i64 =
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    anyhow::ensure!(violations == 0, "Notes foreign-key check failed");
    Ok(())
}
pub(crate) fn migrate_db(db: &mut Connection) -> anyhow::Result<bool> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    validate_schema(db, version)?;
    if version == 2 {
        return Ok(false);
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute_batch(MIGRATION)?;
    validate_schema(&tx, 2)?;
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests;
