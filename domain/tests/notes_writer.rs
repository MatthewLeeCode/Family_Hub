//! Real receive-side SDK metadata, fixed credentials and the authoritative HTTP store.
use anyhow::{Context, Result};
use family_domain::{
    Store,
    agent_notes::{AgentNoteInput, OPERATION_META_KEY, OperationContext},
    provision::{DemoProfile, DemoSetup, WriterSetup},
};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Child {
    process: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
}
impl Child {
    async fn start(directory: &Path, port: u16) -> Result<Self> {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_family-notes-writer"));
        command
            .args([
                format!("--port={port}"),
                "--binding=writer-a".into(),
                "--subject=user-a".into(),
                "--space=space-a".into(),
            ])
            .env_clear()
            .current_dir(directory)
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
        let mut process = command.spawn()?;
        let input = process.stdin.take().context("No stdin")?;
        let output = BufReader::new(process.stdout.take().context("No stdout")?);
        let mut child = Self {
            process,
            input,
            output,
        };
        child.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"notes-writer-test","version":"1"}}})).await?;
        assert!(child.response(1).await?["result"].is_object());
        child
            .send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        Ok(child)
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn response(&mut self, id: i64) -> Result<Value> {
        let mut line = String::new();
        loop {
            line.clear();
            let size = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                self.output.read_line(&mut line),
            )
            .await??;
            anyhow::ensure!(
                size > 0 && size <= family_domain::MAX_RESPONSE_BYTES,
                "Missing or oversized response"
            );
            let value: Value = serde_json::from_str(&line)?;
            if value.get("id").is_some() {
                anyhow::ensure!(value["id"] == id, "Unexpected ID");
                return Ok(value);
            }
        }
    }
    async fn call(&mut self, id: i64, args: Value, meta: Option<Value>) -> Result<Value> {
        let mut params = json!({"name":"notes_create","arguments":args});
        if let Some(meta) = meta {
            params["_meta"] =
                json!({OPERATION_META_KEY:meta,"progressToken":"unrelated-sdk-metadata"});
        }
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":params}))
            .await?;
        let wire = self.response(id).await?;
        let result = &wire["result"];
        let text: Value = serde_json::from_str(
            result["content"][0]["text"]
                .as_str()
                .context("Missing complete text result")?,
        )?;
        assert_eq!(result["structuredContent"], text);
        Ok(result.clone())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_stdio_context_duplicate_concurrency_restart_and_maximum_framing() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database = directory.path().join("notes.sqlite");
    let profiles = directory.path().join("profiles.sqlite");
    rusqlite::Connection::open(&profiles)?.execute_batch("CREATE TABLE profiles(id INTEGER PRIMARY KEY,passcode_hash TEXT,role TEXT);INSERT INTO profiles VALUES(1,'a','admin'),(2,'b','member')")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let mut store = Store::create(&database, &profiles)?;
    store.provision(
        &DemoSetup {
            profiles: vec![
                DemoProfile {
                    profile_id: 1,
                    core_subject: "user-a".into(),
                    private_space: "space-a".into(),
                    name: "Matt".into(),
                },
                DemoProfile {
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
        Path::new(env!("CARGO_BIN_EXE_family-domain-mcp")),
        port,
    )?;
    store.enroll_notes_writer(
        &WriterSetup {
            profile_id: 1,
            subject: "user-a".into(),
            space: "space-a".into(),
            binding: "writer-a".into(),
        },
        &directory.path().join("staging"),
        Path::new(env!("CARGO_BIN_EXE_family-notes-writer")),
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
    let cwd = directory.path().join("staging/writer-a");
    let mut child = Child::start(&cwd, port).await?;
    child
        .send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
        .await?;
    let tools = child.response(2).await?["result"]["tools"].clone();
    assert_eq!(tools.as_array().unwrap().len(), 1);
    assert_eq!(tools[0]["name"], "notes_create");
    assert_eq!(tools[0]["inputSchema"]["additionalProperties"], false);
    let input = AgentNoteInput {
        title: "  Native note  ".into(),
        body: "Original SDK-bound body".into(),
    };
    let op = OperationContext {
        version: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_digest: input.request_digest()?,
    };
    let args = serde_json::to_value(&input)?;
    let meta = serde_json::to_value(&op)?;
    assert_eq!(child.call(3, args.clone(), None).await?["isError"], true);
    let mut forged = args.clone();
    forged["_meta"] = meta.clone();
    assert_eq!(
        child.call(4, forged, Some(meta.clone())).await?["isError"],
        true
    );
    assert_eq!(
        rusqlite::Connection::open(&database)?.query_row(
            "SELECT count(*) FROM notes",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    let first = child.call(5, args.clone(), Some(meta.clone())).await?;
    assert_ne!(first["isError"], true);
    assert_eq!(first["structuredContent"]["operation_id"], op.operation_id);
    assert_eq!(first["structuredContent"]["note"]["title"], "Native note");
    child.process.kill().await?;
    let token = std::fs::read_to_string(cwd.join("family-domain.credential"))?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let url = format!("http://127.0.0.1:{port}/v1/agent/scopes/space-a/notes");
    let concurrent_op = OperationContext {
        operation_id: uuid::Uuid::new_v4().to_string(),
        ..op.clone()
    };
    let request = || {
        client
            .post(&url)
            .bearer_auth(&token)
            .header("X-Binding-ID", "writer-a")
            .header("X-Core-Subject", "user-a")
            .header("X-Core-Space", "space-a")
            .json(&json!({"operation":concurrent_op,"note":input}))
            .send()
    };
    let (a, b) = tokio::join!(request(), request());
    let concurrent = a?.error_for_status()?.json::<Value>().await?;
    assert_eq!(concurrent["operation_id"], concurrent_op.operation_id);
    assert_ne!(
        concurrent["note"]["id"],
        first["structuredContent"]["note"]["id"]
    );
    assert_eq!(b?.error_for_status()?.json::<Value>().await?, concurrent);
    let mut child = Child::start(&cwd, port).await?;
    assert_eq!(child.call(3, args, Some(meta)).await?, first);
    assert_eq!(
        rusqlite::Connection::open(&database)?.query_row(
            "SELECT count(*) FROM notes",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        2
    );
    let huge = AgentNoteInput {
        title: " ".repeat(784) + &"😀".repeat(60),
        body: "\u{0001}".repeat(16000),
    };
    let op = OperationContext {
        version: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_digest: huge.request_digest()?,
    };
    let result = child
        .call(
            4,
            serde_json::to_value(&huge)?,
            Some(serde_json::to_value(&op)?),
        )
        .await?;
    assert_ne!(result["isError"], true);
    assert_eq!(result["structuredContent"]["note"]["body"], huge.body);
    assert_eq!(
        result["structuredContent"]["note"]["title"],
        huge.title.trim()
    );
    child.process.kill().await?;
    server.abort();
    let _ = server.await;
    Ok(())
}
