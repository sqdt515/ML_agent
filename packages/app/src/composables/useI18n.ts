import { ref, computed } from 'vue'
import type { Locale, Messages } from '@/i18n'
import { messages, getLocale, setLocale as persistLocale } from '@/i18n'

// 模块级当前语言状态，跨组件共享
export const currentLocale = ref<Locale>(getLocale())

// 监听其他标签页的语言变更，保持同步
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'new-ai-locale' && (e.newValue === 'zh' || e.newValue === 'en')) {
      currentLocale.value = e.newValue
    }
  })
}

export type MessageKey = keyof Messages

export function useI18n() {
  const locale = currentLocale

  // 切换语言并持久化
  function setLang(l: Locale) {
    locale.value = l
    persistLocale(l)
  }

  // 根据当前语言返回对应文案，缺失时回退到中文，再回退到 key 本身
  function t(key: MessageKey): string {
    return messages[locale.value][key] ?? messages.zh[key] ?? (key as string)
  }

  // 是否为中文
  const isZh = computed(() => locale.value === 'zh')

  return { locale, setLang, t, isZh }
}
