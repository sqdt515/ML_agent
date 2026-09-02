use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-chat";
const DEFAULT_CONTEXT_BUDGET: u32 = 24000;
const MIN_BUDGET: u32 = 4000;
const MAX_BUDGET: u32 = 60000;
const DEFAULT_MAX_AGENT_ROUNDS: u32 = 20;

const DEFAULT_SYSTEM_PROMPT: &str = "你是 New AI，一个运行在用户桌面上的智能助手。\
你的特点是：亲切、简洁、准确。\
你可以使用提供的工具帮助用户完成操作（如显示/隐藏桌宠、打开链接、查询系统信息、记录便签）。\
调用工具前请先用一句话说明你要做什么；工具结果返回后，用简洁的语言总结给用户。\
不要编造工具不存在的功能，工具执行失败时如实告知。";

/// 全部实工具名（与前端 agentTools 一一对应）
pub const ALL_TOOL_NAMES: &[&str] = &[
    "pet_show",
    "pet_hide",
    "open_url",
    "system_info",
    "get_time",
    "note_create",
    "note_list",
    "fs_list",
    "fs_read",
    "notify",
    "clipboard_read",
    "clipboard_write",
    "fs_write",
    "fs_delete",
    "exec",
    "web_search",
];

/// 工具默认启用状态：exec 默认关，其余默认开
pub fn default_tool_enabled(name: &str) -> bool {
    name != "exec"
}

/// 解析某工具是否启用（tool_flags 未显式设置时回退默认值）
pub fn tool_enabled_by_name(name: &str, flags: &HashMap<String, bool>) -> bool {
    flags
        .get(name)
        .copied()
        .unwrap_or_else(|| default_tool_enabled(name))
}

/// Agent 配置（持久化在 app_config_dir/agent.json）
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AgentConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
    pub tool_enabled: bool,
    pub context_budget: u32,
    pub max_agent_rounds: u32,
    pub plan_mode: bool,
    pub exec_enabled: bool,
    pub web_search_key: String,
    pub tool_flags: HashMap<String, bool>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            tool_enabled: true,
            context_budget: DEFAULT_CONTEXT_BUDGET,
            max_agent_rounds: DEFAULT_MAX_AGENT_ROUNDS,
            plan_mode: true,
            exec_enabled: false,
            web_search_key: String::new(),
            tool_flags: HashMap::new(),
        }
    }
}

pub fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("agent.json")
}

impl AgentConfig {
    pub fn load(app: &AppHandle) -> Self {
        let path = config_path(app);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = config_path(app);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, raw).map_err(|e| format!("写入配置文件失败: {e}"))
    }
}

/// 返回给前端的配置视图（不包含完整 Key）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    pub api_key_set: bool,
    pub api_key_last4: String,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
    pub tool_enabled: bool,
    pub context_budget: u32,
    pub max_agent_rounds: u32,
    pub plan_mode: bool,
    pub exec_enabled: bool,
    pub web_search_key_set: bool,
    pub web_search_key_last4: String,
    pub tool_flags: HashMap<String, bool>,
}

/// 前端提交的配置（可选字段，None 表示保持原值；api_key 为空字符串表示不修改）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfigInput {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub tool_enabled: Option<bool>,
    pub context_budget: Option<u32>,
    pub max_agent_rounds: Option<u32>,
    pub plan_mode: Option<bool>,
    pub exec_enabled: Option<bool>,
    pub web_search_key: Option<String>,
    pub tool_flags: Option<HashMap<String, bool>>,
}

fn last4(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 4 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        String::new()
    }
}

/// 密钥类输入校验：仅允许 ASCII（误粘贴中文/全角字符会导致 Key 不可用）
fn validate_key(field: &str, key: &str) -> Result<(), String> {
    if !key.chars().all(|c| c.is_ascii()) {
        return Err(format!("{field} 含非 ASCII 字符，请检查是否误复制了多余内容"));
    }
    Ok(())
}

pub fn view(config: &AgentConfig) -> AgentConfigView {
    AgentConfigView {
        api_key_set: !config.api_key.is_empty(),
        api_key_last4: last4(&config.api_key),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        system_prompt: config.system_prompt.clone(),
        tool_enabled: config.tool_enabled,
        context_budget: config.context_budget,
        max_agent_rounds: config.max_agent_rounds,
        plan_mode: config.plan_mode,
        exec_enabled: config.exec_enabled,
        web_search_key_set: !config.web_search_key.is_empty(),
        web_search_key_last4: last4(&config.web_search_key),
        tool_flags: ALL_TOOL_NAMES
            .iter()
            .map(|n| (n.to_string(), tool_enabled_by_name(n, &config.tool_flags)))
            .collect(),
    }
}

pub fn apply(app: &AppHandle, input: AgentConfigInput) -> Result<AgentConfigView, String> {
    let mut config = AgentConfig::load(app);
    if let Some(key) = input.api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            validate_key("API Key", trimmed)?;
            config.api_key = trimmed.to_string();
        }
    }
    if let Some(url) = input.base_url {
        let trimmed = url.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            config.base_url = trimmed.to_string();
        }
    }
    if let Some(model) = input.model {
        let trimmed = model.trim();
        if !trimmed.is_empty() {
            config.model = trimmed.to_string();
        }
    }
    if let Some(prompt) = input.system_prompt {
        config.system_prompt = prompt;
    }
    if let Some(enabled) = input.tool_enabled {
        config.tool_enabled = enabled;
    }
    if let Some(budget) = input.context_budget {
        config.context_budget = budget.clamp(MIN_BUDGET, MAX_BUDGET);
    }
    if let Some(rounds) = input.max_agent_rounds {
        config.max_agent_rounds = rounds.clamp(1, 100);
    }
    if let Some(plan_mode) = input.plan_mode {
        config.plan_mode = plan_mode;
    }
    if let Some(exec_enabled) = input.exec_enabled {
        config.exec_enabled = exec_enabled;
    }
    if let Some(key) = input.web_search_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            validate_key("搜索 Key", trimmed)?;
            config.web_search_key = trimmed.to_string();
        }
    }
    if let Some(flags) = input.tool_flags {
        config.tool_flags = flags;
    }
    config.save(app)?;
    Ok(view(&config))
}

#[tauri::command]
pub fn agent_get_config(app: AppHandle) -> AgentConfigView {
    view(&AgentConfig::load(&app))
}

#[tauri::command]
pub fn agent_save_config(
    app: AppHandle,
    input: AgentConfigInput,
) -> Result<AgentConfigView, String> {
    apply(&app, input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_sane() {
        let c = AgentConfig::default();
        assert!(c.api_key.is_empty());
        assert_eq!(c.base_url, "https://api.deepseek.com");
        assert_eq!(c.model, "deepseek-chat");
        assert!(c.tool_enabled);
        assert_eq!(c.context_budget, 24000);
        assert_eq!(c.max_agent_rounds, 20);
        assert!(c.plan_mode);
        assert!(!c.exec_enabled);
        assert!(c.web_search_key.is_empty());
    }

    #[test]
    fn view_masks_key() {
        let mut c = AgentConfig::default();
        c.api_key = "sk-abcdef123456".to_string();
        let v = view(&c);
        assert!(v.api_key_set);
        assert_eq!(v.api_key_last4, "3456");
        assert!(!v.api_key_last4.contains("abcdef"));
    }

    #[test]
    fn view_masks_web_search_key() {
        let mut c = AgentConfig::default();
        c.web_search_key = "tvly-dev-abcdef123456".to_string();
        let v = view(&c);
        assert!(v.web_search_key_set);
        assert_eq!(v.web_search_key_last4, "3456");
        assert!(!v.web_search_key_last4.contains("abcdef"));
    }

    #[test]
    fn apply_clamps_budget() {
        // 用一个临时 AppHandle 不便构造，这里仅验证 clamp 逻辑函数
        assert_eq!(100u32.clamp(MIN_BUDGET, MAX_BUDGET), MIN_BUDGET);
        assert_eq!(99999u32.clamp(MIN_BUDGET, MAX_BUDGET), MAX_BUDGET);
    }

    #[test]
    fn apply_clamps_rounds() {
        // max_agent_rounds 的 clamp(1, 100) 边界
        assert_eq!(0u32.clamp(1, 100), 1);
        assert_eq!(1000u32.clamp(1, 100), 100);
        assert_eq!(50u32.clamp(1, 100), 50);
    }

    #[test]
    fn view_serializes_camel_case() {
        let c = AgentConfig::default();
        let v = view(&c);
        let raw = serde_json::to_string(&v).unwrap();
        assert!(raw.contains("\"maxAgentRounds\""));
        assert!(raw.contains("\"planMode\""));
        assert!(raw.contains("\"execEnabled\""));
        assert!(raw.contains("\"webSearchKeySet\""));
        assert!(raw.contains("\"apiKeySet\""));
        assert!(!raw.contains("max_agent_rounds"));
        assert!(!raw.contains("plan_mode"));
    }

    #[test]
    fn input_deserializes_camel_case() {
        let raw = r#"{"maxAgentRounds":7,"planMode":false,"contextBudget":9999}"#;
        let input: AgentConfigInput = serde_json::from_str(raw).unwrap();
        assert_eq!(input.max_agent_rounds, Some(7));
        assert_eq!(input.plan_mode, Some(false));
        assert_eq!(input.context_budget, Some(9999));
    }

    #[test]
    fn default_tool_enabled_only_exec_off() {
        assert!(default_tool_enabled("fs_read"));
        assert!(default_tool_enabled("fs_write"));
        assert!(default_tool_enabled("web_search"));
        assert!(!default_tool_enabled("exec"));
    }

    #[test]
    fn tool_enabled_by_name_respects_flags() {
        let mut flags = HashMap::new();
        flags.insert("fs_write".to_string(), false);
        flags.insert("exec".to_string(), true);
        assert!(tool_enabled_by_name("fs_read", &flags));
        assert!(!tool_enabled_by_name("fs_write", &flags));
        assert!(tool_enabled_by_name("exec", &flags));
        assert!(!tool_enabled_by_name("exec", &HashMap::new()));
    }

    #[test]
    fn view_fills_all_tool_flags() {
        let c = AgentConfig::default();
        let v = view(&c);
        assert_eq!(v.tool_flags.len(), ALL_TOOL_NAMES.len());
        assert_eq!(v.tool_flags.get("exec"), Some(&false));
        assert_eq!(v.tool_flags.get("fs_read"), Some(&true));
        assert_eq!(v.tool_flags.get("web_search"), Some(&true));
    }

    #[test]
    fn last4_ascii_key() {
        assert_eq!(last4("sk-abcdef123456"), "3456");
        assert_eq!(last4("abc"), "");
        assert_eq!(last4(""), "");
    }

    #[test]
    fn last4_multibyte_does_not_panic() {
        // 字节切片版本在多字节边界会 panic，字符版本应正常返回尾 4 字符
        let s = "sk-密钥误粘贴";
        assert_eq!(last4(s).chars().count(), 4);
    }

    #[test]
    fn validate_key_rejects_non_ascii() {
        assert!(validate_key("API Key", "sk-abc123").is_ok());
        assert!(validate_key("API Key", "sk-abc123密").is_err());
        assert!(validate_key("搜索 Key", "").is_ok());
    }
}
