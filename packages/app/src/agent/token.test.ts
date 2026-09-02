import { describe, expect, it } from 'vitest'
import { estimateTokens, messageTokens } from './token'
import type { ChatMessage } from './types'

describe('token 估算', () => {
  it('CJK 每字符约 1 token，ASCII 约 4 字符 1 token', () => {
    expect(estimateTokens('四个中文字')).toBe(5)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('消息开销：toolCalls 消息成本高于同内容纯文本', () => {
    const base = { role: 'assistant', content: 'hi' } as ChatMessage
    const withTools = {
      ...base,
      toolCalls: [
        { id: '1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"x"}' } },
      ],
    } as ChatMessage
    expect(messageTokens(withTools)).toBeGreaterThan(messageTokens(base))
  })

  it('tool 消息计入工具名开销', () => {
    const toolMsg = { role: 'tool', content: '{}', toolName: 'fs_read' } as unknown as ChatMessage
    const plain = { role: 'tool', content: '{}' } as ChatMessage
    expect(messageTokens(toolMsg)).toBeGreaterThan(messageTokens(plain))
  })
})
