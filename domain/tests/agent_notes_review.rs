//! Independent domain checks using only synthetic stores and public operations.
use family_domain::{
    CreateNote, DeleteNote, ExpectedCaller, NoteQuery, Principal, Store, UpdateNote,
    agent_notes::{AgentNoteInput, OperationContext},
    digest, now,
};
use rusqlite::{Connection, params, types::Value};
use std::path::{Path, PathBuf};

struct Fixture {
    _directory: tempfile::TempDir,
    notes: PathBuf,
    profiles: PathBuf,
}
impl Fixture {
    fn new(seed: bool) -> anyhow::Result<Self> {
        let directory = tempfile::tempdir()?;
        let notes = directory.path().join("notes.sqlite");
        let profiles = directory.path().join("profiles.sqlite");
        let family = Connection::open(&profiles)?;
        family.execute_batch("CREATE TABLE profiles(id INTEGER PRIMARY KEY,passcode_hash TEXT,role TEXT NOT NULL); INSERT INTO profiles VALUES(1,'stamp-1','admin'),(2,'stamp-2','member');")?;
        drop(family);
        drop(Store::create(&notes, &profiles)?);
        if seed {
            let db = Connection::open(&notes)?;
            db.execute_batch("INSERT INTO spaces VALUES('space-a','A','private',1),('space-b','B','private',2),('shared','Shared','shared',NULL); INSERT INTO memberships VALUES('space-a',1,'editor'),('space-b',2,'editor'),('shared',1,'editor'),('shared',2,'editor');")?;
            let stamp = digest(b"stamp-1:admin");
            for (id, token, kind, space, create) in [
                ("ui-a", "1", "ui", None, 0),
                ("read-a", "2", "mcp", Some("space-a"), 0),
                ("writer-a", "3", "mcp", Some("space-a"), 1),
            ] {
                db.execute("INSERT INTO bindings(id,token_hash,profile_id,profile_stamp,subject,space_id,kind,expires_at,mcp_create) VALUES(?,?,1,?,'user-a',?,?,?,?)",
                    params![id,digest(token.repeat(64).as_bytes()),stamp,space,kind,now()+86_400_000,create])?;
            }
        }
        Ok(Self {
            _directory: directory,
            notes,
            profiles,
        })
    }
    fn open(&self, active: bool) -> anyhow::Result<Store> {
        Store::open(&self.notes, &self.profiles, active)
    }
    fn writer(&self, store: &Store) -> anyhow::Result<Principal> {
        Ok(store.authenticate(
            &"3".repeat(64),
            ExpectedCaller::Mcp {
                binding: "writer-a".into(),
                subject: "user-a".into(),
                space: "space-a".into(),
            },
        )?)
    }
    fn ui(&self, store: &Store) -> anyhow::Result<Principal> {
        Ok(store.authenticate(&"1".repeat(64), ExpectedCaller::Ui { profile: 1 })?)
    }
}

fn input() -> AgentNoteInput {
    AgentNoteInput {
        title: "  Historical creation  ".into(),
        body: "Original synthetic content.\n".into(),
    }
}
fn operation(input: &AgentNoteInput) -> anyhow::Result<OperationContext> {
    Ok(OperationContext {
        version: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_digest: input.request_digest()?,
    })
}
type State = Vec<(String, Vec<String>)>;
fn state(path: &Path) -> anyhow::Result<State> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query =
        db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")?;
    let names = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for name in names {
        anyhow::ensure!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
        let mut query = db.prepare(&format!("SELECT * FROM {name}"))?;
        let columns = query.column_count();
        let mut rows = query
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map(|values| format!("{values:?}"))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort();
        result.push((name, rows));
    }
    Ok(result)
}
fn unchanged(before: &State, path: &Path, label: &str) -> anyhow::Result<()> {
    let after = state(path)?;
    let changed: Vec<_> = before
        .iter()
        .filter(|row| !after.contains(row))
        .map(|row| &row.0)
        .collect();
    assert_eq!(before.len(), after.len(), "{label}: table count");
    assert!(changed.is_empty(), "{label}: changed tables {changed:?}");
    Ok(())
}

#[test]
fn customized_check_literals_are_not_normalized_into_an_accepted_schema() -> anyhow::Result<()> {
    let fixture = Fixture::new(false)?;
    let db = Connection::open(&fixture.notes)?;
    let ddl: String = db.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='spaces'",
        [],
        |r| r.get(0),
    )?;
    let customized = ddl.replace("'private'", "'PRIVATE'");
    assert_ne!(customized, ddl);
    db.execute_batch("DROP TABLE spaces")?;
    db.execute_batch(&customized)?;
    assert!(
        db.execute("INSERT INTO spaces VALUES('proof','Proof','private',1)", [])
            .is_err()
    );
    drop(db);
    let before = state(&fixture.notes)?;
    assert!(Store::migrate_agent_notes(&fixture.notes).is_err());
    assert!(fixture.open(true).is_err());
    unchanged(&before, &fixture.notes, "custom schema refusal")?;
    Ok(())
}

#[test]
fn original_creation_receipt_survives_human_edit_delete_and_restart_without_disclosing_new_content()
-> anyhow::Result<()> {
    let fixture = Fixture::new(true)?;
    let mut store = fixture.open(true)?;
    let writer = fixture.writer(&store)?;
    let ui = fixture.ui(&store)?;
    let input = input();
    let operation = operation(&input)?;
    let original = store.create_agent_note(&writer, "space-a", operation.clone(), input.clone())?;
    let edited = store.update_note(
        &ui,
        "space-a",
        &original.note.id,
        UpdateNote {
            request_id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            title: "Human edit".into(),
            body: "LATER HUMAN CONTENT MUST NOT ENTER CREATION RECEIPT".into(),
        },
    )?;
    assert_eq!(edited["note"]["revision"], 2);
    let before = state(&fixture.notes)?;
    assert_eq!(
        store.create_agent_note(&writer, "space-a", operation.clone(), input.clone())?,
        original
    );
    unchanged(&before, &fixture.notes, "replay after edit")?;
    store.delete_note(
        &ui,
        "space-a",
        &original.note.id,
        DeleteNote {
            request_id: uuid::Uuid::new_v4().to_string(),
            revision: 2,
        },
    )?;
    drop(store);
    let mut store = fixture.open(true)?;
    let writer = fixture.writer(&store)?;
    let before = state(&fixture.notes)?;
    assert_eq!(
        store.create_agent_note(&writer, "space-a", operation.clone(), input.clone())?,
        original
    );
    unchanged(&before, &fixture.notes, "replay after delete/restart")?;
    let mut changed = input;
    changed.title = changed.title.trim().into();
    let mut reused = operation;
    reused.request_digest = changed.request_digest()?;
    let error = store
        .create_agent_note(&writer, "space-a", reused, changed)
        .unwrap_err();
    assert_eq!(error.code, "idempotency_conflict");
    assert!(!serde_json::to_string(&error)?.contains("Original synthetic"));
    unchanged(
        &before,
        &fixture.notes,
        "raw title change conflicts despite equal trimmed title",
    )?;
    drop(store);
    let inactive = fixture.open(false)?;
    let inspection = inactive.inspect_agent_note_receipt("writer-a", &original.operation_id)?;
    assert_eq!(inspection["status"], "committed");
    assert_eq!(inspection["note_id"], original.note.id);
    assert!(!inspection.to_string().contains("Historical creation"));
    assert!(!inspection.to_string().contains("Original synthetic"));
    unchanged(&before, &fixture.notes, "operator inspection is read-only")?;
    Ok(())
}

#[test]
fn writer_is_create_only_and_old_read_or_ui_tokens_never_become_writer_authority()
-> anyhow::Result<()> {
    let fixture = Fixture::new(true)?;
    let mut store = fixture.open(true)?;
    let writer = fixture.writer(&store)?;
    let ui = fixture.ui(&store)?;
    let reader = store.authenticate(
        &"2".repeat(64),
        ExpectedCaller::Mcp {
            binding: "read-a".into(),
            subject: "user-a".into(),
            space: "space-a".into(),
        },
    )?;
    let input = input();
    let operation = operation(&input)?;
    let created = store.create_agent_note(&writer, "space-a", operation.clone(), input.clone())?;
    assert!(store.read(&reader, "space-a", &created.note.id).is_ok());
    let before = state(&fixture.notes)?;
    assert!(store.scopes(&writer).is_err());
    assert!(
        store
            .list(&writer, "space-a", &NoteQuery::default())
            .is_err()
    );
    assert!(store.read(&writer, "space-a", &created.note.id).is_err());
    assert!(
        store
            .create_note(
                &writer,
                "space-a",
                CreateNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    title: "No".into(),
                    body: "No".into()
                }
            )
            .is_err()
    );
    assert!(
        store
            .update_note(
                &writer,
                "space-a",
                &created.note.id,
                UpdateNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1,
                    title: "No".into(),
                    body: "No".into()
                }
            )
            .is_err()
    );
    assert!(
        store
            .delete_note(
                &writer,
                "space-a",
                &created.note.id,
                DeleteNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1
                }
            )
            .is_err()
    );
    assert!(
        store
            .create_agent_note(&reader, "space-a", operation.clone(), input.clone())
            .is_err()
    );
    assert!(
        store
            .create_agent_note(&ui, "space-a", operation.clone(), input.clone())
            .is_err()
    );
    assert!(
        store
            .create_agent_note(&writer, "space-b", operation.clone(), input.clone())
            .is_err()
    );
    assert!(
        store
            .create_agent_note(&writer, "shared", operation, input)
            .is_err()
    );
    unchanged(&before, &fixture.notes, "rights remain separated")?;
    Ok(())
}

#[test]
fn existing_receipt_does_not_bypass_current_binding_membership_or_profile_checks()
-> anyhow::Result<()> {
    let fixture = Fixture::new(true)?;
    let mut store = fixture.open(true)?;
    let writer = fixture.writer(&store)?;
    let input = input();
    let operation = operation(&input)?;
    store.create_agent_note(&writer, "space-a", operation.clone(), input.clone())?;
    let db = Connection::open(&fixture.notes)?;
    for (change, restore) in [
        (
            "UPDATE bindings SET mcp_create=0 WHERE id='writer-a'",
            "UPDATE bindings SET mcp_create=1 WHERE id='writer-a'",
        ),
        (
            "UPDATE bindings SET revoked=1 WHERE id='writer-a'",
            "UPDATE bindings SET revoked=0 WHERE id='writer-a'",
        ),
        (
            "UPDATE bindings SET subject='other' WHERE id='writer-a'",
            "UPDATE bindings SET subject='user-a' WHERE id='writer-a'",
        ),
        (
            "UPDATE bindings SET profile_id=2 WHERE id='writer-a'",
            "UPDATE bindings SET profile_id=1 WHERE id='writer-a'",
        ),
        (
            "UPDATE bindings SET space_id='space-b' WHERE id='writer-a'",
            "UPDATE bindings SET space_id='space-a' WHERE id='writer-a'",
        ),
        (
            "UPDATE memberships SET role='viewer' WHERE space_id='space-a' AND profile_id=1",
            "UPDATE memberships SET role='editor' WHERE space_id='space-a' AND profile_id=1",
        ),
        (
            "UPDATE spaces SET owner_profile=2 WHERE id='space-a'",
            "UPDATE spaces SET owner_profile=1 WHERE id='space-a'",
        ),
    ] {
        db.execute(change, [])?;
        let before = state(&fixture.notes)?;
        assert!(
            store
                .create_agent_note(&writer, "space-a", operation.clone(), input.clone())
                .is_err(),
            "{change}"
        );
        unchanged(&before, &fixture.notes, change)?;
        db.execute(restore, [])?;
    }
    let family = Connection::open(&fixture.profiles)?;
    family.execute(
        "UPDATE profiles SET passcode_hash='changed-stamp' WHERE id=1",
        [],
    )?;
    let before = state(&fixture.notes)?;
    assert!(
        store
            .create_agent_note(&writer, "space-a", operation, input)
            .is_err()
    );
    unchanged(
        &before,
        &fixture.notes,
        "fresh profile stamp before receipt lookup",
    )?;
    Ok(())
}

#[test]
fn receipt_insert_failure_rolls_back_the_note_and_exact_operation_can_be_observed_as_absent()
-> anyhow::Result<()> {
    let fixture = Fixture::new(true)?;
    let mut store = fixture.open(true)?;
    let writer = fixture.writer(&store)?;
    let input = input();
    let operation = operation(&input)?;
    let db = Connection::open(&fixture.notes)?;
    db.execute_batch("CREATE TRIGGER review_receipt_failure BEFORE INSERT ON agent_note_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;")?;
    let before = state(&fixture.notes)?;
    assert!(
        store
            .create_agent_note(&writer, "space-a", operation.clone(), input.clone())
            .is_err()
    );
    unchanged(
        &before,
        &fixture.notes,
        "note and receipt roll back together",
    )?;
    db.execute_batch("DROP TRIGGER review_receipt_failure")?;
    drop(store);
    let inactive = fixture.open(false)?;
    assert_eq!(
        inactive.inspect_agent_note_receipt("writer-a", &operation.operation_id)?["status"],
        "not_found"
    );
    // This observation is not a core retry permission or a claim about arbitrary
    // lost acknowledgements. The deterministic SQL fault above rolled back here.
    Ok(())
}
