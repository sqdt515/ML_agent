# New AI 桌宠 → Agent 化改造技术方案

> 目标：把当前「聊天 + 被动工具调用」的桌宠，升级为「自治执行器」——具备规划、任务分解、逐步执行、观察反思、迭代收敛的 agent 范式。
> 本文只做设计，不改代码。分三层：A（轻量 agent 化）、B（真工具）、C（完整复刻 harness）。

---

## 0. 现状盘点（已有可复用的骨架）

| 能力 | 现状 | 位置 |
|---|---|---|
| 流式对话 | ✅ WinHttp + 手写 SSE | `src-tauri/src/llm.rs` → `run_chat` |
| 工具循环 | ✅ Function Calling，上限 5 轮 | `src/stores/agent.ts` → `runAgentLoop`（TOOL_LOOP_LIMIT=5） |
| 工具集 | 7 个本地工具 | `src/agent/tools.ts`（schema）+ `src-tauri/src/agent_tools.rs`（实现） |
| 会话管理 | 多会话 + localStorage，上限 20 | `src/stores/agent.ts` |
| 上下文 | 滑动窗口 + token 预算 + 一次性摘要 | `src/agent/context.ts` → `buildContext` |
| 配置 | key/base_url/model/prompt/tool/budget | `src-tauri/src/agent_config.rs` |
| 形态 | 三窗口（pet/agent/social）+ 托盘 | `src/App.vue`、`src-tauri/src/tray.rs` |

**结论**：对话与工具链路的"管道"已通，缺的是管道之上的「自治编排层」。

---

## 1. 与 harness agent 的核心差距

harness agent 的闭环：**规划 → 分解 → 逐步执行 → 观察 → 反思 → 迭代**，工具只是手段。
当前桌宠只有「单轮问答 + 被动工具循环」，缺少：规划、任务追踪、反思纠错、多步自治、长期记忆、并行/委托。

| 能力 | 桌宠 | 层次 A | 层次 B | 层次 C |
|---|---|---|---|---|
| 规划（plan） | ❌ | ✅ | ✅ | ✅ |
| 任务分解/追踪（todo） | ❌ | ✅ | ✅ | ✅ |
| 自治循环 + 反思 | 部分(5轮) | ✅(可调上限) | ✅ | ✅ |
| 文件/命令/搜索工具 | ❌ | ❌ | ✅ | ✅ |
| 子代理/工作流 | ❌ | ❌ | ❌ | ✅ |
| 目标持久化/长期记忆 | ❌ | ❌ | ❌ | ✅ |

---

## 2. 层次 A：轻量 agent 化（详细设计）

**目标**：用现有 Function Calling 机制，最小成本落地「规划 + 任务清单 + 自治循环」。**零新依赖**。

### 2.1 核心思想：用「元工具」表达元认知

模型通过调用 3 个新增的「元工具」来表达规划与进度。这些工具**由前端拦截执行**（改 Pinia state），**不发到 Rust**：

| 元工具 | 参数 | 作用 |
|---|---|---|
| `create_plan` | `goal, steps[]` | 接到任务先产出执行计划 |
| `update_step` | `step_id, status(pending/in_progress/completed/blocked), note?` | 更新某步状态 |
| `finish` | `summary` | 宣布目标完成 |

与现有 7 个「实工具」（pet_show/open_url/system_info/…）分属两类：实工具 invoke Rust，元工具改前端 state。

### 2.2 数据流（自治循环）

```
用户输入目标
  ↓
[规划阶段] 首轮 LLM 调用 → 期望模型调 create_plan 产出 plan
  ↓ (若 plan_mode 开启：暂停，UI 展示计划，等用户确认)
[执行阶段] 循环：
  streamChat → 收集 tool_calls
    ├─ 元工具 → 前端更新 plan/task 状态（改 Pinia，不 invoke）
    └─ 实工具 → invoke Rust 命令，结果回填 role:tool
  → 把「当前 plan + task 状态 + 最近观察」注入下一轮上下文
  → 继续 streamChat
  ↓
[终止] 满足其一：
  · 模型调 finish
  · 达到 max_agent_rounds（默认 20，可配）
  · 用户 stop
  · 模型连续 N 轮不再调任何工具（自然结束）
```

### 2.3 文件改动清单（层次 A）

**前端（Vue/TS）**

1. `src/agent/types.ts`
   - 新增 `AgentStep { id, title, status, note? }`、`AgentPlan { goal, steps, status }`
   - `ChatSession` 加可选 `plan?: AgentPlan`
   - 新增 `MAX_AGENT_ROUNDS` 常量（或迁入配置）

2. `src/agent/tools.ts`
   - 新增 3 个元工具的 schema（create_plan / update_step / finish）
   - 新增 `isMetaTool(name)` 判断；`toolsToPayload` 同时输出实工具 + 元工具 schema

3. `src/stores/agent.ts`（核心改动）
   - `runAgentLoop` 改造为「规划 + 执行」两阶段
   - 工具结果分流：元工具 → 更新 `session.plan`；实工具 → 现有 invoke 逻辑
   - 循环上限由 `TOOL_LOOP_LIMIT` 改为 `maxAgentRounds`
   - 每轮把 plan/task 状态序列化后注入上下文（新增一个 system 消息或附加到消息尾）
   - `finish` 元工具触发 → 正常收尾（不再被当作"工具循环超限"）
   - 保留会话绑定、空气泡清理、错误透传等已修好的逻辑

4. `src/agent/context.ts`
   - `buildSystemPrompt` 追加「自治执行协议」：接到任务先 create_plan、逐步 update_step、完成后 finish、遇障 update_step(blocked) 并换策略
   - 新增 `buildPlanContext(plan)`：把计划/步骤状态拼成给模型看的结构化文本

5. `src/components/AgentChat.vue`
   - 新增可折叠「计划面板」：显示 goal + 步骤列表 + 状态图标（⏳ 待办 / 🔄 进行中 / ✅ 完成 / ⚠️ 受阻）
   - 流式期间实时刷新；plan_mode 开启时显示「确认计划 / 取消」按钮

6. `src/i18n/zh.ts`、`en.ts`
   - 新增计划面板、状态、确认按钮等文案

**Rust（基本不动）**

7. `src-tauri/src/agent_config.rs`
   - 新增配置项 `max_agent_rounds`（默认 20）、`plan_mode`（默认 true）
   - `AgentConfigView` / `AgentConfigInput` 同步加字段

8. `src-tauri/src/llm.rs`
   - 无需改动（LLM 管道已够用）；可选：规划阶段用非流式 `run_summarize` 风格的稳定调用

**设置 UI**

9. `src/components/SettingsPanel.vue`
   - 新增「自治循环上限」「计划确认开关」两个配置项

### 2.4 依赖

- **无新增依赖**。纯前端状态机 + 现有 Function Calling + 配置项。这是层次 A 最大的优点。

### 2.5 风险与对策

| 风险 | 对策 |
|---|---|
| 模型不按协议调元工具（伪规划） | system prompt 强约束 + 前端容错：模型不产 plan 也能退化回单轮问答 |
| 循环失控 / token 成本 | 硬上限 max_agent_rounds + 每轮 token 预算 + 可随时 stop |
| plan_mode 下模型先干活再出计划 | 规划阶段用独立非流式调用，且在 prompt 里禁止工具 |
| 元工具与实工具同名冲突 | 命名加前缀 `__meta_xxx` 或单独 namespace，前端显式分流 |

### 2.6 验收标准

1. 输入「帮我查一下系统内存占用，并把结果记成便签」→ 模型产出计划 → 逐步执行 system_info → note_create → finish，UI 步骤逐步勾选
2. 工具失败（如非法 URL）→ 步骤标 blocked + 模型换策略或如实汇报，不静默
3. plan_mode 开启时，执行前暂停展示计划，用户确认后才开始
4. 复杂多步任务全程可 stop，停止后计划面板保留当前进度

---

## 3. 层次 B：A + 真工具（设计）

在 A 之上扩展工具，让桌宠能实际「干活」。工具在 Rust 端实现，前端 `tools.ts` 定义 schema。

### 3.1 新增工具（按价值排序）

| 工具 | 能力 | 风险等级 |
|---|---|---|
| `fs_list(dir)` | 列目录 | 低 |
| `fs_read(path)` | 读文本文件 | 低 |
| `fs_write(path, content)` | 写文本文件 | 中 |
| `fs_delete(path)` | 删除文件 | 高 |
| `exec(cmd)` | 执行命令 | 高 |
| `web_search(query)` | 联网搜索 | 中（需额外 key） |
| `clipboard_read/write` | 剪贴板 | 中 |
| `screenshot` | 截图 | 低 |
| `process_list/kill` | 进程管理 | 高 |
| `notify(text)` | 系统通知 | 低 |

### 3.2 沙箱设计（exec / fs_write / fs_delete 必需）

- **路径白名单**：默认限定在 `%USERPROFILE%` 或显式授权的工作区，越界拒绝
- **命令白名单 + 超时**：`std::process::Command` + 超时 kill + 输出截断（如 8KB）
- **分级授权**：危险操作（写/删/执行）需用户二次确认，低危（读/列）直接执行
- 参考 harness 的 sandbox 分级思想（read-only / workspace-write / danger-full-access）

### 3.3 依赖

- 命令执行：标准库 `std::process::Command`（无需新 crate）
- 搜索：需引入 HTTP 客户端（复用 WinHttp 或引入 reqwest）+ 搜索 API（Bing/SerpAPI/Tavily 等，**额外 key 成本**）
- 截图：可复用现有截图脚本思路（System.Drawing 或 winapi）

### 3.4 风险

- **安全是首要风险**：提示注入导致误删/执行恶意命令。必须白名单 + 沙箱 + 确认 + 日志审计
- 搜索引入额外 API key 与合规成本

---

## 4. 层次 C：完整复刻 harness（概要）

### 4.1 能力清单

- **子代理 / 并行 fan-out**：后端编排多个 LLM 调用并行处理子任务（类似 `subagent`）
- **工作流编排**：脚本化多阶段 pipeline（类似 `workflow`）
- **目标持久化**：跨会话的长期目标状态机（active/paused/blocked/complete，类似 `goal`）
- **长期记忆**：跨会话记忆（摘要 + 向量检索，类似 `memory`）

### 4.2 架构调整（关键变化）

当前编排在**纯前端 Pinia store**，只适合单会话流式。层次 C 需要把编排下沉到 **Rust 后端**：

- 新增 `src-tauri/src/orchestrator.rs`：多智能体编排引擎（任务图、并发、结果汇总）
- 新增 `src-tauri/src/goal.rs`：目标状态机 + 持久化
- 新增 `src-tauri/src/memory.rs`：长期记忆（摘要 + 向量检索）
- 前端 store 退化为「编排引擎的视图层」，通过事件流订阅进度

### 4.3 依赖

- 向量存储：sqlite-vec / qdrant / 本地 ANN（重依赖）
- embedding：需嵌入模型或 embedding API（额外 key）
- 并发 HTTP：tokio + reqwest（替换/并行于现有 WinHttp 单请求模型）

### 4.4 风险

- 体量接近独立产品，复杂度显著上升
- 多智能体编排的 token 成本与稳定性
- 记忆系统的隐私权衡（本地向量库 vs 云端 embedding）

---

## 5. 分阶段实施路线图

| 阶段 | 内容 | 预估 |
|---|---|---|
| M1 | 层次 A 核心（元工具 + 自治循环 + 计划面板） | 1–2 天 |
| M2 | 层次 A 配置与容错（max_agent_rounds / plan_mode / 伪规划容错） | 0.5 天 |
| M3 | 层次 B 低危工具（fs_read/list、clipboard、screenshot、notify） | 1 天 |
| M4 | 层次 B 高危工具 + 沙箱 + 确认机制（fs_write/delete、exec） | 2–3 天 |
| M5 | 层次 B 搜索工具 | 1–2 天 |
| M6 | 层次 C 目标持久化 + 长期记忆 | 长期迭代 |

---

## 6. 需要你拍板的事项

1. **从 M1 开始吗？**（层次 A 是地基，B/C 都建立在它之上）
2. **plan_mode 默认开还是关？**（开=更稳但多一步确认；关=更流畅但可能跑偏）
3. **层次 B 的搜索工具**：是否愿意引入额外搜索 API key？还是先只做本地工具（文件/命令/系统）？
4. **命令执行/文件写的安全边界**：授权范围限定在用户目录？还是更窄的工作区？
