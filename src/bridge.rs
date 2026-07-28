use anyhow::{Context, Result, bail};
use rand::RngCore;
use serde_json::{Value, json};

use crate::leetcode::{self, Site};

pub const MAX_BRIDGE_PAYLOAD_BYTES: usize = 1_500_000;

pub fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn dispatch_payload(payload: &str, expected_token: &str) -> Value {
    let result = (|| {
        if payload.len() > MAX_BRIDGE_PAYLOAD_BYTES {
            bail!("bridge payload exceeds the 1500000-byte limit");
        }
        let request: Value =
            serde_json::from_str(payload).context("bridge payload must be JSON")?;
        let token = required_string(&request, "token")?;
        if token != expected_token {
            bail!("invalid bridge token");
        }
        if request.get("method").and_then(Value::as_str) != Some("POST") {
            bail!("unsupported bridge method");
        }
        dispatch(&request)
    })();
    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": format!("{error:#}") }),
    }
}

fn dispatch(request: &Value) -> Result<Value> {
    let path = required_string(request, "path")?;
    let body = request.get("body").unwrap_or(&Value::Null);
    match path {
        "/api/login" => leetcode::launch_login(site_from(body)?),
        "/api/status" => leetcode::user_status(site_from(body)?),
        "/api/problems" => {
            let site = site_from(body)?;
            let skip = body.get("skip").and_then(Value::as_u64).unwrap_or(0);
            let limit = body.get("limit").and_then(Value::as_u64).unwrap_or(50);
            let difficulty = body.get("difficulty").and_then(Value::as_str);
            let search = body.get("search").and_then(Value::as_str);
            leetcode::problem_list(site, skip, limit, difficulty, search)
        }
        "/api/question" => {
            leetcode::question(site_from(body)?, required_string(body, "titleSlug")?)
        }
        "/api/submit" => leetcode::submit(
            site_from(body)?,
            required_string(body, "titleSlug")?,
            required_string(body, "questionId")?,
            required_string(body, "lang")?,
            required_string(body, "code")?,
        ),
        "/api/run" => leetcode::interpret(
            site_from(body)?,
            required_string(body, "titleSlug")?,
            required_string(body, "questionId")?,
            required_string(body, "lang")?,
            required_string(body, "code")?,
            body.get("dataInput").and_then(Value::as_str).unwrap_or(""),
        ),
        "/api/check" => {
            leetcode::check_submission(site_from(body)?, required_string(body, "submissionId")?)
        }
        "/api/draft/load" => crate::drafts::load(
            required_string(body, "site")?,
            required_string(body, "problem")?,
            required_string(body, "language")?,
        ),
        "/api/draft/save" => crate::drafts::save(
            required_string(body, "site")?,
            required_string(body, "problem")?,
            required_string(body, "language")?,
            body.get("code").and_then(Value::as_str).unwrap_or(""),
        ),
        _ => bail!("unknown bridge route: {path}"),
    }
}

fn site_from(body: &Value) -> Result<Site> {
    Site::parse(body.get("site").and_then(Value::as_str).unwrap_or("global"))
}

fn required_string<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{key} is required"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_tokens_are_random_and_long() {
        let first = generate_token();
        let second = generate_token();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn invalid_tokens_are_rejected_before_dispatch() {
        let payload = json!({
            "token": "wrong",
            "path": "/api/status",
            "method": "POST",
            "body": { "site": "global" }
        });
        let result = dispatch_payload(&payload.to_string(), "expected");
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"], "invalid bridge token");
    }

    #[test]
    fn oversized_payloads_are_rejected_before_parsing() {
        let payload = "x".repeat(MAX_BRIDGE_PAYLOAD_BYTES + 1);
        let result = dispatch_payload(&payload, "expected");
        assert_eq!(result["ok"], false);
        assert!(result["error"].as_str().unwrap().contains("byte limit"));
    }

    #[test]
    fn unsupported_methods_are_rejected() {
        let payload = json!({
            "token": "expected",
            "path": "/api/status",
            "method": "GET",
            "body": { "site": "global" }
        });
        let result = dispatch_payload(&payload.to_string(), "expected");
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"], "unsupported bridge method");
    }
}
