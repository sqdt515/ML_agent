import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatMessage, ChatSession, AgentConfig, ToolCall, ChatRole, AgentStep, AgentStepStatus, AgentPlan } from '@/agent/types'
import { MAX_AGENT_ROUNDS } from '@/agent/types'
import { buildContext, buildSystemPrompt, buildPlanContext } from '@/agent/context'
import { agentTools, toolsToPayload, findTool, isMetaTool, setAuditContext } from '@/agent/tools'
import { createChatChannel, streamChat, toOpenAIMessages } from '@/agent/engine'
import { invoke } from '@tauri-apps/api/core'
import { loadConfig } from '@/agent/config'
import { isTauri } from '@/utils/env'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()

const STORAGE_KEY = 'new-ai-agent-sessions'
const MAX_SESSIONS = 20

let idSeq = 0
function genId(prefix: string): string {
  idSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`
}

function now(): number {
  return Date.now()
}

const VALID_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const
const VALID_PLAN_STATUSES = ['awaiting_confirm', 'active', 'done', 'cancelled'] as const

/** 从 localStorage 恢复 plan（含状态校验，兼容非法/缺失字段） */
function parseStoredPlan(raw: unknown): AgentPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const goal = typeof p.goal === 'string' ? p.goal : ''
  const stepsRaw = Array.isArray(p.steps) ? p.steps : []
  const steps: AgentStep[] = stepsRaw
    .filter((st) => st && typeof st === 'object' && typeof (st as Record<string, unknown>).title === 'string')
    .map((st, i) => {
      const o = st as Record<string, unknown>
      return {
        id: typeof o.id === 'string' ? o.id : 'step_' + (i + 1),
        title: String(o.title),
        status: (VALID_STEP_STATUSES as readonly string[]).includes(String(o.status))
          ? (o.status as AgentStepStatus)
          : 'pending',
        note: typeof o.note === 'string' ? o.note : undefined,
      }
    })
  if (steps.length === 0) return undefined
  const status = (VALID_PLAN_STATUSES as readonly string[]).includes(String(p.status))
    ? (p.status as AgentPlan['status'])
    : 'active'
  return { goal, steps, status }
}

/** 调用后端非流式摘要命令，把最旧消息压缩为一条摘要文本 */
async function summarizeMessages(messages: ChatMessage[]): Promise<string> {
  return invoke<string>('agent_summarize', { messages: toOpenAIMessages(messages) })
}

export const useAgentStore = defineStore('agent', () => {
  const config = ref<AgentConfig | null>(null)
  const sessions = ref<ChatSession[]>([])
  const currentId = ref<string | null>(null)
  const streaming = ref(false)
  const toolStatus = ref<string | null>(null)
  const error = ref<string | null>(null)
  const stopRequested = ref(false)

  const current = computed(() => sessions.value.find((s) => s.id === currentId.value) ?? null)
  const messages = computed(() => current.value?.messages ?? [])

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.value))
    } catch {
      /* noop */
    }
  }

  function loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      sessions.value = (parsed as Array<Record<string, unknown>>)
        .filter((s) => s && typeof s.id === 'string' && Array.isArray(s.messages))
        .map((s) => ({
          id: String(s.id),
          title: typeof s.title === 'string' ? s.title : '新对话',
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : now(),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : now(),
          summarized: s.summarized === true,
          model: typeof s.model === 'string' ? s.model : undefined,
          messages: (s.messages as Array<Record<string, unknown>>)
            .filter(
              (m) =>
                m &&
                typeof m.id === 'string' &&
                ['system', 'user', 'assistant', 'tool'].includes(String(m.role)),
            )
            .map((m) => ({
              id: String(m.id),
              role: m.role as ChatRole,
              content: typeof m.content === 'string' ? m.content : '',
              reasoning: typeof m.reasoning === 'string' ? m.reasoning : undefined,
              toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
              toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
              toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as ToolCall[]) : undefined,
              createdAt: typeof m.createdAt === 'number' ? m.createdAt : now(),
            })),
          plan: parseStoredPlan(s.plan),
        }))
    } catch {
      /* noop */
    }
  }

  async function reloadConfig(): Promise<void> {
    if (!isTauri) return
    try {
      config.value = await loadConfig()
    } catch {
      /* noop */
    }
  }

  async function init(): Promise<void> {
    loadFromStorage()
    if (sessions.value.length === 0) {
      newChat()
    } else if (!currentId.value) {
      currentId.value = sessions.value[0].id
    }
    await reloadConfig()
  }

  function newChat(): void {
    const s: ChatSession = {
      id: genId('s'),
      title: '新对话',
      createdAt: now(),
      updatedAt: now(),
      messages: [],
    }
    sessions.value.unshift(s)
    currentId.value = s.id
    trimSessions()
    persist()
  }

  function clearChat(): void {
    const s = current.value
    if (!s) return
    s.messages = []
    s.title = '新对话'
    s.updatedAt = now()
    persist()
  }

  function switchSession(id: string): void {
    currentId.value = id
  }

  function setSessionModel(model: string): void {
    const s = current.value
    if (!s) return
    s.model = model.trim() || undefined
    s.updatedAt = now()
    persist()
  }

  function removeSession(id: string): void {
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx === -1) return
    sessions.value.splice(idx, 1)
    if (currentId.value === id) {
      currentId.value = sessions.value[0]?.id ?? null
      if (!currentId.value) newChat()
    }
    persist()
  }

  function trimSessions(): void {
    sessions.value = sessions.value.slice(0, MAX_SESSIONS)
  }

  /** 向指定会话追加消息（绑定会话，避免流式期间切换会话导致串台） */
  function pushMessageTo(sessionId: string, msg: ChatMessage): void {
    const s = sessions.value.find((x) => x.id === sessionId)
    if (!s) return
    s.messages.push(msg)
    const firstUser = s.messages.find((m) => m.role === 'user')
    if (s.title === '新对话' && firstUser && msg.role === 'user') {
      s.title = firstUser.content.slice(0, 20) || '新对话'
    }
    s.updatedAt = now()
    persist()
  }

  /** 更新指定会话中的指定消息（流式回答绑定到发起请求时的消息，而非"当前最后一条"） */
  function updateMessage(sessionId: string, messageId: string, updater: (m: ChatMessage) => void): void {
    const s = sessions.value.find((x) => x.id === sessionId)
    if (!s) return
    const m = s.messages.find((x) => x.id === messageId)
    if (!m) return
    updater(m)
    s.updatedAt = now()
    persist()
  }


  function parseToolArgs(tc: ToolCall): Record<string, unknown> {
    try {
      return tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** 执行元工具：更新会话的 plan 状态（不发到 Rust），返回给模型的结果文本 */
  function handleMetaTool(sessionId: string, tc: ToolCall): string {
    const s = sessions.value.find((x) => x.id === sessionId)
    if (!s) return JSON.stringify({ ok: false, error: '会话不存在' })
    const args = parseToolArgs(tc)
    const name = tc.function.name

    if (name === 'create_plan') {
      const goal = String(args.goal ?? '')
      const rawSteps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : []
      const steps: AgentStep[] = rawSteps
        .map((st, i) => ({
          id: typeof st.id === 'string' ? st.id : 'step_' + (i + 1),
          title: typeof st.title === 'string' ? st.title : '',
          status: 'pending' as AgentStepStatus,
        }))
        .filter((st) => st.title)
      if (steps.length === 0) {
        return JSON.stringify({ ok: false, error: '计划步骤为空，请至少提供一个步骤' })
      }
      const planStatus: AgentPlan['status'] = config.value?.planMode ? 'awaiting_confirm' : 'active'
      s.plan = { goal, steps, status: planStatus }
      persist()
      return JSON.stringify({ ok: true, result: '已创建计划：' + goal + '（' + steps.length + ' 步）' })
    }

    if (name === 'update_step') {
      if (!s.plan) return JSON.stringify({ ok: false, error: '尚未创建计划' })
      const sid = String(args.step_id ?? '')
      const rawStatus = String(args.status ?? 'in_progress')
      if (!(VALID_STEP_STATUSES as readonly string[]).includes(rawStatus)) {
        return JSON.stringify({ ok: false, error: '非法步骤状态 ' + rawStatus })
      }
      const status = rawStatus as AgentStepStatus
      const step = s.plan.steps.find((x) => x.id === sid)
      if (!step) return JSON.stringify({ ok: false, error: '未知步骤 ' + sid })
      step.status = status
      if (args.note != null) step.note = String(args.note)
      persist()
      return JSON.stringify({ ok: true, result: '步骤 ' + sid + ' 已更新为 ' + status })
    }

    if (name === 'finish') {
      if (s.plan) {
        s.plan.status = 'done'
        for (const st of s.plan.steps) {
          if (st.status === 'pending' || st.status === 'in_progress') {
            st.status = 'completed'
          }
        }
      }
      persist()
      return JSON.stringify({ ok: true, result: '任务完成：' + String(args.summary ?? '') })
    }

    return JSON.stringify({ ok: false, error: '未知元工具 ' + name })
  }

  async function runAgentLoop(sessionId: string, assistantId: string): Promise<void> {
    const cfg = config.value
    if (!cfg) {
      error.value = t('agentErrConfigNotLoaded')
      return
    }
    if (!cfg.apiKeySet) {
      error.value = t('agentErrNoApiKey')
      return
    }

    const tools = cfg.toolEnabled ? toolsToPayload(agentTools, cfg.toolFlags ?? {}) : []
    const maxRounds = cfg.maxAgentRounds || MAX_AGENT_ROUNDS
    const getSession = (): ChatSession | null => sessions.value.find((x) => x.id === sessionId) ?? null

    let curAssistantId = assistantId

    for (let round = 0; round < maxRounds; round++) {
      if (stopRequested.value) break

      const s = getSession()
      if (!s) break

      // 重建上下文：仅剔除末尾的空 assistant 占位，避免产生连续 user 消息
      let msgs = s.messages
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        if (last.role === 'assistant' && !last.content && !last.toolCalls) {
          msgs = msgs.slice(0, -1)
        }
      }

      // 超预算且本会话尚未摘要时，先压缩最旧消息为一条摘要（每会话最多 1 次）
      if (cfg.apiKeySet && !s.summarized) {
        const { droppedMessages } = buildContext(msgs, cfg.contextBudget)
        if (droppedMessages.length > 0) {
          try {
            const summary = await summarizeMessages(droppedMessages)
            s.messages.push({ id: genId('m'), role: 'system', content: summary, createdAt: now() })
            s.summarized = true
            persist()
            msgs = s.messages
            if (msgs.length > 0) {
              const last = msgs[msgs.length - 1]
              if (last.role === 'assistant' && !last.content && !last.toolCalls) {
                msgs = msgs.slice(0, -1)
              }
            }
          } catch (e) {
            console.warn('agent: summarize failed:', e)
          }
        }
      }

      const { messages: ctx, dropped } = buildContext(msgs, cfg.contextBudget)
      const system = buildSystemPrompt(cfg.systemPrompt, cfg.toolEnabled, cfg.planMode, dropped)
      const planCtx = buildPlanContext(s.plan)
      const all: ChatMessage[] = [
        { id: genId('m'), role: 'system', content: system, createdAt: now() },
        ...(planCtx ? [{ id: genId('m'), role: 'system', content: planCtx, createdAt: now() } as ChatMessage] : []),
        ...ctx,
      ]

      let finishReason = ''
      let toolCalls: ToolCall[] = []
      const channel = createChatChannel({
        onDelta: (text) => {
          if (stopRequested.value) return
          updateMessage(sessionId, curAssistantId, (m) => {
            if (m.role === 'assistant') m.content += text
          })
        },
        onReasoning: (text) => {
          if (stopRequested.value) return
          updateMessage(sessionId, curAssistantId, (m) => {
            if (m.role === 'assistant') m.reasoning = (m.reasoning ?? '') + text
          })
        },
        onFinish: (reason, calls) => {
          finishReason = reason
          toolCalls = calls
        },
        onError: (_code, message) => {
          error.value = message
        },
      })

      try {
        await streamChat(toOpenAIMessages(all), tools, channel, s.model)
      } catch (e) {
        error.value = String(e)
        break
      }
      if (stopRequested.value || error.value) break

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) break

      if (round === maxRounds - 1) {
        // 最后一轮仍要调工具：超限，移除未执行工具的 assistant 占位
        const s2 = getSession()
        if (s2) {
          const idx = s2.messages.findIndex((m) => m.id === curAssistantId)
          if (idx !== -1) {
            s2.messages.splice(idx, 1)
            persist()
          }
        }
        error.value = t('agentErrToolLoopLimit')
        break
      }

      updateMessage(sessionId, curAssistantId, (m) => {
        if (m.role === 'assistant') m.toolCalls = toolCalls
      })
      toolStatus.value = t('agentToolCalling') + toolCalls.map((tc) => tc.function.name).join(', ')

      // 计划确认模式兜底：会话尚无计划且本轮未先 create_plan，强制拦截所有工具，要求先规划
      const s0 = getSession()
      if (s0 && cfg.planMode && !s0.plan && !toolCalls.some((tc) => tc.function.name === 'create_plan')) {
        for (const tc of toolCalls) {
          s0.messages.push({
            id: genId('m'),
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.function.name,
            content: JSON.stringify({ ok: false, error: '计划确认模式已开启：请先调用 create_plan 制定分步计划，经用户确认后再执行其他工具。' }),
            createdAt: now(),
          })
        }
        toolStatus.value = null
        const newAssistantId = genId('m')
        s0.messages.push({ id: newAssistantId, role: 'assistant', content: '', createdAt: now() })
        s0.updatedAt = now()
        persist()
        curAssistantId = newAssistantId
        continue
      }

      const metaCalls = toolCalls.filter((tc) => isMetaTool(tc.function.name))
      const realCalls = toolCalls.filter((tc) => !isMetaTool(tc.function.name))

      // 先执行元工具（可能让 plan 进入 awaiting_confirm）
      const metaResults = await Promise.all(
        metaCalls.map(async (tc) => ({ call: tc, content: handleMetaTool(sessionId, tc) })),
      )

      const s3 = getSession()
      if (!s3) break

      // 计划进入待确认：只回填元工具结果，丢弃未执行的实工具调用，暂停等待确认
      if (s3.plan?.status === 'awaiting_confirm') {
        updateMessage(sessionId, curAssistantId, (m) => {
          if (m.role === 'assistant') m.toolCalls = metaCalls
        })
        for (const r of metaResults) {
          s3.messages.push({
            id: genId('m'),
            role: 'tool',
            toolCallId: r.call.id,
            toolName: r.call.function.name,
            content: r.content,
            createdAt: now(),
          })
        }
        toolStatus.value = null
        break
      }

      // 设置高危工具审计上下文：会话 id + 计划是否已确认
      setAuditContext(sessionId, s3.plan?.status === 'active')

      // 执行实工具并回填全部结果
      const realResults = await Promise.all(
        realCalls.map(async (tc) => {
          const tool = findTool(tc.function.name, cfg.toolFlags ?? {})
          if (!tool) {
            return { call: tc, content: JSON.stringify({ ok: false, error: `未知工具 ${tc.function.name}` }) }
          }
          return { call: tc, content: await tool.executor(parseToolArgs(tc)) }
        }),
      )
      const results = [...metaResults, ...realResults]
      for (const r of results) {
        s3.messages.push({
          id: genId('m'),
          role: 'tool',
          toolCallId: r.call.id,
          toolName: r.call.function.name,
          content: r.content,
          createdAt: now(),
        })
      }
      toolStatus.value = null
      const newAssistantId = genId('m')
      s3.messages.push({ id: newAssistantId, role: 'assistant', content: '', createdAt: now() })
      s3.updatedAt = now()
      persist()
      curAssistantId = newAssistantId
    }

    // 清理末尾的空 assistant 占位；若既无内容又无错误/停止，则提示空响应
    const s = getSession()
    if (s) {
      const last = s.messages[s.messages.length - 1]
      if (last?.role === 'assistant' && !last.content && !last.toolCalls) {
        s.messages.pop()
        persist()
        if (!error.value && !stopRequested.value) {
          error.value = t('agentErrEmptyResponse')
        }
      }
    }
  }

  async function execute(sessionId: string, assistantId: string): Promise<void> {
    streaming.value = true
    try {
      await runAgentLoop(sessionId, assistantId)
    } finally {
      streaming.value = false
      toolStatus.value = null
      stopRequested.value = false
    }
  }

  async function send(text: string): Promise<void> {
    const s = current.value
    if (!s || streaming.value || !text.trim()) return
    // 新消息打断当前会话待确认的计划
    if (s.plan?.status === 'awaiting_confirm') {
      s.plan.status = 'cancelled'
    }
    error.value = null
    stopRequested.value = false
    toolStatus.value = null
    const sessionId = s.id
    await reloadConfig()
    if (!config.value) {
      error.value = t('agentErrConfigNotLoaded')
      return
    }
    if (!config.value.apiKeySet) {
      error.value = t('agentErrNoApiKey')
      return
    }
    pushMessageTo(sessionId, { id: genId('m'), role: 'user', content: text.trim(), createdAt: now() })
    const assistantId = genId('m')
    pushMessageTo(sessionId, { id: assistantId, role: 'assistant', content: '', createdAt: now() })
    await execute(sessionId, assistantId)
  }

  function confirmPlan(): void {
    const s = current.value
    if (!s?.plan || s.plan.status !== 'awaiting_confirm') return
    s.plan.status = 'active'
    persist()
    const assistantId = genId('m')
    pushMessageTo(s.id, { id: assistantId, role: 'assistant', content: '', createdAt: now() })
    void execute(s.id, assistantId)
  }

  function cancelPlan(): void {
    const s = current.value
    if (!s?.plan || s.plan.status !== 'awaiting_confirm') return
    s.plan.status = 'cancelled'
    persist()
  }

  function stop(): void {
    stopRequested.value = true
  }

  return {
    config,
    sessions,
    currentId,
    current,
    messages,
    streaming,
    toolStatus,
    error,
    init,
    reloadConfig,
    newChat,
    clearChat,
    switchSession,
    setSessionModel,
    removeSession,
    send,
    stop,
    confirmPlan,
    cancelPlan,
  }
})