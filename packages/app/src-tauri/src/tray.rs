use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

pub const TRAY_ID: &str = "main";

fn is_chinese() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Globalization::GetUserDefaultUILanguage;
        let lang_id = unsafe { GetUserDefaultUILanguage() };
        // 主语言 ID 0x04 = 中文（含 zh-CN / zh-TW / zh-HK）
        lang_id & 0x3FF == 0x04
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(lang) = std::env::var("LANG") {
            lang.starts_with("zh")
        } else {
            false
        }
    }
}

/// 切换设置窗口（social）的可见性：隐藏则显示并聚焦，显示则隐藏。
fn toggle_settings_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("social") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let zh = is_chinese();

    let show = MenuItem::with_id(
        app,
        "show",
        if zh { "显示宠物" } else { "Show Pet" },
        true,
        None::<&str>,
    )?;
    let hide = MenuItem::with_id(
        app,
        "hide",
        if zh { "隐藏宠物" } else { "Hide Pet" },
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "settings",
        if zh { "设置" } else { "Settings" },
        true,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if zh { "退出" } else { "Quit" },
        true,
        None::<&str>,
    )?;

    let menu = Menu::with_items(app, &[&show, &hide, &settings, &sep, &quit])?;

    let png_data = include_bytes!("../icons/icon.png");
    let icon = match Image::from_bytes(png_data) {
        Ok(img) => img,
        Err(e) => {
            eprintln!("tray: failed to decode icon.png, using fallback: {e}");
            Image::new_owned(vec![0, 0, 0, 0], 1, 1)
        }
    };

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .icon_as_template(false)
        .tooltip("New AI")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.show();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.hide();
                }
            }
            "settings" => {
                toggle_settings_window(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
