// 层次 A 前端纯函数测试（临时脚本，非产品代码）
import { toolsToPayload, isMetaTool, metaTools, agentTools } from './src/agent/tools'
import { buildPlanContext, buildSystemPrompt } from './src/agent/context'

let pass = 0
let fail = 0
const results: string[] = []

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; results.push('PASS  ' + name) }
  else { fail++; results.push('FAIL  ' + name + (detail ? '  :: ' + detail : '')) }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), 'expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual))
}

// ===== tools.ts =====
const payload = toolsToPayload(agentTools)
check('toolsToPayload 总数 = 15 (12实+3元)', payload.length === 15, 'actual=' + payload.length)
check('toolsToPayload 元素均含 type=function', payload.every((p) => (p as any).type === 'function'))
const names = payload.map((p) => (p as any).function.name as string)
check('含元工具 create_plan', names.includes('create_plan'))
check('含元工具 update_step', names.includes('update_step'))
check('含元工具 finish', names.includes('finish'))
check('含实工具 open_url', names.includes('open_url'))
check('含实工具 system_info', names.includes('system_info'))
check('含实工具 fs_list', names.includes('fs_list'))
check('含实工具 fs_read', names.includes('fs_read'))
check('含实工具 notify', names.includes('notify'))
check('含实工具 clipboard_read', names.includes('clipboard_read'))
check('含实工具 clipboard_write', names.includes('clipboard_write'))

check('isMetaTool(create_plan)=true', isMetaTool('create_plan'))
check('isMetaTool(update_step)=true', isMetaTool('update_step'))
check('isMetaTool(finish)=true', isMetaTool('finish'))
check('isMetaTool(open_url)=false', !isMetaTool('open_url'))
check('isMetaTool(unknown)=false', !isMetaTool('whatever'))

const cp = metaTools.find((t) => t.name === 'create_plan')!
check('create_plan 存在', !!cp)
check('create_plan required 含 goal', (cp.parameters as any).required.includes('goal'))
check('create_plan required 含 steps', (cp.parameters as any).required.includes('steps'))
check('create_plan steps 是 array', (cp.parameters as any).properties.steps.type === 'array')

const us = metaTools.find((t) => t.name === 'update_step')!
check('update_step required 含 step_id', (us.parameters as any).required.includes('step_id'))
check('update_step required 含 status', (us.parameters as any).required.includes('status'))
eq('update_step status enum', (us.parameters as any).properties.status.enum, ['in_progress', 'completed', 'blocked'])

const fn = metaTools.find((t) => t.name === 'finish')!
check('finish required 含 summary', (fn.parameters as any).required.includes('summary'))

// ===== 层次 B M3 工具 schema =====
const fl = agentTools.find((t) => t.name === 'fs_list')!
check('fs_list required 含 dir', (fl.parameters as any).required.includes('dir'))
const fr = agentTools.find((t) => t.name === 'fs_read')!
check('fs_read required 含 path', (fr.parameters as any).required.includes('path'))
const nt = agentTools.find((t) => t.name === 'notify')!
check('notify required 含 text', (nt.parameters as any).required.includes('text'))
const cw = agentTools.find((t) => t.name === 'clipboard_write')!
check('clipboard_write required 含 text', (cw.parameters as any).required.includes('text'))
const cr = agentTools.find((t) => t.name === 'clipboard_read')!
check('clipboard_read 无参数', (cr.parameters as any).type === 'object')

// ===== context.ts =====
check('buildPlanContext(undefined)=null', buildPlanContext(undefined) === null)
check('buildPlanContext(空 steps)=null', buildPlanContext({ goal: 'g', steps: [], status: 'active' }) === null)

const plan = {
  goal: '查内存并记便签',
  steps: [
    { id: 's1', title: '查内存', status: 'completed' as const },
    { id: 's2', title: '记便签', status: 'in_progress' as const, note: '写入中' },
    { id: 's3', title: '汇报', status: 'pending' as const },
  ],
  status: 'active' as const,
}
const planCtx = buildPlanContext(plan)!
check('buildPlanContext 非空', !!planCtx)
check('含 goal', planCtx.includes('查内存并记便签'))
check('含步骤标题1', planCtx.includes('查内存'))
check('含步骤标题2', planCtx.includes('记便签'))
check('含步骤标题3', planCtx.includes('汇报'))
check('含状态 completed', planCtx.includes('[completed]'))
check('含状态 in_progress', planCtx.includes('[in_progress]'))
check('含状态 pending', planCtx.includes('[pending]'))
check('含 note', planCtx.includes('写入中'))

const sp1 = buildSystemPrompt('base', true, 0)
check('toolEnabled=true 含 create_plan', sp1.includes('create_plan'))
const sp2 = buildSystemPrompt('base', false, 0)
check('toolEnabled=false 含关闭工具', sp2.includes('关闭工具'))
check('toolEnabled=false 不含 create_plan', !sp2.includes('create_plan'))
const sp3 = buildSystemPrompt('base', true, 5)
check('dropped>0 含省略提示', sp3.includes('省略'))

console.log('\n===== 纯函数测试结果: ' + pass + ' pass, ' + fail + ' fail =====')
for (const r of results) console.log(r)
