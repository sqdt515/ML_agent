// 极简 Markdown 渲染：先转义 HTML，再应用少量安全变换，避免 XSS。
// 围栏代码块先提取为占位符，避免代码体被行内/段落/标题变换破坏。
export function renderMarkdown(src: string): string {
  if (!src) return ''

  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 1. 提取围栏代码块，原位替换为占位符（控制符可安全穿过转义与其余变换）
  const blocks: string[] = []
  let html = src.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code)
    return `\x00${blocks.length - 1}\x00`
  })

  html = escapeHtml(html)

  // 2. 行内代码 / 加粗 / 标题 / 段落（只作用于围栏块外的文本）
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  html = html.replace(/^### (.*)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.*)$/gm, '<h4>$1</h4>')
  html = html.replace(/^# (.*)$/gm, '<h4>$1</h4>')

  // 段落与换行
  html = html
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('')

  // 3. 还原代码块：块体只做 HTML 转义，不经任何 Markdown 变换
  html = html.replace(/\x00(\d+)\x00/g, (_m, idx: string) => {
    const code = blocks[Number(idx)] ?? ''
    const langMatch = code.match(/^([a-zA-Z0-9_+-]*)\n?/)
    const lang = langMatch?.[1] ?? ''
    const body = escapeHtml(code.slice(langMatch?.[0].length ?? 0).replace(/\n$/, ''))
    const langTag = lang ? `<span class="code-lang">${lang}</span>` : ''
    return `<div class="code-wrap">${langTag}<pre class="code-block"><code>${body}</code></pre></div>`
  })

  return html
}
