import { invoke, Channel } from '@tauri-apps/api/core'
import type { ChatChunk, ChatMessage, ToolCall } from './types'

export interface EngineHandlers {
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onFinish?: (reason: string, toolCalls: ToolCall[]) => void
  onError?: (code: string, message: string) => void
}

/** 发送给 DeepSeek 的 OpenAI 兼容消息 */
export interface OpenAIOutMessage {
  role: string
  content?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIOutMessage[] {
  const out: OpenAIOutMessage[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'user') {
      out.push({ role: m.role, content: m.content })
    } else if (m.role === 'assistant') {
      const item: OpenAIOutMessage = { role: 'assistant', content: m.content }
      if (m.toolCalls && m.toolCalls.length > 0) item.tool_calls = m.toolCalls
      out.push(item)
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    }
  }
  return out
}

export function createChatChannel(handlers: EngineHandlers): Channel<ChatChunk> {
  const channel = new Channel<ChatChunk>()
  channel.onmessage = (msg) => {
    switch (msg.kind) {
      case 'delta':
        handlers.onDelta?.(msg.text)
        break
      case 'reasoning':
        handlers.onReasoning?.(msg.text)
        break
      case 'finish':
        handlers.onFinish?.(msg.reason, msg.tool_calls ?? [])
        break
      case 'error':
        handlers.onError?.(msg.code, msg.message)
        break
    }
  }
  return channel
}

export async function streamChat(
  messages: OpenAIOutMessage[],
  tools: Array<Record<string, unknown>>,
  channel: Channel<ChatChunk>,
  model?: string,
): Promise<void> {
  await invoke('agent_chat_stream', { messages, tools, model, channel })
}