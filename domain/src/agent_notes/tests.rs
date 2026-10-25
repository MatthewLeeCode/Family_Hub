use super::*;
use std::path::PathBuf;

struct Fixture {
    directory: tempfile::TempDir,
    database: PathBuf,
    profiles: PathBuf,
    store: Store,
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("notes.sqlite");
    let profiles = directory.path().join("profiles.sqlite");
    Connection::open(&profiles).unwrap().execute_batch("CREATE TABLE profiles(id INTEGER PRIMARY KEY,passcode_hash TEXT,role TEXT);INSERT INTO profiles VALUES(1,'hash-a','admin'),(2,'hash-b','member')").unwrap();
    let mut store = Store::create(&database, &profiles).unwrap();
    let program = std::env::current_exe().unwrap();
    store
        .provision(
            &provision::DemoSetup {
                profiles: vec![
                    provision::DemoProfile {
                        profile_id: 1,
                        core_subject: "user-a".into(),
                        private_space: "space-a".into(),
                        name: "Matt".into(),
                    },
                    provision::DemoProfile {
                        profile_id: 2,
                        core_subject: "user-b".into(),
                        private_space: "space-b".into(),
                        name: "Nicky".into(),
                    },
                ],
                shared_space: "shared".into(),
                shared_name: "Shared".into(),
            },
            &directory.path().join("ui"),
            &directory.path().join("read"),
            &program,
            12345,
        )
        .unwrap();
    for (profile, subject, space, binding) in [
        (1, "user-a", "space-a", "writer-a"),
        (2, "user-b", "space-b", "writer-b"),
        (1, "user-a", "shared", "writer-shared"),
    ] {
        store
            .enroll_notes_writer(
                &provision::WriterSetup {
                    profile_id: profile,
                    subject: subject.into(),
                    space: space.into(),
                    binding: binding.into(),
                },
                &directory.path().join("writers"),
                &program,
                12345,
            )
            .unwrap();
    }
    store.active = true;
    Fixture {
        directory,
        database,
        profiles,
        store,
    }
}
fn writer(f: &Fixture, binding: &str, subject: &str, space: &str) -> Principal {
    let token = std::fs::read_to_string(
        f.directory
            .path()
            .join("writers")
            .join(binding)
            .join("family-domain.credential"),
    )
    .unwrap();
    f.store
        .authenticate(
            &token,
            ExpectedCaller::Mcp {
                binding: binding.into(),
                subject: subject.into(),
                space: space.into(),
            },
        )
        .unwrap()
}
fn ui(f: &Fixture, profile: i64) -> Principal {
    let token = std::fs::read_to_string(
        f.directory
            .path()
            .join(format!("ui/profile-{profile}.credential")),
    )
    .unwrap();
    f.store
        .authenticate(&token, ExpectedCaller::Ui { profile })
        .unwrap()
}
fn input() -> AgentNoteInput {
    AgentNoteInput {
        title: "  Example  ".into(),
        body: "Original body.".into(),
    }
}
fn operation(input: &AgentNoteInput) -> OperationContext {
    OperationContext {
        version: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_digest: input.request_digest().unwrap(),
    }
}
fn counts(store: &Store) -> (i64, i64) {
    (
        store
            .db
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap(),
        store
            .db
            .query_row("SELECT count(*) FROM agent_note_receipts", [], |r| r.get(0))
            .unwrap(),
    )
}

#[test]
fn raw_digest_vectors_match_the_core_contract() {
    for (title, body, expected) in [
        (
            "Example",
            "A note.",
            "39efa3188210a9dbb5736b865d807db6f7de943733ff36800ceebbd3682c26f6",
        ),
        (
            "  Résumé  ",
            "Line 1\n\"Quoted\" \\ 😀",
            "a0ea5d87d60670ce3056969c27806de14d6ea246fa804bead657da801d814950",
        ),
    ] {
        assert_eq!(
            AgentNoteInput {
                title: title.into(),
                body: body.into()
            }
            .request_digest()
            .unwrap(),
            expected
        );
    }
}

#[test]
fn payload_and_metadata_are_strict_before_effects() {
    let mut f = fixture();
    let who = writer(&f, "writer-a", "user-a", "space-a");
    for (title, body) in [
        (" ".into(), "".into()),
        ("x".repeat(241), "".into()),
        (" ".repeat(1024) + "x", "".into()),
        ("a\0b".into(), "".into()),
        ("x".into(), "a\0b".into()),
        ("x".into(), "😀".repeat(4001)),
    ] {
        let input = AgentNoteInput { title, body };
        let op = operation(&input);
        assert_eq!(
            f.store
                .create_agent_note(&who, "space-a", op, input)
                .unwrap_err()
                .code,
            "validation_error"
        );
    }
    for case in 0..5 {
        let input = input();
        let mut op = operation(&input);
        match case {
            0 => op.version = 2,
            1 => op.operation_id = op.operation_id.to_uppercase(),
            2 => op.operation_id = "not-a-uuid".into(),
            3 => op.request_digest = "A".repeat(64),
            _ => op.request_digest = "0".repeat(64),
        }
        assert_eq!(
            f.store
                .create_agent_note(&who, "space-a", op, input)
                .unwrap_err()
                .code,
            "validation_error"
        );
    }
    assert!(
        serde_json::from_value::<AgentNoteInput>(
            json!({"title":"x","body":"","operation_id":"spoof"})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<OperationContext>(json!({"version":1,"operation_id":uuid::Uuid::new_v4().to_string(),"request_digest":"0".repeat(64),"owner_id":"spoof"})).is_err());
    assert_eq!(counts(&f.store), (0, 0));
}

#[test]
fn dedicated_writer_cannot_read_or_use_human_crud_and_readers_cannot_create() {
    let mut f = fixture();
    let who = writer(&f, "writer-a", "user-a", "space-a");
    let human = ui(&f, 1);
    let note = f
        .store
        .create_note(
            &human,
            "space-a",
            CreateNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Human".into(),
                body: "Private".into(),
            },
        )
        .unwrap()["note"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(f.store.scopes(&who).unwrap_err().code, "access_denied");
    assert_eq!(
        f.store
            .list(&who, "space-a", &NoteQuery::default())
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(
        f.store.read(&who, "space-a", &note).unwrap_err().code,
        "access_denied"
    );
    assert_eq!(
        f.store
            .create_note(
                &who,
                "space-a",
                CreateNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    title: "Bypass".into(),
                    body: "".into()
                }
            )
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(
        f.store
            .update_note(
                &who,
                "space-a",
                &note,
                UpdateNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1,
                    title: "Bypass".into(),
                    body: "".into()
                }
            )
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(
        f.store
            .delete_note(
                &who,
                "space-a",
                &note,
                DeleteNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1
                }
            )
            .unwrap_err()
            .code,
        "access_denied"
    );
    let token = std::fs::read_to_string(
        f.directory
            .path()
            .join("read/family-notes-1-private/family-domain.credential"),
    )
    .unwrap();
    let reader = f
        .store
        .authenticate(
            &token,
            ExpectedCaller::Mcp {
                binding: "family-notes-1-private".into(),
                subject: "user-a".into(),
                space: "space-a".into(),
            },
        )
        .unwrap();
    for principal in [&human, &reader] {
        let input = input();
        assert_eq!(
            f.store
                .create_agent_note(principal, "space-a", operation(&input), input)
                .unwrap_err()
                .code,
            "access_denied"
        );
    }
    let input = input();
    assert_eq!(
        f.store
            .create_agent_note(&who, "shared", operation(&input), input)
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(counts(&f.store), (1, 0));
}

#[test]
fn exact_receipt_survives_human_edit_delete_restart_and_conflicting_retry() {
    let mut f = fixture();
    let who = writer(&f, "writer-shared", "user-a", "shared");
    let human = ui(&f, 2);
    let input = input();
    let op = operation(&input);
    let original = f
        .store
        .create_agent_note(&who, "shared", op.clone(), input.clone())
        .unwrap();
    assert_eq!(original.note.title, "Example");
    assert_eq!(original.note.created_by, Some(1));
    assert_eq!(
        original,
        f.store
            .create_agent_note(&who, "shared", op.clone(), input.clone())
            .unwrap()
    );
    f.store
        .update_note(
            &human,
            "shared",
            &original.note.id,
            UpdateNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                title: "Human update".into(),
                body: "Changed".into(),
            },
        )
        .unwrap();
    assert_eq!(
        original,
        f.store
            .create_agent_note(&who, "shared", op.clone(), input.clone())
            .unwrap()
    );
    f.store
        .delete_note(
            &human,
            "shared",
            &original.note.id,
            DeleteNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                revision: 2,
            },
        )
        .unwrap();
    assert!(
        f.store
            .db
            .execute("UPDATE agent_note_receipts SET result='{}'", [])
            .is_err()
    );
    assert!(
        f.store
            .db
            .execute("DELETE FROM agent_note_receipts", [])
            .is_err()
    );
    drop(f.store);
    f.store = Store::open(&f.database, &f.profiles, true).unwrap();
    let who = writer(&f, "writer-shared", "user-a", "shared");
    assert_eq!(
        original,
        f.store
            .create_agent_note(&who, "shared", op.clone(), input.clone())
            .unwrap()
    );
    let changed = AgentNoteInput {
        title: input.title.trim().into(),
        body: input.body,
    };
    let conflict = OperationContext {
        request_digest: changed.request_digest().unwrap(),
        ..op.clone()
    };
    assert_eq!(
        f.store
            .create_agent_note(&who, "shared", conflict, changed)
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    assert_eq!(counts(&f.store), (1, 1));
    f.store.active = false;
    let evidence = f
        .store
        .inspect_agent_note_receipt("writer-shared", &op.operation_id)
        .unwrap();
    assert_eq!(evidence["status"], "committed");
    assert!(!evidence.to_string().contains("Original body"));
}

#[test]
fn receipt_insert_failure_rolls_back_note_atomically() {
    let mut f = fixture();
    let who = writer(&f, "writer-a", "user-a", "space-a");
    f.store.db.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_note_receipts BEGIN SELECT RAISE(ABORT,'injected failure'); END").unwrap();
    let input = input();
    let op = operation(&input);
    assert_eq!(
        f.store
            .create_agent_note(&who, "space-a", op.clone(), input.clone())
            .unwrap_err()
            .code,
        "domain_unavailable"
    );
    assert_eq!(counts(&f.store), (0, 0));
    f.store
        .db
        .execute_batch("DROP TRIGGER fail_receipt")
        .unwrap();
    f.store
        .create_agent_note(&who, "space-a", op, input)
        .unwrap();
    assert_eq!(counts(&f.store), (1, 1));
}

#[test]
fn current_authority_is_checked_before_replaying_receipts() {
    for mutation in [
        "UPDATE bindings SET revoked=1 WHERE id='writer-a'",
        "UPDATE bindings SET expires_at=0 WHERE id='writer-a'",
        "UPDATE bindings SET mcp_create=0 WHERE id='writer-a'",
        "UPDATE memberships SET role='viewer' WHERE profile_id=1 AND space_id='space-a'",
        "UPDATE spaces SET owner_profile=2 WHERE id='space-a'",
    ] {
        let mut f = fixture();
        let who = writer(&f, "writer-a", "user-a", "space-a");
        let input = input();
        let op = operation(&input);
        f.store
            .create_agent_note(&who, "space-a", op.clone(), input.clone())
            .unwrap();
        f.store.db.execute_batch(mutation).unwrap();
        assert_eq!(
            f.store
                .create_agent_note(&who, "space-a", op, input)
                .unwrap_err()
                .code,
            "access_denied",
            "{mutation}"
        );
        assert_eq!(counts(&f.store), (1, 1));
    }
}

#[test]
fn family_stamp_is_read_after_waiting_for_notes_write_lock() {
    let mut f = fixture();
    let who = writer(&f, "writer-a", "user-a", "space-a");
    static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    fn waiting(attempt: i32) -> bool {
        BUSY.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(5));
        attempt < 400
    }
    BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    f.store.db.busy_handler(Some(waiting)).unwrap();
    let profiles = f.profiles.clone();
    let lock = Connection::open(&f.database).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let task = std::thread::spawn(move || {
        let input = input();
        let error = f
            .store
            .create_agent_note(&who, "space-a", operation(&input), input)
            .unwrap_err();
        (f, error)
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "Writer did not reach its Notes lock"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    Connection::open(profiles)
        .unwrap()
        .execute("UPDATE profiles SET passcode_hash='changed' WHERE id=1", [])
        .unwrap();
    lock.execute_batch("COMMIT").unwrap();
    let (f, error) = task.join().unwrap();
    assert_eq!(error.code, "access_denied");
    assert_eq!(counts(&f.store), (0, 0));
}

#[test]
fn explicit_schema_migration_preserves_rows_defaults_and_refuses_unknown_schema() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("old.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute_batch("INSERT INTO domain_meta VALUES('instance','preserved');INSERT INTO spaces VALUES('shared','Shared','shared',NULL);INSERT INTO memberships VALUES('shared',1,'editor');INSERT INTO bindings(id,token_hash,profile_id,profile_stamp,subject,space_id,kind,expires_at) VALUES('old','hash',1,'stamp','user-a','shared','mcp',9999999999999);INSERT INTO receipts VALUES(1,'request','digest','{\"kept\":true}')").unwrap();
    db.execute_batch(IMPORT_SCHEMA).unwrap();
    drop(db);
    assert_eq!(
        Store::migrate_agent_notes(&path).unwrap(),
        json!({"schema_version":2,"applied":true})
    );
    assert_eq!(
        Store::migrate_agent_notes(&path).unwrap(),
        json!({"schema_version":2,"applied":false})
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT mcp_create FROM bindings WHERE id='old'", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT result FROM receipts", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "{\"kept\":true}"
    );
    db.execute_batch("CREATE TABLE unexpected(value TEXT)")
        .unwrap();
    drop(db);
    assert!(Store::migrate_agent_notes(&path).is_err());
}

#[test]
fn enrollment_never_upgrades_readers_or_overwrites_tokens() {
    let mut f = fixture();
    f.store.active = false;
    let program = std::env::current_exe().unwrap();
    let setup = provision::WriterSetup {
        profile_id: 1,
        subject: "user-a".into(),
        space: "space-a".into(),
        binding: "writer-a".into(),
    };
    let path = f
        .directory
        .path()
        .join("writers/writer-a/family-domain.credential");
    let token = std::fs::read(&path).unwrap();
    assert!(
        f.store
            .enroll_notes_writer(&setup, &f.directory.path().join("writers"), &program, 12345)
            .is_err()
    );
    assert_eq!(std::fs::read(path).unwrap(), token);
    assert_eq!(
        f.store
            .db
            .query_row(
                "SELECT count(*) FROM bindings WHERE kind='mcp' AND mcp_create=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        4
    );
    assert!(Store::migrate_agent_notes(&f.database).is_err()); // ownership lock
}

#[test]
fn failed_schema_allocation_rolls_back_the_entire_migration() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute("INSERT INTO domain_meta VALUES('instance','untouched')", [])
        .unwrap();
    let before = schema_rows(&db).unwrap();
    let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    db.pragma_update(None, "max_page_count", pages).unwrap();
    {
        let probe = db.transaction().unwrap();
        probe
            .execute_batch(&MIGRATION[..MIGRATION.find("CREATE TABLE").unwrap()])
            .unwrap();
        probe.rollback().unwrap();
    }
    // The ALTER fits in the existing schema page. Receipt-table allocation then
    // fails as SQLITE_FULL inside the same production migration transaction.
    assert!(migrate_db(&mut db).is_err());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(schema_rows(&db).unwrap(), before);
    assert_eq!(
        db.query_row(
            "SELECT value FROM domain_meta WHERE key='instance'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "untouched"
    );
    db.pragma_update(None, "max_page_count", pages + 20)
        .unwrap();
    assert!(migrate_db(&mut db).unwrap());
    assert!(!migrate_db(&mut db).unwrap());
}

#[test]
fn customized_table_with_sqlite_lookalike_prefix_is_not_hidden_by_schema_filter() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute_batch("CREATE TABLE sqliteXcustom(value TEXT)")
        .unwrap();
    assert!(migrate_db(&mut db).is_err());
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
