<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { SkinManifest } from '@/types'
import PetRenderer from '@/pet/PetRenderer.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import AgentChat from '@/components/AgentChat.vue'
import { usePetStore } from '@/stores/pet'
import { useSettingsStore } from '@/stores/settings'
import { usePetInteraction } from '@/composables/usePetInteraction'
import { useWindowSize } from '@/composables/useWindowSize'
import { usePreferredDark } from '@vueuse/core'
import { isTauri } from '@/utils/env'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useI18n } from '@/composables/useI18n'

// 浏览器环境无 __TAURI_INTERNALS__，getCurrentWindow() 会抛错，用 isTauri 守卫
const currentWindow = isTauri ? getCurrentWindow() : null
const isSettingsWindow = currentWindow?.label === 'social'
const isAgentWindow = currentWindow?.label === 'agent'
const { t } = useI18n()

const petStore = usePetStore()
const settings = useSettingsStore()
const systemPrefersDark = usePreferredDark()
const petAppRef = ref<HTMLElement | null>(null)
const manifest = ref<SkinManifest | null>(null)

// 主题类名：light 模式或 system 模式下系统非深色时，添加 theme-light
const themeClass = computed(() => {
  if (settings.theme === 'light') return 'theme-light'
  if (settings.theme === 'system' && !systemPrefersDark.value) return 'theme-light'
  return ''
})

// 窗口尺寸跟随皮肤尺寸；manifest 未加载前给一个默认值
const SETTINGS_BTN_SIZE = 20
const SETTINGS_BTN_GAP = 6
const windowWidth = computed(() => (manifest.value?.size.width ?? 120) + SETTINGS_BTN_GAP + SETTINGS_BTN_SIZE)
const windowHeight = computed(() => Math.max(manifest.value?.size.height ?? 120, SETTINGS_BTN_SIZE))

// 拖拽与点击交互（social 窗口使用空函数占位，避免调用 pet 专属 composable）
const { onMouseDown, onMouseUp } = isSettingsWindow
  ? { onMouseDown: (_: MouseEvent) => {}, onMouseUp: (_: MouseEvent) => {} }
  : usePetInteraction(petAppRef)
async function openSettings() {
  if (!isTauri) return
  try {
    const settingsWindow = await WebviewWindow.getByLabel('social')
    if (!settingsWindow) {
      console.warn('settings window (social) not found')
      return
    }
    await settingsWindow.show()
    if (await settingsWindow.isMinimized()) {
      await settingsWindow.unminimize()
    }
    await settingsWindow.setFocus()
  } catch (err) {
    console.error('openSettings failed:', err)
  }
}

async function openAgent() {
  if (!isTauri) return
  try {
    const agentWindow = await WebviewWindow.getByLabel('agent')
    if (!agentWindow) {
      console.warn('agent window (agent) not found')
      return
    }
    await agentWindow.show()
    if (await agentWindow.isMinimized()) {
      await agentWindow.unminimize()
    }
    await agentWindow.setFocus()
  } catch (err) {
    console.error('openAgent failed:', err)
  }
}

if (isSettingsWindow && currentWindow) {
  // social 窗口：关闭时隐藏而非销毁
  onMounted(() => {
    currentWindow.onCloseRequested(async (event) => {
      event.preventDefault()
      await currentWindow.hide()
    })
  })
} else if (!isAgentWindow) {
  // pet 窗口专属：动态调整窗口大小（agent 窗口尺寸由 tauri.conf.json 控制，不在此 resize）
  useWindowSize(windowWidth, windowHeight)

  // 加载皮肤清单
  onMounted(async () => {
    try {
      const res = await fetch('/skins/default/skin.json')
      if (!res.ok) {
        console.warn('skin.json response not ok:', res.status)
        return
      }
      manifest.value = (await res.json()) as SkinManifest
    } catch (err) {
      console.error('Failed to load skin manifest:', err)
    }
  })
}
</script>

<template>
  <!-- 设置窗口（social） -->
  <div v-if="isSettingsWindow" class="settings-window" :class="themeClass">
    <SettingsPanel />
  </div>

  <!-- Agent 窗口（agent） -->
  <div v-else-if="isAgentWindow" class="agent-window" :class="themeClass">
    <AgentChat />
  </div>

  <!-- 宠物窗口（pet） -->
  <div
    v-else
    class="pet-app"
    :class="themeClass"
    ref="petAppRef"
    @mousedown="onMouseDown"
    @mouseup="onMouseUp"
    @dblclick.stop="openAgent"
  >
    <PetRenderer
      v-if="manifest"
      :manifest="manifest"
      :state="petStore.movementState"
    />    <button
      type="button"
      class="settings-btn"
      :title="t('settings')"
      :aria-label="t('settings')"
      @mousedown.stop
      @click.stop="openSettings"
      @dblclick.stop
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.pet-app {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100vw;
  height: 100vh;
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0.75;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.settings-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.16);
  color: var(--text-bright);
}

.settings-window {
  width: 100vw;
  height: 100vh;
}

.agent-window {
  width: 100vw;
  height: 100vh;
}
</style>
