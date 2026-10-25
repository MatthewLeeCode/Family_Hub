//! Explicit operator provisioning for synthetic local demonstrations. No token is printed.
use crate::*;
use rand::RngCore;
use std::{io::Write, path::PathBuf};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemoProfile {
    pub profile_id: i64,
    pub core_subject: String,
    pub private_space: String,
    pub name: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemoSetup {
    pub profiles: Vec<DemoProfile>,
    pub shared_space: String,
    pub shared_name: String,
}

pub fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
impl Store {
    pub fn provision(
        &mut self,
        setup: &DemoSetup,
        ui_dir: &Path,
        mcp_root: &Path,
        mcp_program: &Path,
        port: u16,
    ) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(
            !self.active,
            "Provision only while the Notes authority is inactive"
        );
        anyhow::ensure!(
            port > 0 && setup.profiles.len() == 2 && valid_id(&setup.shared_space),
            "Expected two synthetic profiles and a shared space"
        );
        anyhow::ensure!(
            self.db
                .query_row("SELECT COUNT(*) FROM bindings", [], |r| r.get::<_, i64>(0))?
                == 0,
            "Bindings already exist; do not overwrite credentials"
        );
        let mut unique_profiles = std::collections::HashSet::new();
        let mut unique_subjects = std::collections::HashSet::new();
        let mut unique_spaces = std::collections::HashSet::from([setup.shared_space.clone()]);
        for p in &setup.profiles {
            anyhow::ensure!(
                p.profile_id > 0
                    && unique_profiles.insert(p.profile_id)
                    && valid_id(&p.core_subject)
                    && unique_subjects.insert(p.core_subject.clone())
                    && valid_id(&p.private_space)
                    && unique_spaces.insert(p.private_space.clone())
                    && !p.name.trim().is_empty(),
                "Invalid or repeated synthetic mapping"
            );
            self.profile_stamp(p.profile_id)?;
        }
        let program = std::fs::canonicalize(mcp_program)?;
        let mut manifest = Vec::new();
        let stamps = setup
            .profiles
            .iter()
            .map(|p| self.profile_stamp(p.profile_id))
            .collect::<Result<Vec<_>>>()?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO spaces VALUES(?,?,'shared',NULL)",
            params![setup.shared_space, setup.shared_name],
        )?;
        for (p, stamp) in setup.profiles.iter().zip(stamps) {
            tx.execute(
                "INSERT INTO spaces VALUES(?,?,'private',?)",
                params![
                    p.private_space,
                    format!("{} · private", p.name),
                    p.profile_id
                ],
            )?;
            for space in [&p.private_space, &setup.shared_space] {
                tx.execute(
                    "INSERT INTO memberships VALUES(?,?,'editor')",
                    params![space, p.profile_id],
                )?;
            }
            for (kind, space, binding, path) in [
                (
                    "ui",
                    None,
                    format!("ui-profile-{}", p.profile_id),
                    ui_dir.join(format!("profile-{}.credential", p.profile_id)),
                ),
                (
                    "mcp",
                    Some(&p.private_space),
                    format!("family-notes-{}-private", p.profile_id),
                    mcp_root
                        .join(format!("family-notes-{}-private", p.profile_id))
                        .join("family-domain.credential"),
                ),
                (
                    "mcp",
                    Some(&setup.shared_space),
                    format!("family-notes-{}-shared", p.profile_id),
                    mcp_root
                        .join(format!("family-notes-{}-shared", p.profile_id))
                        .join("family-domain.credential"),
                ),
            ] {
                let mut bytes = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut bytes);
                let token = hex::encode(bytes);
                write_private(&path, token.as_bytes())?;
                tx.execute("INSERT INTO bindings(id,token_hash,profile_id,profile_stamp,subject,space_id,kind,expires_at) VALUES(?,?,?,?,?,?,?,?)",
                    params![binding,digest(token.as_bytes()),p.profile_id,stamp,p.core_subject,space,kind,now()+7*24*60*60*1000])?;
                if let Some(space) = space {
                    manifest.push(json!({"id":binding,"owner_id":p.core_subject,"space_id":space,"program":program,"args":[format!("--port={port}"),format!("--binding={binding}"),format!("--subject={}",p.core_subject),format!("--space={space}")],"tools":["notes_list","notes_read"],"effects":{"notes_list":"read","notes_read":"read"}}));
                }
            }
        }
        let manifest_path = ui_dir.join("notes-mcp-connections.json");
        write_private(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)?;
        tx.commit()?;
        Ok(manifest_path)
    }
}
