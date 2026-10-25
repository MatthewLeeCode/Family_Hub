//! Real native child, clean environment and connection-specific cwd; no network beyond loopback.
use anyhow::{Context, Result};
use family_domain::{
    Store,
    provision::{DemoProfile, DemoSetup},
};
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn response(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    expected: i64,
) -> Result<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            reader.read_line(&mut line),
        )
        .await??;
        anyhow::ensure!(
            read > 0 && read < 131072,
            "MCP response missing or oversized"
        );
        let value: Value = serde_json::from_str(&line)?;
        if value.get("id").is_some() {
            anyhow::ensure!(value["id"] == expected, "Unexpected MCP response ID");
            return Ok(value);
        }
    }
}
async fn send(writer: &mut tokio::process::ChildStdin, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ui_crud_and_real_stdio_mcp_use_the_same_scoped_store() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let profiles = directory.path().join("profiles.sqlite");
    let database = directory.path().join("notes.sqlite");
    let db = rusqlite::Connection::open(&profiles)?;
    db.execute_batch("CREATE TABLE profiles(id INTEGER PRIMARY KEY,passcode_hash TEXT,role TEXT); INSERT INTO profiles VALUES(1,'a','admin'),(2,'b','member');")?;
    drop(db);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let program = std::path::Path::new(env!("CARGO_BIN_EXE_family-domain-mcp"));
    let mut store = Store::create(&database, &profiles)?;
    store.provision(
        &DemoSetup {
            profiles: vec![
                DemoProfile {
                    profile_id: 1,
                    core_subject: "user-a".into(),
                    private_space: "space-a".into(),
                    name: "A".into(),
                },
                DemoProfile {
                    profile_id: 2,
                    core_subject: "user-b".into(),
                    private_space: "space-b".into(),
                    name: "B".into(),
                },
            ],
            shared_space: "shared".into(),
            shared_name: "Shared".into(),
        },
        &directory.path().join("ui"),
        &directory.path().join("staging"),
        program,
        port,
    )?;
    drop(store);
    let server = tokio::spawn(
        axum::serve(
            listener,
            family_domain::http::router(Store::open(&database, &profiles, true)?),
        )
        .into_future(),
    );
    let ui_token = std::fs::read_to_string(directory.path().join("ui/profile-1.credential"))?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let body = json!({"request_id":uuid::Uuid::new_v4().to_string(),"title":"Human-created note","body":"Only profile A should read this."});
    let url = format!("http://127.0.0.1:{port}/v1/scopes/space-a/notes");
    let created: Value = client
        .post(&url)
        .bearer_auth(&ui_token)
        .header("X-Family-Profile", "1")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let replay: Value = client
        .post(&url)
        .bearer_auth(&ui_token)
        .header("X-Family-Profile", "1")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(created, replay);

    let mut command = tokio::process::Command::new(program);
    command
        .args([
            format!("--port={port}"),
            "--binding=family-notes-1-private".into(),
            "--subject=user-a".into(),
            "--space=space-a".into(),
        ])
        .env_clear()
        .current_dir(directory.path().join("staging/family-notes-1-private"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut input = child.stdin.take().context("Missing child input")?;
    let mut output = BufReader::new(child.stdout.take().context("Missing child output")?);
    send(&mut input,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"scoped-test","version":"1"}}})).await?;
    let initialized = response(&mut output, 1).await?;
    assert!(initialized.get("result").is_some());
    send(
        &mut input,
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .await?;
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await?;
    let catalog = response(&mut output, 2).await?;
    assert_eq!(catalog["result"]["tools"].as_array().unwrap().len(), 2);
    send(&mut input,json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"notes_read","arguments":{"id":created["note"]["id"]}}})).await?;
    let read = response(&mut output, 3).await?;
    assert_eq!(read["result"]["structuredContent"], created);
    for (id, name, args) in [
        (4, "notes_list", json!({"subject":"user-b"})),
        (5, "notes_create", body.clone()),
    ] {
        send(&mut input,json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})).await?;
        assert_eq!(response(&mut output, id).await?["result"]["isError"], true);
    }
    child.kill().await?;
    let mcp_token = std::fs::read_to_string(
        directory
            .path()
            .join("staging/family-notes-1-private/family-domain.credential"),
    )?;
    let attempted = client
        .post(&url)
        .bearer_auth(mcp_token)
        .header("X-Binding-ID", "family-notes-1-private")
        .header("X-Core-Subject", "user-a")
        .header("X-Core-Space", "space-a")
        .json(&body)
        .send()
        .await?;
    assert_eq!(attempted.status(), reqwest::StatusCode::FORBIDDEN);
    server.abort();
    Ok(())
}
