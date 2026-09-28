mod ai;
mod basemap;
mod tiles;

use tauri::Manager;

pub fn run() {
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
