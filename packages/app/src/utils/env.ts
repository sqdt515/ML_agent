// 判断当前是否运行在 Tauri 容器内（纯浏览器预览时为 false）
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
