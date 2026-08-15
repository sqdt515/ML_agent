import type { ChatMessage, AgentPlan } from './types'
import { estimateTokens } from './token'

export interface BuildContextResult {
  /** 进入上下文的非 system 消息（从最新向前保留，预算内） */
  messages: ChatMessage[]
  /** 因超预算被省略的消息条数 */
  dropped: number
  /** 因超预算被省略的最旧消息（用于压缩为摘要） */
  droppedMessages: ChatMessage[]
}

/** 组装系统提示词（附加工具开关与省略提示） */
export function buildSystemPrompt(base: string, toolEnabled: boolean, dropped: number): string {
  let prompt = base.trim()
  if (toolEnabled) {
    prompt += '\n\n（自治执行协议：接到需要多步完成的任务时，先调用 create_plan 制定计划；执行过程中用 update_step 更新每步状态；全部完成后调用 finish 总结。简单问题可直接回答，不必规划。）'
  } else {
    prompt += '\n\n（当前已关闭工具调用，请只进行对话，不要请求使用工具。）'
  }
  if (dropped > 0) {
    prompt += `\n\n（提示：由于对话过长，最旧的 ${dropped} 条消息已被省略，请基于剩余上下文继续。）`
  }
  return prompt
}

/**
 * 上下文构建：滑动窗口裁剪。
 * 始终保留最新一条消息；从最新向最旧累计 token，超过预算后丢弃更早的消息。
 */
export function buildContext(messages: ChatMessage[], budget: number): BuildContextResult {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const history = messages.filter((m) => m.role !== 'system')

  let total = 0
  const kept: ChatMessage[] = []
  const droppedMsgs: ChatMessage[] = []
  let dropped = 0

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    const cost = estimateTokens(msg.content)
    if (total + cost > budget && kept.length > 0) {
      dropped += 1
      droppedMsgs.push(msg)
      continue
    }
    kept.unshift(msg)
    total += cost
  }

  return { messages: [...systemMsgs, ...kept], dropped, droppedMessages: droppedMsgs }
}

const STEP_ICON: Record<string, string> = {
  pending: '·',
  in_progress: '▶',
  completed: '✓',
  blocked: '⚠',
}

/** 把当前执行计划序列化为给模型看的结构化文本，注入下一轮上下文 */
export function buildPlanContext(plan: AgentPlan | undefined): string | null {
  if (!plan || plan.steps.length === 0) return null
  const lines: string[] = []
  for (const st of plan.steps) {
    let line = '  ' + (STEP_ICON[st.status] ?? '·') + ' [' + st.status + '] ' + st.title
    if (st.note) line += '（' + st.note + '）'
    lines.push(line)
  }
  const sep = '\n'
  return (
    '当前任务计划（目标：' +
    plan.goal +
    '）：' +
    sep +
    lines.join(sep) +
    sep +
    '请继续按计划推进：开始某步前标 in_progress，完成后标 completed，遇到障碍标 blocked 并说明原因、必要时调整策略，全部完成调用 finish。'
  )
}