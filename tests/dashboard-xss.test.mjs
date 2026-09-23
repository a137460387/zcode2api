import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8')

// 看板把上游可控的账号 id 渲染进 innerHTML。`esc()` 只做 HTML 实体转义，而
// `<button onclick="setEnabled('${esc(a.id)}', ...)">` 把 id 放进了 **JS 字符串字面量**：
// HTML 解析器会先把属性值里的 `&#39;` 解回 `'`，于是 `x'-alert(1)-'` 逃逸出字符串执行任意 JS。
// 账号 id 来自上游 `userInfo.user_id`（远程可控），属存储型 XSS。
//
// 本测试不跑浏览器，而是把 index.html 里**真实的**渲染实现（唯一的渲染代码路径）取出来，
// 在一个只实现必要接口的假 DOM 上执行 refresh()，断言产物 HTML 中不含可逃逸的 JS 上下文。
const EVIL_ID = "bigmodel:x'-alert(1)-'"

function loadRefresh() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('dashboard <script> not found')
  const nodes = new Map()
  const document = {
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, { id, textContent: '', innerHTML: '', href: '', open: false, showModal() {}, close() {}, addEventListener() {} })
      return nodes.get(id)
    },
  }
  const accounts = [{ id: EVIL_ID, provider: 'bigmodel', type: 'oauth', enabled: true, name: 'n', stats: {} }]
  const fetchStub = async () => ({ json: async () => ({ accounts, requests: [], paramPool: {}, farmUrl: '' }) })
  const factory = new Function(
    'document', 'fetch', 'setInterval', 'clearInterval', 'alert', 'confirm',
    `${m[1]}\n; return { render: async () => { await refresh(); return document.getElementById('accounts').innerHTML } }`,
  )
  return factory(document, fetchStub, () => 0, () => {}, () => {}, () => true)
}

describe('看板账号渲染：JS 上下文注入面', () => {
  it('账号 id 含单引号时不产生可执行的 JS 字符串逃逸', async () => {
    const rendered = await loadRefresh().render()
    expect(rendered).toContain('bigmodel') // 确实渲染了该账号
    const buttons = [...rendered.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    expect(buttons.length).toBeGreaterThan(0)
    for (const [, attrs] of buttons) {
      // 动态 id 一旦进入 JS 上下文（onclick/href=javascript:）就有逃逸风险，属性里不得出现
      expect(attrs).not.toMatch(/onclick\s*=/)
      expect(attrs).not.toMatch(/javascript\s*:/i)
    }
  })

  it('HTML 实体转义后不再被还原进可执行上下文（&#39; 必须只出现在文本/属性值，不闭合 JS 字符串）', async () => {
    const rendered = await loadRefresh().render()
    // 旧实现会产生 onclick="setEnabled('bigmodel:x&#39;-alert(1)-&#39;', true)"
    // —— 解析器把 &#39; 解回 ' 后正是 setEnabled('bigmodel:x'-alert(1)-'', true)
    expect(rendered).not.toContain('setEnabled(')
    expect(rendered).not.toContain('del(')
  })
})
