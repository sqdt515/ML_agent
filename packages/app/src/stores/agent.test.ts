import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage, ChatSession } from '@/agent/types'

// store 依赖 @tauri-apps/api/core（invoke/Channel），测试环境下用空实现替代
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  Channel: class<T> {
    onmessage: ((msg: T) => void) | null = null
  },
}))

import { useAgentStore } from './agent'

function makeSession(id: string, planStatus?: string): ChatSession {
  return {
    id,
    title: '测试',
    createdAt: 0,
    updatedAt: 0,
    summarized: false,
    messages: [],
    plan: planStatus
      ? { goal: '目标', steps: [{ id: 'a', title: '步骤A', status: 'pending' }], status: planStatus as never }
      : undefined,
  } as ChatSession
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('agent store plan 状态机', () => {
  it('confirmPlan 将 awaiting_confirm → active', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1', 'awaiting_confirm'), makeSession('s2', 'active')]
    agent.currentId = 's1'
    agent.confirmPlan()
    expect(agent.current?.plan?.status).toBe('active')
  })

  it('会话隔离：另一会话的 plan 不受影响', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1', 'awaiting_confirm'), makeSession('s2', 'active')]
    agent.currentId = 's1'
    agent.confirmPlan()
    expect(agent.sessions.find((s) => s.id === 's2')?.plan?.status).toBe('active')
  })

  it('cancelPlan 将 awaiting_confirm → cancelled', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1', 'awaiting_confirm')]
    agent.currentId = 's1'
    agent.cancelPlan()
    expect(agent.current?.plan?.status).toBe('cancelled')
  })

  it('非 awaiting_confirm 时 confirmPlan no-op', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1', 'active')]
    agent.currentId = 's1'
    agent.confirmPlan()
    expect(agent.current?.plan?.status).toBe('active')
  })

  it('非 awaiting_confirm 时 cancelPlan no-op', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1', 'active')]
    agent.currentId = 's1'
    agent.cancelPlan()
    expect(agent.current?.plan?.status).toBe('active')
  })

  it('无 plan 时 confirmPlan 不抛错', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1')]
    agent.currentId = 's1'
    expect(() => agent.confirmPlan()).not.toThrow()
  })

  it('无 plan 时 cancelPlan 不抛错', () => {
    const agent = useAgentStore()
    agent.sessions = [makeSession('s1')]
    agent.currentId = 's1'
    expect(() => agent.cancelPlan()).not.toThrow()
  })
})

describe('会话生命周期（防残留）', () => {
  function pushMsg(content: string): void {
    useAgentStore().current!.messages.push({
      id: 'm_' + content,
      role: 'user',
      content,
      createdAt: 0,
    } as ChatMessage)
  }

  it('newChat 在当前会话为空时复用，不堆积空会话', () => {
    const agent = useAgentStore()
    agent.newChat()
    const first = agent.current!.id
    agent.newChat()
    agent.newChat()
    expect(agent.sessions).toHaveLength(1)
    expect(agent.current!.id).toBe(first)
  })

  it('newChat 在当前会话有内容时新建', () => {
    const agent = useAgentStore()
    agent.newChat()
    pushMsg('hi')
    agent.newChat()
    expect(agent.sessions).toHaveLength(2)
    expect(agent.current!.messages).toHaveLength(0)
  })

  it('clearChat 移除当前会话并回退到其余会话', () => {
    const agent = useAgentStore()
    agent.newChat()
    const withContent = agent.current!.id
    pushMsg('hi')
    agent.newChat()
    agent.clearChat()
    expect(agent.sessions).toHaveLength(1)
    expect(agent.current!.id).toBe(withContent)
  })

  it('清空唯一会话后自动新建一个空会话', () => {
    const agent = useAgentStore()
    agent.newChat()
    agent.clearChat()
    expect(agent.sessions).toHaveLength(1)
    expect(agent.current).not.toBeNull()
    expect(agent.current!.messages).toHaveLength(0)
  })

  it('init 时清理历史残留的空会话并修正 currentId', async () => {
    localStorage.setItem(
      'new-ai-agent-sessions',
      JSON.stringify([
        { id: 's_empty1', title: '新对话', createdAt: 0, updatedAt: 0, messages: [] },
        {
          id: 's_full',
          title: '有内容',
          createdAt: 0,
          updatedAt: 0,
          messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 0 }],
        },
        { id: 's_empty2', title: '新对话', createdAt: 0, updatedAt: 0, messages: [] },
      ]),
    )
    const agent = useAgentStore()
    await agent.init()
    expect(agent.sessions.map((s) => s.id)).toEqual(['s_full'])
    expect(agent.current!.id).toBe('s_full')
  })

  it('全部会话为空时保留一个可用会话', async () => {
    localStorage.setItem(
      'new-ai-agent-sessions',
      JSON.stringify([
        { id: 's_e1', title: '新对话', createdAt: 0, updatedAt: 0, messages: [] },
        { id: 's_e2', title: '新对话', createdAt: 0, updatedAt: 0, messages: [] },
      ]),
    )
    const agent = useAgentStore()
    await agent.init()
    expect(agent.sessions).toHaveLength(2)
    expect(agent.current).not.toBeNull()
  })
})
