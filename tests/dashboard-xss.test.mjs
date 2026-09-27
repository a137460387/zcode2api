import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.html'), 'utf8')

// 面板把**上游可控**的字符串渲染进 innerHTML：账号 id 来自 `userInfo.user_id`、
// 账号名来自 OAuth 用户资料、模型名与错误信息来自上游响应体。任一环被注入就是存储型 XSS。
//
// 两条独立防线，各自有测试：
// 1. HTML 上下文 → `esc()` 转义（文本/属性里不得出现裸 `<`、`"`）。
// 2. JS 上下文 → **动态值绝不进 onclick/href=javascript:**。`esc()` 只做 HTML 实体转义，
//    而 `<button onclick="f('${esc(id)}')">` 里的 `&#39;` 会被 HTML 解析器**先解回 `'`**，
//    于是 `x'-alert(1)-'` 逃逸出字符串执行任意 JS——这正是本项目修过的形态。
//    故本面板一律 data-* + 事件委托。
//
// 本测试不跑浏览器，而是把 index.html 里**真实的**渲染函数取出来，在只实现必要接口的
// 假 DOM 上执行 refresh()，断言产物 HTML 不含可逃逸的 JS 上下文。

const EVIL_ID = "bigmodel:x'-alert(1)-'"
const EVIL_NAME = '<img src=x onerror="alert(2)">'
const EVIL_MODEL = '"><script>alert(3)</script>'
const EVIL_ERROR = '</td><script>alert(4)</script>'

const accountFixture = (over = {}) => ({
  id: EVIL_ID,
  provider: 'bigmodel',
  type: 'oauth',
  enabled: true,
  needsRelogin: false,
  noPackage: false,
  strikes: 0,
  cooldownRemainMs: 0,
  cooldownUntilIso: null,
  name: EVIL_NAME,
  email: 'x@y.z',
  userId: '1',
  planCache: { balances: [{ entitlementId: 'e', modelName: EVIL_MODEL, total: 100, used: 10, remaining: 90 }] },
  quota: { total: 100, remaining: 90, used: 10, pct: 90 },
  stats: {
    requests: 1,
    inputTokens: 2,
    outputTokens: 3,
    lastUsedAt: 0,
    lastUsedAtIso: new Date().toISOString(),
    lastError: { status: 429, code: 3012, atIso: new Date().toISOString() },
  },
  createdAt: 0,
  createdAtIso: new Date().toISOString(),
  hasJwt: true,
  hasApiKey: false,
  secretMask: 'eyJhbG…ture',
  healthy: true,
  ...over,
})

function makeEnv({ accounts = [accountFixture()], rows } = {}) {
  const recentRows = rows ?? [{
    iso: '2026-09-25 21:00:00',
    model: EVIL_MODEL,
    account: EVIL_ID,
    stream: true,
    status: 502,
    error: EVIL_ERROR,
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
    elapsed_ms: 10,
    ttft_ms: 5,
    tokens_per_sec: 1.5,
  }]
  const nodes = new Map()
  const el = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, innerHTML: '', textContent: '', className: '', href: '', hidden: false, value: '',
        dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, appendChild() {}, remove() {}, close() {}, showModal() {},
        querySelectorAll: () => [],
      })
    }
    return nodes.get(id)
  }
  const document = {
    getElementById: el,
    querySelector: () => el('__q'),
    querySelectorAll: () => [],
    createElement: () => el('__created'),
    addEventListener() {},
    body: { classList: { toggle() {}, contains: () => false } },
  }
  const noop = () => {}
  const storage = { getItem: () => null, setItem: noop, removeItem: noop }
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/usage/recent')
      ? { rows: recentRows, total: recentRows.length }
      : {
        accounts,
        total: accounts.length,
        usable: accounts.length,
        pool: { pool: 3, received: 9, used: 6, lastPushAt: Date.now() - 1000, newestAgeMs: 3000 },
      }),
  })
  const win = { addEventListener: noop, confirm: () => true, location: { reload: noop } }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!script) throw new Error('dashboard <script> not found')
  // 只注入 stub、不触发真实轮询：脚本把启动挂在 window 'load' 事件上，而这里的
  // window.addEventListener 是空实现，故 boot()/setInterval 都不会跑。
  const factory = new Function(
    'document', 'window', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'localStorage', 'sessionStorage', 'console', 'navigator', 'location',
    `${script[1]}
; return {
  render: async () => { await refresh(); return document.getElementById('accounts').innerHTML },
  renderAll: async () => {
    await refresh()
    return ['accounts', 'cards', 'recent', 'pp-pool', 'pp-age', 'pp-farm', 'meta']
      .map((id) => document.getElementById(id).innerHTML + document.getElementById(id).textContent).join('\\n')
  },
}`,
  )
  return factory(document, win, fetchStub, noop, noop, noop, noop, storage, storage, console, {}, { reload: noop })
}

describe('管理面板：JS 上下文注入面', () => {
  it('账号 id 含单引号时不产生可执行的 JS 字符串逃逸', async () => {
    const rendered = await makeEnv().render()
    expect(rendered).toContain('bigmodel') // 确实渲染了该账号
    const buttons = [...rendered.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    expect(buttons.length).toBeGreaterThan(0)
    for (const [, attrs] of buttons) {
      // 动态 id 一旦进入 JS 上下文（onclick/href=javascript:）就有逃逸风险
      expect(attrs).not.toMatch(/onclick\s*=/)
      expect(attrs).not.toMatch(/javascript\s*:/i)
    }
    // 旧形态的产物必须彻底消失（`f('${esc(id)}')` 那类写法）
    expect(rendered).not.toContain('toggleAccount(')
    expect(rendered).not.toContain('deleteAccount(')
  })

  it('动态值只经 data-* 传递（事件委托的数据通道）', async () => {
    const rendered = await makeEnv().render()
    // data-id 是 HTML 属性，esc() 在这里是正确且充分的防线
    expect(rendered).toContain('data-act="toggle"')
    expect(rendered).toContain('data-id="bigmodel:x&#39;-alert(1)-&#39;"')
  })

  it('账号名里的 HTML 被转义（不产生真实标签）', async () => {
    const rendered = await makeEnv().render()
    expect(rendered).toContain('&lt;img src=x onerror=')
    expect(rendered).not.toContain('<img src=x')
  })

  it('模型名与错误信息里的 HTML 被转义（最近请求表）', async () => {
    const all = await makeEnv().renderAll()
    expect(all).not.toContain('<script>alert(3)')
    expect(all).not.toContain('<script>alert(4)')
    expect(all).toContain('&lt;script&gt;')
  })

  it('整个面板文件不含任何内联 onclick（防止将来被加回来）', () => {
    expect(html).not.toMatch(/onclick\s*=/i)
    expect(html).not.toMatch(/javascript\s*:/i)
  })

  it('没有账号时给出可操作的引导而不是空白', async () => {
    const rendered = await makeEnv({ accounts: [] }).render()
    expect(rendered).toContain('还没有账号')
    expect(rendered).toContain('扫描本机 ZCode 登录')
  })
})

describe('管理面板：凭据不回显', () => {
  it('账号渲染里不出现凭据字段名或原文', async () => {
    const rendered = await makeEnv().render()
    expect(rendered).not.toContain('accessToken')
    expect(rendered).not.toContain('refreshToken')
    // 只显示掩码
    expect(rendered).toContain('eyJhbG…ture')
  })
})

describe('管理面板：OAuth 登录弹窗', () => {
  it('授权 URL 通过 href 属性 / textContent 注入，不经 innerHTML（避免 javascript: 协议注入）', () => {
    // 授权 URL 由上游返回，理论上受控于 zcode.z.ai，但跨上游转发/中间代理仍可能被改写。
    // 防线：URL 只能作为 <a href> 属性或元素 textContent 写进 DOM，绝不能拼进 innerHTML。
    // 新版弹窗的渲染路径：
    //   $('dlgLoginUrl').href = r.authorizeUrl        ← 属性赋值，浏览器会拒绝 javascript:
    //   $('dlgLoginUrlText').textContent = r.authorizeUrl  ← 纯文本，不产生标签
    expect(html).toMatch(/\$\('dlgLoginUrl'\)\.href\s*=\s*r\.authorizeUrl/)
    expect(html).toMatch(/\$\('dlgLoginUrlText'\)\.textContent\s*=\s*r\.authorizeUrl/)
    // 反例防线：授权 URL 不得出现在任何 innerHTML 拼字符串里。
    expect(html).not.toMatch(/innerHTML\s*\+?=.*authorizeUrl/)
  })

  it('弹窗按钮不带 onclick，状态文案经 textContent 注入（不经 innerHTML）', () => {
    // 弹窗内的按钮（复制链接 / 重新生成 / 关闭）必须走 data-act 委托，不写 onclick。
    const dlgMatch = html.match(/<dialog id="dlgLogin">([\s\S]*?)<\/dialog>/)
    expect(dlgMatch).toBeTruthy()
    const dlg = dlgMatch[1]
    expect(dlg).not.toMatch(/onclick\s*=/i)
    expect(dlg).not.toMatch(/javascript\s*:/i)
    // 错误消息与计时文本只通过 setLoginStatus → textContent 注入：
    // 即便上游返回 "<script>alert(1)</script>" 作为 p.error，也不会变成可执行标签。
    expect(html).toMatch(/el\.textContent\s*=\s*text/)
  })

  it('三个步骤都有 data-state 属性用于状态机渲染（pending/active/done）', () => {
    // 状态机靠 data-state 视觉化（CSS 选择器 [data-state="active"]），
    // 这三行必须存在，否则 startLogin 找不到目标元素会静默失败。
    expect(html).toContain('id="dlgLoginStep1"')
    expect(html).toContain('id="dlgLoginStep2"')
    expect(html).toContain('id="dlgLoginStep3"')
    expect(html).toContain('data-state="pending"')
  })
})

describe('管理面板：套餐有效期渲染', () => {
  it('expiresAt 数字被解析为时间文本，不允许注入 HTML', async () => {
    // expiresAt 在上游是秒级 epoch 数字，但写库前可能经过客户端/扫描路径，不能假设类型安全。
    // 即便异常数据（字符串里塞 HTML）混进来，渲染也必须用 esc() 兜住——fmtExpiry 内部已做
    // Number() 转换，非数字会落空，但若有任何分支把它当字符串原样拼接，这里就会暴露。
    const evilExp = '1"><script>alert(5)</script>'
    const acc = accountFixture({
      planCache: {
        balances: [
          { entitlementId: 'e1', modelName: 'GLM-5.3', total: 100, remaining: 90, expiresAt: evilExp },
          { entitlementId: 'e2', modelName: 'GLM-5.3-Flash', total: 100, remaining: 90, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
        ],
      },
    })
    const rendered = await makeEnv({ accounts: [acc] }).render()
    expect(rendered).not.toContain('<script>alert(5)')
    // evilExp 里的 `"><script>` 不能被解析为真实标签：要么被 esc() 实体转义，要么整个被 Number() 拒绝
    expect(rendered).not.toContain('<script>')
    // 正常那条 Flash 的有效期应正常渲染（"Xh 后到期"或"Xmin 后到期"）
    expect(rendered).toMatch(/\d+(min|h|天) 后到期/)
  })

  it('同模型多 entitlement 各自一行渲染（不合并），且模型名走 esc()', async () => {
    // 用户决策：显示层不合并——同账号下同模型多 entitlement 的 expiresAt/reset 节奏不同，
    // 合并会掩盖"周末包快烧完、日包还早"的差异。调度层内部仍按模型合并紧迫度，
    // 但面板必须逐条显示。
    const acc = accountFixture({
      planCache: {
        balances: [
          { entitlementId: 'e1', modelName: EVIL_MODEL, total: 100, remaining: 90, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
          { entitlementId: 'e2', modelName: EVIL_MODEL, total: 200, remaining: 180, expiresAt: Math.floor(Date.now() / 1000) + 7200 },
        ],
      },
    })
    const rendered = await makeEnv({ accounts: [acc] }).render()
    expect(rendered).not.toContain('<script>alert(3)')
    expect(rendered).toContain('&lt;script&gt;')
    // 逐条显示：应同时出现 90/100 与 180/200（而不是合并的 270/300）
    expect(rendered).toContain('90 / 100')
    expect(rendered).toContain('180 / 200')
    expect(rendered).not.toContain('270 / 300')
  })

  it('已过期的 entitlement 在自己的行内显示红字"已过期"，不另起汇总行', async () => {
    const pastSec = Math.floor(Date.now() / 1000) - 60
    const acc = accountFixture({
      planCache: {
        balances: [
          { entitlementId: 'e1', modelName: 'GLM-5.3', total: 100, remaining: 50, expiresAt: pastSec },
        ],
      },
    })
    const rendered = await makeEnv({ accounts: [acc] }).render()
    expect(rendered).toContain('已过期')
    // 不再渲染合并版的"└ 已过期 X/Y 作废"汇总行——已过期信息挂在该 entitlement 自己的行内
    expect(rendered).not.toContain('作废')
  })
})
