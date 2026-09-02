use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAX_LOG_SIZE: u64 = 1_000_000; // 超过 1MB 轮转归档
const MAX_PARAMS_CHARS: usize = 120; // 敏感参数截断（需容纳常见文件路径）
const MAX_RESULT_CHARS: usize = 200;

/// 一条审计记录（JSON Lines，每行一条）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub timestamp: String,
    pub tool_name: String,
    pub session_id: String,
    pub params: String,
    pub result: String,
    pub user_confirm: bool,
}

pub fn audit_log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("audit.log")
}

static AUDIT_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn lock() -> &'static std::sync::Mutex<()> {
    AUDIT_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// 从 UNIX 天数反推公历年月日（Howard Hinnant civil_from_days 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 生成 ISO 8601 UTC 时间戳（YYYY-MM-DDTHH:MM:SSZ），不依赖第三方时间库
fn timestamp_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        let mut t: String = s.chars().take(max).collect();
        t.push('\u{2026}');
        t
    } else {
        s.to_string()
    }
}

/// 追加一条审计记录（只追加，不改历史；超限自动轮转）
pub fn append(
    app: &AppHandle,
    tool_name: &str,
    session_id: &str,
    params: &str,
    result: &str,
    user_confirm: bool,
) {
    let _guard = match lock().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let path = audit_log_path(app);

    // 轮转：超过上限则归档为 audit-<unix秒>.log
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_SIZE {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let archive = path.with_file_name(format!("audit-{ts}.log"));
            let _ = std::fs::rename(&path, &archive);
        }
    }

    let entry = AuditEntry {
        timestamp: timestamp_iso8601(),
        tool_name: tool_name.to_string(),
        session_id: session_id.to_string(),
        params: truncate_chars(params, MAX_PARAMS_CHARS),
        result: truncate_chars(result, MAX_RESULT_CHARS),
        user_confirm,
    };

    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(line) = serde_json::to_string(&entry) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// 读取日志（时间倒序，最新在前；limit=0 表示不限）
pub fn read_logs(app: &AppHandle, limit: usize) -> Vec<AuditEntry> {
    let path = audit_log_path(app);
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<AuditEntry> = raw
        .lines()
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .collect();
    entries.reverse();
    if limit > 0 && entries.len() > limit {
        entries.truncate(limit);
    }
    entries
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn export_csv(app: &AppHandle) -> String {
    let entries = read_logs(app, 0);
    let mut out = String::from("timestamp,tool_name,session_id,user_confirm,params,result\n");
    for e in entries {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            csv_escape(&e.timestamp),
            csv_escape(&e.tool_name),
            csv_escape(&e.session_id),
            if e.user_confirm { "true" } else { "false" },
            csv_escape(&e.params),
            csv_escape(&e.result),
        ));
    }
    out
}

fn export_txt(app: &AppHandle) -> String {
    let entries = read_logs(app, 0);
    let mut out = String::new();
    for e in entries {
        out.push_str(&format!(
            "[{}] {} (session={}, confirm={})\n  params: {}\n  result: {}\n",
            e.timestamp, e.tool_name, e.session_id, e.user_confirm, e.params, e.result,
        ));
    }
    out
}

#[tauri::command]
pub fn agent_get_audit_logs(app: AppHandle, limit: Option<usize>) -> Vec<AuditEntry> {
    read_logs(&app, limit.unwrap_or(200))
}

#[tauri::command]
pub fn agent_export_audit_logs(app: AppHandle, format: String) -> Result<String, String> {
    match format.as_str() {
        "csv" => Ok(export_csv(&app)),
        "txt" => Ok(export_txt(&app)),
        _ => Err("不支持的导出格式（仅支持 csv / txt）".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_keeps_whole() {
        assert_eq!(truncate_chars("hello", 50), "hello");
    }

    #[test]
    fn truncate_long_cuts_at_limit() {
        let s = "a".repeat(60);
        let t = truncate_chars(&s, 50);
        assert_eq!(t.chars().count(), 51); // 50 + 省略号
        assert!(t.ends_with('\u{2026}'));
    }

    #[test]
    fn csv_escape_plain_passthrough() {
        assert_eq!(csv_escape("plain"), "plain");
    }

    #[test]
    fn csv_escape_quotes_comma() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(10957), (2000, 1, 1));
        assert_eq!(civil_from_days(19723), (2024, 1, 1));
    }

    #[test]
    fn timestamp_iso8601_format() {
        let t = timestamp_iso8601();
        assert_eq!(t.len(), 20, "actual: {t}");
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[7..8], "-");
        assert_eq!(&t[10..11], "T");
        assert!(t.ends_with('Z'));
        let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
        assert_eq!(digits.len(), 14);
    }
}
