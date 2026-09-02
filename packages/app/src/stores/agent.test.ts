import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatSession } from '@/agent/types'

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
