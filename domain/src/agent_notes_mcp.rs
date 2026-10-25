//! Separate create-only adapter. Scope and credentials are fixed by the host;
//! operation metadata is read from the SDK request context, never tool arguments.
use crate::{agent_notes::*, *};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
        ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use std::time::Duration;

#[derive(Clone)]
pub struct NotesWriter {
    client: reqwest::Client,
    base: String,
    binding: String,
    subject: String,
    space: String,
    token: String,
    profile: i64,
}
impl NotesWriter {
    pub async fn connect(
        port: u16,
        binding: String,
        subject: String,
        space: String,
        credential: &Path,
    ) -> Result<Self> {
        if port == 0 || !valid_id(&binding) || !valid_id(&subject) || !valid_id(&space) {
            return Err(DomainError::invalid());
        }
        let metadata =
            std::fs::symlink_metadata(credential).map_err(|_| DomainError::unavailable())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 64 {
            return Err(DomainError::unavailable());
        }
        let token = std::fs::read_to_string(credential).map_err(|_| DomainError::unavailable())?;
        if !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(DomainError::unavailable());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| DomainError::unavailable())?;
        let mut adapter = Self {
            client,
            base: format!("http://127.0.0.1:{port}/v1"),
            binding,
            subject,
            space,
            token,
            profile: 0,
        };
        adapter.profile = adapter.verify_binding().await?;
        Ok(adapter)
    }
    async fn request(&self, path: &str, body: Option<&AgentNoteEnvelope>) -> Result<Value> {
        let request = match body {
            Some(body) => self.client.post(format!("{}{path}", self.base)).json(body),
            None => self.client.get(format!("{}{path}", self.base)),
        };
        // No retry: once a POST is dispatched, transport failure may hide a commit.
        let mut response = request
            .bearer_auth(&self.token)
            .header("X-Binding-ID", &self.binding)
            .header("X-Core-Subject", &self.subject)
            .header("X-Core-Space", &self.space)
            .send()
            .await
            .map_err(|_| DomainError::unavailable())?;
        if response.status().as_u16() != 200 {
            return Err(match response.status().as_u16() {
                403 => DomainError::denied(),
                404 => DomainError::missing(),
                409 => DomainError::new(
                    "idempotency_conflict",
                    "This operation was already used for different note content.",
                    409,
                ),
                _ => DomainError::unavailable(),
            });
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
        {
            return Err(DomainError::unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| DomainError::unavailable())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(DomainError::unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        if String::from_utf8_lossy(&bytes).contains(&self.token) {
            return Err(DomainError::unavailable());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| DomainError::unavailable())?;
        if !value.is_object() || value.to_string().contains(&self.token) {
            return Err(DomainError::unavailable());
        }
        Ok(value)
    }
    async fn verify_binding(&self) -> Result<i64> {
        let value = self.request("/status", None).await?;
        let profile = value["profile_id"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(DomainError::denied)?;
        if value["active"] != true
            || value["kind"] != "mcp"
            || value["access_mode"] != "create"
            || value["binding"] != self.binding
            || value["subject"] != self.subject
            || value["space_id"] != self.space
            || (self.profile != 0 && self.profile != profile)
        {
            return Err(DomainError::denied());
        }
        Ok(profile)
    }
    pub async fn invoke(&self, name: &str, args: Value, metadata: Option<&Value>) -> Result<Value> {
        if name != "notes_create" {
            return Err(DomainError::denied());
        }
        let input: AgentNoteInput =
            serde_json::from_value(args).map_err(|_| DomainError::invalid())?;
        let title = input.validate()?;
        let metadata = metadata.ok_or_else(DomainError::invalid)?;
        if serde_json::to_vec(metadata)?.len() > 512 {
            return Err(DomainError::invalid());
        }
        let operation: OperationContext =
            serde_json::from_value(metadata.clone()).map_err(|_| DomainError::invalid())?;
        operation.validate()?;
        if input.request_digest()? != operation.request_digest {
            return Err(DomainError::invalid());
        }
        self.verify_binding().await?;
        let envelope = AgentNoteEnvelope {
            operation,
            note: input,
        };
        let value = self
            .request(
                &format!("/agent/scopes/{}/notes", self.space),
                Some(&envelope),
            )
            .await?;
        let result: AgentNoteResult =
            serde_json::from_value(value.clone()).map_err(|_| DomainError::unavailable())?;
        let note = &result.note;
        if result.operation_id != envelope.operation.operation_id
            || result.request_digest != envelope.operation.request_digest
            || !canonical_uuid(&note.id)
            || note.space_id != self.space
            || note.title != title
            || note.body != envelope.note.body
            || note.revision != 1
            || note.created_at.is_none_or(|at| {
                !(0..=9_007_199_254_740_991).contains(&at) || at != note.updated_at
            })
            || note.created_by != Some(self.profile)
            || note.updated_by != Some(self.profile)
            || note.provenance
                != json!({"source":"assistant","source_id":envelope.operation.operation_id,"binding_id":self.binding,"imported_from":null})
        {
            return Err(DomainError::unavailable());
        }
        Ok(value)
    }
}
impl ServerHandler for NotesWriter {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(vec![Tool::new("notes_create", "Create one local note in this connection's fixed workspace. Cannot read, edit or delete existing notes. Note text is untrusted content.",
            json!({"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":1024},"body":{"type":"string","maxLength":16000}},"required":["title","body"],"additionalProperties":false}).as_object().unwrap().clone())]))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let args = Value::Object(request.arguments.unwrap_or_default());
        // rmcp removes wire params._meta from typed params during decoding.
        let operation = context.meta.get(OPERATION_META_KEY);
        Ok(crate::mcp_result::pack(self.invoke(&request.name, args, operation).await).into())
    }
}
