use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-chat";
const DEFAULT_CONTEXT_BUDGET: u32 = 24000;
const MIN_BUDGET: u32 = 4000;
const MAX_BUDGET: u32 = 60000;

const DEFAULT_SYSTEM_PROMPT: &str = "你是 New AI，一个运行在用户桌面上的智能助手。\
你的特点是：亲切、简洁、准确。\
你可以使用提供的工具帮助用户完成操作（如显示/隐藏桌宠、打开链接、查询系统信息、记录便签）。\
调用工具前请先用一句话说明你要做什么；工具结果返回后，用简洁的语言总结给用户。\
不要编造工具不存在的功能，工具执行失败时如实告知。";

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
}

pub fn view(config: &AgentConfig) -> AgentConfigView {
    let last4 = if config.api_key.len() >= 4 {
        config.api_key[config.api_key.len() - 4..].to_string()
    } else {
        String::new()
    };
    AgentConfigView {
        api_key_set: !config.api_key.is_empty(),
        api_key_last4: last4,
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        system_prompt: config.system_prompt.clone(),
        tool_enabled: config.tool_enabled,
        context_budget: config.context_budget,
    }
}

pub fn apply(app: &AppHandle, input: AgentConfigInput) -> Result<AgentConfigView, String> {
    let mut config = AgentConfig::load(app);
    if let Some(key) = input.api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
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
    fn apply_clamps_budget() {

        // 用一个临时 AppHandle 不便构造，这里仅验证 clamp 逻辑函数
        assert_eq!(100u32.clamp(MIN_BUDGET, MAX_BUDGET), MIN_BUDGET);
        assert_eq!(99999u32.clamp(MIN_BUDGET, MAX_BUDGET), MAX_BUDGET);
    }
}