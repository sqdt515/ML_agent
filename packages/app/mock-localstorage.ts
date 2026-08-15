// 测试用 mock：在 store 模块加载前注入 localStorage
const mem: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v) },
  removeItem: (k: string) => { delete mem[k] },
}
