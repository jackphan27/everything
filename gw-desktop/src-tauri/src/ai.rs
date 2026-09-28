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
