use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use windows::core::PCWSTR;
use windows::Win32::Foundation::WIN32_ERROR;
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_VALUE_TYPE, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
};
use windows::Win32::System::SystemInformation::{
    GlobalMemoryStatusEx, GetNativeSystemInfo, GetTickCount64, MEMORYSTATUSEX, SYSTEM_INFO,
};

fn ok_json(value: serde_json::Value) -> Result<String, String> {
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// === 桌宠控制 ===

#[tauri::command]
pub fn agent_tool_pet_show(app: AppHandle) -> Result<String, String> {
    let window = app.get_webview_window("pet").ok_or_else(|| "找不到桌宠窗口".to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    ok_json(serde_json::json!({ "ok": true, "result": "桌宠已显示" }))
}

#[tauri::command]
pub fn agent_tool_pet_hide(app: AppHandle) -> Result<String, String> {
    let window = app.get_webview_window("pet").ok_or_else(|| "找不到桌宠窗口".to_string())?;
    let _ = window.hide();
    ok_json(serde_json::json!({ "ok": true, "result": "桌宠已隐藏" }))
}

// === 打开链接 ===

#[tauri::command]
pub fn agent_tool_open_url(url: String) -> Result<String, String> {
    let trimmed = url.trim().to_string();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("仅允许打开 http/https 链接".to_string());
    }
    open::that(&trimmed).map_err(|e| format!("打开链接失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "result": format!("已在浏览器打开 {trimmed}") }))
}

// === 系统信息 ===

#[tauri::command]
pub fn agent_tool_system_info() -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string());

    let mut info: SYSTEM_INFO = unsafe { std::mem::zeroed() };
    unsafe { GetNativeSystemInfo(&mut info) };

    let mut mem: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let _ = unsafe { GlobalMemoryStatusEx(&mut mem) };

    let uptime_secs = unsafe { GetTickCount64() } / 1000;
    ok_json(serde_json::json!({
        "ok": true,
        "os": os,
        "arch": arch,
        "hostname": host,
        "cpu_cores": info.dwNumberOfProcessors,
        "memory_total_gb": round1(mem.ullTotalPhys as f64 / 1073741824.0),
        "memory_avail_gb": round1(mem.ullAvailPhys as f64 / 1073741824.0),
        "uptime_secs": uptime_secs,
    }))
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

// === 时间 ===

fn encode_w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 从 UTC 纪元秒数转公历 (年, 月, 日)
fn civil_from_days(z0: i64) -> (i64, u32, u32) {
    let z = z0 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

fn format_iso(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    let rem = secs.rem_euclid(86400);
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let s = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
}

/// 读取注册表 ActiveTimeBias：UTC 与本地时间的分钟差（UTC - 本地）
fn local_utc_offset_minutes() -> Option<i32> {
    unsafe {
        let subkey = encode_w("SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation");
        let mut key: HKEY = std::mem::zeroed();
        let rc = RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(subkey.as_ptr()), None, KEY_READ, &mut key);
        if rc != WIN32_ERROR(0) {
            return None;
        }
        let name = encode_w("ActiveTimeBias");
        let mut ty: REG_VALUE_TYPE = REG_VALUE_TYPE(0);
        let mut data: i32 = 0;
        let mut size: u32 = 4;
        let rc2 = RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut ty),
            Some(&mut data as *mut i32 as *mut u8),
            Some(&mut size),
        );
        let _ = RegCloseKey(key);
        if rc2 != WIN32_ERROR(0) {
            return None;
        }
        Some(data)
    }
}

#[tauri::command]
pub fn agent_tool_get_time() -> Result<String, String> {
    let secs = now_secs() as i64;
    let utc = format_iso(secs);
    let (local, offset) = match local_utc_offset_minutes() {
        Some(bias) => {
            let local_secs = secs - i64::from(bias) * 60;
            let sign = if bias <= 0 { '+' } else { '-' };
            let abs = bias.abs();
            (format_iso(local_secs), format!("UTC{sign}{:02}:{:02}", abs / 60, abs % 60))
        }
        None => (utc.clone(), "UTC".to_string()),
    };
    ok_json(serde_json::json!({ "ok": true, "utc": utc, "local": local, "offset": offset }))
}

// === 便签 ===

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    id: String,
    text: String,
    created_at: u64,
}

fn notes_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("notes.json")
}

fn load_notes(app: &AppHandle) -> Vec<Note> {
    std::fs::read_to_string(notes_path(app))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_notes(app: &AppHandle, notes: &[Note]) -> Result<(), String> {
    let path = notes_path(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(notes).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("写入便签失败: {e}"))
}

#[tauri::command]
pub fn agent_tool_note_create(app: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("便签内容不能为空".to_string());
    }
    let mut notes = load_notes(&app);
    notes.push(Note {
        id: format!("n_{}", now_secs()),
        text: trimmed,
        created_at: now_secs(),
    });
    save_notes(&app, &notes)?;
    ok_json(serde_json::json!({ "ok": true, "result": format!("便签已创建（当前共 {} 条）", notes.len()) }))
}

#[tauri::command]
pub fn agent_tool_note_list(app: AppHandle) -> Result<String, String> {
    let notes = load_notes(&app);
    ok_json(serde_json::json!({ "ok": true, "notes": notes }))
}

// === 文件系统（只读，低危） ===

#[tauri::command]
pub fn agent_tool_fs_list(dir: String) -> Result<String, String> {
    let path = std::path::Path::new(dir.trim());
    if path.as_os_str().is_empty() {
        return Err("目录不能为空".to_string());
    }
    let entries = std::fs::read_dir(path).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            entry.metadata().ok().map(|m| m.len())
        };
        items.push(serde_json::json!({ "name": name, "is_dir": is_dir, "size": size }));
    }
    items.sort_by(|a, b| {
        let ad = a["is_dir"].as_bool().unwrap_or(false);
        let bd = b["is_dir"].as_bool().unwrap_or(false);
        bd.cmp(&ad).then_with(|| {
            a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
        })
    });
    let total = items.len();
    if items.len() > 200 {
        items.truncate(200);
    }
    ok_json(serde_json::json!({ "ok": true, "path": dir, "count": total, "items": items }))
}

#[tauri::command]
pub fn agent_tool_fs_read(path: String) -> Result<String, String> {
    let p = std::path::Path::new(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件失败: {e}"))?;
    if meta.is_dir() {
        return Err("目标是目录，请改用列目录工具".to_string());
    }
    const MAX_BYTES: u64 = 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "文件过大（{} 字节），仅支持 ≤1MB 的文本文件",
            meta.len()
        ));
    }
    let content =
        std::fs::read_to_string(p).map_err(|e| format!("读取失败（可能非 UTF-8 文本）: {e}"))?;
    const MAX_CHARS: usize = 8000;
    let truncated = content.chars().count() > MAX_CHARS;
    let display: String = content.chars().take(MAX_CHARS).collect();
    ok_json(serde_json::json!({ "ok": true, "path": path, "size": meta.len(), "truncated": truncated, "content": display }))
}

// === 系统通知 ===

#[tauri::command]
pub fn agent_tool_notify(app: AppHandle, text: String) -> Result<String, String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err("通知内容不能为空".to_string());
    }
    app.notification()
        .builder()
        .title("New AI")
        .body(&trimmed)
        .show()
        .map_err(|e| format!("发送通知失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "result": "通知已发送" }))
}

// === 剪贴板 ===

#[tauri::command]
pub fn agent_tool_clipboard_read() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    let text = cb.get_text().map_err(|e| format!("读取剪贴板失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "text": text }))
}

#[tauri::command]
pub fn agent_tool_clipboard_write(text: String) -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    cb.set_text(text.clone())
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "result": "已写入剪贴板" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_known_values() {
        // 1970-01-01
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-02-29 闰日
        assert_eq!(civil_from_days(11016), (2000, 2, 29));
        // 2026-08-05
        assert_eq!(civil_from_days(20670), (2026, 8, 5));
    }

    #[test]
    fn iso_format() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00");
        assert_eq!(format_iso(86399), "1970-01-01T23:59:59");
        assert_eq!(format_iso(86400), "1970-01-02T00:00:00");
    }
}