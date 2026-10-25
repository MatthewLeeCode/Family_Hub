//! Preserve complete JSON for both structured and text-only MCP clients.
//! Byte limits apply after JSON string escaping and MCP result wrapping.
use crate::*;
use rmcp::model::{CallToolResult, ContentBlock, ServerResult};

// Leave room for the RPC envelope in addition to the host's result limit.
const RESULT_LIMIT: usize = MAX_RESPONSE_BYTES - 1024;

fn paired(value: Value, error: bool) -> Result<CallToolResult> {
    let text = serde_json::to_string(&value)?;
    let mut result = if error {
        CallToolResult::structured_error(value)
    } else {
        CallToolResult::structured(value)
    };
    result.content = vec![ContentBlock::text(text)];
    Ok(result)
}

fn bounded(mut value: Value) -> Result<CallToolResult> {
    if serde_json::to_vec(&value)?.len() > MAX_RESPONSE_BYTES {
        return Err(DomainError::unavailable());
    }
    if let Some(rows) = value.get("notes") {
        validate_page(rows, value.get("next_cursor"))?;
    }
    loop {
        let result = paired(value.clone(), false)?;
        let response = ServerResult::CallToolResult(result.clone());
        if serde_json::to_vec(&response)?.len() <= RESULT_LIMIT {
            return Ok(result);
        }
        // Only list results can be paged. A single note is never truncated.
        let rows = value
            .get_mut("notes")
            .and_then(Value::as_array_mut)
            .filter(|rows| rows.len() > 1)
            .ok_or_else(DomainError::unavailable)?;
        rows.pop();
        let last = rows.last().ok_or_else(DomainError::unavailable)?;
        let id = last["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(DomainError::unavailable)?;
        let updated_at = last["updated_at"]
            .as_i64()
            .ok_or_else(DomainError::unavailable)?;
        // The domain uses descending (updated_at, id) keyset pagination. Resume
        // after the last *included* record, not the original full-page cursor.
        value["next_cursor"] = json!(format!("{updated_at}:{id}"));
    }
}

fn validate_page(rows: &Value, cursor: Option<&Value>) -> Result<()> {
    let rows = rows
        .as_array()
        .filter(|rows| rows.len() <= 50)
        .ok_or_else(DomainError::unavailable)?;
    let mut previous: Option<(i64, &str)> = None;
    let mut ids = std::collections::BTreeSet::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(DomainError::unavailable)?;
        let at = row["updated_at"]
            .as_i64()
            .filter(|at| *at >= 0)
            .ok_or_else(DomainError::unavailable)?;
        if !ids.insert(id) || previous.is_some_and(|old| old <= (at, id)) {
            return Err(DomainError::unavailable());
        }
        previous = Some((at, id));
    }
    match cursor {
        Some(Value::Null) => Ok(()),
        Some(Value::String(cursor))
            if previous.is_some_and(|(at, id)| *cursor == format!("{at}:{id}")) =>
        {
            Ok(())
        }
        _ => Err(DomainError::unavailable()),
    }
}

pub(crate) fn pack(result: Result<Value>) -> CallToolResult {
    match result.and_then(bounded) {
        Ok(result) => result,
        Err(error) => paired(json!({"code":error.code,"error":error.error}), true)
            .expect("Fixed domain error JSON is serializable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_oversized_result_fails_without_echoing_content() {
        let result = pack(Ok(json!({"note":{"body":"sensitive-data".repeat(30000)}})));
        assert_eq!(result.is_error, Some(true));
        let wire = serde_json::to_value(result).unwrap();
        assert!(!wire.to_string().contains("sensitive-data"));
        let text: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, wire["structuredContent"]);
        assert_eq!(text["code"], "domain_unavailable");
    }

    #[test]
    fn ordinary_page_preserves_existing_cursor_and_exact_text() {
        let value = json!({"notes":[{"id":"n1","updated_at":1,"title":"A \"quote\" and \\ path"}],"next_cursor":"1:n1"});
        let wire = serde_json::to_value(pack(Ok(value.clone()))).unwrap();
        let text: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text, value);
        assert_eq!(wire["structuredContent"], value);
    }

    #[test]
    fn malformed_page_never_becomes_success_by_dropping_its_tail() {
        let large = "\u{0001}".repeat(12000);
        let base = json!({"notes":[{"id":"z","updated_at":3,"title":large},{"id":"y","updated_at":2,"title":large},{"id":"x","updated_at":1,"title":large}],"next_cursor":null});
        assert!(serde_json::to_vec(&base).unwrap().len() < MAX_RESPONSE_BYTES);
        for case in 0..5 {
            let mut value = base.clone();
            match case {
                0 => value["notes"][2]["updated_at"] = json!(4),
                1 => value["notes"][2]["updated_at"] = json!(-1),
                2 => value["notes"][2]["id"] = json!("../invalid"),
                3 => value["notes"][2]["id"] = json!("z"),
                _ => value["next_cursor"] = json!("1:other"),
            }
            assert_eq!(pack(Ok(value)).is_error, Some(true));
        }
    }
}
