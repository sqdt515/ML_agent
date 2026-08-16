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