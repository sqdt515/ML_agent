import type { ChatMessage } from './types'
import { estimateTokens } from './token'

export interface BuildContextResult {
  /** 进入上下文的非 system 消息（从最新向前保留，预算内） */
  messages: ChatMessage[]
  /** 因超预算被省略的消息条数 */
  dropped: number
  /** 因超预算被省略的最旧消息（用于压缩为摘要） */
  droppedMessages: ChatMessage[]
}

/** 组装系统提示词（附加工具开关与省略提示） */
export function buildSystemPrompt(base: string, toolEnabled: boolean, dropped: number): string {
  let prompt = base.trim()
  if (!toolEnabled) {
    prompt += '\n\n（当前已关闭工具调用，请只进行对话，不要请求使用工具。）'
  }
  if (dropped > 0) {
    prompt += `\n\n（提示：由于对话过长，最旧的 ${dropped} 条消息已被省略，请基于剩余上下文继续。）`
  }
  return prompt
}

/**
 * 上下文构建：滑动窗口裁剪。
 * 始终保留最新一条消息；从最新向最旧累计 token，超过预算后丢弃更早的消息。
 */
export function buildContext(messages: ChatMessage[], budget: number): BuildContextResult {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const history = messages.filter((m) => m.role !== 'system')

  let total = 0
  const kept: ChatMessage[] = []
  const droppedMsgs: ChatMessage[] = []
  let dropped = 0

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const cost = estimateTokens(msg.content)
    if (total + cost > budget && kept.length > 0) {
      dropped += 1
      droppedMsgs.push(msg)
      continue
    }
    kept.unshift(msg)
    total += cost
  }

  return { messages: [...systemMsgs, ...kept], dropped, droppedMessages: droppedMsgs }
}