import { zh } from './zh'
import { en } from './en'

export type Locale = 'zh' | 'en'
// Messages 类型由 zh 字典的 key 派生，值放宽为 string，
// 使 en 字典（as const 字面量）也能赋值给 Record<Locale, Messages>
export type Messages = { readonly [K in keyof typeof zh]: string }

// localStorage 存储 key
const LOCALE_KEY = 'new-ai-locale'

// 所有语言文案集合
export const messages: Record<Locale, Messages> = {
  zh,
  en,
}

// 根据 navigator.language 判断默认语言
export function detectLocale(): Locale {
  try {
    const nav = navigator.language || ''
    if (nav.startsWith('zh')) return 'zh'
  } catch {
    /* noop */
  }
  return 'en'
}

// 从 localStorage 读取当前语言，无记录时回退到系统语言
export function getLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    /* noop */
  }
  return detectLocale()
}

// 将语言写入 localStorage
export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    /* noop */
  }
}

export { zh, en }
