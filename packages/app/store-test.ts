import './mock-localstorage'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './src/stores/agent'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')) }
}

setActivePinia(createPinia())
const agent = useAgentStore()

function makeSession(id: string, planStatus?: string): any {
  return {
    id,
    title: '测试',
    createdAt: 0,
    updatedAt: 0,
    summarized: false,
    messages: [],
    plan: planStatus
      ? { goal: '目标', steps: [{ id: 'a', title: '步骤A', status: 'pending' }], status: planStatus }
      : undefined,
  }
}

// 用例 1: confirmPlan 将 awaiting_confirm → active
agent.sessions = [makeSession('s1', 'awaiting_confirm'), makeSession('s2', 'active')]
agent.currentId = 's1'
agent.confirmPlan()
check('confirmPlan: awaiting_confirm → active', agent.current?.plan?.status === 'active')

// 用例 2: 会话隔离——另一会话 plan 不受影响
check('会话隔离: 另一会话 plan 保持 active', agent.sessions.find((s: any) => s.id === 's2')?.plan?.status === 'active')

// 用例 3: cancelPlan 将 awaiting_confirm → cancelled
agent.sessions = [makeSession('s1', 'awaiting_confirm')]
agent.currentId = 's1'
agent.cancelPlan()
check('cancelPlan: awaiting_confirm → cancelled', agent.current?.plan?.status === 'cancelled')

// 用例 4: 非 awaiting_confirm 时 confirmPlan no-op
agent.sessions = [makeSession('s1', 'active')]
agent.currentId = 's1'
agent.confirmPlan()
check('confirmPlan: 非 awaiting_confirm 时 no-op', agent.current?.plan?.status === 'active')

// 用例 5: 非 awaiting_confirm 时 cancelPlan no-op
agent.cancelPlan()
check('cancelPlan: 非 awaiting_confirm 时 no-op', agent.current?.plan?.status === 'active')

// 用例 6: 无 plan 时 confirmPlan 不抛错
agent.sessions = [makeSession('s1')]
agent.currentId = 's1'
agent.confirmPlan()
check('confirmPlan: 无 plan 不抛错', true)

// 用例 7: 无 plan 时 cancelPlan 不抛错
agent.cancelPlan()
check('cancelPlan: 无 plan 不抛错', true)

console.log(`\n===== store 运行时测试: ${pass} pass, ${fail} fail =====`)
if (fail > 0) process.exit(1)
