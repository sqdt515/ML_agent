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
}

export const TOOL_LOOP_LIMIT = 5