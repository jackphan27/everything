mod ai;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ai::get_settings,
            ai::save_settings,
            ai::test_ai,
            ai::ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Graphic Walker Desktop");
}
