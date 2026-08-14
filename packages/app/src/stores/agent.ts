import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatMessage, ChatSession, AgentConfig, ToolCall, ChatRole } from '@/agent/types'
import { TOOL_LOOP_LIMIT } from '@/agent/types'
import { buildContext, buildSystemPrompt } from '@/agent/context'
import { agentTools, toolsToPayload, findTool } from '@/agent/tools'
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
              toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
              toolName: typeof m.toolName === 'string' ? m.toolName : undefined,
              toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as ToolCall[]) : undefined,
              createdAt: typeof m.createdAt === 'number' ? m.createdAt : now(),
            })),
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

    const tools = cfg.toolEnabled ? toolsToPayload(agentTools) : []
    const getSession = (): ChatSession | null => sessions.value.find((x) => x.id === sessionId) ?? null

    let curAssistantId = assistantId

    for (let round = 0; round < TOOL_LOOP_LIMIT; round++) {
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
      const system = buildSystemPrompt(cfg.systemPrompt, cfg.toolEnabled, dropped)
      const all: ChatMessage[] = [
        { id: genId('m'), role: 'system', content: system, createdAt: now() },
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
        onFinish: (reason, calls) => {
          finishReason = reason
          toolCalls = calls
        },
        onError: (_code, message) => {
          error.value = message
        },
      })

      try {
        await streamChat(toOpenAIMessages(all), tools, channel)
      } catch (e) {
        error.value = String(e)
        break
      }
      if (stopRequested.value || error.value) break

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) break

      if (round === TOOL_LOOP_LIMIT - 1) {
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

      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          const tool = findTool(tc.function.name)
          let content: string
          if (!tool) {
            content = JSON.stringify({ ok: false, error: `未知工具 ${tc.function.name}` })
          } else {
            let args: Record<string, unknown> = {}
            try {
              args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
            } catch {
              /* noop */
            }
            content = await tool.executor(args)
          }
          return { call: tc, content }
        }),
      )
      const s3 = getSession()
      if (!s3) break
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

  async function send(text: string): Promise<void> {
    const s = current.value
    if (!s || streaming.value || !text.trim()) return
    error.value = null
    stopRequested.value = false
    toolStatus.value = null
    streaming.value = true
    const sessionId = s.id
    await reloadConfig()
    if (!config.value) {
      error.value = t('agentErrConfigNotLoaded')
      streaming.value = false
      return
    }
    if (!config.value.apiKeySet) {
      error.value = t('agentErrNoApiKey')
      streaming.value = false
      return
    }
    pushMessageTo(sessionId, { id: genId('m'), role: 'user', content: text.trim(), createdAt: now() })
    const assistantId = genId('m')
    pushMessageTo(sessionId, { id: assistantId, role: 'assistant', content: '', createdAt: now() })
    try {
      await runAgentLoop(sessionId, assistantId)
    } finally {
      streaming.value = false
      toolStatus.value = null
      stopRequested.value = false
    }
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
    removeSession,
    send,
    stop,
  }
})