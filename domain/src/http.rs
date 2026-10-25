//! Fixed loopback transport. Authentication data is never part of a Notes command.
use crate::*;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::sync::{Arc, Mutex};
type Shared = Arc<Mutex<Store>>;

impl IntoResponse for DomainError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            Json(self),
        )
            .into_response()
    }
}
pub fn router(store: Store) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/scopes", get(scopes))
        .route("/v1/scopes/{space}/notes", get(list).post(create))
        .route("/v1/agent/scopes/{space}/notes", post(create_agent))
        .route(
            "/v1/scopes/{space}/notes/{id}",
            get(read).put(update).delete(delete),
        )
        .fallback(|| async { DomainError::missing() })
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(Arc::new(Mutex::new(store)))
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(DomainError::denied)
}
fn authenticate(store: &Store, headers: &HeaderMap) -> Result<Principal> {
    let token = header(headers, "authorization")?
        .strip_prefix("Bearer ")
        .ok_or_else(DomainError::denied)?;
    let expected = if headers.contains_key("x-family-profile") {
        if headers.contains_key("x-core-subject")
            || headers.contains_key("x-core-space")
            || headers.contains_key("x-binding-id")
        {
            return Err(DomainError::denied());
        }
        ExpectedCaller::Ui {
            profile: header(headers, "x-family-profile")?
                .parse()
                .map_err(|_| DomainError::denied())?,
        }
    } else {
        ExpectedCaller::Mcp {
            binding: header(headers, "x-binding-id")?.into(),
            subject: header(headers, "x-core-subject")?.into(),
            space: header(headers, "x-core-space")?.into(),
        }
    };
    store.authenticate(token, expected)
}
async fn run(
    state: Shared,
    headers: HeaderMap,
    f: impl FnOnce(&mut Store, &Principal) -> Result<Value> + Send + 'static,
) -> Result<Json<Value>> {
    tokio::task::spawn_blocking(move || {
        let mut store = state.lock().map_err(|_| DomainError::unavailable())?;
        let who = authenticate(&store, &headers)?;
        f(&mut store, &who).map(Json)
    })
    .await
    .map_err(|_| DomainError::unavailable())?
}
async fn status(State(state): State<Shared>, headers: HeaderMap) -> Result<Json<Value>> {
    run(state, headers, |store, who| Ok(store.status(who))).await
}
async fn scopes(State(state): State<Shared>, headers: HeaderMap) -> Result<Json<Value>> {
    run(state, headers, |store, who| store.scopes(who)).await
}
async fn list(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath(space): RoutePath<String>,
    query: std::result::Result<Query<NoteQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(query) = query.map_err(|_| DomainError::invalid())?;
    run(state, headers, move |store, who| {
        store.list(who, &space, &query)
    })
    .await
}
async fn read(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath((space, id)): RoutePath<(String, String)>,
) -> Result<Json<Value>> {
    run(state, headers, move |store, who| {
        store.read(who, &space, &id)
    })
    .await
}
async fn create(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath(space): RoutePath<String>,
    input: std::result::Result<Json<CreateNote>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(input) = input.map_err(|_| DomainError::invalid())?;
    run(state, headers, move |store, who| {
        store.create_note(who, &space, input)
    })
    .await
}
async fn create_agent(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath(space): RoutePath<String>,
    input: std::result::Result<Json<crate::agent_notes::AgentNoteEnvelope>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(input) = input.map_err(|_| DomainError::invalid())?;
    run(state, headers, move |store, who| {
        Ok(serde_json::to_value(store.create_agent_note(
            who,
            &space,
            input.operation,
            input.note,
        )?)?)
    })
    .await
}
async fn update(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath((space, id)): RoutePath<(String, String)>,
    input: std::result::Result<Json<UpdateNote>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(input) = input.map_err(|_| DomainError::invalid())?;
    run(state, headers, move |store, who| {
        store.update_note(who, &space, &id, input)
    })
    .await
}
async fn delete(
    State(state): State<Shared>,
    headers: HeaderMap,
    RoutePath((space, id)): RoutePath<(String, String)>,
    input: std::result::Result<Json<DeleteNote>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(input) = input.map_err(|_| DomainError::invalid())?;
    run(state, headers, move |store, who| {
        store.delete_note(who, &space, &id, input)
    })
    .await
}
