// 测试用 mock：替代 @tauri-apps/api/core（store/config/engine 均 import 它）
export async function invoke<T>(_cmd: string, _args?: unknown): Promise<T> {
  return undefined as unknown as T
}
export class Channel<T> {
  onmessage: ((msg: T) => void) | null = null
}
