<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useSettingsStore } from '@/stores/settings'
import { loadConfig, saveConfig } from '@/agent/config'
import { isTauri } from '@/utils/env'
import type { Locale } from '@/i18n'
import type { ThemeMode } from '@/stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()

// 语言选项
const localeOptions: { value: Locale; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

// 主题选项
const themeOptions: { value: ThemeMode; key: 'dark' | 'light' | 'system' }[] = [
  { value: 'dark', key: 'dark' },
  { value: 'light', key: 'light' },
  { value: 'system', key: 'system' },
]

// === Agent 配置 ===
const apiKey = ref('')
const apiKeySet = ref(false)
const apiKeyLast4 = ref('')
const baseUrl = ref('https://api.deepseek.com')
const model = ref('deepseek-chat')
const systemPrompt = ref('')
const toolEnabled = ref(true)
const contextBudget = ref(24000)
const maxAgentRounds = ref(20)
const planMode = ref(true)
const execEnabled = ref(false)
const saving = ref(false)
const savedHint = ref(false)

const modelOptions = ['deepseek-chat', 'deepseek-reasoner']
const apiKeyPlaceholder = computed(() =>
  apiKeySet.value ? `sk-...（已配置 ****${apiKeyLast4.value}，留空不修改）` : 'sk-...',
)

function selectLocale(l: Locale) {
  settings.setLocale(l)
}

function selectTheme(theme: ThemeMode) {
  settings.setTheme(theme)
}

async function loadAgentConfig() {
  if (!isTauri) return
  try {
    const cfg = await loadConfig()
    apiKeySet.value = cfg.apiKeySet
    apiKeyLast4.value = cfg.apiKeyLast4
    baseUrl.value = cfg.baseUrl
    model.value = cfg.model
    systemPrompt.value = cfg.systemPrompt
    toolEnabled.value = cfg.toolEnabled
    contextBudget.value = cfg.contextBudget
    maxAgentRounds.value = cfg.maxAgentRounds
    planMode.value = cfg.planMode
    execEnabled.value = cfg.execEnabled
  } catch {
    /* noop */
  }
}

async function saveAgentConfig() {
  if (!isTauri) return
  saving.value = true
  savedHint.value = false
  try {
    const cfg = await saveConfig({
      apiKey: apiKey.value.trim() || undefined,
      baseUrl: baseUrl.value.trim() || undefined,
      model: model.value,
      systemPrompt: systemPrompt.value,
      toolEnabled: toolEnabled.value,
      contextBudget: contextBudget.value,
      maxAgentRounds: maxAgentRounds.value,
      planMode: planMode.value,
      execEnabled: execEnabled.value,
    })
    apiKey.value = ''
    apiKeySet.value = cfg.apiKeySet
    apiKeyLast4.value = cfg.apiKeyLast4
    savedHint.value = true
    setTimeout(() => {
      savedHint.value = false
    }, 2000)
  } catch {
    /* noop */
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void loadAgentConfig()
})
</script>

<template>
  <div class="settings-panel">
    <div class="settings-header">
      <span class="settings-title">{{ t('settings') }}</span>
    </div>

    <div class="settings-section">
      <div class="section-label">{{ t('language') }}</div>
      <div class="btn-group">
        <button
          v-for="opt in localeOptions"
          :key="opt.value"
          class="seg-btn"
          :class="{ active: settings.locale === opt.value }"
          @click="selectLocale(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-label">{{ t('theme') }}</div>
      <div class="btn-group">
        <button
          v-for="opt in themeOptions"
          :key="opt.value"
          class="seg-btn"
          :class="{ active: settings.theme === opt.value }"
          @click="selectTheme(opt.value)"
        >
          {{ t(opt.key) }}
        </button>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-label">{{ t('agentSection') }}</div>
      <div class="form">
        <label class="field">
          <span class="field-label">{{ t('apiKey') }}</span>
          <input
            v-model="apiKey"
            type="password"
            class="text-input"
            :placeholder="apiKeyPlaceholder"
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('baseUrl') }}</span>
          <input v-model="baseUrl" type="text" class="text-input" spellcheck="false" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('model') }}</span>
          <select v-model="model" class="text-input select">
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">{{ t('systemPrompt') }}</span>
          <textarea
            v-model="systemPrompt"
            class="text-input area"
            rows="3"
            spellcheck="false"
          />
        </label>

        <div class="field row">
          <span class="field-label">{{ t('toolEnabled') }}</span>
          <label class="switch">
            <input v-model="toolEnabled" type="checkbox" />
            <span class="slider"></span>
          </label>
        </div>

        <label class="field">
          <span class="field-label">{{ t('contextBudget') }}</span>
          <input
            v-model.number="contextBudget"
            type="number"
            min="4000"
            max="60000"
            step="1000"
            class="text-input"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('maxAgentRounds') }}</span>
          <input
            v-model.number="maxAgentRounds"
            type="number"
            min="1"
            max="100"
            step="1"
            class="text-input"
          />
        </label>

        <div class="field row">
          <span class="field-label">{{ t('planMode') }}</span>
          <label class="switch">
            <input v-model="planMode" type="checkbox" />
            <span class="slider"></span>
          </label>
        </div>

        <div class="field row">
          <span class="field-label">{{ t('execEnabled') }}</span>
          <label class="switch">
            <input v-model="execEnabled" type="checkbox" />
            <span class="slider"></span>
          </label>
        </div>
        <p v-if="execEnabled" style="color:#d97706;font-size:12px;margin:2px 0 10px;">{{ t('execEnabledWarning') }}</p>

        <div class="form-actions">
          <button class="save-btn" :disabled="saving" @click="saveAgentConfig">
            {{ saving ? t('saving') : t('save') }}
          </button>
          <span v-if="savedHint" class="saved-hint">{{ t('saved') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--panel-bg);
  color: var(--text-color);
  user-select: none;
  overflow-y: auto;
}

.settings-header {
  margin-bottom: 10px;
}

.settings-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-bright);
}

.settings-section {
  margin-top: 10px;
}

.settings-section:first-of-type {
  margin-top: 0;
}

.section-label {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.btn-group {
  display: flex;
  gap: 4px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 3px;
}

.seg-btn {
  flex: 1;
  padding: 5px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}

.seg-btn:hover {
  color: var(--text-bright);
}

.seg-btn.active {
  background: var(--accent-bg);
  color: var(--accent-text);
  border: 1px solid var(--accent-border);
}

/* === Agent 表单 === */
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field.row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.field-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text-color);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.text-input:focus {
  border-color: var(--accent-border);
}

.text-input.select {
  height: 30px;
}

.text-input.area {
  resize: vertical;
  min-height: 56px;
}

.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  transition: background 0.2s;
  cursor: pointer;
}

.slider::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  left: 2px;
  top: 2px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: transform 0.2s, background 0.2s;
}

.switch input:checked + .slider {
  background: var(--accent-bg);
  border-color: var(--accent-border);
}

.switch input:checked + .slider::before {
  transform: translateX(16px);
  background: var(--accent-text);
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.save-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: var(--accent-color);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.saved-hint {
  font-size: 11px;
  color: var(--accent-text);
}
</style>