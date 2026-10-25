use super::*;
use std::path::PathBuf;

struct Fixture {
    dir: tempfile::TempDir,
    database: PathBuf,
    profiles: PathBuf,
    store: Store,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path().join("profiles.sqlite");
    let database = dir.path().join("notes.sqlite");
    let conn = Connection::open(&profiles).unwrap();
    conn.execute_batch("CREATE TABLE profiles(id INTEGER PRIMARY KEY,passcode_hash TEXT,role TEXT); INSERT INTO profiles VALUES(1,'hash-a','admin'),(2,'hash-b','member');").unwrap();
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
                        name: "A".into(),
                    },
                    provision::DemoProfile {
                        profile_id: 2,
                        core_subject: "user-b".into(),
                        private_space: "space-b".into(),
                        name: "B".into(),
                    },
                ],
                shared_space: "shared".into(),
                shared_name: "Shared".into(),
            },
            &dir.path().join("ui"),
            &dir.path().join("mcp"),
            &program,
            4291,
        )
        .unwrap();
    store.active = true;
    Fixture {
        dir,
        database,
        profiles,
        store,
    }
}
fn ui(f: &Fixture, id: i64) -> Principal {
    let token = std::fs::read_to_string(
        f.dir
            .path()
            .join("ui")
            .join(format!("profile-{id}.credential")),
    )
    .unwrap();
    f.store
        .authenticate(&token, ExpectedCaller::Ui { profile: id })
        .unwrap()
}
fn create(title: &str) -> CreateNote {
    CreateNote {
        request_id: uuid::Uuid::new_v4().to_string(),
        title: title.into(),
        body: "A private synthetic note".into(),
    }
}

#[test]
fn private_shared_scope_and_revision_checked_crud() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let b = ui(&f, 2);
    let note = f
        .store
        .create_note(&a, "space-a", create("Private"))
        .unwrap()["note"]
        .clone();
    let id = note["id"].as_str().unwrap();
    assert_eq!(
        f.store.read(&b, "space-a", id).unwrap_err().code,
        "not_found"
    );
    assert_eq!(
        f.store.read(&b, "space-b", id).unwrap_err().code,
        "not_found"
    );
    let shared = f.store.create_note(&a, "shared", create("Shared")).unwrap()["note"].clone();
    let shared_id = shared["id"].as_str().unwrap();
    assert_eq!(
        f.store.read(&b, "shared", shared_id).unwrap()["note"]["title"],
        "Shared"
    );
    let changed = f
        .store
        .update_note(
            &b,
            "shared",
            shared_id,
            UpdateNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                title: "Updated".into(),
                body: "New text".into(),
            },
        )
        .unwrap();
    assert_eq!(changed["note"]["revision"], 2);
    assert_eq!(changed["note"]["updated_by"], 2);
    assert_eq!(
        f.store
            .delete_note(
                &a,
                "shared",
                shared_id,
                DeleteNote {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    revision: 1
                }
            )
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    f.store
        .delete_note(
            &a,
            "shared",
            shared_id,
            DeleteNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                revision: 2,
            },
        )
        .unwrap();
    let (document, revision, updated_at, deleted): (String, i64, i64, bool) = f
        .store
        .db
        .query_row(
            "SELECT document,revision,updated_at,deleted FROM notes WHERE id=?",
            [shared_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    let tombstone: Note = serde_json::from_str(&document).unwrap();
    assert!(deleted);
    assert_eq!(tombstone.revision, revision);
    assert_eq!(tombstone.updated_at, updated_at);
    assert_eq!(tombstone.updated_by, Some(1));
    assert_eq!(
        f.store.read(&a, "shared", shared_id).unwrap_err().code,
        "not_found"
    );
    assert_eq!(f.store.read(&a, "space-a", id).unwrap()["note"], note);
}

#[test]
fn idempotency_and_revisions_survive_restart_without_duplicate_writes() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let input = create("One copy");
    let original = serde_json::to_value(&input).unwrap();
    let result = f.store.create_note(&a, "space-a", input).unwrap();
    drop(f.store);
    f.store = Store::open(&f.database, &f.profiles, true).unwrap();
    let a = ui(&f, 1);
    assert_eq!(
        f.store
            .create_note(
                &a,
                "space-a",
                serde_json::from_value(original.clone()).unwrap()
            )
            .unwrap(),
        result
    );
    let mut changed = original.clone();
    changed["body"] = json!("different");
    assert_eq!(
        f.store
            .create_note(&a, "space-a", serde_json::from_value(changed).unwrap())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    assert_eq!(
        f.store
            .create_note(&a, "shared", serde_json::from_value(original).unwrap())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    assert_eq!(
        f.store.list(&a, "space-a", &NoteQuery::default()).unwrap()["notes"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let id = result["note"]["id"].as_str().unwrap();
    let deletion = DeleteNote {
        request_id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
    };
    let copy = serde_json::to_value(&deletion).unwrap();
    let result = f.store.delete_note(&a, "space-a", id, deletion).unwrap();
    assert_eq!(
        f.store
            .delete_note(&a, "space-a", id, serde_json::from_value(copy).unwrap())
            .unwrap(),
        result
    );
}

#[test]
fn token_bindings_are_exact_and_mcp_cannot_mutate_even_with_valid_credentials() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let token = std::fs::read_to_string(
        f.dir
            .path()
            .join("mcp/family-notes-1-private/family-domain.credential"),
    )
    .unwrap();
    let expected = || ExpectedCaller::Mcp {
        binding: "family-notes-1-private".into(),
        subject: "user-a".into(),
        space: "space-a".into(),
    };
    let mcp = f.store.authenticate(&token, expected()).unwrap();
    assert_eq!(
        f.store
            .create_note(&mcp, "space-a", create("Denied"))
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(
        f.store
            .list(&mcp, "shared", &NoteQuery::default())
            .unwrap_err()
            .code,
        "not_found"
    );
    assert!(
        f.store
            .authenticate(&token, ExpectedCaller::Ui { profile: 1 })
            .is_err()
    );
    assert!(
        f.store
            .authenticate(
                &token,
                ExpectedCaller::Mcp {
                    binding: "family-notes-1-private".into(),
                    subject: "user-b".into(),
                    space: "space-a".into()
                }
            )
            .is_err()
    );
    assert!(
        f.store
            .authenticate(
                &token,
                ExpectedCaller::Mcp {
                    binding: "family-notes-1-private".into(),
                    subject: "user-a".into(),
                    space: "shared".into()
                }
            )
            .is_err()
    );
    f.store
        .db
        .execute(
            "UPDATE bindings SET revoked=1 WHERE id='family-notes-1-private'",
            [],
        )
        .unwrap();
    assert!(f.store.authenticate(&token, expected()).is_err());
    assert!(
        f.store
            .list(&mcp, "space-a", &NoteQuery::default())
            .is_err()
    );
    f.store
        .db
        .execute(
            "UPDATE memberships SET role='viewer' WHERE profile_id=1 AND space_id='shared'",
            [],
        )
        .unwrap();
    assert!(f.store.create_note(&a, "shared", create("Denied")).is_err());
}

#[test]
fn profile_revocation_and_inactive_authority_fail_closed() {
    for sql in [
        "UPDATE profiles SET passcode_hash='new' WHERE id=1",
        "UPDATE profiles SET role='member' WHERE id=1",
        "DELETE FROM profiles WHERE id=1",
    ] {
        let f = fixture();
        let a = ui(&f, 1);
        Connection::open(&f.profiles)
            .unwrap()
            .execute(sql, [])
            .unwrap();
        assert!(f.store.list(&a, "space-a", &NoteQuery::default()).is_err());
        let token = std::fs::read_to_string(f.dir.path().join("ui/profile-1.credential")).unwrap();
        assert!(
            f.store
                .authenticate(&token, ExpectedCaller::Ui { profile: 1 })
                .is_err()
        );
    }
    let mut f = fixture();
    let a = ui(&f, 1);
    f.store.active = false;
    assert_eq!(
        f.store
            .create_note(&a, "space-a", create("Disabled"))
            .unwrap_err()
            .code,
        "domain_inactive"
    );
    assert_eq!(f.store.scopes(&a).unwrap_err().code, "domain_inactive");
    assert_eq!(f.store.status(&a)["active"], false);
}

#[test]
fn list_cursor_search_validation_and_no_silent_store_initialization() {
    let mut f = fixture();
    let a = ui(&f, 1);
    for i in 0..52 {
        f.store
            .create_note(&a, "space-a", create(&format!("Note {i}")))
            .unwrap();
    }
    let first = f.store.list(&a, "space-a", &NoteQuery::default()).unwrap();
    assert_eq!(first["notes"].as_array().unwrap().len(), 50);
    let next = f
        .store
        .list(
            &a,
            "space-a",
            &NoteQuery {
                q: String::new(),
                cursor: Some(first["next_cursor"].as_str().unwrap().into()),
            },
        )
        .unwrap();
    assert_eq!(next["notes"].as_array().unwrap().len(), 2);
    let search = f
        .store
        .list(
            &a,
            "space-a",
            &NoteQuery {
                q: "Note 51".into(),
                cursor: None,
            },
        )
        .unwrap();
    assert_eq!(search["notes"].as_array().unwrap().len(), 1);
    let mut bad = create(" ");
    assert_eq!(
        f.store.create_note(&a, "space-a", bad).unwrap_err().code,
        "validation_error"
    );
    bad = create("valid");
    bad.body = "a".repeat(16001);
    assert!(f.store.create_note(&a, "space-a", bad).is_err());
    assert!(
        serde_json::from_value::<CreateNote>(
            json!({"request_id":"id","title":"x","body":"x","profile_id":2})
        )
        .is_err()
    );
    assert!(Store::open(&f.dir.path().join("missing.sqlite"), &f.profiles, true).is_err());
    let empty = f.dir.path().join("empty.sqlite");
    std::fs::write(&empty, []).unwrap();
    assert!(Store::open(&empty, &f.profiles, true).is_err());
    assert!(Store::create(&f.database, &f.profiles).is_err());
}

#[tokio::test]
async fn real_http_and_native_adapter_share_one_store_and_deny_identity_in_arguments() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let note = f
        .store
        .create_note(&a, "space-a", create("Read through MCP"))
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(axum::serve(listener, crate::http::router(f.store)).into_future());
    let adapter = mcp::NotesMcp::connect(
        port,
        "family-notes-1-private".into(),
        "user-a".into(),
        "space-a".into(),
        &f.dir
            .path()
            .join("mcp/family-notes-1-private/family-domain.credential"),
    )
    .await
    .unwrap();
    assert_eq!(
        adapter
            .invoke("notes_read", json!({"id":note["note"]["id"]}))
            .await
            .unwrap(),
        note
    );
    assert!(
        adapter
            .invoke("notes_list", json!({"space_id":"shared"}))
            .await
            .is_err()
    );
    assert!(
        adapter
            .invoke("notes_create", json!({"title":"No writes"}))
            .await
            .is_err()
    );
    assert!(
        mcp::NotesMcp::connect(
            port,
            "family-notes-1-private".into(),
            "user-b".into(),
            "space-a".into(),
            &f.dir
                .path()
                .join("mcp/family-notes-1-private/family-domain.credential")
        )
        .await
        .is_err()
    );
    handle.abort();
}

fn export_payload(export_id: &str, notes: Value) -> Vec<u8> {
    let payload = json!({"export_id":export_id,"created_at":1000,"notes":notes}).to_string();
    serde_json::to_vec(&json!({"format":"personal-assistant-notes-export/1","sha256":digest(payload.as_bytes()),"payload":payload})).unwrap()
}
fn legacy(id: &str, space: &str, deleted: bool) -> Value {
    json!({"id":id,"space_id":space,"title":"Historical note","body":"Unchanged source text","revision":7,"updated_at":456,"deleted":deleted})
}
#[test]
fn offline_import_preserves_history_tombstones_and_replay_after_human_edit() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let export_id = uuid::Uuid::new_v4().to_string();
    let bytes = export_payload(
        &export_id,
        json!([
            legacy("legacy-live", "space-a", false),
            legacy("legacy-deleted", "shared", true)
        ]),
    );
    assert!(f.store.import_core_notes(&bytes).is_err());
    f.store.active = false;
    assert_eq!(f.store.import_core_notes(&bytes).unwrap()["notes"], 2);
    f.store.active = true;
    let note = f.store.read(&a, "space-a", "legacy-live").unwrap()["note"].clone();
    assert_eq!(note["id"], "legacy-live");
    assert_eq!(note["revision"], 7);
    assert_eq!(note["updated_at"], 456);
    assert!(
        note["created_at"].is_null()
            && note["created_by"].is_null()
            && note["updated_by"].is_null()
    );
    assert_eq!(note["provenance"]["export_id"], export_id);
    assert_eq!(note["provenance"]["source_id"], "legacy-live");
    assert!(f.store.read(&a, "shared", "legacy-deleted").is_err());
    f.store
        .update_note(
            &a,
            "space-a",
            "legacy-live",
            UpdateNote {
                request_id: uuid::Uuid::new_v4().to_string(),
                revision: 7,
                title: "Edited after import".into(),
                body: "New text".into(),
            },
        )
        .unwrap();
    drop(f.store);
    f.store = Store::open(&f.database, &f.profiles, false).unwrap();
    assert_eq!(
        f.store.import_core_notes(&bytes).unwrap()["already_imported"],
        true
    );
    f.store.active = true;
    let a = ui(&f, 1);
    assert_eq!(
        f.store.read(&a, "space-a", "legacy-live").unwrap()["note"]["revision"],
        8
    );
    assert_eq!(
        f.store.read(&a, "space-a", "legacy-live").unwrap()["note"]["created_by"],
        Value::Null
    );
}
#[test]
fn import_rolls_back_entire_batch_on_unknown_scope_duplicate_or_id_collision() {
    let mut f = fixture();
    f.store.active = false;
    for rows in [
        json!([
            legacy("first", "space-a", false),
            legacy("second", "unknown-space", false)
        ]),
        json!([
            legacy("same", "space-a", false),
            legacy("same", "shared", false)
        ]),
    ] {
        assert!(
            f.store
                .import_core_notes(&export_payload(&uuid::Uuid::new_v4().to_string(), rows))
                .is_err()
        );
        assert_eq!(
            f.store
                .db
                .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let bytes = export_payload(&id, json!([legacy("existing", "space-a", false)]));
    f.store.import_core_notes(&bytes).unwrap();
    assert!(
        f.store
            .import_core_notes(&export_payload(
                &uuid::Uuid::new_v4().to_string(),
                json!([
                    legacy("new", "space-a", false),
                    legacy("existing", "space-a", false)
                ])
            ))
            .is_err()
    );
    assert_eq!(
        f.store
            .db
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        f.store
            .import_core_notes(&export_payload(&id, json!([])))
            .is_err()
    );
    let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
    envelope["sha256"] = json!("0".repeat(64));
    assert!(
        f.store
            .import_core_notes(&serde_json::to_vec(&envelope).unwrap())
            .is_err()
    );
    assert!(
        Store::open(&f.database, &f.profiles, false).is_err(),
        "offline import must not open a store held by a daemon"
    );
}

#[tokio::test]
async fn worst_valid_escaped_notes_keep_complete_http_and_mcp_content_within_caps() {
    let mut f = fixture();
    let a = ui(&f, 1);
    let scope = "s".repeat(128);
    f.store
        .db
        .execute(
            "INSERT INTO spaces VALUES(?,'Large scope','private',1)",
            [&scope],
        )
        .unwrap();
    f.store
        .db
        .execute("INSERT INTO memberships VALUES(?,1,'editor')", [&scope])
        .unwrap();
    f.store
        .db
        .execute(
            "UPDATE bindings SET space_id=? WHERE id='family-notes-1-private'",
            [&scope],
        )
        .unwrap();
    let title = "\u{0001}".repeat(240);
    let body = "\u{0001}".repeat(16000);
    let notes=(0..50).map(|i|json!({"id":format!("n{i:03}{}","x".repeat(124)),"space_id":scope,"title":title,"body":body,"revision":i64::MAX,"updated_at":i64::MAX,"deleted":false})).collect::<Vec<_>>();
    f.store.active = false;
    f.store
        .import_core_notes(&export_payload(
            &uuid::Uuid::new_v4().to_string(),
            json!(notes),
        ))
        .unwrap();
    f.store.active = true;
    let list = f.store.list(&a, &scope, &NoteQuery::default()).unwrap();
    assert_eq!(list["notes"].as_array().unwrap().len(), 50);
    let id = list["notes"][0]["id"].as_str().unwrap().to_string();
    let read = f.store.read(&a, &scope, &id).unwrap();
    for value in [list.clone(), read.clone()] {
        let http_size = serde_json::to_vec(&value).unwrap().len();
        assert!(http_size > 65536 && http_size <= MAX_RESPONSE_BYTES);
        let final_result = mcp::tool_result(Ok(value.clone()));
        assert!(serde_json::to_vec(&final_result).unwrap().len() <= 256 * 1024);
        let wire = serde_json::to_value(&final_result).unwrap();
        let fallback: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(Some(fallback), final_result.structured_content);
        if value.get("note").is_some() {
            assert_eq!(final_result.structured_content, Some(value));
        }
    }
    // Even a final HTTP page may need several MCP pages. Escaped text must
    // survive intact, and the shortened cursor must neither skip nor repeat.
    let mut gathered = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let page = f
            .store
            .list(
                &a,
                &scope,
                &NoteQuery {
                    q: String::new(),
                    cursor,
                },
            )
            .unwrap();
        let result = mcp::tool_result(Ok(page));
        assert_ne!(result.is_error, Some(true));
        let value = result.structured_content.unwrap();
        gathered.extend(value["notes"].as_array().unwrap().iter().cloned());
        pages += 1;
        assert!(pages <= 50);
        cursor = value["next_cursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    assert!(pages > 1);
    assert_eq!(gathered, *list["notes"].as_array().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(axum::serve(listener, crate::http::router(f.store)).into_future());
    let adapter = mcp::NotesMcp::connect(
        port,
        "family-notes-1-private".into(),
        "user-a".into(),
        scope,
        &f.dir
            .path()
            .join("mcp/family-notes-1-private/family-domain.credential"),
    )
    .await
    .unwrap();
    assert_eq!(adapter.invoke("notes_list", json!({})).await.unwrap(), list);
    assert_eq!(
        adapter
            .invoke("notes_read", json!({"id":id}))
            .await
            .unwrap(),
        read
    );
    server.abort();
}
