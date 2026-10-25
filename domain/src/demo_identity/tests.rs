use super::*;
use crate::provision::{DemoProfile, DemoSetup};
use std::collections::BTreeMap;

struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path().join("profiles.sqlite");
    Connection::open(&profiles).unwrap().execute_batch(
        "CREATE TABLE profiles(id INTEGER PRIMARY KEY,name TEXT UNIQUE COLLATE NOCASE,role TEXT,passcode_hash TEXT);
         INSERT INTO profiles VALUES(1,'You','admin','synthetic-a'),(2,'Partner','admin','synthetic-b'),(3,'Nan','member','synthetic-c');"
    ).unwrap();
    let mut store = Store::create(&dir.path().join("notes.sqlite"), &profiles).unwrap();
    store
        .provision(
            &DemoSetup {
                profiles: vec![
                    DemoProfile {
                        profile_id: 1,
                        core_subject: "user-matt".into(),
                        private_space: "space-matt".into(),
                        name: "Matt".into(),
                    },
                    DemoProfile {
                        profile_id: 2,
                        core_subject: "user-alex".into(),
                        private_space: "space-alex".into(),
                        name: "Alex".into(),
                    },
                ],
                shared_space: "space-household".into(),
                shared_name: "Household".into(),
            },
            &dir.path().join("ui"),
            &dir.path().join("mcp"),
            &std::env::current_exe().unwrap(),
            4291,
        )
        .unwrap();
    Fixture { dir, store }
}

type Tables = BTreeMap<String, Vec<Vec<rusqlite::types::Value>>>;
fn snapshot(db: &Connection) -> Tables {
    let names: Vec<String> = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = db
                .prepare(&format!(
                    "SELECT * FROM \"{}\" ORDER BY rowid",
                    name.replace('"', "\"\"")
                ))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}

#[test]
fn migration_changes_only_label_preserving_credentials_notes_receipts_and_replay() {
    let mut f = fixture();
    let token = std::fs::read_to_string(f.dir.path().join("ui/profile-2.credential")).unwrap();
    let who = f
        .store
        .authenticate(&token, ExpectedCaller::Ui { profile: 2 })
        .unwrap();
    f.store.active = true;
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = || CreateNote {
        request_id: request_id.clone(),
        title: "Keep my note".into(),
        body: "Unchanged synthetic contents".into(),
    };
    let created = f.store.create_note(&who, "space-alex", request()).unwrap();
    f.store.active = false;
    // Expired/revoked credentials must not be renewed by an identity-label change.
    f.store
        .db
        .execute(
            "UPDATE bindings SET expires_at=0,revoked=1 WHERE id='family-notes-1-shared'",
            [],
        )
        .unwrap();
    let profile_before = snapshot(&f.store.profiles);
    let mut expected = snapshot(&f.store.db);
    let spaces = expected.get_mut("spaces").unwrap();
    let row = spaces
        .iter_mut()
        .find(|r| r[0] == rusqlite::types::Value::Text("space-alex".into()))
        .unwrap();
    row[1] = rusqlite::types::Value::Text("Nicky · private".into());
    assert_eq!(
        f.store.rename_demo_profiles().unwrap(),
        DemoRename {
            applied: true,
            renamed_spaces: 1
        }
    );
    assert_eq!(snapshot(&f.store.db), expected);
    assert_eq!(snapshot(&f.store.profiles), profile_before);
    assert_eq!(
        f.store.rename_demo_profiles().unwrap(),
        DemoRename {
            applied: false,
            renamed_spaces: 0
        }
    );
    assert_eq!(snapshot(&f.store.db), expected);
    let who = f
        .store
        .authenticate(&token, ExpectedCaller::Ui { profile: 2 })
        .unwrap();
    f.store.active = true;
    assert_eq!(
        f.store.create_note(&who, "space-alex", request()).unwrap(),
        created
    );
    assert_eq!(snapshot(&f.store.db), expected);
}

#[test]
fn canonical_family_names_and_fresh_notes_labels_are_a_noop() {
    let mut f = fixture();
    let profiles = Connection::open(f.dir.path().join("profiles.sqlite")).unwrap();
    profiles.execute_batch("UPDATE profiles SET name='Matt' WHERE id=1; UPDATE profiles SET name='Nicky' WHERE id=2;").unwrap();
    f.store
        .db
        .execute(
            "UPDATE spaces SET name='Nicky · private' WHERE id='space-alex'",
            [],
        )
        .unwrap();
    let before = snapshot(&f.store.db);
    assert!(!f.store.rename_demo_profiles().unwrap().applied);
    assert_eq!(snapshot(&f.store.db), before);
}

#[test]
fn custom_mapping_is_rejected_without_any_mutation() {
    for sql in [
        "UPDATE spaces SET name='Custom' WHERE id='space-alex'",
        "UPDATE spaces SET owner_profile=1 WHERE id='space-alex'",
        "UPDATE memberships SET role='viewer' WHERE space_id='space-alex'",
        "UPDATE bindings SET subject='user-matt' WHERE id='ui-profile-2'",
        "UPDATE bindings SET profile_stamp='different' WHERE id='ui-profile-2'",
        "DELETE FROM bindings WHERE id='family-notes-2-shared'",
        "INSERT INTO spaces VALUES('custom','Custom','shared',NULL)",
    ] {
        let mut f = fixture();
        f.store.db.execute_batch(sql).unwrap();
        let before = snapshot(&f.store.db);
        assert!(
            f.store.rename_demo_profiles().is_err(),
            "accepted custom state: {sql}"
        );
        assert_eq!(snapshot(&f.store.db), before);
    }
    for sql in [
        "UPDATE profiles SET name='Other' WHERE id=2",
        "UPDATE profiles SET role='member' WHERE id=2",
        "UPDATE profiles SET passcode_hash='rotated' WHERE id=2",
        "UPDATE profiles SET name='Nicky' WHERE id=3",
        "DELETE FROM profiles WHERE id=2",
    ] {
        let mut f = fixture();
        let profiles = Connection::open(f.dir.path().join("profiles.sqlite")).unwrap();
        profiles.execute_batch(sql).unwrap();
        let before = snapshot(&f.store.db);
        assert!(
            f.store.rename_demo_profiles().is_err(),
            "accepted custom profile: {sql}"
        );
        assert_eq!(snapshot(&f.store.db), before);
    }
}

#[test]
fn ownership_lock_and_active_store_prevent_live_migration() {
    let mut f = fixture();
    assert!(
        Store::open(
            &f.dir.path().join("notes.sqlite"),
            &f.dir.path().join("profiles.sqlite"),
            false
        )
        .is_err()
    );
    f.store.active = true;
    let before = snapshot(&f.store.db);
    assert!(f.store.rename_demo_profiles().is_err());
    assert_eq!(snapshot(&f.store.db), before);
    let Fixture { dir, store } = f;
    drop(store);
    let mut reopened = Store::open(
        &dir.path().join("notes.sqlite"),
        &dir.path().join("profiles.sqlite"),
        false,
    )
    .unwrap();
    assert!(reopened.rename_demo_profiles().unwrap().applied);
    assert!(
        Store::open(
            &dir.path().join("absent.sqlite"),
            &dir.path().join("profiles.sqlite"),
            false
        )
        .is_err()
    );
    assert!(!dir.path().join("absent.sqlite").exists());
}
