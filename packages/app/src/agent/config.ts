import { invoke } from '@tauri-apps/api/core'
import type { AgentConfig } from './types'

export interface AgentConfigInput {
  apiKey?: string
  baseUrl?: string
  model?: string
  systemPrompt?: string
  toolEnabled?: boolean
  contextBudget?: number
  maxAgentRounds?: number
  planMode?: boolean
  execEnabled?: boolean
}

export async function loadConfig(): Promise<AgentConfig> {
  return invoke<AgentConfig>('agent_get_config')
}

export async function saveConfig(input: AgentConfigInput): Promise<AgentConfig> {
  return invoke<AgentConfig>('agent_save_config', { input })
}