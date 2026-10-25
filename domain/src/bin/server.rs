use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use family_domain::{Store, provision::DemoSetup};
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Explicit schema-1 to schema-2 migration while the daemon is stopped.
    MigrateAgentNotes {
        #[arg(long)]
        database: PathBuf,
        #[arg(long, required = true)]
        services_stopped: bool,
    },
    /// Enroll a separate synthetic create-only binding; never upgrades a reader.
    EnrollNotesWriter {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        #[arg(long)]
        profile: i64,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        space: String,
        #[arg(long)]
        binding: String,
        #[arg(long)]
        staging: PathBuf,
        #[arg(long)]
        program: PathBuf,
        #[arg(long)]
        port: u16,
        #[arg(long, required = true)]
        services_stopped: bool,
    },
    /// Content-free evidence only; never retries or settles a core action.
    InspectAgentNoteReceipt {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        #[arg(long)]
        binding: String,
        #[arg(long)]
        operation: String,
        #[arg(long, required = true)]
        services_stopped: bool,
    },
    /// Create an empty store and scoped synthetic credentials. Never overwrites.
    InitDemo {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        #[arg(long)]
        mapping: PathBuf,
        #[arg(long)]
        ui_credentials: PathBuf,
        #[arg(long)]
        mcp_root: PathBuf,
        #[arg(long)]
        mcp_program: PathBuf,
        #[arg(long, default_value_t = 4291)]
        port: u16,
    },
    /// Only enable after retiring the core's Notes write path and migrating data.
    Serve {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        #[arg(long, default_value_t = 4291)]
        port: u16,
        #[arg(long)]
        active: bool,
    },
    /// Import the core's immutable export while the Notes daemon is stopped.
    ImportCoreNotes {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        #[arg(long)]
        export: PathBuf,
    },
    /// Rename fixed synthetic Notes labels after stopping all three services.
    RenameDemoProfiles {
        #[arg(long)]
        database: PathBuf,
        #[arg(long)]
        profiles_db: PathBuf,
        /// Confirms Family Hub is also stopped; its DB has no daemon lock.
        #[arg(long, required = true)]
        services_stopped: bool,
    },
}
#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::MigrateAgentNotes {
            database,
            services_stopped,
        } => {
            anyhow::ensure!(services_stopped, "Stop services before migration");
            println!("{}", Store::migrate_agent_notes(&database)?);
        }
        Command::EnrollNotesWriter {
            database,
            profiles_db,
            profile,
            subject,
            space,
            binding,
            staging,
            program,
            port,
            services_stopped,
        } => {
            anyhow::ensure!(services_stopped, "Stop services before enrollment");
            let mut store = Store::open(&database, &profiles_db, false)?;
            let manifest = store.enroll_notes_writer(
                &family_domain::provision::WriterSetup {
                    profile_id: profile,
                    subject,
                    space,
                    binding,
                },
                &staging,
                &program,
                port,
            )?;
            println!("{}", serde_json::json!({"manifest":manifest}));
        }
        Command::InspectAgentNoteReceipt {
            database,
            profiles_db,
            binding,
            operation,
            services_stopped,
        } => {
            anyhow::ensure!(services_stopped, "Stop services before receipt inspection");
            let store = Store::open(&database, &profiles_db, false)?;
            println!(
                "{}",
                store.inspect_agent_note_receipt(&binding, &operation)?
            );
        }
        Command::InitDemo {
            database,
            profiles_db,
            mapping,
            ui_credentials,
            mcp_root,
            mcp_program,
            port,
        } => {
            let bytes = read_limited(&mapping, 16384)?;
            let setup: DemoSetup = serde_json::from_slice(&bytes)?;
            if let Some(parent) = database.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut store = Store::create(&database, &profiles_db)?;
            let manifest =
                store.provision(&setup, &ui_credentials, &mcp_root, &mcp_program, port)?;
            println!(
                "Synthetic Notes store initialized, inactive. Connection manifest: {}",
                manifest.display()
            );
        }
        Command::Serve {
            database,
            profiles_db,
            port,
            active,
        } => {
            anyhow::ensure!(port > 0, "Use a nonzero loopback port");
            let store = Store::open(&database, &profiles_db, active)
                .context("Cannot open the Notes store")?;
            let listener =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
            println!("Family Notes listening on 127.0.0.1:{port}; active={active}");
            axum::serve(listener, family_domain::http::router(store)).await?;
        }
        Command::ImportCoreNotes {
            database,
            profiles_db,
            export,
        } => {
            let bytes = read_limited(&export, 32 * 1024 * 1024)?;
            let mut store = Store::open(&database, &profiles_db, false)?;
            let receipt = store.import_core_notes(&bytes)?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
        Command::RenameDemoProfiles {
            database,
            profiles_db,
            services_stopped,
        } => {
            anyhow::ensure!(
                services_stopped,
                "Stop all services before renaming demo profiles"
            );
            let mut store = Store::open(&database, &profiles_db, false)?;
            println!("{}", serde_json::to_string(&store.rename_demo_profiles()?)?);
        }
    }
    Ok(())
}
fn read_limited(path: &std::path::Path, limit: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(
        file.metadata()?.len() <= limit,
        "Input file exceeds the size limit"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= limit,
        "Input file exceeds the size limit"
    );
    Ok(bytes)
}
