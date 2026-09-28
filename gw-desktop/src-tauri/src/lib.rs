mod ai;
mod basemap;
mod tiles;
#[cfg(test)]
mod test_http;

use tauri::Manager;

/// WebView2 switches: no background networking, telemetry pings or component updates, so the
/// webview itself makes no connections. Passed through the environment variable rather than
/// `additionalBrowserArgs` so they combine with switches set by other tools (e.g. the WebDriver
/// used in the smoke test adds remote debugging the same way) instead of replacing them.
#[cfg(windows)]
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
    --disable-background-networking --disable-component-update --disable-domain-reliability --no-pings";

#[cfg(windows)]
fn set_webview2_args() {
    const VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let args = match std::env::var(VAR) {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing} {WEBVIEW2_ARGS}"),
        _ => WEBVIEW2_ARGS.to_string(),
    };
    // Called first thing in run(), before any other thread exists.
    std::env::set_var(VAR, args);
}

pub fn run() {
    #[cfg(windows)]
    set_webview2_args();
    tauri::Builder::default()
        .setup(|app| {
            app.manage(tiles::TileState::load(app.handle()));
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
