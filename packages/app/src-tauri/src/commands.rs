#[tauri::command]
pub fn agent_app_exit(app: tauri::AppHandle) {
    app.exit(0);
}