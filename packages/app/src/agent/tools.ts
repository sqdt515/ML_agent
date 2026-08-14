import { invoke } from '@tauri-apps/api/core'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  executor: (args: Record<string, unknown>) => Promise<string>
}

async function invokeTool<T>(cmd: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    const res = await invoke<T>(cmd, args)
    return JSON.stringify(res ?? { ok: true })
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) })
  }
}

const emptyParams = { type: 'object', properties: {}, additionalProperties: false }

export const agentTools: AgentTool[] = [
  {
    name: 'pet_show',
    description: '显示桌面宠物窗口',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_pet_show'),
  },
  {
    name: 'pet_hide',
    description: '隐藏桌面宠物窗口',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_pet_hide'),
  },
  {
    name: 'open_url',
    description: '在系统默认浏览器中打开一个 http/https 链接',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的完整 URL' } },
      required: ['url'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_open_url', { url: String(args.url ?? '') }),
  },
  {
    name: 'system_info',
    description: '获取当前系统信息（操作系统、主机名、CPU、内存、运行时长）',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_system_info'),
  },
  {
    name: 'get_time',
    description: '获取当前日期时间（本地时间、UTC 与时区偏移）',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_get_time'),
  },
  {
    name: 'note_create',
    description: '创建一条本地便签',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '便签内容' } },
      required: ['text'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_note_create', { text: String(args.text ?? '') }),
  },
  {
    name: 'note_list',
    description: '列出所有本地便签',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_note_list'),
  },
]

export function toolsToPayload(tools: AgentTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export function findTool(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.name === name)
}