import { describe, expect, it } from 'vitest'
import { PROVIDER_PRESETS, findPresetByBaseUrl, isReasonerModel } from './types'

describe('PROVIDER_PRESETS', () => {
  it('至少 6 个预设且 baseUrl 唯一', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(new Set(PROVIDER_PRESETS.map((p) => p.baseUrl)).size).toBe(PROVIDER_PRESETS.length)
  })

  it('包含主流供应商', () => {
    for (const id of ['deepseek', 'openai', 'moonshot', 'qwen', 'glm', 'ollama']) {
      expect(PROVIDER_PRESETS.some((p) => p.id === id), id).toBe(true)
    }
  })

  it('每个预设至少 1 个模型', () => {
    expect(PROVIDER_PRESETS.every((p) => p.models.length >= 1)).toBe(true)
  })

  it('deepseek 预设含带 reasoning 标记的 reasoner 模型', () => {
    const deepseek = PROVIDER_PRESETS.find((p) => p.id === 'deepseek')!
    expect(deepseek.models.some((m) => m.id === 'deepseek-reasoner' && m.reasoning)).toBe(true)
  })
})

describe('isReasonerModel', () => {
  it('识别推理模型', () => {
    expect(isReasonerModel('deepseek-reasoner')).toBe(true)
    expect(isReasonerModel('o1')).toBe(true)
    expect(isReasonerModel('o3-mini')).toBe(true)
    expect(isReasonerModel('deepseek-r1')).toBe(true)
  })

  it('非推理模型返回 false', () => {
    expect(isReasonerModel('deepseek-chat')).toBe(false)
    expect(isReasonerModel('gpt-4o')).toBe(false)
  })
})

describe('findPresetByBaseUrl', () => {
  it('按 baseUrl 匹配预设', () => {
    expect(findPresetByBaseUrl('https://api.deepseek.com')?.id).toBe('deepseek')
  })

  it('尾斜杠归一化', () => {
    expect(findPresetByBaseUrl('https://api.deepseek.com/')?.id).toBe('deepseek')
  })

  it('未知地址返回 undefined', () => {
    expect(findPresetByBaseUrl('https://example.com/v1')).toBeUndefined()
  })
})
