import { invoke } from '@tauri-apps/api/core'

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  executor: (args: Record<string, unknown>) => Promise<string>
}

/** 元工具：只定义 schema，执行由 store 拦截（更新 plan 状态，不发到 Rust） */
export interface MetaTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const metaTools: MetaTool[] = [
  {
    name: 'create_plan',
    description: '为当前任务创建一个分步执行计划。接到需要多步完成的任务时，应先调用本工具产出计划。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务目标的简短描述' },
        steps: {
          type: 'array',
          description: '有序的执行步骤列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '步骤唯一标识' },
              title: { type: 'string', description: '步骤描述' },
            },
            required: ['id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_step',
    description: '更新执行计划中某一步的状态（进行中/已完成/受阻）。',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: '步骤 id' },
        status: { type: 'string', enum: ['in_progress', 'completed', 'blocked'], description: '新状态' },
        note: { type: 'string', description: '可选备注，如受阻原因' },
      },
      required: ['step_id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: '宣布任务全部完成，附上简洁总结。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '完成总结' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]

export function isMetaTool(name: string): boolean {
  return metaTools.some((t) => t.name === name)
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
  const schemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [
    ...tools,
    ...metaTools,
  ]
  return schemas.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export function findTool(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.name === name)
}