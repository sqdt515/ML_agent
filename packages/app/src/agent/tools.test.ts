import { describe, expect, it } from 'vitest'
import { agentTools, findTool, isMetaTool, metaTools, toolsToPayload } from './tools'

/** payload 元素为 OpenAI function-calling 形状 */
type FnPayload = { type: string; function: { name: string } }

function names(payload: Array<Record<string, unknown>>): string[] {
  return payload.map((p) => (p as FnPayload).function.name)
}

/** 按名称在实工具+元工具里查找，并取出 JSON Schema 形状的 parameters */
function paramsOf(name: string): { type?: string; required?: string[]; properties?: Record<string, { type?: string; enum?: string[] }> } {
  const tool = [...agentTools, ...metaTools].find((t) => t.name === name)
  expect(tool).toBeDefined()
  return tool!.parameters as { type?: string; required?: string[]; properties?: Record<string, { type?: string; enum?: string[] }> }
}

describe('toolsToPayload', () => {
  it('默认包含 16 实工具 + 3 元工具，且均为 function 类型', () => {
    const payload = toolsToPayload(agentTools)
    expect(payload).toHaveLength(19)
    expect(payload.every((p) => (p as FnPayload).type === 'function')).toBe(true)
  })

  it('exec 关闭后 payload 为 18 项且不含 exec', () => {
    const payload = toolsToPayload(agentTools, { exec: false })
    expect(payload).toHaveLength(18)
    const ns = names(payload)
    expect(ns).not.toContain('exec')
    expect(ns).toContain('web_search')
  })

  it('exec + web_search 关闭后 payload 为 17 项', () => {
    const payload = toolsToPayload(agentTools, { exec: false, web_search: false })
    expect(payload).toHaveLength(17)
    expect(names(payload)).not.toContain('web_search')
  })

  it('默认 payload 含全部关键工具名', () => {
    const ns = names(toolsToPayload(agentTools))
    for (const n of ['create_plan', 'update_step', 'finish', 'open_url', 'system_info', 'fs_list', 'fs_read', 'notify', 'clipboard_read', 'clipboard_write', 'fs_write', 'fs_delete', 'exec', 'web_search']) {
      expect(ns).toContain(n)
    }
  })
})

describe('isMetaTool', () => {
  it('元工具返回 true', () => {
    expect(isMetaTool('create_plan')).toBe(true)
    expect(isMetaTool('update_step')).toBe(true)
    expect(isMetaTool('finish')).toBe(true)
  })

  it('实工具与未知工具返回 false', () => {
    expect(isMetaTool('open_url')).toBe(false)
    expect(isMetaTool('whatever')).toBe(false)
  })
})

describe('元工具 schema', () => {
  it('create_plan 必填 goal 与 steps，steps 为数组', () => {
    const p = paramsOf('create_plan')
    expect(p.required).toContain('goal')
    expect(p.required).toContain('steps')
    expect(p.properties?.['steps']?.type).toBe('array')
  })

  it('update_step 必填 step_id 与 status，status 有枚举', () => {
    const p = paramsOf('update_step')
    expect(p.required).toContain('step_id')
    expect(p.required).toContain('status')
    expect(p.properties?.['status']?.enum).toEqual(['in_progress', 'completed', 'blocked'])
  })

  it('finish 必填 summary', () => {
    expect(paramsOf('finish').required).toContain('summary')
  })
})

describe('实工具 schema', () => {
  it('必填字段符合定义', () => {
    expect(paramsOf('fs_list').required).toContain('dir')
    expect(paramsOf('fs_read').required).toContain('path')
    expect(paramsOf('notify').required).toContain('text')
    expect(paramsOf('clipboard_write').required).toContain('text')
    expect(paramsOf('fs_write').required).toEqual(expect.arrayContaining(['path', 'content']))
    expect(paramsOf('fs_delete').required).toContain('path')
    expect(paramsOf('exec').required).toContain('cmd')
    expect(paramsOf('web_search').required).toContain('query')
  })

  it('clipboard_read 无必填参数', () => {
    expect(paramsOf('clipboard_read')?.type).toBe('object')
  })
})

describe('findTool', () => {
  it('默认（flags 为空）能找到 exec 与 web_search', () => {
    expect(findTool('exec')).toBeDefined()
    expect(findTool('web_search')).toBeDefined()
  })

  it('flags 显式关闭后返回 undefined', () => {
    expect(findTool('exec', { exec: false })).toBeUndefined()
    expect(findTool('web_search', { web_search: false })).toBeUndefined()
  })
})
