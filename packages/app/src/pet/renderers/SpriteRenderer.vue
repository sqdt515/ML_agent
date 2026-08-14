<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import type { SpriteConfig } from '@/types'

const props = defineProps<{
  src: string
  sprite: SpriteConfig
  loop: boolean
  duration?: number
}>()

const canvasRef = ref<HTMLCanvasElement | undefined>()
let image: HTMLImageElement | null = null
let currentFrame = 0
let rafId: number | null = null
let lastFrameTime = 0
// 加载代际，防止快速切换 src 时旧图覆盖新图
let loadGeneration = 0

function stop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function drawFrame() {
  const canvas = canvasRef.value
  if (!canvas || !image) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const { startFrame = 0, columns, frameWidth, frameHeight } = props.sprite
  const absFrame = startFrame + currentFrame
  const col = absFrame % columns
  const row = Math.floor(absFrame / columns)

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(
    image,
    col * frameWidth,
    row * frameHeight,
    frameWidth,
    frameHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  )
}

function tick(timestamp: number) {
  const interval = 1000 / props.sprite.fps
  if (timestamp - lastFrameTime >= interval) {
    lastFrameTime = timestamp - ((timestamp - lastFrameTime) % interval)

    if (currentFrame >= props.sprite.frameCount - 1) {
      if (props.loop) {
        currentFrame = 0
      } else {
        rafId = null
        return
      }
    } else {
      currentFrame++
    }
    drawFrame()
  }
  rafId = requestAnimationFrame(tick)
}

function startAnim() {
  stop()
  currentFrame = 0
  lastFrameTime = 0
  drawFrame()
  if (document.visibilityState === 'visible') {
    rafId = requestAnimationFrame(tick)
  }
}

function loadImage(src: string) {
  stop()
  const gen = ++loadGeneration
  const img = new Image()
  img.onload = () => {
    if (gen !== loadGeneration) return
    image = img
    startAnim()
  }
  img.onerror = () => {
    if (gen !== loadGeneration) return
    console.error('Failed to load sprite:', src)
  }
  img.src = src
}

// 切换图片源时重新加载
watch(
  () => props.src,
  (newSrc) => loadImage(newSrc),
)

// 切换 sprite 配置（同图不同帧参数）时重启动画
watch(
  () => props.sprite,
  () => {
    if (image) startAnim()
  },
)

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    if (image && rafId === null) startAnim()
  } else {
    stop()
  }
}

onMounted(() => {
  loadImage(props.src)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  stop()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <canvas
    ref="canvasRef"
    :width="sprite.frameWidth"
    :height="sprite.frameHeight"
    class="sprite-renderer"
  ></canvas>
</template>

<style scoped>
.sprite-renderer {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
</style>
