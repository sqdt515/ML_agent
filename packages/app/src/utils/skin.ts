import type { SkinManifest, MovementState, SkinAnimationConfig } from '@/types'

/**
 * 解析指定状态对应的动画配置。
 * 优先取目标状态；若该状态没有配置，则回退到 idle；idle 也不存在时返回 undefined。
 */
export function resolveAnimation(
  manifest: SkinManifest,
  state: MovementState,
): SkinAnimationConfig | undefined {
  return manifest.animations[state] ?? manifest.animations.idle
}
