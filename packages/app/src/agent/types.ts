// === Agent 消息与会话类型 ===

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCallFunction {
  name: string
  arguments: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: ToolCallFunction
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  /** reasoner 类模型的思考过程（折叠展示） */
  reasoning?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: ToolCall[]
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 会话级模型覆盖（未设置则用全局配置） */
  model?: string
  /** 是否已把早期超预算消息压缩为摘要 */
  summarized?: boolean
  /** 自治执行计划（层次 A：规划 + 任务追踪） */
  plan?: AgentPlan
}

// === 流式分片（与后端 ChatChunk 对应） ===

export type AgentErrorCode =
  | 'missing_key'
  | 'auth'
  | 'balance'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'tool_loop_limit'
  | 'aborted'

export type ChatChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'finish'; reason: string; tool_calls?: ToolCall[] }
  | { kind: 'error'; code: string; message: string }

// === Agent 配置 ===

export interface AgentConfig {
  apiKeySet: boolean
  apiKeyLast4: string
  baseUrl: string
  model: string
  systemPrompt: string
  toolEnabled: boolean
  contextBudget: number
  maxAgentRounds: number
  planMode: boolean
  execEnabled: boolean
  webSearchKeySet: boolean
  webSearchKeyLast4: string
}

// === 自治执行计划（层次 A） ===

export type AgentStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface AgentStep {
  id: string
  title: string
  status: AgentStepStatus
  note?: string
}

export interface AgentPlan {
  goal: string
  steps: AgentStep[]
  status: 'awaiting_confirm' | 'active' | 'done' | 'cancelled'
}

/** 自治循环默认上限（后端配置 maxAgentRounds 可覆盖） */
export const MAX_AGENT_ROUNDS = 20

export const TOOL_LOOP_LIMIT = 5

// === 供应商预设（多模型/多供应商） ===

export interface ProviderCapabilities {
  /** 是否支持 function calling（tool_calls） */
  toolCalls: boolean
  /** 是否支持流式 */
  streaming: boolean
  /** 供应商默认是否为 reasoner 类（有思考过程） */
  reasoning: boolean
  /** 上下文窗口（tokens） */
  contextWindow: number
}

export interface ProviderModel {
  id: string
  /** 是否为 reasoner 类（覆盖供应商级 capabilities.reasoning） */
  reasoning?: boolean
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  defaultModel: string
  capabilities: ProviderCapabilities
  models: ProviderModel[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 64_000 },
    models: [
      { id: 'deepseek-chat' },
      { id: 'deepseek-reasoner', reasoning: true },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 128_000 },
    models: [
      { id: 'gpt-4o' },
      { id: 'gpt-4o-mini' },
      { id: 'o1', reasoning: true },
      { id: 'o3-mini', reasoning: true },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 128_000 },
    models: [
      { id: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k' },
      { id: 'kimi-k2-0711-preview' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 32_000 },
    models: [
      { id: 'qwen-plus' },
      { id: 'qwen-max' },
      { id: 'qwen-turbo' },
    ],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 128_000 },
    models: [
      { id: 'glm-4-flash' },
      { id: 'glm-4-plus' },
      { id: 'glm-4-air' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    capabilities: { toolCalls: true, streaming: true, reasoning: false, contextWindow: 8_000 },
    models: [
      { id: 'llama3.1' },
      { id: 'qwen2.5' },
    ],
  },
]

/** 根据 baseUrl 反查预设（迁移/能力标签展示用） */
export function findPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const norm = baseUrl.trim().replace(/\/+$/, '')
  return PROVIDER_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, '') === norm)
}

/** 判断模型是否为 reasoner 类（决定是否展示思考过程） */
export function isReasonerModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  return (
    m.includes('reasoner') ||
    m.includes('thinking') ||
    m.includes('deepseek-r1') ||
    /^o[13](-|$)/.test(m)
  )
}
