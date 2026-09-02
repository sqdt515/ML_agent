import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown 围栏代码块', () => {
  it('带语言标签：生成 code-lang 与 code-block 结构', () => {
    const html = renderMarkdown('```python\nprint(1)\n```')
    expect(html).toContain('<span class="code-lang">python</span>')
    expect(html).toContain('<pre class="code-block"><code>print(1)</code></pre>')
  })

  it('无语言标签：不产生畸形标签，结构完整', () => {
    const html = renderMarkdown('```\ncode\n```')
    expect(html).toContain('<pre class="code-block"><code>code</code></pre>')
    expect(html).not.toContain('<span<')
  })

  it('代码体内的注释、加粗、空行、缩进逐字保留', () => {
    const code = '# 这是注释\n**不是加粗**\n\nif x:\n    return `y`'
    const html = renderMarkdown('```\n' + code + '\n```')
    expect(html).toContain('# 这是注释')
    expect(html).toContain('**不是加粗**')
    expect(html).toContain('    return `y`')
    expect(html).not.toContain('<h4>')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('inline-code')
  })

  it('代码块内的新行不被拆散为多个段落', () => {
    const html = renderMarkdown('```\nline1\n\nline2\n```')
    expect((html.match(/code-block/g) ?? []).length).toBe(1)
    expect(html).toContain('line1\n\nline2')
  })

  it('XSS 输入在代码块内被转义', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('围栏块外的行内代码与加粗仍生效', () => {
    const html = renderMarkdown('前 `x` 后 **粗**\n\n```\ncode\n```')
    expect(html).toContain('<code class="inline-code">x</code>')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<pre class="code-block"><code>code</code></pre>')
  })
})
