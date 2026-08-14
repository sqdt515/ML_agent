// 极简 Markdown 渲染：先转义 HTML，再应用少量安全变换，避免 XSS
export function renderMarkdown(src: string): string {
  if (!src) return ''

  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  let html = escapeHtml(src)

  // 围栏代码块
  html = html.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    const langMatch = code.match(/^([a-zA-Z0-9_+-]*)\n?/)
    const lang = langMatch?.[1] ?? ''
    const body = code.slice(langMatch?.[0].length ?? 0).replace(/\n$/, '')
    const label = lang ? ` class="code-lang">${lang}</span>` : ''
    return `<div class="code-wrap"><span${label}<pre class="code-block"><code>${body}</code></pre></div>`
  })

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')

  // 加粗
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // 标题
  html = html.replace(/^### (.*)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.*)$/gm, '<h4>$1</h4>')
  html = html.replace(/^# (.*)$/gm, '<h4>$1</h4>')

  // 段落与换行
  html = html
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('')

  return html
}