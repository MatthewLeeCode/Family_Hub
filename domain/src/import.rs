//! Offline, all-or-nothing import after the core has frozen its Notes authority.
use crate::*;
const FORMAT: &str = "personal-assistant-notes-export/1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    sha256: String,
    payload: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    export_id: String,
    created_at: i64,
    notes: Vec<LegacyNote>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyNote {
    id: String,
    space_id: String,
    title: String,
    body: String,
    revision: i64,
    updated_at: i64,
    deleted: bool,
}
impl Store {
    pub fn import_core_notes(&mut self, bytes: &[u8]) -> anyhow::Result<Value> {
        anyhow::ensure!(!self.active, "Import requires an inactive Notes store");
        anyhow::ensure!(bytes.len() <= 32 * 1024 * 1024, "Notes export is too large");
        let envelope: Envelope = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("Invalid Notes export envelope"))?;
        anyhow::ensure!(
            envelope.payload.len() <= 16 * 1024 * 1024,
            "Notes export payload is too large"
        );
        anyhow::ensure!(envelope.format == FORMAT, "Unsupported Notes export format");
        anyhow::ensure!(
            envelope.sha256.len() == 64 && envelope.sha256 == digest(envelope.payload.as_bytes()),
            "Notes export checksum mismatch"
        );
        let payload: Payload = serde_json::from_str(&envelope.payload)
            .map_err(|_| anyhow::anyhow!("Invalid Notes export payload"))?;
        uuid::Uuid::parse_str(&payload.export_id)
            .map_err(|_| anyhow::anyhow!("Invalid export ID"))?;
        anyhow::ensure!(
            payload.created_at >= 0 && payload.notes.len() <= 10000,
            "Invalid Notes export metadata"
        );
        // Additive import bookkeeping for stores initialized before import support.
        self.db.execute_batch("CREATE TABLE IF NOT EXISTS imported_exports(export_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,note_count INTEGER NOT NULL,source_created_at INTEGER NOT NULL,imported_at INTEGER NOT NULL)")?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing:Option<(String,String,i64)>=tx.query_row("SELECT export_id,sha256,note_count FROM imported_exports WHERE export_id=? OR sha256=?",params![payload.export_id,envelope.sha256],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id, hash, count)) = existing {
            anyhow::ensure!(
                id == payload.export_id && hash == envelope.sha256,
                "Export identity was already imported with different content"
            );
            return Ok(json!({"already_imported":true,"export_id":id,"sha256":hash,"notes":count}));
        }
        let mut seen = std::collections::HashSet::new();
        for legacy in &payload.notes {
            anyhow::ensure!(
                valid_id(&legacy.id)
                    && valid_id(&legacy.space_id)
                    && seen.insert(legacy.id.clone())
                    && legacy.revision > 0
                    && legacy.updated_at >= 0,
                "Invalid or duplicate exported note identity/revision"
            );
            validate_text(legacy.title.clone(), &legacy.body)?;
            anyhow::ensure!(legacy.title.len() <= 240, "Exported title is too large");
            let known: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM spaces WHERE id=?)",
                [&legacy.space_id],
                |r| r.get(0),
            )?;
            anyhow::ensure!(known, "Export contains an unknown Notes scope");
            let collision: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?)",
                [&legacy.id],
                |r| r.get(0),
            )?;
            anyhow::ensure!(
                !collision,
                "Exported note ID already exists; import did not change any notes"
            );
            let note = Note {
                id: legacy.id.clone(),
                space_id: legacy.space_id.clone(),
                title: legacy.title.clone(),
                body: legacy.body.clone(),
                revision: legacy.revision,
                created_at: None,
                updated_at: legacy.updated_at,
                created_by: None,
                updated_by: None,
                provenance: json!({"source":"core-demo-import","source_id":legacy.id,"imported_from":FORMAT,"export_id":payload.export_id,"export_sha256":envelope.sha256,"export_created_at":payload.created_at}),
            };
            tx.execute("INSERT INTO notes(id,space_id,document,revision,updated_at,deleted) VALUES(?,?,?,?,?,?)",params![note.id,note.space_id,serde_json::to_string(&note)?,note.revision,note.updated_at,legacy.deleted])?;
        }
        tx.execute(
            "INSERT INTO imported_exports VALUES(?,?,?,?,?)",
            params![
                payload.export_id,
                envelope.sha256,
                payload.notes.len() as i64,
                payload.created_at,
                now()
            ],
        )?;
        tx.commit()?;
        Ok(
            json!({"already_imported":false,"export_id":payload.export_id,"sha256":envelope.sha256,"notes":payload.notes.len()}),
        )
    }
}
