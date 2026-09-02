import { describe, expect, it } from 'vitest'
import { buildPlanContext, buildSystemPrompt } from './context'
import type { AgentPlan } from './types'

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
