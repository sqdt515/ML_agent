import { describe, expect, it } from 'vitest'
import { buildContext, buildPlanContext, buildSystemPrompt } from './context'
import { messageTokens } from './token'
import type { AgentPlan, ChatMessage } from './types'

function mk(role: ChatMessage['role'], content: string, i: number): ChatMessage {
  return { id: `m${i}`, role, content, createdAt: 0 }
}

describe('buildContext', () => {
  it('空历史返回空结果', () => {
    const r = buildContext([], 1000)
    expect(r.messages).toHaveLength(0)
    expect(r.dropped).toBe(0)
    expect(r.droppedMessages).toHaveLength(0)
  })

  it('两条消息预算恰好够时全部保留', () => {
    const a = mk('user', 'AAAA', 1)
    const b = mk('user', 'BBBB', 2)
    const total = messageTokens(a) + messageTokens(b)
    const r = buildContext([a, b], total)
    expect(r.dropped).toBe(0)
    expect(r.messages).toHaveLength(2)
  })

  it('预算差一时丢弃最旧消息且保持顺序', () => {
    const a = mk('user', 'AAAA', 1)
    const b = mk('user', 'BBBB', 2)
    const total = messageTokens(a) + messageTokens(b)
    const r = buildContext([a, b], total - 1)
    expect(r.dropped).toBe(1)
    expect(r.messages.map((m) => m.content)).toEqual(['BBBB'])
    expect(r.droppedMessages.map((m) => m.content)).toEqual(['AAAA'])
  })

  it('最新一条即使单独超预算也保留', () => {
    const huge = mk('user', '很'.repeat(500), 1)
    const r = buildContext([huge], 1)
    expect(r.messages).toHaveLength(1)
    expect(r.dropped).toBe(0)
  })

  it('system 消息不参与预算、永不丢弃', () => {
    const sys = mk('system', '系统提示', 0)
    const a = mk('user', 'AAAA', 1)
    const b = mk('user', 'BBBB', 2)
    const r = buildContext([sys, a, b], messageTokens(a) + 1)
    expect(r.messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(r.messages.some((m) => m.content === '系统提示')).toBe(true)
    expect(r.dropped).toBe(1)
  })
})

describe('buildPlanContext', () => {
  it('无 plan 或空 steps 返回 null', () => {
    expect(buildPlanContext(undefined)).toBeNull()
    expect(buildPlanContext({ goal: 'g', steps: [], status: 'active' })).toBeNull()
  })

  it('包含 goal、步骤标题、状态与备注', () => {
    const plan: AgentPlan = {
      goal: '查内存并记便签',
      steps: [
        { id: 's1', title: '查内存', status: 'completed' },
        { id: 's2', title: '记便签', status: 'in_progress', note: '写入中' },
        { id: 's3', title: '汇报', status: 'pending' },
      ],
      status: 'active',
    }
    const ctx = buildPlanContext(plan)!
    expect(ctx).toBeTruthy()
    expect(ctx).toContain('查内存并记便签')
    expect(ctx).toContain('查内存')
    expect(ctx).toContain('记便签')
    expect(ctx).toContain('汇报')
    expect(ctx).toContain('[completed]')
    expect(ctx).toContain('[in_progress]')
    expect(ctx).toContain('[pending]')
    expect(ctx).toContain('写入中')
  })
})

describe('buildSystemPrompt', () => {
  it('计划模式开启时含 create_plan、等待用户确认与禁止直接调用', () => {
    const sp = buildSystemPrompt('base', true, true, 0)
    expect(sp).toContain('create_plan')
    expect(sp).toContain('等待用户确认')
    expect(sp).toContain('严禁')
  })

  it('计划模式关闭时不要求确认，但保留直接回答指引', () => {
    const sp = buildSystemPrompt('base', true, false, 0)
    expect(sp).not.toContain('等待用户确认')
    expect(sp).toContain('简单问题可直接回答')
  })

  it('工具关闭时提示无工具可用且不含 create_plan', () => {
    const sp = buildSystemPrompt('base', false, true, 0)
    expect(sp).toContain('关闭工具')
    expect(sp).not.toContain('create_plan')
  })

  it('有省略消息时给出提示', () => {
    expect(buildSystemPrompt('base', true, true, 5)).toContain('省略')
  })
})
