import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentConfig, ChatMessage } from '@/agent/types'

// ============================================================
// 黑盒测试：mock Tauri IPC，从 store 公共 API（send/confirmPlan/…）
// 驱动完整的 Agent 循环，只观察会话状态与 invoke 调用序列，
// 不触碰 store 内部函数。流式分片由脚本按轮次回放给 Channel。
// ============================================================

type Chunk = Record<string, unknown>
type ChannelLike = { onmessage: ((m: Chunk) => void) | null }
type Script = (channel: ChannelLike) => void

const mocks = vi.hoisted(() => ({
  scripts: [] as Script[],
  toolLog: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  summarizeCount: 0,
}))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((m: Chunk) => void) | null = null
  },
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === 'agent_chat_stream') {
      const script = mocks.scripts.shift()
      if (!script) throw new Error('测试脚本耗尽：多了一轮流式请求')
      script(args.channel as ChannelLike)
      return undefined
    }
    if (cmd === 'agent_summarize') {
      mocks.summarizeCount += 1
      return '这是早期对话的摘要'
    }
    // 其余一律视为工具调用：记录并返回统一成功结果
    mocks.toolLog.push({ cmd, args })
    return { ok: true, result: 'mocked', path: String(args.path ?? '') }
  }),
}))

import { useAgentStore } from './agent'

function baseConfig(planMode: boolean): AgentConfig {
  return {
    apiKeySet: true,
    apiKeyLast4: '1234',
    baseUrl: 'https://api.example.com',
    model: 'test-model',
    systemPrompt: 'base',
    toolEnabled: true,
    contextBudget: 24000,
    maxAgentRounds: 20,
    planMode,
    execEnabled: false,
    webSearchKeySet: false,
    webSearchKeyLast4: '',
    toolFlags: {},
  }
}

/** 推送一段流式脚本：ch.onmessage 依次收到分片 */
function streamScript(...chunks: Chunk[]): void {
  mocks.scripts.push((ch) => {
    for (const c of chunks) ch.onmessage?.(c)
  })
}

function finish(reason: string, toolCalls?: unknown): Chunk {
  return { kind: 'finish', reason, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  mocks.scripts.length = 0
  mocks.toolLog.length = 0
  mocks.summarizeCount = 0
})

describe('agent 循环（黑盒，经 mock IPC 驱动）', () => {
  it('场景1：纯文本回答——用户消息、流式拼接、无工具调用', async () => {
    const agent = useAgentStore()
    agent.newChat()
    agent.config = baseConfig(false)
    streamScript({ kind: 'delta', text: '你好' }, { kind: 'delta', text: '！' }, finish('stop'))

    await agent.send('打个招呼')

    expect(agent.error).toBeNull()
    expect(agent.streaming).toBe(false)
    const msgs = agent.current!.messages
    expect(msgs.map((m: ChatMessage) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toBe('你好！')
    expect(mocks.toolLog).toHaveLength(0)
  })

  it('场景2：一轮工具调用——回填 toolCalls、执行工具并回喂结果', async () => {
    const agent = useAgentStore()
    agent.newChat()
    agent.config = baseConfig(false)
    streamScript(
      finish('tool_calls', [
        { id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } },
      ]),
    )
    streamScript({ kind: 'delta', text: '已读取' }, finish('stop'))

    await agent.send('读一下 a.txt')

    expect(agent.error).toBeNull()
    const msgs = agent.current!.messages
    const assistant = msgs.find((m: ChatMessage) => m.role === 'assistant')!
    expect(assistant.toolCalls).toHaveLength(1)
    const toolMsg = msgs.find((m: ChatMessage) => m.role === 'tool')!
    expect(toolMsg.toolName).toBe('fs_read')
    expect(toolMsg.toolCallId).toBe('call_1')
    expect(JSON.parse(toolMsg.content).ok).toBe(true)
    // 高危工具审计上下文：invoke 参数携带会话 id 与确认标记
    expect(mocks.toolLog).toHaveLength(1)
    expect(mocks.toolLog[0].cmd).toBe('agent_tool_fs_read')
    expect(mocks.toolLog[0].args.path).toBe('a.txt')
    expect(mocks.toolLog[0].args.sessionId).toBe(agent.current!.id)
    expect(mocks.toolLog[0].args.userConfirm).toBe(false)
  })

  it('场景3：计划模式硬闸——未先 create_plan 的工具调用被拦截', async () => {
    const agent = useAgentStore()
    agent.newChat()
    agent.config = baseConfig(true)
    streamScript(
      finish('tool_calls', [
        { id: 'call_2', type: 'function', function: { name: 'fs_read', arguments: '{"path":"x"}' } },
      ]),
    )
    streamScript({ kind: 'delta', text: '好的' }, finish('stop'))

    await agent.send('直接读文件')

    expect(agent.error).toBeNull()
    expect(agent.current!.plan).toBeUndefined()
    const toolMsgs = agent.current!.messages.filter((m: ChatMessage) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toContain('计划确认模式已开启')
    // 被拦截的实工具不应真正执行
    expect(mocks.toolLog).toHaveLength(0)
  })

  it('场景4：create_plan 后暂停等待确认，confirmPlan 恢复执行', async () => {
    const agent = useAgentStore()
    agent.newChat()
    agent.config = baseConfig(true)
    streamScript(
      finish('tool_calls', [
        {
          id: 'call_3',
          type: 'function',
          function: {
            name: 'create_plan',
            arguments: '{"goal":"查天气","steps":[{"title":"第一步"}]}',
          },
        },
      ]),
    )
    streamScript({ kind: 'delta', text: '第一步已就绪' }, finish('stop'))

    await agent.send('帮我查天气')

    const plan = agent.current!.plan!
    expect(plan.status).toBe('awaiting_confirm')
    expect(plan.goal).toBe('查天气')
    // 元工具在本地执行，不应打到后端
    expect(mocks.toolLog).toHaveLength(0)

    agent.confirmPlan()
    await new Promise((r) => setTimeout(r, 20))

    expect(plan.status).toBe('active')
    expect(agent.error).toBeNull()
  })

  it('场景5：超预算触发一次摘要压缩，且每会话只压缩一次', async () => {
    const agent = useAgentStore()
    agent.newChat()
    const cfg = baseConfig(false)
    cfg.contextBudget = 10
    agent.config = cfg
    // 预置两条超预算的旧消息
    agent.current!.messages.push(
      { id: 'o1', role: 'user', content: '很旧的问题'.repeat(50), createdAt: 0 } as ChatMessage,
      { id: 'o2', role: 'assistant', content: '很旧的回答'.repeat(50), createdAt: 0 } as ChatMessage,
    )
    streamScript({ kind: 'delta', text: '新回答' }, finish('stop'))
    await agent.send('新问题')

    expect(mocks.summarizeCount).toBe(1)
    const sysMsgs = agent.current!.messages.filter((m: ChatMessage) => m.role === 'system')
    expect(sysMsgs).toHaveLength(1)
    expect(sysMsgs[0].content).toContain('摘要')

    streamScript({ kind: 'delta', text: '又回答' }, finish('stop'))
    await agent.send('再来一条')
    // 已摘要过的会话不再重复压缩
    expect(mocks.summarizeCount).toBe(1)
  })
})
