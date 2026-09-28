//! Basemap tile proxy. The webview's CSP blocks every remote host, so map tiles are
//! requested from the `tiles:` custom protocol and served here: from the built-in
//! offline basemap (default), or fetched from a tile server and cached on disk.
//! Whenever an online tile can't be fetched, the built-in basemap is served instead,
//! so the map never goes blank.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        RwLock,
    },
    time::Duration,
};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::{
    http::{Request, Response, StatusCode},
    AppHandle, Manager, State,
};

use crate::{ai::HeaderEntry, basemap};

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TileMode {
    /// Built-in offline basemap rendered locally (no network).
    Builtin,
    /// Fetch missing tiles from the tile server and cache them.
    Online,
    /// Serve cached tiles only (built-in basemap where none is cached); never touch the network.
    Cache,
    /// No basemap.
    Off,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MapSettings {
    mode: TileMode,
    /// XYZ template, e.g. https://tile.openstreetmap.org/{z}/{x}/{y}.png ({s} is also supported).
    url_template: String,
    attribution: String,
    headers: Vec<HeaderEntry>,
    verify_ssl: bool,
    proxy: String,
}

impl Default for MapSettings {
    fn default() -> Self {
        Self {
            mode: TileMode::Builtin,
            url_template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png".into(),
            attribution: "© OpenStreetMap contributors".into(),
            headers: Vec::new(),
            verify_ssl: true,
            proxy: String::new(),
        }
    }
}

struct Inner {
    settings: MapSettings,
    client: reqwest::Client,
    revision: u64,
}

pub struct TileState {
    inner: RwLock<Inner>,
    cache_root: PathBuf,
    settings_file: PathBuf,
    /// Unix time until which the tile server is considered unreachable (skip straight to fallback).
    offline_until: AtomicU64,
}

const OFFLINE_BACKOFF_SECS: u64 = 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSettingsView {
    settings: MapSettings,
    /// Changes whenever settings are saved, so the webview can cache-bust tile URLs.
    revision: u64,
}

fn build_client(s: &MapSettings) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    for h in s.headers.iter().filter(|h| !h.name.trim().is_empty()) {
        let n = HeaderName::from_bytes(h.name.trim().as_bytes()).map_err(|_| format!("Invalid header name: {:?}", h.name))?;
        let v = HeaderValue::from_str(&h.value).map_err(|_| format!("Invalid value for header {}", h.name))?;
        headers.insert(n, v);
    }
    let mut b = reqwest::Client::builder()
        // OSM's tile policy requires an identifying User-Agent.
        .user_agent(concat!("GraphicWalkerDesktop/", env!("CARGO_PKG_VERSION")))
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .danger_accept_invalid_certs(!s.verify_ssl)
        .danger_accept_invalid_hostnames(!s.verify_ssl);
    if !s.proxy.trim().is_empty() {
        b = b.proxy(reqwest::Proxy::all(s.proxy.trim()).map_err(|e| format!("Invalid proxy: {e}"))?);
    }
    b.build().map_err(|e| e.to_string())
}

impl TileState {
    pub fn load(app: &AppHandle) -> Self {
        let config_dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
        let cache_root = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("tiles");
        let settings_file = config_dir.join("map-settings.json");
        let settings: MapSettings = fs::read_to_string(&settings_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let client = build_client(&settings).unwrap_or_else(|_| build_client(&MapSettings::default()).expect("default tile client"));
        Self {
            inner: RwLock::new(Inner { settings, client, revision: 1 }),
            cache_root,
            settings_file,
            offline_until: AtomicU64::new(0),
        }
    }

    fn view(&self) -> MapSettingsView {
        let g = self.inner.read().unwrap();
        MapSettingsView { settings: g.settings.clone(), revision: g.revision }
    }
}

#[tauri::command]
pub fn get_map_settings(state: State<'_, TileState>) -> MapSettingsView {
    state.view()
}

#[tauri::command]
pub fn save_map_settings(state: State<'_, TileState>, settings: MapSettings) -> Result<MapSettingsView, String> {
    let client = build_client(&settings)?;
    if let Some(dir) = state.settings_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&state.settings_file, json).map_err(|e| e.to_string())?;
    {
        let mut g = state.inner.write().unwrap();
        g.settings = settings;
        g.client = client;
        g.revision += 1;
    }
    state.offline_until.store(0, Ordering::Relaxed);
    Ok(state.view())
}

#[tauri::command]
pub fn clear_tile_cache(state: State<'_, TileState>) -> Result<(), String> {
    match fs::remove_dir_all(&state.cache_root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// FNV-1a: stable folder name per tile source so switching servers never mixes tiles.
fn source_key(template: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in template.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn parse_zxy(path: &str) -> Option<(u32, u32, u32)> {
    let mut it = path.trim_matches('/').split('/');
    let z: u32 = it.next()?.parse().ok()?;
    let x: u32 = it.next()?.parse().ok()?;
    let y_part = it.next()?;
    let y: u32 = y_part.split('.').next()?.parse().ok()?;
    if it.next().is_some() || z > 24 || x >= (1u32 << z) || y >= (1u32 << z) {
        return None;
    }
    Some((z, x, y))
}

fn sniff_type(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    respond_from(status, body, "")
}

fn respond_from(status: StatusCode, body: Vec<u8>, source: &str) -> Response<Vec<u8>> {
    let ctype = if status.is_success() { sniff_type(&body) } else { "text/plain" };
    // Fallback tiles must not be cached by the webview, so real tiles replace them once online.
    let cache = if source == "fallback" { "no-store" } else { "max-age=86400" };
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Cache-Control", cache)
        .header("X-Tile-Source", source)
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap()
}

fn read_cached(path: &Path) -> Option<Vec<u8>> {
    fs::read(path).ok().filter(|b| !b.is_empty())
}

async fn builtin(z: u32, x: u32, y: u32, source: &str) -> Response<Vec<u8>> {
    match tauri::async_runtime::spawn_blocking(move || basemap::render_tile(z, x, y)).await {
        Ok(png) if !png.is_empty() => respond_from(StatusCode::OK, png, source),
        _ => respond(StatusCode::INTERNAL_SERVER_ERROR, b"render failed".to_vec()),
    }
}

fn tile_url(template: &str, z: u32, x: u32, y: u32) -> String {
    let sub = ["a", "b", "c"][((x + y) % 3) as usize];
    template
        .replace("{s}", sub)
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string())
        .replace("{r}", "")
}

/// Fetch one tile; Err carries a human-readable reason (status, TLS error, …).
async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client.get(url).send().await.map_err(|e| {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(&format!("\n  caused by: {s}"));
            src = s.source();
        }
        msg
    })?;
    let status = resp.status();
    let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
        return Err(format!("HTTP {status} from {url}\n{body}"));
    }
    if sniff_type(&bytes) == "application/octet-stream" {
        return Err(format!("{url} did not return an image (content-type {ctype:?}, {} bytes)", bytes.len()));
    }
    Ok(bytes.to_vec())
}

/// Try the tile server with the (unsaved) settings from the dialog.
#[tauri::command]
pub async fn test_tiles(settings: MapSettings) -> Result<String, String> {
    let client = build_client(&settings)?;
    let url = tile_url(&settings.url_template, 5, 25, 16);
    let started = std::time::Instant::now();
    let bytes = fetch(&client, &url).await?;
    Ok(format!("OK: {url} returned a {} image ({} bytes) in {} ms", sniff_type(&bytes), bytes.len(), started.elapsed().as_millis()))
}

pub async fn handle(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some((z, x, y)) = parse_zxy(request.uri().path()) else {
        return respond(StatusCode::BAD_REQUEST, b"expected /{z}/{x}/{y}".to_vec());
    };
    let state = app.state::<TileState>();
    let (settings, client) = {
        let g = state.inner.read().unwrap();
        (g.settings.clone(), g.client.clone())
    };
    match settings.mode {
        TileMode::Off => return respond(StatusCode::NOT_FOUND, Vec::new()),
        TileMode::Builtin => return builtin(z, x, y, "builtin").await,
        TileMode::Online | TileMode::Cache => {}
    }
    let file = state
        .cache_root
        .join(source_key(&settings.url_template))
        .join(z.to_string())
        .join(x.to_string())
        .join(y.to_string());
    if let Some(bytes) = read_cached(&file) {
        return respond_from(StatusCode::OK, bytes, "cache");
    }
    if settings.mode == TileMode::Cache {
        return builtin(z, x, y, "fallback").await;
    }
    if now_secs() < state.offline_until.load(Ordering::Relaxed) {
        return builtin(z, x, y, "fallback").await;
    }
    match fetch(&client, &tile_url(&settings.url_template, z, x, y)).await {
        Ok(bytes) => {
            if let Some(dir) = file.parent() {
                if fs::create_dir_all(dir).is_ok() {
                    let _ = fs::write(&file, &bytes);
                }
            }
            respond_from(StatusCode::OK, bytes, "online")
        }
        // Offline, blocked or failing server: show the built-in basemap instead of a blank map.
        Err(_) => {
            state.offline_until.store(now_secs() + OFFLINE_BACKOFF_SECS, Ordering::Relaxed);
            builtin(z, x, y, "fallback").await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::{serve, Canned};

    #[test]
    fn parses_tile_paths() {
        assert_eq!(parse_zxy("/3/4/5"), Some((3, 4, 5)));
        assert_eq!(parse_zxy("/3/4/5.png"), Some((3, 4, 5)));
        assert_eq!(parse_zxy("/3/8/5"), None); // x out of range at z=3
        assert_eq!(parse_zxy("/../etc/passwd"), None);
        assert_eq!(parse_zxy("/1/0/0/extra"), None);
        assert_eq!(parse_zxy("/25/0/0"), None);
    }

    #[test]
    fn fills_url_templates() {
        assert_eq!(tile_url("https://t/{z}/{x}/{y}.png", 5, 25, 16), "https://t/5/25/16.png");
        assert_eq!(tile_url("https://{s}.t/{z}/{x}/{y}{r}.png", 1, 1, 1), "https://c.t/1/1/1.png");
    }

    #[test]
    fn cache_folder_differs_per_server() {
        assert_ne!(source_key("https://a/{z}/{x}/{y}"), source_key("https://b/{z}/{x}/{y}"));
        assert_eq!(source_key("x").len(), 16);
    }

    #[test]
    fn sniffs_image_types() {
        assert_eq!(sniff_type(&crate::basemap::render_tile(0, 0, 0)), "image/png");
        assert_eq!(sniff_type(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
        assert_eq!(sniff_type(b"RIFF\0\0\0\0WEBPVP8"), "image/webp");
        assert_eq!(sniff_type(b"<html>"), "application/octet-stream");
    }

    fn with_headers(headers: Vec<HeaderEntry>) -> MapSettings {
        MapSettings { mode: TileMode::Online, headers, ..Default::default() }
    }

    #[test]
    fn fetch_sends_custom_headers_and_user_agent() {
        let png = crate::basemap::render_tile(1, 0, 0);
        let srv = serve(Canned { status: 200, content_type: "image/png", body: png.clone() });
        let client = build_client(&with_headers(vec![HeaderEntry { name: "X-Key".into(), value: "k1".into() }])).unwrap();
        let got = tauri::async_runtime::block_on(fetch(&client, &format!("{}/1/0/0.png", srv.base))).unwrap();
        assert_eq!(got, png);
        let req = srv.requests.lock().unwrap()[0].to_ascii_lowercase();
        assert!(req.starts_with("get /1/0/0.png "));
        assert!(req.contains("x-key: k1"));
        assert!(req.contains("user-agent: graphicwalkerdesktop/"));
    }

    #[test]
    fn fetch_rejects_errors_and_non_images() {
        let client = build_client(&MapSettings::default()).unwrap();
        let srv = serve(Canned { status: 403, content_type: "text/plain", body: b"blocked by policy".to_vec() });
        let err = tauri::async_runtime::block_on(fetch(&client, &format!("{}/0/0/0", srv.base))).unwrap_err();
        assert!(err.contains("403") && err.contains("blocked by policy"), "{err}");
        let srv = serve(Canned { status: 200, content_type: "text/html", body: b"<html>login</html>".to_vec() });
        let err = tauri::async_runtime::block_on(fetch(&client, &format!("{}/0/0/0", srv.base))).unwrap_err();
        assert!(err.contains("did not return an image"), "{err}");
    }

    #[test]
    fn rejects_invalid_header_names() {
        assert!(build_client(&with_headers(vec![HeaderEntry { name: "a b".into(), value: "v".into() }])).is_err());
    }

    #[test]
    fn settings_json_uses_defaults_for_missing_fields() {
        let s: MapSettings = serde_json::from_str(r#"{"mode":"online"}"#).unwrap();
        assert!(matches!(s.mode, TileMode::Online));
        assert!(s.verify_ssl);
        assert!(s.url_template.contains("{z}"));
    }
}
