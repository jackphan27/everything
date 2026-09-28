//! AI gateway: the webview never talks to the network. Chart requests go through
//! these commands, which apply the user's custom headers, TLS policy and proxy.

use std::{fs, path::PathBuf, time::Duration};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "gw-desktop";
const KEYRING_USER: &str = "ai-api-key";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiStyle {
    Openai,
    Anthropic,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HeaderEntry {
    pub(crate) name: String,
    pub(crate) value: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    enabled: bool,
    api_style: ApiStyle,
    base_url: String,
    model: String,
    auth_header: String,
    auth_prefix: String,
    headers: Vec<HeaderEntry>,
    verify_ssl: bool,
    proxy: String,
    timeout_secs: u64,
    temperature: f32,
    max_tokens: u32,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            api_style: ApiStyle::Openai,
            base_url: String::new(),
            model: String::new(),
            auth_header: "Authorization".into(),
            auth_prefix: "Bearer ".into(),
            headers: Vec::new(),
            verify_ssl: true,
            proxy: String::new(),
            timeout_secs: 60,
            temperature: 0.1,
            max_tokens: 1024,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: AiSettings,
    has_api_key: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    role: String,
    content: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ai-settings.json"))
}

fn load(app: &AppHandle) -> AiSettings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn stored_key() -> Option<String> {
    keyring_entry().ok()?.get_password().ok().filter(|k| !k.is_empty())
}

fn view(settings: AiSettings) -> SettingsView {
    SettingsView { settings, has_api_key: stored_key().is_some() }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsView {
    view(load(&app))
}

/// `api_key`: None = keep the stored key, Some("") = delete it, Some(k) = replace it.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AiSettings, api_key: Option<String>) -> Result<SettingsView, String> {
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(settings_path(&app)?, json).map_err(|e| e.to_string())?;
    match api_key.as_deref() {
        None => {}
        Some("") => match keyring_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Could not remove API key: {e}")),
        },
        Some(k) => keyring_entry()?.set_password(k).map_err(|e| format!("Could not store API key: {e}"))?,
    }
    Ok(view(settings))
}

/// Tests the settings currently in the dialog (not yet saved).
#[tauri::command]
pub async fn test_ai(settings: AiSettings, api_key: Option<String>) -> Result<String, String> {
    let key = api_key.filter(|k| !k.is_empty()).or_else(stored_key);
    let messages = vec![ChatMsg { role: "user".into(), content: "Reply with the single word OK.".into() }];
    complete(&settings, key.as_deref(), &messages).await
}

#[tauri::command]
pub async fn ai_chat(app: AppHandle, messages: Vec<ChatMsg>) -> Result<String, String> {
    let settings = load(&app);
    if !settings.enabled {
        return Err("AI is disabled. Enable it in AI settings.".into());
    }
    complete(&settings, stored_key().as_deref(), &messages).await
}

fn endpoint(base: &str, suffix: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err("Base URL must start with http:// or https://".into());
    }
    Ok(if base.ends_with(suffix) { base.to_string() } else { format!("{base}{suffix}") })
}

fn build_headers(s: &AiSettings, key: Option<&str>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let mut put = |name: &str, value: &str| -> Result<(), String> {
        let n = HeaderName::from_bytes(name.trim().as_bytes()).map_err(|_| format!("Invalid header name: {name:?}"))?;
        let mut v = HeaderValue::from_str(value).map_err(|_| format!("Invalid value for header {name}"))?;
        if n == reqwest::header::AUTHORIZATION || n.as_str().contains("key") || n.as_str().contains("token") {
            v.set_sensitive(true);
        }
        map.insert(n, v);
        Ok(())
    };
    if matches!(s.api_style, ApiStyle::Anthropic) {
        put("anthropic-version", "2023-06-01")?;
    }
    if let (Some(k), false) = (key, s.auth_header.trim().is_empty()) {
        put(&s.auth_header, &format!("{}{}", s.auth_prefix, k))?;
    }
    // Custom headers last, so they can override anything above.
    for h in s.headers.iter().filter(|h| !h.name.trim().is_empty()) {
        put(&h.name, &h.value)?;
    }
    Ok(map)
}

fn client(s: &AiSettings) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(s.timeout_secs.max(5)))
        .danger_accept_invalid_certs(!s.verify_ssl)
        .danger_accept_invalid_hostnames(!s.verify_ssl);
    if !s.proxy.trim().is_empty() {
        b = b.proxy(reqwest::Proxy::all(s.proxy.trim()).map_err(|e| format!("Invalid proxy: {e}"))?);
    }
    b.build().map_err(|e| e.to_string())
}

async fn complete(s: &AiSettings, key: Option<&str>, messages: &[ChatMsg]) -> Result<String, String> {
    if s.model.trim().is_empty() {
        return Err("Set a model name in AI settings.".into());
    }
    let (url, body) = match s.api_style {
        ApiStyle::Openai => (
            endpoint(&s.base_url, "/chat/completions")?,
            json!({
                "model": s.model,
                "messages": messages,
                "temperature": s.temperature,
                "max_tokens": s.max_tokens,
            }),
        ),
        ApiStyle::Anthropic => {
            let system: Vec<&str> = messages.iter().filter(|m| m.role == "system").map(|m| m.content.as_str()).collect();
            let rest: Vec<&ChatMsg> = messages.iter().filter(|m| m.role != "system").collect();
            (
                endpoint(&s.base_url, "/messages")?,
                json!({
                    "model": s.model,
                    "system": system.join("\n\n"),
                    "messages": rest,
                    "temperature": s.temperature,
                    "max_tokens": s.max_tokens,
                }),
            )
        }
    };

    let resp = client(s)?
        .post(&url)
        .headers(build_headers(s, key)?)
        .json(&body)
        .send()
        .await
        .map_err(|e| describe_send_error(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{url} returned HTTP {status}:\n{}", truncate(&text, 800)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("Response is not JSON:\n{}", truncate(&text, 800)))?;
    extract_text(s, &v).ok_or_else(|| format!("Unexpected response shape:\n{}", truncate(&text, 800)))
}

fn extract_text(s: &AiSettings, v: &Value) -> Option<String> {
    match s.api_style {
        ApiStyle::Openai => {
            let content = &v["choices"][0]["message"]["content"];
            content.as_str().map(str::to_owned).or_else(|| {
                // Some gateways return content as an array of parts.
                Some(content.as_array()?.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""))
            })
        }
        ApiStyle::Anthropic => Some(
            v["content"].as_array()?.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""),
        ),
    }
    .filter(|t| !t.is_empty())
}

fn describe_send_error(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        msg.push_str(&format!("\n  caused by: {s}"));
        src = s.source();
    }
    if msg.contains("certificate") || msg.contains("SSL") || msg.contains("TLS") {
        msg.push_str("\n\nHint: for an internal endpoint with a self-signed certificate, untick \"Verify SSL certificates\".");
    }
    msg
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{serve, Canned};

    fn settings(style: ApiStyle, base: &str) -> AiSettings {
        AiSettings { enabled: true, api_style: style, base_url: base.into(), model: "m1".into(), ..Default::default() }
    }

    fn msgs() -> Vec<ChatMsg> {
        vec![
            ChatMsg { role: "system".into(), content: "be brief".into() },
            ChatMsg { role: "user".into(), content: "Fields:\n- Sales".into() },
        ]
    }

    #[test]
    fn endpoint_appends_suffix_once() {
        assert_eq!(endpoint("https://llm.local/v1/", "/chat/completions").unwrap(), "https://llm.local/v1/chat/completions");
        assert_eq!(endpoint(" https://llm.local/v1/chat/completions ", "/chat/completions").unwrap(), "https://llm.local/v1/chat/completions");
        assert!(endpoint("llm.local/v1", "/messages").is_err());
    }

    #[test]
    fn headers_key_prefix_and_custom_overrides() {
        let mut s = settings(ApiStyle::Openai, "https://x");
        s.headers = vec![
            HeaderEntry { name: "X-Tenant".into(), value: "acme".into() },
            HeaderEntry { name: " ".into(), value: "ignored".into() },
        ];
        let h = build_headers(&s, Some("sk-1")).unwrap();
        assert_eq!(h["authorization"], "Bearer sk-1");
        assert!(h["authorization"].is_sensitive());
        assert_eq!(h["x-tenant"], "acme");
        assert_eq!(h.len(), 2);

        // A custom header can replace the default auth header.
        s.headers = vec![HeaderEntry { name: "Authorization".into(), value: "Basic abc".into() }];
        assert_eq!(build_headers(&s, Some("sk-1")).unwrap()["authorization"], "Basic abc");
    }

    #[test]
    fn headers_custom_key_header_and_anthropic_version() {
        let mut s = settings(ApiStyle::Anthropic, "https://x");
        s.auth_header = "x-api-key".into();
        s.auth_prefix = String::new();
        let h = build_headers(&s, Some("k")).unwrap();
        assert_eq!(h["x-api-key"], "k");
        assert!(h["x-api-key"].is_sensitive());
        assert_eq!(h["anthropic-version"], "2023-06-01");

        // No auth header configured: the key is not sent at all.
        s.auth_header = String::new();
        assert!(build_headers(&s, Some("k")).unwrap().get("x-api-key").is_none());
    }

    #[test]
    fn headers_reject_invalid_names_and_values() {
        let mut s = settings(ApiStyle::Openai, "https://x");
        s.headers = vec![HeaderEntry { name: "bad name".into(), value: "v".into() }];
        assert!(build_headers(&s, None).unwrap_err().contains("Invalid header name"));
        s.headers = vec![HeaderEntry { name: "X-A".into(), value: "line\nbreak".into() }];
        assert!(build_headers(&s, None).unwrap_err().contains("Invalid value"));
    }

    #[test]
    fn extracts_text_from_both_formats() {
        let o = settings(ApiStyle::Openai, "");
        assert_eq!(extract_text(&o, &json!({"choices":[{"message":{"content":"hi"}}]})).as_deref(), Some("hi"));
        assert_eq!(
            extract_text(&o, &json!({"choices":[{"message":{"content":[{"text":"a"},{"text":"b"}]}}]})).as_deref(),
            Some("ab")
        );
        assert_eq!(extract_text(&o, &json!({"choices":[]})), None);
        let a = settings(ApiStyle::Anthropic, "");
        assert_eq!(extract_text(&a, &json!({"content":[{"type":"text","text":"{}"}]})).as_deref(), Some("{}"));
        assert_eq!(extract_text(&a, &json!({"content":[]})), None);
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate("héllo", 2), "hé");
        assert_eq!(truncate("hi", 10), "hi");
    }

    #[test]
    fn openai_request_carries_headers_and_messages() {
        let srv = serve(Canned { status: 200, content_type: "application/json", body: br#"{"choices":[{"message":{"content":"{\"mark\":\"bar\"}"}}]}"#.to_vec() });
        let mut s = settings(ApiStyle::Openai, &format!("{}/v1", srv.base));
        s.headers = vec![HeaderEntry { name: "X-Gateway".into(), value: "corp".into() }];
        let out = tauri::async_runtime::block_on(complete(&s, Some("sk-9"), &msgs())).unwrap();
        assert_eq!(out, r#"{"mark":"bar"}"#);
        let req = srv.requests.lock().unwrap()[0].to_ascii_lowercase();
        assert!(req.starts_with("post /v1/chat/completions "), "{req}");
        assert!(req.contains("authorization: bearer sk-9"));
        assert!(req.contains("x-gateway: corp"));
        assert!(req.contains(r#""model":"m1""#) && req.contains("fields:\\n- sales"));
    }

    #[test]
    fn anthropic_request_moves_system_prompt() {
        let srv = serve(Canned { status: 200, content_type: "application/json", body: br#"{"content":[{"type":"text","text":"ok"}]}"#.to_vec() });
        let s = settings(ApiStyle::Anthropic, &srv.base);
        assert_eq!(tauri::async_runtime::block_on(complete(&s, Some("k"), &msgs())).unwrap(), "ok");
        let req = srv.requests.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /messages "), "{req}");
        assert!(req.contains(r#""system":"be brief""#));
        assert!(!req.contains(r#""role":"system""#));
    }

    #[test]
    fn http_errors_are_reported_with_status_and_body() {
        let srv = serve(Canned { status: 401, content_type: "application/json", body: br#"{"error":"bad key"}"#.to_vec() });
        let s = settings(ApiStyle::Openai, &srv.base);
        let err = tauri::async_runtime::block_on(complete(&s, Some("k"), &msgs())).unwrap_err();
        assert!(err.contains("401") && err.contains("bad key"), "{err}");
    }

    #[test]
    fn missing_model_is_reported_before_any_request() {
        let mut s = settings(ApiStyle::Openai, "https://unreachable.invalid");
        s.model = " ".into();
        assert!(tauri::async_runtime::block_on(complete(&s, None, &msgs())).unwrap_err().contains("model"));
    }
}
