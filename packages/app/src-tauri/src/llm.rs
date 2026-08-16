use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
    WINHTTP_OPEN_REQUEST_FLAGS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

use crate::agent_config::AgentConfig;

/// 推送给前端的流式分片
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatChunk {
    Delta {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Finish {
        reason: String,
        tool_calls: Vec<Value>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug)]
pub struct GatewayError {
    pub code: &'static str,
    pub message: String,
}

fn network_error(message: impl Into<String>) -> GatewayError {
    GatewayError {
        code: "network",
        message: message.into(),
    }
}

/// 解析 base_url，返回 (host, port, path, is_https)
fn parse_url(url: &str) -> Result<(String, u16, String, bool), GatewayError> {
    let trimmed = url.trim().trim_end_matches('/');
    let (rest, https) = if let Some(r) = trimmed.strip_prefix("https://") {
        (r, true)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (r, false)
    } else {
        return Err(GatewayError {
            code: "bad_request",
            message: "接口地址必须以 http:// 或 https:// 开头".to_string(),
        });
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p.parse::<u16>().map_err(|_| GatewayError {
                code: "bad_request",
                message: "端口格式错误".to_string(),
            })?;
            (h.to_string(), port)
        }
        None => (authority.to_string(), if https { 443 } else { 80 }),
    };
    Ok((host, port, path, https))
}

fn encode_w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

struct HandleGuard(*mut core::ffi::c_void);
impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

/// 同时持有 session/connect/request 三个句柄，保证读取期间父句柄不被提前关闭。
/// WinHTTP 的 request 依赖 connect、connect 依赖 session；父句柄被 close 会导致读操作返回 12017（操作取消）。
struct WinHttpHandles {
    _session: HandleGuard,
    _connect: HandleGuard,
    request: HandleGuard,
}

#[derive(Default)]
struct SseState {
    done: bool,
    finish_reason: Option<String>,
    tool_calls: Vec<Value>,
    saw_delta: bool,
}

fn merge_tool_call(target: &mut Vec<Value>, delta: &Value) {
    let index = delta.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    while target.len() <= index {
        target.push(
            json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }),
        );
    }
    let item = &mut target[index];
    if let Some(id) = delta.get("id").and_then(|v| v.as_str()) {
        if !id.is_empty() {
            item["id"] = json!(id);
        }
    }
    if let Some(f) = delta.get("function") {
        if let Some(name) = f.get("name").and_then(|v| v.as_str()) {
            if !name.is_empty() {
                item["function"]["name"] = json!(name);
            }
        }
        if let Some(args) = f.get("arguments").and_then(|v| v.as_str()) {
            if !args.is_empty() {
                let cur = item["function"]["arguments"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                item["function"]["arguments"] = json!(cur + args);
            }
        }
    }
}

fn find_event_boundary(s: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < s.len() {
        if s[i] == b'\n' && s[i + 1] == b'\n' {
            return Some(i);
        }
        if i + 3 < s.len() && &s[i..i + 4] == b"\r\n\r\n" {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn handle_event(
    event: &str,
    state: &mut SseState,
    channel: &Channel<ChatChunk>,
) -> Result<(), GatewayError> {
    let mut data = String::new();
    for line in event.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data.push_str(rest.trim_start());
            data.push('\n');
        }
    }
    let data = data.trim();
    if data.is_empty() {
        return Ok(());
    }
    if data == "[DONE]" {
        state.done = true;
        return Ok(());
    }
    let parsed: Value = serde_json::from_str(data).map_err(|e| GatewayError {
        code: "bad_request",
        message: format!("SSE 数据解析失败: {e}"),
    })?;
    if let Some(err) = parsed.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("DeepSeek 返回错误")
            .to_string();
        return Err(GatewayError {
            code: "bad_request",
            message: msg,
        });
    }
    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                if !reason.is_empty() {
                    state.finish_reason = Some(reason.to_string());
                }
            }
            if let Some(delta) = choice.get("delta") {
                if let Some(reasoning) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
                    if !reasoning.is_empty() {
                        state.saw_delta = true;
                        channel
                            .send(ChatChunk::Reasoning {
                                text: reasoning.to_string(),
                            })
                            .map_err(|_| GatewayError {
                                code: "aborted",
                                message: "连接已中断".to_string(),
                            })?;
                    }
                }
                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        state.saw_delta = true;
                        channel
                            .send(ChatChunk::Delta {
                                text: content.to_string(),
                            })
                            .map_err(|_| GatewayError {
                                code: "aborted",
                                message: "连接已中断".to_string(),
                            })?;
                    }
                }
                if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                    for call in calls {
                        merge_tool_call(&mut state.tool_calls, call);
                    }
                }
            }
        }
    }
    Ok(())
}

/// 增量处理 SSE 缓冲：每遇到一个完整事件（空行分隔）就解析并推送
fn process_sse_buffer(
    buf: &mut Vec<u8>,
    state: &mut SseState,
    channel: &Channel<ChatChunk>,
) -> Result<(), GatewayError> {
    loop {
        let Some(boundary) = find_event_boundary(buf) else {
            return Ok(());
        };
        let sep_len = if buf[boundary..].starts_with(b"\r\n\r\n") {
            4
        } else {
            2
        };
        let event = String::from_utf8_lossy(&buf[..boundary]).into_owned();
        buf.drain(..boundary + sep_len);
        handle_event(&event, state, channel)?;
    }
}

fn read_all(request: *mut core::ffi::c_void) -> String {
    let mut out = String::new();
    unsafe {
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
    }
    out
}

/// 建立连接、发送 POST 请求并校验 HTTP 状态码；返回已就绪的请求句柄
fn open_and_send(
    config: &AgentConfig,
    endpoint: &str,
    https: bool,
    host: &str,
    port: u16,
    body: &[u8],
) -> Result<WinHttpHandles, GatewayError> {
    unsafe {
        let session = WinHttpOpen(
            PCWSTR::null(),
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err(network_error("WinHttpOpen 失败"));
        }
        let session = HandleGuard(session);

        let server = encode_w(host);
        let connect = WinHttpConnect(session.0, PCWSTR(server.as_ptr()), port, 0);
        if connect.is_null() {
            return Err(network_error("WinHttpConnect 失败"));
        }
        let connect = HandleGuard(connect);

        let verb = encode_w("POST");
        let object = encode_w(endpoint);
        let request = WinHttpOpenRequest(
            connect.0,
            PCWSTR(verb.as_ptr()),
            PCWSTR(object.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            if https {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        );
        if request.is_null() {
            return Err(network_error("WinHttpOpenRequest 失败"));
        }
        let request = HandleGuard(request);

        let _ = WinHttpSetTimeouts(request.0, 10000, 10000, 30000, 180000);

        let auth = format!(
            "Authorization: Bearer {}\r\nContent-Type: application/json",
            config.api_key
        );
        let headers: Vec<u16> = auth.encode_utf16().collect();
        WinHttpSendRequest(
            request.0,
            Some(&headers),
            Some(body.as_ptr() as *const core::ffi::c_void),
            body.len() as u32,
            body.len() as u32,
            0,
        )
        .map_err(map_winhttp_err)?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(map_winhttp_err)?;

        let mut status: u32 = 0;
        let mut status_len: u32 = std::mem::size_of::<u32>() as u32;
        let mut index: u32 = 0;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut core::ffi::c_void),
            &mut status_len,
            &mut index,
        )
        .map_err(map_winhttp_err)?;
        if status >= 400 {
            let err_body = read_all(request.0);
            return Err(map_http_status(status, &err_body));
        }
        Ok(WinHttpHandles {
            _session: session,
            _connect: connect,
            request,
        })
    }
}

/// 从非流式响应中提取 choices[0].message.content
fn extract_content(raw: &str) -> Result<String, GatewayError> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| GatewayError {
        code: "bad_request",
        message: format!("响应解析失败: {e}"),
    })?;
    if let Some(err) = parsed.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("服务端返回错误")
            .to_string();
        return Err(GatewayError {
            code: "bad_request",
            message: msg,
        });
    }
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| GatewayError {
            code: "bad_request",
            message: "响应中没有可用的摘要内容".to_string(),
        })
}

const SUMMARIZE_SYSTEM: &str = "你是对话摘要助手。请用简洁的中文把下面这段对话压缩成一段 200 字以内的摘要，保留关键事实、用户诉求与已完成的工具操作结果；不要添加对话中没有的信息。只输出摘要正文。";

/// 非流式摘要请求：将一段历史消息压缩为一条摘要文本
fn run_summarize(config: &AgentConfig, messages: Vec<Value>) -> Result<String, GatewayError> {
    let (host, port, base_path, https) = parse_url(&config.base_url)?;
    let endpoint = format!("{}/chat/completions", base_path.trim_end_matches('/'));

    let mut payload = json!({
        "model": config.model,
        "stream": false,
        "temperature": 0.3,
        "max_tokens": 1024,
    });
    let mut msgs: Vec<Value> = Vec::with_capacity(messages.len() + 1);
    msgs.push(json!({ "role": "system", "content": SUMMARIZE_SYSTEM }));
    msgs.extend(messages);
    payload["messages"] = json!(msgs);

    let body = serde_json::to_vec(&payload).map_err(|e| GatewayError {
        code: "bad_request",
        message: e.to_string(),
    })?;
    let handles = open_and_send(config, &endpoint, https, &host, port, &body)?;
    let raw = read_all(handles.request.0);
    extract_content(&raw)
}

fn map_winhttp_err(e: windows::core::Error) -> GatewayError {
    let raw = e.code().0 as u32;
    let low = raw & 0xFFFF;
    // 保留真实错误码，便于区分超时/无法连接/连接重置等不同故障
    let (code, message) = match low {
        12002 => ("timeout", "请求超时，请检查网络或稍后重试".to_string()),
        12029 => ("network", "无法连接到服务器，请检查网络".to_string()),
        12030 | 12031 => (
            "network",
            "连接被重置，请检查网络代理或稍后重试".to_string(),
        ),
        _ => ("network", format!("网络请求失败（错误码 {low}）: {e}")),
    };
    GatewayError { code, message }
}

fn map_http_status(status: u32, body: &str) -> GatewayError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| format!("HTTP {status}"));
    let code = match status {
        401 | 403 => "auth",
        402 => "balance",
        429 => "rate_limit",
        _ if status >= 500 => "server",
        _ => "bad_request",
    };
    GatewayError { code, message }
}

fn run_chat(
    config: &AgentConfig,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    channel: &Channel<ChatChunk>,
) -> Result<(), GatewayError> {
    let (host, port, base_path, https) = parse_url(&config.base_url)?;
    let endpoint = format!("{}/chat/completions", base_path.trim_end_matches('/'));

    let mut payload = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "temperature": 0.7,
    });
    if let Some(tools) = tools {
        if !tools.is_empty() {
            payload["tools"] = json!(tools);
            payload["tool_choice"] = "auto".into();
        }
    }
    let body = serde_json::to_vec(&payload).map_err(|e| GatewayError {
        code: "bad_request",
        message: e.to_string(),
    })?;

    let handles = open_and_send(config, &endpoint, https, &host, port, &body)?;

    unsafe {
        let mut raw: Vec<u8> = Vec::new();
        let mut state = SseState::default();
        let mut read_error: Option<GatewayError> = None;

        loop {
            let mut available: u32 = 0;
            if let Err(e) = WinHttpQueryDataAvailable(handles.request.0, &mut available) {
                read_error = Some(map_winhttp_err(e));
                break;
            }
            if available == 0 {
                break;
            }
            let mut buf = vec![0u8; available as usize];
            let mut read: u32 = 0;
            if let Err(e) = WinHttpReadData(
                handles.request.0,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut read,
            ) {
                read_error = Some(map_winhttp_err(e));
                break;
            }
            if read == 0 {
                break;
            }
            buf.truncate(read as usize);
            raw.extend_from_slice(&buf);
            process_sse_buffer(&mut raw, &mut state, channel)?;
            if state.done {
                break;
            }
        }

        // 读循环因真实 WinHTTP 错误退出：透传具体原因
        if let Some(err) = read_error {
            let _ = channel.send(ChatChunk::Error {
                code: err.code.to_string(),
                message: err.message,
            });
            return Ok(());
        }

        let reason = state.finish_reason.unwrap_or_else(|| "stop".to_string());

        // 内容被安全策略过滤：明确报错而非静默结束
        if reason == "content_filter" {
            let _ = channel.send(ChatChunk::Error {
                code: "content_filter".to_string(),
                message: "内容被安全策略过滤，请调整后重试".to_string(),
            });
            return Ok(());
        }

        // 未收到 [DONE]：连接中断。区分「完全没收到」与「半途截断」
        if !state.done {
            if !state.saw_delta && state.tool_calls.is_empty() {
                let _ = channel.send(ChatChunk::Error {
                    code: "network".to_string(),
                    message: "连接中断，未收到有效响应".to_string(),
                });
            } else {
                let _ = channel.send(ChatChunk::Error {
                    code: "network".to_string(),
                    message: "连接中断，回答不完整，请重试".to_string(),
                });
            }
            return Ok(());
        }

        let calls: Vec<Value> = state
            .tool_calls
            .into_iter()
            .filter(|c| {
                !c["id"].as_str().unwrap_or("").is_empty()
                    && !c["function"]["name"].as_str().unwrap_or("").is_empty()
            })
            .collect();
        let _ = channel.send(ChatChunk::Finish {
            reason,
            tool_calls: calls,
        });
        Ok(())
    }
}

#[tauri::command]
pub async fn agent_chat_stream(
    app: AppHandle,
    messages: Vec<Value>,
    tools: Option<Vec<Value>>,
    model: Option<String>,
    channel: Channel<ChatChunk>,
) -> Result<(), String> {
    let mut config = AgentConfig::load(&app);
    if let Some(m) = model {
        let trimmed = m.trim();
        if !trimmed.is_empty() {
            config.model = trimmed.to_string();
        }
    }
    if config.api_key.trim().is_empty() {
        let _ = channel.send(ChatChunk::Error {
            code: "missing_key".to_string(),
            message: "未配置 API Key，请先在设置中填写".to_string(),
        });
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = run_chat(&config, messages, tools, &channel) {
            let _ = channel.send(ChatChunk::Error {
                code: e.code.to_string(),
                message: e.message,
            });
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn agent_summarize(app: AppHandle, messages: Vec<Value>) -> Result<String, String> {
    let config = AgentConfig::load(&app);
    if config.api_key.trim().is_empty() {
        return Err("未配置 API Key，无法生成摘要".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_summarize(&config, messages))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {}", e.code, e.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> Channel<ChatChunk> {
        Channel::new(|_| Ok(()))
    }

    #[test]
    fn parse_sse_delta_and_done() {
        let ch = channel();
        let mut state = SseState::default();
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"},\"index\":0}]}\n\n".as_bytes(),
        );
        buf.extend_from_slice(
            "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"},\"index\":0}]}\n\n".as_bytes(),
        );
        buf.extend_from_slice("data: [DONE]\n\n".as_bytes());
        process_sse_buffer(&mut buf, &mut state, &ch).unwrap();
        assert!(state.done);
        assert!(buf.is_empty());
    }

    #[test]
    fn parse_sse_reasoning_content() {
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::<ChatChunk>::new()));
        let recv = received.clone();
        let ch = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                if let Ok(chunk) = serde_json::from_str::<ChatChunk>(&s) {
                    recv.lock().unwrap().push(chunk);
                }
            }
            Ok(())
        });
        let mut state = SseState::default();
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"让我思考\"},\"index\":0}]}\n\n".as_bytes(),
        );
        buf.extend_from_slice(
            "data: {\"choices\":[{\"delta\":{\"content\":\"答案\"},\"index\":0}]}\n\n".as_bytes(),
        );
        buf.extend_from_slice("data: [DONE]\n\n".as_bytes());
        process_sse_buffer(&mut buf, &mut state, &ch).unwrap();
        let msgs = received.lock().unwrap();
        let has_reasoning = msgs
            .iter()
            .any(|c| matches!(c, ChatChunk::Reasoning { .. }));
        let has_delta = msgs.iter().any(|c| matches!(c, ChatChunk::Delta { .. }));
        assert!(has_reasoning, "应收到 Reasoning 分片");
        assert!(has_delta, "应收到 Delta 分片");
        assert!(state.saw_delta);
    }

    #[test]
    fn parse_sse_tool_calls_aggregation() {
        let ch = channel();
        let mut state = SseState::default();
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_time\",\"arguments\":\"\"}}]},\"index\":0}]}\n\n".as_bytes());
        buf.extend_from_slice("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]},\"index\":0}]}\n\n".as_bytes());
        buf.extend_from_slice(
            "data: {\"choices\":[{\"finish_reason\":\"tool_calls\",\"index\":0}]}\n\n".as_bytes(),
        );
        buf.extend_from_slice("data: [DONE]\n\n".as_bytes());
        process_sse_buffer(&mut buf, &mut state, &ch).unwrap();
        assert_eq!(state.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(state.tool_calls.len(), 1);
        assert_eq!(state.tool_calls[0]["id"], "call_1");
        assert_eq!(state.tool_calls[0]["function"]["name"], "get_time");
        assert_eq!(state.tool_calls[0]["function"]["arguments"], "{}");
    }

    #[test]
    fn extract_content_ok() {
        let raw = r#"{"choices":[{"message":{"role":"assistant","content":"摘要内容"}}]}"#;
        assert_eq!(extract_content(raw).unwrap(), "摘要内容");
    }

    #[test]
    fn extract_content_error() {
        let raw = r#"{"error":{"message":"余额不足"}}"#;
        let err = extract_content(raw).unwrap_err();
        assert_eq!(err.code, "bad_request");
        assert!(err.message.contains("余额不足"));
    }

    #[test]
    fn extract_content_missing() {
        let raw = r#"{"choices":[]}"#;
        assert!(extract_content(raw).is_err());
    }

    #[test]
    fn parse_url_variants() {
        let (h, p, path, https) = parse_url("https://api.deepseek.com").unwrap();
        assert_eq!(h, "api.deepseek.com");
        assert_eq!(p, 443);
        assert_eq!(path, "/");
        assert!(https);

        let (h2, _p2, path2, https2) = parse_url("https://api.deepseek.com/v1").unwrap();
        assert_eq!(h2, "api.deepseek.com");
        assert_eq!(path2, "/v1");
        assert!(https2);

        assert!(parse_url("api.deepseek.com").is_err());
    }
}
