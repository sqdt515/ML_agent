import { ref, onUnmounted, type Ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { usePetStore } from '@/stores/pet'
import { isTauri } from '@/utils/env'

const DRAG_DELAY_MS = 150

/**
 * 桌面宠物拖拽与点击交互。
 * - 按住超过 150ms：进入拖拽模式，调用原生 startDragging()
 * - 150ms 内松开：视为点击，触发 onClick 回调
 * @param target 宠物根元素，用于判定点击是否落在宠物上
 * @param onClick 单击回调
 */
export function usePetInteraction(
  target: Ref<HTMLElement | null | undefined>,
  onClick?: () => void,
) {
  const petStore = usePetStore()

  const isDragging = ref(false)
  let dragTimer: ReturnType<typeof setTimeout> | null = null
  let isClick = true

  function clearDragTimer() {
    if (dragTimer) {
      clearTimeout(dragTimer)
      dragTimer = null
    }
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    isClick = true
    clearDragTimer()

    dragTimer = setTimeout(async () => {
      // 超过阈值，进入拖拽
      isClick = false
      isDragging.value = true
      petStore.setDragging(true)
      if (isTauri) {
        try {
          await getCurrentWindow().startDragging()
        } catch (err) {
          console.error('startDragging failed:', err)
        } finally {
          isDragging.value = false
          petStore.setDragging(false)
        }
      } else {
        // 浏览器预览环境：无原生拖拽，仅重置状态（松开时由 onMouseUp 处理）
        isDragging.value = false
        petStore.setDragging(false)
      }
    }, DRAG_DELAY_MS)
  }

  function onMouseUp(e: MouseEvent) {
    clearDragTimer()
    if (isClick) {
      const root = target.value
      // 仅当松开位置仍在宠物元素上时视为点击
      if (root && e.target instanceof Node && root.contains(e.target)) {
        onClick?.()
      }
    }
    isClick = false
  }

  onUnmounted(() => {
    clearDragTimer()
  })

  return { isDragging, onMouseDown, onMouseUp }
}
