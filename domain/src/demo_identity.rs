//! Offline display-label migration for the fixed synthetic household only.
//! It neither provisions credentials nor changes an authorization record.
use crate::*;

#[derive(Debug, Serialize, PartialEq)]
pub struct DemoRename {
    pub applied: bool,
    pub renamed_spaces: usize,
}

impl Store {
    /// The caller must stop Family Hub as well as the Notes daemon first.
    /// `Store::open` already holds the same ownership lock as the daemon.
    pub fn rename_demo_profiles(&mut self) -> anyhow::Result<DemoRename> {
        anyhow::ensure!(!self.active, "Stop services before renaming demo profiles");
        let profiles = self.profiles.transaction()?;
        let profile_rows: Vec<(i64, String, String, Option<String>)> = {
            let mut statement = profiles.prepare(
                "SELECT id,name,role,passcode_hash FROM profiles WHERE id IN (1,2) ORDER BY id",
            )?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        anyhow::ensure!(
            profile_rows.len() == 2
                && profile_rows[0].0 == 1
                && profile_rows[1].0 == 2
                && profile_rows.iter().all(|p| p.2 == "admin" && p.3.is_some())
                && matches!(
                    (profile_rows[0].1.as_str(), profile_rows[1].1.as_str()),
                    ("You", "Partner") | ("Matt", "Nicky")
                ),
            "This is not the expected synthetic Family profile mapping"
        );
        let collision: bool = profiles.query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id NOT IN (1,2) AND name COLLATE NOCASE IN ('Matt','Nicky'))",
            [], |r| r.get(0),
        )?;
        anyhow::ensure!(!collision, "The new profile names are already in use");
        let stamps = profile_rows
            .iter()
            .map(|p| digest(format!("{}:{}", p.3.as_deref().unwrap(), p.2).as_bytes()))
            .collect::<Vec<_>>();
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let spaces: Vec<(String, String, String, Option<i64>)> = {
            let mut statement =
                tx.prepare("SELECT id,name,kind,owner_profile FROM spaces ORDER BY id")?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        anyhow::ensure!(
            spaces.len() == 3
                && spaces[0].0 == "space-alex"
                && spaces[0].2 == "private"
                && spaces[0].3 == Some(2)
                && matches!(spaces[0].1.as_str(), "Alex · private" | "Nicky · private")
                && spaces[1]
                    == (
                        "space-household".into(),
                        "Household".into(),
                        "shared".into(),
                        None
                    )
                && spaces[2]
                    == (
                        "space-matt".into(),
                        "Matt · private".into(),
                        "private".into(),
                        Some(1)
                    ),
            "This is not the expected synthetic Notes workspace mapping"
        );
        let memberships: Vec<(String, i64, String)> = {
            let mut statement = tx.prepare(
                "SELECT space_id,profile_id,role FROM memberships ORDER BY space_id,profile_id",
            )?;
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        anyhow::ensure!(
            memberships
                == vec![
                    ("space-alex".into(), 2, "editor".into()),
                    ("space-household".into(), 1, "editor".into()),
                    ("space-household".into(), 2, "editor".into()),
                    ("space-matt".into(), 1, "editor".into()),
                ],
            "This is not the expected synthetic Notes membership mapping"
        );
        let count: i64 = tx.query_row("SELECT count(*) FROM bindings", [], |r| r.get(0))?;
        anyhow::ensure!(
            count == 6,
            "This is not the expected synthetic Notes binding set"
        );
        for (profile, subject, private) in [
            (1, "user-matt", "space-matt"),
            (2, "user-alex", "space-alex"),
        ] {
            for (id, kind, space) in [
                (format!("ui-profile-{profile}"), "ui", None),
                (
                    format!("family-notes-{profile}-private"),
                    "mcp",
                    Some(private),
                ),
                (
                    format!("family-notes-{profile}-shared"),
                    "mcp",
                    Some("space-household"),
                ),
            ] {
                let matches: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM bindings WHERE id=? AND profile_id=? AND subject=? AND space_id IS ? AND kind=? AND profile_stamp=?)",
                    params![id,profile,subject,space,kind,stamps[(profile-1) as usize]], |r| r.get(0),
                )?;
                anyhow::ensure!(
                    matches,
                    "This is not the expected synthetic Notes credential mapping"
                );
            }
        }
        let applied = spaces[0].1 == "Alex · private";
        if applied {
            anyhow::ensure!(tx.execute("UPDATE spaces SET name='Nicky · private' WHERE id='space-alex' AND name='Alex · private'", [])? == 1,
                "The Notes workspace changed during migration");
        }
        tx.commit()?;
        profiles.commit()?;
        Ok(DemoRename {
            applied,
            renamed_spaces: usize::from(applied),
        })
    }
}

#[cfg(test)]
mod tests;
