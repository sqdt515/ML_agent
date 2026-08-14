import type { ChatMessage } from './types'

// 启发式 token 估算：CJK 每字符约 1 token，其他字符约 0.25 token
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) {
    tokens += CJK_RE.test(ch) ? 1 : 0.25
  }
  return Math.max(1, Math.ceil(tokens))
}

export function messageTokens(msg: ChatMessage): number {
  let n = estimateTokens(msg.content) + 4 // 角色等开销
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      n += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 3
    }
  }
  if (msg.toolName) n += estimateTokens(msg.toolName)
  return n
}

export function sessionTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}