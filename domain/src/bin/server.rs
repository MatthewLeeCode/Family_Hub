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
}
#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
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
