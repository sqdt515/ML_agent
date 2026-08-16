use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use windows::core::PCWSTR;
use windows::Win32::Foundation::WIN32_ERROR;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    REG_VALUE_TYPE,
};
use windows::Win32::System::SystemInformation::{
    GetNativeSystemInfo, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};

fn ok_json(value: serde_json::Value) -> Result<String, String> {
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect()
    } else {
        s.to_string()
    }
}

// === 桌宠控制 ===

#[tauri::command]
pub fn agent_tool_pet_show(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "找不到桌宠窗口".to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    ok_json(serde_json::json!({ "ok": true, "result": "桌宠已显示" }))
}

#[tauri::command]
pub fn agent_tool_pet_hide(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "找不到桌宠窗口".to_string())?;
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
        let rc = RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            None,
            KEY_READ,
            &mut key,
        );
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
            (
                format_iso(local_secs),
                format!("UTC{sign}{:02}:{:02}", abs / 60, abs % 60),
            )
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
    ok_json(
        serde_json::json!({ "ok": true, "result": format!("便签已创建（当前共 {} 条）", notes.len()) }),
    )
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
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        })
    });
    let total = items.len();
    if items.len() > 200 {
        items.truncate(200);
    }
    ok_json(serde_json::json!({ "ok": true, "path": dir, "count": total, "items": items }))
}

#[tauri::command]
/// 解析读取路径：绝对路径原样返回，相对路径解析到工作目录（与 fs_write/fs_delete 一致，不做沙箱限制）
fn resolve_read_path(ws: &std::path::Path, input: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(input.trim());
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        ws.join(p)
    }
}

/// 读取文本文件的核心逻辑（纯函数，接受已解析的路径）
fn read_text_file(p: &std::path::Path, display_path: &str) -> Result<String, String> {
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
    ok_json(
        serde_json::json!({ "ok": true, "path": display_path, "size": meta.len(), "truncated": truncated, "content": display }),
    )
}

#[tauri::command]
pub fn agent_tool_fs_read(app: AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let resolved = resolve_read_path(&workspace_dir(&app), trimmed);
    read_text_file(&resolved, &resolved.to_string_lossy())
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

// === 文件写入/删除（中危：限制在应用专属工作目录） ===

fn workspace_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("workspace")
}

/// 纯函数：把用户输入路径解析到 ws 目录内，防路径穿越（..）与越界
fn resolve_within(ws: &std::path::Path, input: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(input.trim());
    if p.as_os_str().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        ws.join(p)
    };
    let parent = joined.parent().unwrap_or(ws);
    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("解析路径失败: {e}"))?;
    let file_name = joined.file_name().ok_or_else(|| "路径无效".to_string())?;
    let resolved = parent_canon.join(file_name);
    std::fs::create_dir_all(ws).map_err(|e| format!("创建工作目录失败: {e}"))?;
    let ws_canon = ws
        .canonicalize()
        .map_err(|e| format!("解析工作目录失败: {e}"))?;
    if !resolved.starts_with(&ws_canon) {
        return Err("路径超出工作目录范围".to_string());
    }
    Ok(resolved)
}

/// 把用户输入路径解析到应用工作目录内
fn resolve_in_workspace(app: &AppHandle, input: &str) -> Result<std::path::PathBuf, String> {
    resolve_within(&workspace_dir(app), input)
}

/// 剥掉 Windows verbatim 前缀（\\?\、\\?\UNC\），返回适合展示的路径
fn display_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{}", stripped)
    } else if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        stripped.to_string()
    } else {
        s.into_owned()
    }
}

#[tauri::command]
pub fn agent_tool_fs_write(
    app: AppHandle,
    path: String,
    content: String,
) -> Result<String, String> {
    if content.len() > 1024 * 1024 {
        return Err("内容过大（>1MB）".to_string());
    }
    let target = resolve_in_workspace(&app, &path)?;
    std::fs::write(&target, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "result": "已写入", "path": display_path(&target) }))
}

#[tauri::command]
pub fn agent_tool_fs_delete(app: AppHandle, path: String) -> Result<String, String> {
    let target = resolve_in_workspace(&app, &path)?;
    let meta = std::fs::metadata(&target).map_err(|e| format!("文件不存在或无法访问: {e}"))?;
    if meta.is_dir() {
        return Err("仅支持删除文件，不删除目录".to_string());
    }
    std::fs::remove_file(&target).map_err(|e| format!("删除失败: {e}"))?;
    ok_json(serde_json::json!({ "ok": true, "result": "已删除", "path": display_path(&target) }))
}

// === 命令执行（高危：不做命令白名单，仅超时与输出截断防护） ===

#[tauri::command]
pub fn agent_tool_exec(cmd: String) -> Result<String, String> {
    let trimmed = cmd.trim().to_string();
    if trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    let mut child = std::process::Command::new("cmd")
        .args(["/C", &trimmed])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动命令失败: {e}"))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let pid = child.id();
                    // /T 杀整棵进程树（cmd + 子进程），/F 强制，确保管道写端全部关闭
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
                    let _ = child.wait();
                    return Err("命令执行超时（30 秒），已终止".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待命令失败: {e}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("读取输出失败: {e}"))?;

    fn truncate(s: String) -> (String, bool) {
        const MAX_CHARS: usize = 8000;
        if s.chars().count() > MAX_CHARS {
            (s.chars().take(MAX_CHARS).collect(), true)
        } else {
            (s, false)
        }
    }
    let (stdout_disp, so_trunc) = truncate(String::from_utf8_lossy(&output.stdout).to_string());
    let (stderr_disp, se_trunc) = truncate(String::from_utf8_lossy(&output.stderr).to_string());

    ok_json(serde_json::json!({
        "ok": output.status.success(),
        "exit_code": output.status.code(),
        "stdout": stdout_disp,
        "stderr": stderr_disp,
        "stdout_truncated": so_trunc,
        "stderr_truncated": se_trunc,
    }))
}

// === 联网搜索（Tavily） ===

/// 调用 Tavily Search API，返回响应体 JSON 字符串
fn tavily_post(body_json: &str) -> Result<String, String> {
    const HOST: &str = "api.tavily.com";
    const PORT: u16 = 443;
    const PATH: &str = "/search";
    unsafe {
        let session = WinHttpOpen(
            PCWSTR::null(),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err("WinHttpOpen 失败".to_string());
        }
        let server = encode_w(HOST);
        let connect = WinHttpConnect(session, PCWSTR(server.as_ptr()), PORT, 0);
        if connect.is_null() {
            let _ = WinHttpCloseHandle(session);
            return Err("WinHttpConnect 失败".to_string());
        }
        let verb = encode_w("POST");
        let object = encode_w(PATH);
        let request = WinHttpOpenRequest(
            connect,
            PCWSTR(verb.as_ptr()),
            PCWSTR(object.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        if request.is_null() {
            let _ = WinHttpCloseHandle(connect);
            let _ = WinHttpCloseHandle(session);
            return Err("WinHttpOpenRequest 失败".to_string());
        }
        let _ = WinHttpSetTimeouts(request, 10000, 10000, 30000, 30000);
        let headers: Vec<u16> = "Content-Type: application/json".encode_utf16().collect();
        let body = body_json.as_bytes();
        WinHttpSendRequest(
            request,
            Some(&headers),
            Some(body.as_ptr() as *const core::ffi::c_void),
            body.len() as u32,
            body.len() as u32,
            0,
        )
        .map_err(|e| format!("发送请求失败: {e}"))?;
        WinHttpReceiveResponse(request, std::ptr::null_mut())
            .map_err(|e| format!("接收响应失败: {e}"))?;

        let mut status: u32 = 0;
        let mut status_len: u32 = std::mem::size_of::<u32>() as u32;
        let mut index: u32 = 0;
        WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut core::ffi::c_void),
            &mut status_len,
            &mut index,
        )
        .map_err(|e| format!("读取状态码失败: {e}"))?;

        let mut out = String::new();
        loop {
            let mut available: u32 = 0;
            if WinHttpQueryDataAvailable(request, &mut available).is_err() || available == 0 {
                break;
            }
            let mut buf = vec![0u8; available as usize];
            let mut read: u32 = 0;
            if WinHttpReadData(
                request,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut read,
            )
            .is_err()
                || read == 0
            {
                break;
            }
            buf.truncate(read as usize);
            out.push_str(&String::from_utf8_lossy(&buf));
        }

        let _ = WinHttpCloseHandle(request);
        let _ = WinHttpCloseHandle(connect);
        let _ = WinHttpCloseHandle(session);

        if status >= 400 {
            return Err(format!("HTTP {status}: {}", truncate_chars(&out, 300)));
        }
        Ok(out)
    }
}

#[tauri::command]
pub fn agent_tool_web_search(app: AppHandle, query: String) -> Result<String, String> {
    let config = crate::agent_config::AgentConfig::load(&app);
    if config.web_search_key.is_empty() {
        return Err("未配置联网搜索 Key，请先在设置中填写".to_string());
    }
    let query = query.trim();
    if query.is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    let body = serde_json::json!({
        "api_key": config.web_search_key,
        "query": query,
        "max_results": 5,
        "search_depth": "basic",
    });
    let raw = tavily_post(&body.to_string()).map_err(|e| format!("联网搜索失败: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("搜索响应解析失败: {e}"))?;
    let answer = parsed
        .get("answer")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_string();
    let mut results = Vec::new();
    if let Some(arr) = parsed.get("results").and_then(|r| r.as_array()) {
        for item in arr.iter().take(5) {
            let title = item
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let url = item
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            let content = item
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            results.push(serde_json::json!({
                "title": title,
                "url": url,
                "content": truncate_chars(&content, 300),
            }));
        }
    }
    ok_json(serde_json::json!({
        "ok": true,
        "answer": truncate_chars(&answer, 500),
        "results": results,
    }))
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

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "newai_{}_{}_{}",
            name,
            std::process::id(),
            now_secs()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fs_list_sorts_dirs_first_then_name() {
        let base = temp_dir("fslist");
        std::fs::create_dir_all(base.join("subdir")).unwrap();
        std::fs::write(base.join("b.txt"), "bbb").unwrap();
        std::fs::write(base.join("a.txt"), "aaa").unwrap();

        let res = agent_tool_fs_list(base.to_string_lossy().to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["ok"], true);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items[0]["name"], "subdir");
        assert_eq!(items[0]["is_dir"], true);
        let files: Vec<&str> = items
            .iter()
            .filter(|i| i["is_dir"] == false)
            .map(|i| i["name"].as_str().unwrap())
            .collect();
        assert_eq!(files, vec!["a.txt", "b.txt"]);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn fs_list_empty_dir_errors() {
        assert!(agent_tool_fs_list("   ".to_string()).is_err());
    }

    #[test]
    fn fs_list_nonexistent_dir_errors() {
        assert!(agent_tool_fs_list("Z:/nonexistent_xyz_12345".to_string()).is_err());
    }

    #[test]
    fn fs_list_truncates_at_200() {
        let base = temp_dir("fslist200");
        for i in 0..205 {
            std::fs::write(base.join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let res = agent_tool_fs_list(base.to_string_lossy().to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["count"], 205);
        assert_eq!(v["items"].as_array().unwrap().len(), 200);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn fs_read_roundtrip() {
        let base = temp_dir("fsread");
        let file = base.join("hello.txt");
        std::fs::write(&file, "你好，世界").unwrap();
        let res = read_text_file(&file, &file.to_string_lossy()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["content"], "你好，世界");
        assert_eq!(v["truncated"], false);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn fs_read_empty_path_errors() {
        assert!(read_text_file(std::path::Path::new(""), "").is_err());
    }

    #[test]
    fn fs_read_dir_errors() {
        let base = std::env::temp_dir();
        assert!(read_text_file(&base, &base.to_string_lossy()).is_err());
    }

    #[test]
    fn fs_read_large_file_errors() {
        let base = temp_dir("fsreadbig");
        let file = base.join("big.bin");
        let data = vec![b'a'; 1024 * 1024 + 1];
        std::fs::write(&file, &data).unwrap();
        assert!(read_text_file(&file, &file.to_string_lossy()).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn fs_read_non_utf8_errors() {
        let base = temp_dir("fsreadbin");
        let file = base.join("bad.bin");
        std::fs::write(&file, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert!(read_text_file(&file, &file.to_string_lossy()).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_read_path_relative_joins_workspace() {
        let ws = std::path::PathBuf::from("C:/tmp/ws");
        let r = resolve_read_path(&ws, "hello.txt");
        assert_eq!(r, std::path::PathBuf::from("C:/tmp/ws/hello.txt"));
    }

    #[test]
    fn resolve_read_path_absolute_unchanged() {
        let ws = std::path::PathBuf::from("C:/tmp/ws");
        let r = resolve_read_path(&ws, "C:/Windows/System32");
        assert_eq!(r, std::path::PathBuf::from("C:/Windows/System32"));
    }

    #[test]
    fn display_path_strips_verbatim_prefix() {
        let p = std::path::Path::new(r"\\?\C:\Users\test\hello.txt");
        assert_eq!(display_path(p), r"C:\Users\test\hello.txt");
    }

    #[test]
    fn display_path_keeps_normal_path() {
        let p = std::path::Path::new(r"C:\Users\test\hello.txt");
        assert_eq!(display_path(p), r"C:\Users\test\hello.txt");
    }

    #[test]
    fn fs_read_relative_path_resolves_to_workspace() {
        // 端到端回归测试 4：fs_write 写相对路径 → fs_read 读相对路径一次成功
        let base = temp_dir("fsread_rel");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let target = resolve_within(&ws, "hello.txt").unwrap();
        std::fs::write(&target, "hello world").unwrap();
        // 关键验证：resolve_read_path 解析的相对路径能读到 fs_write 写入的内容
        let resolved = resolve_read_path(&ws, "hello.txt");
        let res = read_text_file(&resolved, &resolved.to_string_lossy()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["content"], "hello world");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_rejects_parent_traversal() {
        let base = temp_dir("resolve_trav");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        assert!(resolve_within(&ws, "../escape.txt").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_accepts_relative() {
        let base = temp_dir("resolve_rel");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let r = resolve_within(&ws, "sub/file.txt").unwrap();
        let ws_canon = ws.canonicalize().unwrap();
        assert!(r.starts_with(&ws_canon));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_rejects_absolute_outside() {
        let base = temp_dir("resolve_abs");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let outside = std::env::temp_dir();
        assert!(resolve_within(&ws, outside.to_string_lossy().as_ref()).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_empty_path_errors() {
        let base = temp_dir("resolve_empty");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        assert!(resolve_within(&ws, "").is_err());
        assert!(resolve_within(&ws, "   ").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_accepts_absolute_inside() {
        let base = temp_dir("resolve_abs_in");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let abs = ws.join("f.txt");
        let r = resolve_within(&ws, abs.to_string_lossy().as_ref()).unwrap();
        let ws_canon = ws.canonicalize().unwrap();
        assert!(r.starts_with(&ws_canon));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_rejects_deep_traversal() {
        let base = temp_dir("resolve_deep");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        assert!(resolve_within(&ws, "a/../../escape.txt").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolve_within_rejects_windows_root() {
        let base = temp_dir("resolve_root");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let root = std::path::PathBuf::from("C:\\Windows\\System32");
        assert!(resolve_within(&ws, root.to_string_lossy().as_ref()).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn exec_echo_returns_stdout() {
        let out = agent_tool_exec("echo hello_m4_test".to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true, "echo 应成功: {out}");
        assert!(
            v["stdout"].as_str().unwrap().contains("hello_m4_test"),
            "stdout 应含回显: {out}"
        );
        assert_eq!(v["exit_code"], 0);
    }

    #[test]
    fn exec_empty_cmd_errors() {
        assert!(agent_tool_exec("".to_string()).is_err());
        assert!(agent_tool_exec("   ".to_string()).is_err());
    }

    #[test]
    fn exec_missing_command_returns_nonzero() {
        let out = agent_tool_exec("nonexistent_cmd_xyz_12345".to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], false);
        assert_ne!(v["exit_code"], 0);
    }

    #[test]
    fn exec_preserves_exit_code() {
        let out = agent_tool_exec("exit /b 5".to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["exit_code"], 5);
    }

    #[test]
    fn exec_truncates_long_output() {
        let out = agent_tool_exec("for /L %i in (1,1,3000) do @echo xxxxxxxx".to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["stdout_truncated"], true, "3000 行输出应触发截断: {out}");
    }

    #[test]
    fn exec_utf8_output() {
        let out = agent_tool_exec("echo 中文测试".to_string()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let stdout = v["stdout"].as_str().unwrap_or("");
        // cmd 默认 GBK 编码，echo 中文可能乱码；只断言无 panic 且 stdout 非空
        assert!(
            !stdout.is_empty() || !v["stderr"].as_str().unwrap_or("").is_empty(),
            "stdout/stderr 至少其一非空: {out}"
        );
    }

    #[test]
    fn exec_times_out() {
        let start = std::time::Instant::now();
        let r = agent_tool_exec("ping -t 127.0.0.1".to_string());
        let elapsed = start.elapsed();
        assert!(r.is_err(), "无限 ping 应触发超时返回 Err");
        assert!(r.unwrap_err().contains("超时"), "错误信息应含「超时」");
        assert!(
            elapsed.as_secs() >= 28,
            "应接近 30 秒超时，实际 {elapsed:?}"
        );
    }

    #[test]
    fn fs_write_delete_roundtrip_sandboxed() {
        let base = temp_dir("fs_roundtrip");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let target = resolve_within(&ws, "hello.txt").unwrap();
        std::fs::write(&target, "m4 内容".as_bytes()).unwrap();
        let read_back = std::fs::read_to_string(&target).unwrap();
        assert_eq!(read_back, "m4 内容");
        std::fs::remove_file(&target).unwrap();
        assert!(!target.exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn fs_read_truncates_long_content() {
        let base = temp_dir("fsreadlong");
        let file = base.join("long.txt");
        std::fs::write(&file, "a".repeat(9000)).unwrap();
        let res = read_text_file(&file, &file.to_string_lossy()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["content"].as_str().unwrap().chars().count(), 8000);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
