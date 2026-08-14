import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { Locale } from '@/i18n'
import { getLocale } from '@/i18n'
import { currentLocale, useI18n } from '@/composables/useI18n'

export type ThemeMode = 'dark' | 'light' | 'system'

const THEME_KEY = 'new-ai-theme'

// 从 localStorage 读取主题，默认深色
function loadTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw
  } catch {
    /* noop */
  }
  return 'dark'
}

// 判断系统当前是否偏好浅色
function systemPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

// 根据主题模式在 documentElement 上增删 theme-light 类
function applyThemeClass(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const shouldLight = theme === 'light' || (theme === 'system' && systemPrefersLight())
  if (shouldLight) {
    root.classList.add('theme-light')
  } else {
    root.classList.remove('theme-light')
  }
}

export const useSettingsStore = defineStore('settings', () => {
  // 语言：与 useI18n 共享同一 localStorage key，初始值一致
  const locale = ref<Locale>(getLocale())
  const theme = ref<ThemeMode>(loadTheme())

  // 初始化时应用主题类
  applyThemeClass(theme.value)

  // 监听系统主题变化，system 模式下实时切换
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      if (theme.value === 'system') applyThemeClass('system')
    }
    // 兼容旧版 Safari 的 addListener
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
    } else if (typeof (mql as unknown as { addListener?: (cb: (e: unknown) => void) => void }).addListener === 'function') {
      ;(mql as unknown as { addListener: (cb: (e: unknown) => void) => void }).addListener(onChange)
    }
  }

  // 外部通过 useI18n.setLang 改语言时，同步回 store.locale
  watch(currentLocale, (l) => {
    if (l !== locale.value) locale.value = l
  })

  // 切换语言：更新 store 并同步到 useI18n（会写 localStorage 并更新 currentLocale）
  function setLocale(l: Locale) {
    locale.value = l
    useI18n().setLang(l)
  }

  // 切换主题：更新 store、写 localStorage、应用 DOM 类
  function setTheme(t: ThemeMode) {
    theme.value = t
    try {
      localStorage.setItem(THEME_KEY, t)
    } catch {
      /* noop */
    }
    applyThemeClass(t)
  }

  return {
    locale,
    theme,
    setLocale,
    setTheme,
  }
})
