<script setup lang="ts">
import { computed } from 'vue'
import type { SkinManifest, MovementState } from '@/types'
import { resolveAnimation } from '@/utils/skin'
import SpriteRenderer from './renderers/SpriteRenderer.vue'

const props = defineProps<{
  manifest: SkinManifest
  state: MovementState
}>()

// 解析当前状态对应的动画，缺失时回退到 idle
const animation = computed(() => resolveAnimation(props.manifest, props.state))

// 皮肤资源 URL：约定为 /skins/{id}/{file}
const src = computed(() => {
  const file = animation.value?.file
  return file ? `/skins/${props.manifest.id}/${file}` : ''
})

const rendererStyle = computed(() => ({
  width: `${props.manifest.size.width}px`,
  height: `${props.manifest.size.height}px`,
}))
</script>

<template>
  <div class="pet-canvas">
    <div class="pet-renderer" :style="rendererStyle">
      <SpriteRenderer
        v-if="animation && animation.sprite"
        :src="src"
        :sprite="animation.sprite"
        :loop="animation.loop"
        :duration="animation.duration"
      />
    </div>
  </div>
</template>

<style scoped>
.pet-canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.pet-renderer {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
