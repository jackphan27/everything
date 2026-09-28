//! Basemap tile proxy. The webview's CSP blocks every remote host, so map tiles are
//! requested from the `tiles:` custom protocol and fetched here instead. Tiles are
//! cached on disk, so areas you have viewed keep working offline, and "cache only"
//! mode never touches the network.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
    time::Duration,
};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::{
    http::{Request, Response, StatusCode},
    AppHandle, Manager, State,
};

use crate::ai::HeaderEntry;

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TileMode {
    /// Fetch missing tiles from the tile server and cache them.
    Online,
    /// Serve cached tiles only; never touch the network.
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
            mode: TileMode::Online,
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
        .timeout(Duration::from_secs(20))
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
        Self { inner: RwLock::new(Inner { settings, client, revision: 1 }), cache_root, settings_file }
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
    let ctype = if status.is_success() { sniff_type(&body) } else { "text/plain" };
    Response::builder()
        .status(status)
        .header("Content-Type", ctype)
        .header("Cache-Control", "max-age=86400")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap()
}

fn read_cached(path: &Path) -> Option<Vec<u8>> {
    fs::read(path).ok().filter(|b| !b.is_empty())
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
    if settings.mode == TileMode::Off {
        return respond(StatusCode::NOT_FOUND, Vec::new());
    }
    let file = state
        .cache_root
        .join(source_key(&settings.url_template))
        .join(z.to_string())
        .join(x.to_string())
        .join(y.to_string());
    if let Some(bytes) = read_cached(&file) {
        return respond(StatusCode::OK, bytes);
    }
    if settings.mode == TileMode::Cache {
        return respond(StatusCode::NOT_FOUND, Vec::new());
    }

    let sub = ["a", "b", "c"][((x + y) % 3) as usize];
    let url = settings
        .url_template
        .replace("{s}", sub)
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string())
        .replace("{r}", "");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => return respond(StatusCode::BAD_GATEWAY, e.to_string().into_bytes()),
    };
    let status = resp.status();
    let Ok(bytes) = resp.bytes().await else {
        return respond(StatusCode::BAD_GATEWAY, Vec::new());
    };
    if !status.is_success() {
        return respond(StatusCode::BAD_GATEWAY, format!("{url} returned {status}").into_bytes());
    }
    if let Some(dir) = file.parent() {
        if fs::create_dir_all(dir).is_ok() {
            let _ = fs::write(&file, &bytes);
        }
    }
    respond(StatusCode::OK, bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tile_paths() {
        assert_eq!(parse_zxy("/3/4/5"), Some((3, 4, 5)));
        assert_eq!(parse_zxy("/3/4/5.png"), Some((3, 4, 5)));
        assert_eq!(parse_zxy("/3/8/5"), None); // x out of range at z=3
        assert_eq!(parse_zxy("/../etc/passwd"), None);
        assert_eq!(parse_zxy("/1/0/0/extra"), None);
    }
}
