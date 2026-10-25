use axum::{
    Router,
    body::Body,
    http::{Response, StatusCode},
    routing::{get, post},
};
use family_domain::{
    agent_notes::{AgentNoteInput, OperationContext},
    agent_notes_mcp::NotesWriter,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn malformed_post_results_never_succeed_or_retry_or_echo_credentials() {
    for fault in [
        "redirect",
        "oversized",
        "nonobject",
        "echo",
        "escaped-echo",
        "server-error",
        "wrong-status",
        "id",
        "digest",
        "binding",
        "scope",
        "profile",
        "revision",
        "time",
        "body",
        "title",
        "unknown",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let credential = directory.path().join("family-domain.credential");
        let token = "d".repeat(64);
        std::fs::write(&credential, &token).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let posts = Arc::new(AtomicUsize::new(0));
        let post_count = posts.clone();
        let traps = Arc::new(AtomicUsize::new(0));
        let trap_count = traps.clone();
        let input = AgentNoteInput {
            title: "  Title  ".into(),
            body: "Body".into(),
        };
        let op = OperationContext {
            version: 1,
            operation_id: uuid::Uuid::new_v4().to_string(),
            request_digest: input.request_digest().unwrap(),
        };
        let result = json!({"operation_id":op.operation_id,"request_digest":op.request_digest,"note":{"id":uuid::Uuid::new_v4().to_string(),"space_id":"space-a","title":"Title","body":"Body","revision":1,"created_at":1,"updated_at":1,"created_by":1,"updated_by":1,"provenance":{"source":"assistant","source_id":op.operation_id,"binding_id":"binding-a","imported_from":null}}});
        let router=Router::new().route("/v1/status",get(||async{axum::Json(json!({"active":true,"kind":"mcp","access_mode":"create","binding":"binding-a","subject":"user-a","space_id":"space-a","profile_id":1}))}))
            .route("/v1/agent/scopes/space-a/notes",post(move||{let mut value=result.clone();let calls=post_count.clone();async move {
                calls.fetch_add(1,Ordering::SeqCst);
                match fault {
                    "redirect"=>return Response::builder().status(StatusCode::TEMPORARY_REDIRECT).header("Location",format!("http://127.0.0.1:{port}/trap")).body(Body::empty()).unwrap(),
                    "oversized"=>return Response::new(Body::from("x".repeat(family_domain::MAX_RESPONSE_BYTES+1))),
                    "nonobject"=>return Response::new(Body::from("[]")),
                    "echo"=>value["note"]["body"]=json!("d".repeat(64)),
                    "escaped-echo"=>return Response::new(Body::from(format!("{{\"debug\":\"{}\"}}","\\u0064".repeat(64)))),
                    "server-error"=>return Response::builder().status(500).body(Body::from("private failure detail")).unwrap(),
                    "wrong-status"=>return Response::builder().status(201).body(Body::from(value.to_string())).unwrap(),
                    "id"=>value["operation_id"]=json!(uuid::Uuid::new_v4().to_string()),
                    "digest"=>value["request_digest"]=json!("0".repeat(64)),
                    "binding"=>value["note"]["provenance"]["binding_id"]=json!("other"),
                    "scope"=>value["note"]["space_id"]=json!("other"),
                    "profile"=>value["note"]["created_by"]=json!(2),
                    "revision"=>value["note"]["revision"]=json!(2),
                    "time"=>value["note"]["created_at"]=json!(0),
                    "body"=>value["note"]["body"]=json!("changed"),
                    "title"=>value["note"]["title"]=json!("  Title  "),
                    "unknown"=>value["extra"]=json!(true),_=>unreachable!(),
                }
                Response::new(Body::from(value.to_string()))
            }})).route("/trap",get(move||{let calls=trap_count.clone();async move{calls.fetch_add(1,Ordering::SeqCst);"trap"}}));
        let server = tokio::spawn(axum::serve(listener, router).into_future());
        let adapter = NotesWriter::connect(
            port,
            "binding-a".into(),
            "user-a".into(),
            "space-a".into(),
            &credential,
        )
        .await
        .unwrap();
        let error = adapter
            .invoke(
                "notes_create",
                serde_json::to_value(&input).unwrap(),
                Some(&serde_json::to_value(&op).unwrap()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "domain_unavailable", "{fault}");
        assert!(!error.to_string().contains(&token));
        assert!(!error.to_string().contains("private failure"));
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        assert_eq!(traps.load(Ordering::SeqCst), 0);
        server.abort();
    }
}

#[tokio::test]
async fn metadata_validation_precedes_io_and_current_binding_is_rechecked() {
    let directory = tempfile::tempdir().unwrap();
    let credential = directory.path().join("family-domain.credential");
    std::fs::write(&credential, "d".repeat(64)).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let router=Router::new().route("/v1/status",get(move||{let counted=counted.clone();async move {
        let count=counted.fetch_add(1,Ordering::SeqCst);
        axum::Json(json!({"active":true,"kind":"mcp","access_mode":if count==0{"create"}else{"read"},"binding":"binding-a","subject":"user-a","space_id":"space-a","profile_id":1}))
    }}));
    let server = tokio::spawn(axum::serve(listener, router).into_future());
    let adapter = NotesWriter::connect(
        port,
        "binding-a".into(),
        "user-a".into(),
        "space-a".into(),
        &credential,
    )
    .await
    .unwrap();
    let input = AgentNoteInput {
        title: "Title".into(),
        body: "Body".into(),
    };
    let op = OperationContext {
        version: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_digest: input.request_digest().unwrap(),
    };
    let good = serde_json::to_value(&op).unwrap();
    let args = serde_json::to_value(&input).unwrap();
    for bad in [
        Value::Null,
        json!({"version":2,"operation_id":op.operation_id,"request_digest":op.request_digest}),
        json!({"version":1,"operation_id":op.operation_id,"request_digest":op.request_digest,"extra":true}),
        json!({"version":1,"operation_id":op.operation_id,"request_digest":"0".repeat(64)}),
    ] {
        assert_eq!(
            adapter
                .invoke("notes_create", args.clone(), Some(&bad))
                .await
                .unwrap_err()
                .code,
            "validation_error"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        adapter
            .invoke("notes_create", args, Some(&good))
            .await
            .unwrap_err()
            .code,
        "access_denied"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}
