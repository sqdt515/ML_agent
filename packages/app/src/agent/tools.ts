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
    description: '为当前任务创建分步执行计划。任何需要调用多个工具或包含多个步骤的任务，都必须先调用本工具制定计划，等待用户确认后再执行其他工具。',
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
  {
    name: 'fs_list',
    description: '列出指定目录下的文件和子目录（只读，目录优先排序，最多 200 项）',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: '要列出的目录路径' } },
      required: ['dir'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_fs_list', { dir: String(args.dir ?? '') }),
  },
  {
    name: 'fs_read',
    description: '读取一个文本文件的内容（只读，仅支持 ≤1MB 的 UTF-8 文本文件）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要读取的文件完整路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_fs_read', { path: String(args.path ?? '') }),
  },
  {
    name: 'notify',
    description: '发送一条系统桌面通知',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '通知内容' } },
      required: ['text'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_notify', { text: String(args.text ?? '') }),
  },
  {
    name: 'clipboard_read',
    description: '读取系统剪贴板中的文本内容',
    parameters: emptyParams,
    executor: async () => invokeTool('agent_tool_clipboard_read'),
  },
  {
    name: 'clipboard_write',
    description: '将文本写入系统剪贴板',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要写入剪贴板的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_clipboard_write', { text: String(args.text ?? '') }),
  },
  {
    name: 'fs_write',
    description: '将文本内容写入应用专属工作目录下的一个文件（路径相对工作目录，或工作目录内的绝对路径）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作目录）' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_fs_write', { path: String(args.path ?? ''), content: String(args.content ?? '') }),
  },
  {
    name: 'fs_delete',
    description: '删除应用专属工作目录下的一个文件（仅文件，不删除目录）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要删除的文件路径（相对工作目录）' } },
      required: ['path'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_fs_delete', { path: String(args.path ?? '') }),
  },
  {
    name: 'exec',
    description: '在系统命令行中执行一条命令（Windows cmd），返回退出码、stdout、stderr；最长执行 30 秒',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string', description: '要执行的命令' } },
      required: ['cmd'],
      additionalProperties: false,
    },
    executor: async (args) => invokeTool('agent_tool_exec', { cmd: String(args.cmd ?? '') }),
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