import { ref, watch, onUnmounted, toValue, type MaybeRefOrGetter } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { isTauri } from '@/utils/env'

const DEBOUNCE_MS = 100

/**
 * 根据传入的宽高设置 pet 窗口大小，带防抖。
 * 宽高可以是数值、ref 或 getter，便于直接传入 computed。
 */
export function useWindowSize(
  width: MaybeRefOrGetter<number>,
  height: MaybeRefOrGetter<number>,
) {
  const appliedWidth = ref(0)
  const appliedHeight = ref(0)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function applySize(w: number, h: number) {
    if (w === appliedWidth.value && h === appliedHeight.value) return
    appliedWidth.value = w
    appliedHeight.value = h
    if (isTauri) {
      getCurrentWindow()
        .setSize(new LogicalSize(w, h))
        .catch((e) => {
          console.error('useWindowSize: setSize failed', e)
        })
    }
  }

  watch(
    () => [toValue(width), toValue(height)] as const,
    ([w, h]) => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => applySize(w, h), DEBOUNCE_MS)
    },
    { immediate: true },
  )

  onUnmounted(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })

  return { appliedWidth, appliedHeight }
}
