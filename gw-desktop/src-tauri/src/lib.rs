mod ai;
mod basemap;
mod tiles;
#[cfg(test)]
mod test_http;

use tauri::Manager;

/// WebView2 switches: no background networking, telemetry pings or component updates, so the
/// webview itself makes no connections.
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --disable-background-networking --disable-component-update --disable-domain-reliability --no-pings";

/// WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the app passes its own
/// arguments, so switches from that variable (e.g. the remote-debugging port used by the
/// smoke test) are merged in here instead of being dropped.
fn webview2_args(extra: Option<&str>) -> String {
    match extra.map(str::trim) {
        Some(extra) if !extra.is_empty() => format!("{WEBVIEW2_ARGS} {extra}"),
        _ => WEBVIEW2_ARGS.to_string(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(tiles::TileState::load(app.handle()));
            // The main window is declared in tauri.conf.json with `create: false` and built here,
            // so its browser arguments can be computed at runtime.
            let config = app.config().app.windows.first().cloned().ok_or("no window in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .additional_browser_args(&webview2_args(std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().as_deref()))
                .build()?;
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("tiles", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(tiles::handle(app, request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            ai::get_settings,
            ai::save_settings,
            ai::test_ai,
            ai::ai_chat,
            tiles::get_map_settings,
            tiles::save_map_settings,
            tiles::clear_tile_cache,
            tiles::test_tiles,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Graphic Walker Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview2_args_keep_privacy_switches_and_merge_extra() {
        assert_eq!(webview2_args(None), WEBVIEW2_ARGS);
        assert_eq!(webview2_args(Some("  ")), WEBVIEW2_ARGS);
        let merged = webview2_args(Some(" --remote-debugging-port=9222 "));
        assert!(merged.starts_with("--disable-features=msWebOOUI"));
        assert!(merged.contains(" --disable-background-networking "));
        assert!(merged.ends_with(" --remote-debugging-port=9222"));
    }
}
