//! Family-owned Notes domain. Only the daemon opens the authoritative store.
//! Transport credentials identify a caller; command JSON cannot claim identity.
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub mod http;
pub mod import;
pub mod mcp;
pub mod provision;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Serialize)]
pub struct DomainError {
    pub code: &'static str,
    pub error: &'static str,
    #[serde(skip)]
    pub status: u16,
}
impl DomainError {
    pub fn new(code: &'static str, error: &'static str, status: u16) -> Self {
        Self {
            code,
            error,
            status,
        }
    }
    pub fn unavailable() -> Self {
        Self::new(
            "domain_unavailable",
            "Notes is unavailable. Try again shortly.",
            503,
        )
    }
    pub fn invalid() -> Self {
        Self::new(
            "validation_error",
            "Check the note title, text and request fields.",
            400,
        )
    }
    fn denied() -> Self {
        Self::new(
            "access_denied",
            "This connection cannot access those notes.",
            403,
        )
    }
    fn missing() -> Self {
        Self::new("not_found", "That note was not found.", 404)
    }
}
type Result<T> = std::result::Result<T, DomainError>;
impl From<rusqlite::Error> for DomainError {
    fn from(_: rusqlite::Error) -> Self {
        Self::unavailable()
    }
}
impl From<serde_json::Error> for DomainError {
    fn from(_: serde_json::Error) -> Self {
        Self::unavailable()
    }
}
impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)
    }
}
impl std::error::Error for DomainError {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub body: String,
    pub revision: i64,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    pub created_by: Option<i64>,
    pub updated_by: Option<i64>,
    pub provenance: Value,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateNote {
    pub request_id: String,
    pub title: String,
    pub body: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateNote {
    pub request_id: String,
    pub revision: i64,
    pub title: String,
    pub body: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteNote {
    pub request_id: String,
    pub revision: i64,
}
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteQuery {
    #[serde(default)]
    pub q: String,
    pub cursor: Option<String>,
}

/// Constructed by transport authentication, never deserialized from commands.
pub struct Principal {
    profile: i64,
    kind: String,
    space: Option<String>,
    binding: String,
    subject: String,
}
pub enum ExpectedCaller {
    Ui {
        profile: i64,
    },
    Mcp {
        binding: String,
        subject: String,
        space: String,
    },
}
pub struct Store {
    db: Connection,
    profiles: Connection,
    active: bool,
    _ownership: std::fs::File,
}
type BindingRow = (
    String,
    i64,
    String,
    String,
    Option<String>,
    String,
    i64,
    bool,
);

const SCHEMA: &str = r#"
PRAGMA user_version=1;
CREATE TABLE domain_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('private','shared')),owner_profile INTEGER);
CREATE TABLE memberships(space_id TEXT NOT NULL REFERENCES spaces(id),profile_id INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('editor','viewer')),PRIMARY KEY(space_id,profile_id));
CREATE TABLE bindings(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,profile_id INTEGER NOT NULL,profile_stamp TEXT NOT NULL,subject TEXT NOT NULL,space_id TEXT REFERENCES spaces(id),kind TEXT NOT NULL CHECK(kind IN ('ui','mcp')),expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE notes(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES spaces(id),document TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX notes_scope ON notes(space_id,deleted,updated_at,id);
CREATE TABLE receipts(profile_id INTEGER NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(profile_id,request_id));
"#;

impl Store {
    pub fn create(path: &Path, profile_path: &Path) -> anyhow::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        drop(file);
        let ownership = owner_lock(path)?;
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.execute_batch(SCHEMA)?;
        db.execute(
            "INSERT INTO domain_meta VALUES('instance_id',?)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        drop(db);
        Self::open_owned(path, profile_path, false, ownership)
    }
    pub fn open(path: &Path, profile_path: &Path, active: bool) -> anyhow::Result<Self> {
        let ownership = owner_lock(path)?;
        Self::open_owned(path, profile_path, active, ownership)
    }
    fn open_owned(
        path: &Path,
        profile_path: &Path,
        active: bool,
        ownership: std::fs::File,
    ) -> anyhow::Result<Self> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        anyhow::ensure!(
            version == 1,
            "Unsupported Notes store; initialize or migrate explicitly"
        );
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")?;
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        let profiles = Connection::open_with_flags(profile_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        profiles.busy_timeout(std::time::Duration::from_secs(3))?;
        Ok(Self {
            db,
            profiles,
            active,
            _ownership: ownership,
        })
    }
    pub fn profile_stamp(&self, profile: i64) -> Result<String> {
        let value: Option<(Option<String>, String)> = self
            .profiles
            .query_row(
                "SELECT passcode_hash,role FROM profiles WHERE id=?",
                [profile],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (passcode, role) = value.ok_or_else(DomainError::denied)?;
        // Match the existing Family Hub session stamp, including Python str(None).
        Ok(digest(
            format!("{}:{role}", passcode.as_deref().unwrap_or("None")).as_bytes(),
        ))
    }
    pub fn authenticate(&self, token: &str, expected: ExpectedCaller) -> Result<Principal> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(DomainError::denied());
        }
        let row: Option<BindingRow> = self.db.query_row(
            "SELECT id,profile_id,profile_stamp,subject,space_id,kind,expires_at,revoked FROM bindings WHERE token_hash=?",
            [digest(token.as_bytes())], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional()?;
        let (binding, profile, stamp, subject, space, kind, expires, revoked) =
            row.ok_or_else(DomainError::denied)?;
        if revoked || expires <= now() || stamp != self.profile_stamp(profile)? {
            return Err(DomainError::denied());
        }
        let matches = match expected {
            ExpectedCaller::Ui { profile: claimed } => {
                kind == "ui" && profile == claimed && space.is_none()
            }
            ExpectedCaller::Mcp {
                binding: b,
                subject: s,
                space: w,
            } => {
                kind == "mcp"
                    && binding == b
                    && subject == s
                    && space.as_deref() == Some(w.as_str())
            }
        };
        if !matches {
            return Err(DomainError::denied());
        }
        Ok(Principal {
            profile,
            kind,
            space,
            binding,
            subject,
        })
    }
    pub fn status(&self, principal: &Principal) -> Value {
        json!({"active":self.active,"binding":principal.binding,"kind":principal.kind,"subject":principal.subject,"space_id":principal.space,"profile_id":principal.profile})
    }
    fn enabled(&self) -> Result<()> {
        if !self.active {
            return Err(DomainError::new(
                "domain_inactive",
                "Notes is not enabled for this household yet.",
                503,
            ));
        }
        Ok(())
    }
    fn current_principal(&self, who: &Principal) -> Result<()> {
        let stamp = self.profile_stamp(who.profile)?;
        let valid:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM bindings WHERE id=? AND profile_id=? AND profile_stamp=? AND subject=? AND kind=? AND space_id IS ? AND revoked=0 AND expires_at>?)",
            params![who.binding,who.profile,stamp,who.subject,who.kind,who.space,now()],|r|r.get(0))?;
        if !valid {
            return Err(DomainError::denied());
        }
        Ok(())
    }
    fn access(db: &Connection, who: &Principal, space: &str, write: bool) -> Result<()> {
        if !valid_id(space) || who.space.as_deref().is_some_and(|bound| bound != space) {
            return Err(DomainError::missing());
        }
        if write && who.kind != "ui" {
            return Err(DomainError::denied());
        }
        let row: Option<(String,String,Option<i64>)> = db.query_row(
            "SELECT m.role,s.kind,s.owner_profile FROM memberships m JOIN spaces s ON s.id=m.space_id WHERE m.profile_id=? AND m.space_id=?",
            params![who.profile, space], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (role, kind, owner) = row.ok_or_else(DomainError::missing)?;
        if kind == "private" && owner != Some(who.profile) {
            return Err(DomainError::missing());
        }
        if write && role != "editor" {
            return Err(DomainError::denied());
        }
        Ok(())
    }
    pub fn scopes(&self, who: &Principal) -> Result<Value> {
        self.enabled()?;
        self.current_principal(who)?;
        let mut rows = self.db.prepare("SELECT s.id,s.name,s.kind,m.role,s.owner_profile FROM spaces s JOIN memberships m ON m.space_id=s.id WHERE m.profile_id=? ORDER BY s.kind,s.name,s.id")?;
        let scopes = rows
            .query_map([who.profile], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(id, _, kind, _, owner)| {
                who.space.as_ref().is_none_or(|s| s == id)
                    && (kind != "private" || *owner == Some(who.profile))
            })
            .map(|(id, name, kind, role, _)| json!({"id":id,"name":name,"kind":kind,"role":role}))
            .collect::<Vec<_>>();
        Ok(json!({"scopes":scopes}))
    }
    pub fn list(&self, who: &Principal, space: &str, query: &NoteQuery) -> Result<Value> {
        self.enabled()?;
        self.current_principal(who)?;
        Self::access(&self.db, who, space, false)?;
        if query.q.len() > 200 {
            return Err(DomainError::invalid());
        }
        let (before, id) = match query.cursor.as_deref() {
            None | Some("") => (i64::MAX, "~".to_string()),
            Some(c) if c.len() <= 160 => {
                let (at, id) = c.split_once(':').ok_or_else(DomainError::invalid)?;
                if !valid_id(id) {
                    return Err(DomainError::invalid());
                }
                (
                    at.parse::<i64>().map_err(|_| DomainError::invalid())?,
                    id.to_string(),
                )
            }
            _ => return Err(DomainError::invalid()),
        };
        let mut statement = self.db.prepare("SELECT document FROM notes WHERE space_id=? AND deleted=0 AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC")?;
        let rows = statement.query_map(params![space, before, before, id], |r| {
            r.get::<_, String>(0)
        })?;
        let needle = query.q.to_lowercase();
        let mut notes = Vec::new();
        for document in rows {
            let n: Note = serde_json::from_str(&document?)?;
            if !needle.is_empty()
                && !n.title.to_lowercase().contains(&needle)
                && !n.body.to_lowercase().contains(&needle)
            {
                continue;
            }
            notes.push(n);
            if notes.len() == 51 {
                break;
            }
        }
        let more = notes.len() > 50;
        notes.truncate(50);
        let cursor = more
            .then(|| notes.last().map(|n| format!("{}:{}", n.updated_at, n.id)))
            .flatten();
        Ok(
            json!({"notes":notes.iter().map(|n|json!({"id":n.id,"space_id":n.space_id,"title":n.title,"preview":n.body.chars().take(160).collect::<String>(),"revision":n.revision,"created_at":n.created_at,"updated_at":n.updated_at})).collect::<Vec<_>>(),"next_cursor":cursor}),
        )
    }
    fn read_db(db: &Connection, space: &str, id: &str) -> Result<Note> {
        if !valid_id(id) {
            return Err(DomainError::missing());
        }
        let document: Option<String> = db
            .query_row(
                "SELECT document FROM notes WHERE id=? AND space_id=? AND deleted=0",
                params![id, space],
                |r| r.get(0),
            )
            .optional()?;
        Ok(serde_json::from_str(
            &document.ok_or_else(DomainError::missing)?,
        )?)
    }
    pub fn read(&self, who: &Principal, space: &str, id: &str) -> Result<Value> {
        self.enabled()?;
        self.current_principal(who)?;
        Self::access(&self.db, who, space, false)?;
        Ok(json!({"note":Self::read_db(&self.db,space,id)?}))
    }
    pub fn create_note(
        &mut self,
        who: &Principal,
        space: &str,
        input: CreateNote,
    ) -> Result<Value> {
        let hash = digest(&serde_json::to_vec(&json!(["create", space, &input]))?);
        let request = input.request_id.clone();
        self.mutate(who, space, &request, &hash, move |db| {
            let title = validate_text(input.title, input.body.as_str())?;
            let n = Note {
                id: uuid::Uuid::new_v4().to_string(),
                space_id: space.into(),
                title,
                body: input.body,
                revision: 1,
                created_at: Some(now()),
                updated_at: now(),
                created_by: Some(who.profile),
                updated_by: Some(who.profile),
                provenance: json!({"source":"family-ui","source_id":null,"imported_from":null}),
            };
            db.execute(
                "INSERT INTO notes(id,space_id,document,revision,updated_at) VALUES(?,?,?,?,?)",
                params![
                    n.id,
                    space,
                    serde_json::to_string(&n)?,
                    n.revision,
                    n.updated_at
                ],
            )?;
            Ok(json!({"note":n}))
        })
    }
    pub fn update_note(
        &mut self,
        who: &Principal,
        space: &str,
        id: &str,
        input: UpdateNote,
    ) -> Result<Value> {
        let hash = digest(&serde_json::to_vec(&json!(["update", space, id, &input]))?);
        let request = input.request_id.clone();
        self.mutate(who, space, &request, &hash, move |db| {
            let mut n = Self::read_db(db, space, id)?;
            check_revision(n.revision, input.revision)?;
            n.title = validate_text(input.title, input.body.as_str())?;
            n.body = input.body;
            n.revision = n.revision.checked_add(1).ok_or_else(DomainError::invalid)?;
            n.updated_at = now();
            n.updated_by = Some(who.profile);
            db.execute(
                "UPDATE notes SET document=?,revision=?,updated_at=? WHERE id=? AND revision=?",
                params![
                    serde_json::to_string(&n)?,
                    n.revision,
                    n.updated_at,
                    id,
                    input.revision
                ],
            )?;
            Ok(json!({"note":n}))
        })
    }
    pub fn delete_note(
        &mut self,
        who: &Principal,
        space: &str,
        id: &str,
        input: DeleteNote,
    ) -> Result<Value> {
        let hash = digest(&serde_json::to_vec(&json!(["delete", space, id, &input]))?);
        let request = input.request_id.clone();
        self.mutate(who, space, &request, &hash, move |db| {
            let mut n = Self::read_db(db, space, id)?;
            check_revision(n.revision, input.revision)?;
            let revision = n.revision.checked_add(1).ok_or_else(DomainError::invalid)?;
            n.revision=revision;
            n.updated_at=now();
            n.updated_by=Some(who.profile);
            db.execute(
                "UPDATE notes SET deleted=1,document=?,revision=?,updated_at=? WHERE id=? AND revision=?",
                params![serde_json::to_string(&n)?, revision, n.updated_at, id, input.revision],
            )?;
            Ok(json!({"id":id,"revision":revision,"deleted":true}))
        })
    }
    fn mutate(
        &mut self,
        who: &Principal,
        space: &str,
        request: &str,
        hash: &str,
        operation: impl FnOnce(&Connection) -> Result<Value>,
    ) -> Result<Value> {
        self.enabled()?;
        self.current_principal(who)?;
        if uuid::Uuid::parse_str(request).is_err() {
            return Err(DomainError::invalid());
        }
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::access(&tx, who, space, true)?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT request_hash,result FROM receipts WHERE profile_id=? AND request_id=?",
                params![who.profile, request],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((stored, result)) = previous {
            if stored != hash {
                return Err(DomainError::new(
                    "idempotency_conflict",
                    "This request ID was already used for different changes.",
                    409,
                ));
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let result = operation(&tx)?;
        tx.execute(
            "INSERT INTO receipts VALUES(?,?,?,?)",
            params![who.profile, request, hash, serde_json::to_string(&result)?],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
fn owner_lock(path: &Path) -> anyhow::Result<std::fs::File> {
    use fs2::FileExt;
    let path = std::fs::canonicalize(path)?;
    let lock = path.with_extension("notes-owner.lock");
    if let Ok(metadata) = std::fs::symlink_metadata(&lock) {
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "Invalid Notes ownership lock"
        );
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)?;
    file.try_lock_exclusive().map_err(|_| {
        anyhow::anyhow!(
            "The Notes store is already open; stop its daemon before offline operations"
        )
    })?;
    Ok(file)
}
fn validate_text(title: String, body: &str) -> Result<String> {
    let title = title.trim().to_string();
    if title.is_empty()
        || title.len() > 240
        || body.len() > 16000
        || title.contains('\0')
        || body.contains('\0')
    {
        return Err(DomainError::invalid());
    }
    Ok(title)
}
fn check_revision(actual: i64, expected: i64) -> Result<()> {
    if actual != expected {
        return Err(DomainError::new(
            "revision_conflict",
            "This note changed. Load the latest version before applying your edits.",
            409,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
