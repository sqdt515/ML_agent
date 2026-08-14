mod agent_config;
mod agent_tools;
mod commands;
mod llm;
mod tray;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::agent_app_exit,
            agent_config::agent_get_config,
            agent_config::agent_save_config,
            llm::agent_chat_stream,
            llm::agent_summarize,
            agent_tools::agent_tool_pet_show,
            agent_tools::agent_tool_pet_hide,
            agent_tools::agent_tool_open_url,
            agent_tools::agent_tool_system_info,
            agent_tools::agent_tool_get_time,
            agent_tools::agent_tool_note_create,
            agent_tools::agent_tool_note_list,
        ])
        .setup(|app| {
            println!("New AI started");
            tray::setup_tray(app)?;

            // 显示式显示 pet 窗口（Tauri 2 在某些环境下 visible:true 不生效）
            if let Some(window) = app.get_webview_window("pet") {
                println!("setup: found pet window");
                if let Err(e) = window.show() {
                    eprintln!("setup: show error: {e}");
                }
            } else {
                println!("setup: pet window not found");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building new-ai")
        .run(|app, event| {
            if let tauri::RunEvent::Ready = event {
                println!("ready: application ready");
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    println!("retry: delayed show");
                    if let Some(window) = app_handle.get_webview_window("pet") {
                        if let Err(e) = window.show() {
                            eprintln!("retry: show error: {e}");
                        }
                    } else {
                        eprintln!("retry: pet window not found (delayed)");
                    }
                });
            }
        });
}