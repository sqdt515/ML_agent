import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MovementState } from '@/types'

export const usePetStore = defineStore('pet', () => {
  // 当前移动状态，默认待机
  const movementState = ref<MovementState>('idle')
  // 是否正在被拖拽
  const isDragging = ref(false)

  function setMovement(state: MovementState) {
    movementState.value = state
  }

  function setDragging(value: boolean) {
    isDragging.value = value
  }

  return {
    movementState,
    isDragging,
    setMovement,
    setDragging,
  }
})
