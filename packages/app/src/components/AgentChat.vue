<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from '@/composables/useI18n'
import { renderMarkdown } from '@/agent/markdown'
import { isTauri } from '@/utils/env'

const { t } = useI18n()
const agent = useAgentStore()
const draft = ref('')
const listRef = ref<HTMLElement | null>(null)

const showStop = computed(() => agent.streaming)
const streamLen = computed(() => {
  const msgs = agent.messages
  const last = msgs[msgs.length - 1]
  return last ? last.content.length : 0
})

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch([() => agent.messages.length, streamLen], scrollToBottom)

onMounted(() => {
  void agent.init()
})

function onSend(): void {
  const text = draft.value.trim()
  if (!text || agent.streaming) return
  draft.value = ''
  void agent.send(text)
}

function onSwitchSession(e: Event): void {
  const target = e.target as HTMLSelectElement
  if (target.value) agent.switchSession(target.value)
}

function minimize(): void {
  if (isTauri) void getCurrentWindow().minimize()
}

function hideWindow(): void {
  if (isTauri) void getCurrentWindow().hide()
}

function exitApp(): void {
  if (isTauri) void invoke('agent_app_exit')
}
</script>

<template>
  <div class="agent-chat">
    <header class="titlebar" data-tauri-drag-region>
      <div class="titlebar-left" data-tauri-drag-region>
        <span class="app-title">{{ t('agentTitle') }}</span>
        <span v-if="agent.streaming" class="status">{{ t('generating') }}</span>
        <span v-else-if="agent.toolStatus" class="status">{{ agent.toolStatus }}</span>
      </div>
      <div class="titlebar-actions">
        <button class="win-btn" :title="t('minimize')" @click="minimize">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
        <button class="win-btn" :title="t('hide')" @click="hideWindow">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true">
            <path d="M9.5 3.5 2.5 10.5M2.5 3.5 9.5 10.5" />
          </svg>
        </button>
        <button class="win-btn exit" :title="t('exit')" @click="exitApp">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />
          </svg>
        </button>
      </div>
    </header>

    <div class="session-bar">
      <select class="session-select" :value="agent.currentId ?? ''" @change="onSwitchSession">
        <option v-for="s in agent.sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
      </select>
      <button class="ghost-btn" @click="agent.newChat()">{{ t('newChat') }}</button>
      <button class="ghost-btn" @click="agent.clearChat()">{{ t('clear') }}</button>
    </div>

    <div ref="listRef" class="message-list">
      <div v-if="agent.messages.length === 0" class="empty">
        <p class="empty-title">{{ t('agentGreeting') }}</p>
        <p class="empty-hint">{{ t('agentGreetingHint') }}</p>
      </div>

      <template v-for="(m, idx) in agent.messages" :key="m.id">
        <div v-if="m.role === 'tool'" class="tool-line">
          <span class="tool-chip">🔧 {{ m.toolName }}</span>
          <span class="tool-result">{{ m.content }}</span>
        </div>

        <div v-else-if="m.role === 'user'" class="msg user">
          <div class="bubble user-bubble">{{ m.content }}</div>
        </div>

        <div v-else-if="m.role === 'system'" class="summary-line">
          <span class="summary-chip">📝 {{ t('earlySummary') }}</span>
          <span class="summary-text">{{ m.content }}</span>
        </div>

        <div v-else class="msg assistant">
          <div v-if="m.toolCalls && m.toolCalls.length" class="tool-line">
            <span class="tool-chip">🔧 {{ m.toolCalls.map((c) => c.function.name).join(', ') }}</span>
          </div>
          <div
            class="bubble assistant-bubble"
            :class="{ streaming: idx === agent.messages.length - 1 && agent.streaming }"
            v-html="renderMarkdown(m.content)"
          />
        </div>
      </template>

      <div v-if="agent.error" class="error-banner">{{ agent.error }}</div>
    </div>

    <footer class="input-bar">
      <textarea
        v-model="draft"
        class="input-box"
        :placeholder="t('chatPlaceholder')"
        rows="1"
        @keydown.enter.exact.prevent="onSend"
      />
      <button v-if="showStop" class="send-btn stop" @click="agent.stop()">{{ t('stop') }}</button>
      <button v-else class="send-btn" :disabled="!draft.trim() || agent.streaming" @click="onSend">
        {{ t('send') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.agent-chat {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background: var(--bg-color);
  color: var(--text-color);
  user-select: none;
}

/* === 标题栏 === */
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  flex-shrink: 0;
  padding: 0 8px 0 12px;
  background: var(--elevated-bg);
  border-bottom: 1px solid var(--border-color);
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.app-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
}

.status {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.titlebar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.win-btn:hover {
  background: var(--hover-bg);
  color: var(--text-bright);
}

.win-btn.exit:hover {
  background: #e5484d;
  color: #fff;
}

/* === 会话栏 === */
.session-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.session-select {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text-color);
  font-size: 12px;
  outline: none;
}

.ghost-btn {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.ghost-btn:hover {
  background: var(--hover-bg);
  color: var(--text-bright);
}

/* === 消息列表 === */
.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
}

.empty-title {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 6px;
}

.empty-hint {
  font-size: 12px;
  margin: 0;
}

.msg {
  display: flex;
}

.msg.user {
  justify-content: flex-end;
}

.msg.assistant {
  justify-content: flex-start;
}

.bubble {
  max-width: 82%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}

.user-bubble {
  background: var(--accent-bg);
  border: 1px solid var(--accent-border);
  color: var(--text-bright);
  border-bottom-right-radius: 4px;
}

.assistant-bubble {
  background: var(--panel-bg);
  border: 1px solid var(--border-color);
  color: var(--text-color);
  border-bottom-left-radius: 4px;
}

.assistant-bubble.streaming::after {
  content: '▍';
  color: var(--accent-text);
  animation: blink 0.9s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

.tool-line {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 2px 0;
}

.tool-chip {
  font-size: 11px;
  color: var(--accent-text);
  background: var(--accent-bg);
  border: 1px solid var(--accent-border);
  border-radius: 999px;
  padding: 2px 8px;
}

.tool-result {
  font-size: 11px;
  color: var(--text-muted);
  max-width: 90%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: ltr;
  text-align: left;
}

.error-banner {
  padding: 8px 10px;
  border: 1px solid rgba(229, 72, 77, 0.4);
  background: rgba(229, 72, 77, 0.1);
  color: #e5484d;
  border-radius: 8px;
  font-size: 12px;
}

/* === 输入区 === */
.input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--border-color);
  background: var(--elevated-bg);
}

.input-box {
  flex: 1;
  min-height: 36px;
  max-height: 96px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--text-color);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
  outline: none;
  overflow-y: auto;
}

.input-box:focus {
  border-color: var(--accent-border);
}

.send-btn {
  height: 36px;
  padding: 0 16px;
  border: none;
  border-radius: 8px;
  background: var(--accent-color);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-btn.stop {
  background: #e5484d;
}

/* === 渲染内容 === */
:deep(.assistant-bubble p) {
  margin: 0 0 6px;
}

:deep(.assistant-bubble p:last-child) {
  margin-bottom: 0;
}

:deep(.assistant-bubble h4) {
  margin: 8px 0 4px;
  font-size: 14px;
  color: var(--text-bright);
}

:deep(.assistant-bubble strong) {
  color: var(--text-bright);
}

:deep(.inline-code) {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 0 4px;
}

:deep(.code-wrap) {
  position: relative;
  margin: 6px 0;
}

:deep(.code-lang) {
  position: absolute;
  top: 4px;
  right: 8px;
  font-size: 10px;
  color: var(--text-muted);
}

:deep(.code-block) {
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
}

/* === 摘要提示 === */
.summary-line {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0;
  padding: 6px 10px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: var(--input-bg);
}

.summary-chip {
  font-size: 11px;
  color: var(--text-secondary);
}

.summary-text {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* 滚动条 */
.message-list::-webkit-scrollbar,
.input-box::-webkit-scrollbar {
  width: 8px;
}

.message-list::-webkit-scrollbar-thumb,
.input-box::-webkit-scrollbar-thumb {
  background: var(--scrollbar-color);
  border-radius: 4px;
}
</style>