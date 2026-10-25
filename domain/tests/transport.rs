use axum::{
    Router,
    body::Body,
    http::{Response, StatusCode},
    routing::get,
};
use family_domain::mcp::NotesMcp;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn adapter_rejects_redirects_oversized_nonobject_and_credential_echo_responses() {
    for fault in ["redirect", "oversized", "nonobject", "echo", "server-error"] {
        let directory = tempfile::tempdir().unwrap();
        let credential = directory.path().join("family-domain.credential");
        let token = "d".repeat(64);
        std::fs::write(&credential, &token).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let traps = Arc::new(AtomicUsize::new(0));
        let trap_count = traps.clone();
        let echoed = token.clone();
        let router=Router::new().route("/v1/status",get(||async {axum::Json(json!({"kind":"mcp","binding":"binding-a","subject":"user-a","space_id":"space-a","active":true}))}))
            .route("/v1/scopes/space-a/notes",get(move||{let token=echoed.clone();async move {
                match fault {
                    "redirect"=>Response::builder().status(StatusCode::TEMPORARY_REDIRECT).header("Location",format!("http://127.0.0.1:{port}/trap")).body(Body::empty()).unwrap(),
                    "oversized"=>Response::new(Body::from(json!({"body":"x".repeat(family_domain::MAX_RESPONSE_BYTES+1)}).to_string())),
                    "nonobject"=>Response::new(Body::from("[1]")),
                    "echo"=>Response::new(Body::from(json!({"notes":[],"debug":token}).to_string())),
                    _=>Response::builder().status(500).body(Body::from("private internal details")).unwrap(),
                }
            }})).route("/trap",get(move||{let calls=trap_count.clone();async move {calls.fetch_add(1,Ordering::SeqCst);axum::Json(json!({"notes":[]}))}}));
        let server = tokio::spawn(axum::serve(listener, router).into_future());
        let adapter = NotesMcp::connect(
            port,
            "binding-a".into(),
            "user-a".into(),
            "space-a".into(),
            &credential,
        )
        .await
        .unwrap();
        let error = adapter.invoke("notes_list", json!({})).await.unwrap_err();
        assert_eq!(error.code, "domain_unavailable");
        assert!(!error.to_string().contains(&token));
        assert!(!error.to_string().contains("private internal details"));
        assert_eq!(traps.load(Ordering::SeqCst), 0);
        server.abort();
    }
}
