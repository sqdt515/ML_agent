import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatMessage, ChatSession, AgentConfig, ToolCall } from '@/agent/types'
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
      if (raw) {
        const parsed = JSON.parse(raw) as ChatSession[]
        if (Array.isArray(parsed)) sessions.value = parsed
      }
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

  function pushMessage(msg: ChatMessage): void {
    const s = current.value
    if (!s) return
    s.messages.push(msg)
    const firstUser = s.messages.find((m) => m.role === 'user')
    if (s.title === '新对话' && firstUser && msg.role === 'user') {
      s.title = firstUser.content.slice(0, 20) || '新对话'
    }
    s.updatedAt = now()
    persist()
  }

  function updateLastMessage(updater: (m: ChatMessage) => void): void {
    const s = current.value
    if (!s || s.messages.length === 0) return
    updater(s.messages[s.messages.length - 1])
    s.updatedAt = now()
    persist()
  }


  async function runAgentLoop(): Promise<void> {
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

    for (let round = 0; round < TOOL_LOOP_LIMIT; round++) {
      if (stopRequested.value) break

      // 重建上下文：排除末尾的空 assistant 占位
      const msgs = current.value?.messages.filter(
        (m) => !(m.role === 'assistant' && !m.content && !m.toolCalls),
      ) ?? []

      // 超预算且本会话尚未摘要时，先压缩最旧消息为一条摘要（每会话最多 1 次）
      const session = current.value
      if (cfg.apiKeySet && session && !session.summarized) {
        const { droppedMessages } = buildContext(msgs, cfg.contextBudget)
        if (droppedMessages.length > 0) {
          try {
            const summary = await summarizeMessages(droppedMessages)
            session.messages.push({
              id: genId('m'),
              role: 'system',
              content: summary,
              createdAt: now(),
            })
            session.summarized = true
            persist()
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
          updateLastMessage((m) => {
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

      updateLastMessage((m) => {
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
      for (const r of results) {
        pushMessage({
          id: genId('m'),
          role: 'tool',
          toolCallId: r.call.id,
          toolName: r.call.function.name,
          content: r.content,
          createdAt: now(),
        })
      }
      toolStatus.value = null
      pushMessage({ id: genId('m'), role: 'assistant', content: '', createdAt: now() })
    }

    const lastMsg = current.value?.messages[current.value.messages.length - 1]
    if (!error.value && !stopRequested.value && lastMsg?.role === 'assistant' && lastMsg.toolCalls) {
      error.value = t('agentErrToolLoopLimit')
    }
  }

  async function send(text: string): Promise<void> {
    const s = current.value
    if (!s || streaming.value || !text.trim()) return
    error.value = null
    stopRequested.value = false
    toolStatus.value = null
    streaming.value = true
    await reloadConfig()
    pushMessage({ id: genId('m'), role: 'user', content: text.trim(), createdAt: now() })
    pushMessage({ id: genId('m'), role: 'assistant', content: '', createdAt: now() })
    try {
      await runAgentLoop()
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