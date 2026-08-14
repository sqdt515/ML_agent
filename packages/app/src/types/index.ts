// === 移动状态 ===

export type MovementState = 'idle' | 'walk' | 'run' | 'sprint'

// === 动画格式 ===

export type AnimationFormat = 'sprite' | 'image'

// === 皮肤系统 ===

/** 精灵图帧配置 */
export interface SpriteConfig {
  frameWidth: number
  frameHeight: number
  frameCount: number
  columns: number
  fps: number
  startFrame?: number
}

/** 单个动画配置 */
export interface SkinAnimationConfig {
  file: string
  loop: boolean
  duration?: number
  sprite?: SpriteConfig
}

/** 皮肤清单 */
export interface SkinManifest {
  id: string
  name: string
  author: string
  format: AnimationFormat
  size: { width: number; height: number }
  animations: Partial<Record<MovementState, SkinAnimationConfig>>
}
