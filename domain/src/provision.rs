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

#[derive(Debug)]
pub struct WriterSetup {
    pub profile_id: i64,
    pub subject: String,
    pub space: String,
    pub binding: String,
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
    /// Explicit offline enrollment. Existing bindings and policies are never upgraded.
    pub fn enroll_notes_writer(
        &mut self,
        setup: &WriterSetup,
        staging: &Path,
        program: &Path,
        port: u16,
    ) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(
            !self.active,
            "Enroll only while the Notes daemon is stopped"
        );
        anyhow::ensure!(
            setup.profile_id > 0
                && valid_id(&setup.subject)
                && valid_id(&setup.space)
                && valid_id(&setup.binding)
                && port > 0,
            "Invalid writer mapping"
        );
        let program = std::fs::canonicalize(program)?;
        anyhow::ensure!(program.is_file(), "Writer executable is unavailable");
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let stamp = Self::profile_stamp_db(&self.profiles, setup.profile_id)?;
        let existing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM bindings WHERE kind='mcp' AND mcp_create=0 AND profile_id=? AND subject=? AND space_id=? AND profile_stamp=? AND revoked=0 AND expires_at>?)",
            params![setup.profile_id,setup.subject,setup.space,stamp,now()], |r| r.get(0))?;
        anyhow::ensure!(
            existing,
            "No current read binding matches this existing profile, subject and workspace"
        );
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM bindings WHERE id=?)",
            [&setup.binding],
            |r| r.get(0),
        )?;
        anyhow::ensure!(
            !duplicate,
            "Binding already exists; never upgrade or overwrite a connection"
        );
        let principal = Principal {
            profile: setup.profile_id,
            kind: "mcp".into(),
            space: Some(setup.space.clone()),
            binding: setup.binding.clone(),
            subject: setup.subject.clone(),
            access: AccessMode::McpCreate,
        };
        crate::agent_notes::writer_access(&tx, &principal, &setup.space)?;
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let directory = staging.join(&setup.binding);
        // Exclusive new files remain inert if enrollment fails before its DB commit.
        write_private(
            &directory.join("family-domain.credential"),
            token.as_bytes(),
        )?;
        let manifest = directory.join("notes-writer-connection.json");
        let connection = json!([{"id":setup.binding,"owner_id":setup.subject,"space_id":setup.space,"program":program,
            "args":[format!("--port={port}"),format!("--binding={}",setup.binding),format!("--subject={}",setup.subject),format!("--space={}",setup.space)],
            "tools":["notes_create"],"effects":{"notes_create":"local_write"},"operation_context":"family_notes_create_v1"}]);
        write_private(&manifest, &serde_json::to_vec_pretty(&connection)?)?;
        tx.execute("INSERT INTO bindings(id,token_hash,profile_id,profile_stamp,subject,space_id,kind,expires_at,mcp_create) VALUES(?,?,?,?,?,?,'mcp',?,1)",
            params![setup.binding,digest(token.as_bytes()),setup.profile_id,stamp,setup.subject,setup.space,now()+7*24*60*60*1000])?;
        tx.commit()?;
        Ok(manifest)
    }
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
