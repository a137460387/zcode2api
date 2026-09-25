import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PanelAuth } from '../src/panel/auth.js'

let dir, file
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-panel-'))
  file = path.join(dir, 'panel.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** 伪造 Express 请求：只需 socket/get/query 三个接口。 */
const req = ({ addr = '203.0.113.9', headers = {}, query = {} } = {}) => ({
  socket: { remoteAddress: addr },
  query,
  get: (name) => headers[name.toLowerCase()],
})
const local = (headers = {}) => req({ addr: '127.0.0.1', headers })
const remote = (headers = {}) => req({ headers })

describe('PanelAuth：口令存储', () => {
  it('未设置密码时 hasPassword 为 false，来源为 none', () => {
    const auth = new PanelAuth({ file })
    expect(auth.hasPassword()).toBe(false)
    expect(auth.passwordSource()).toBe('none')
    expect(auth.verify('anything')).toBe(false)
  })

  it('.env 引导密码可用，来源标记为 env', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'sk-env-pass' })
    expect(auth.passwordSource()).toBe('env')
    expect(auth.verify('sk-env-pass')).toBe(true)
    expect(auth.verify('sk-env-pas')).toBe(false)
    expect(auth.verify('')).toBe(false)
  })

  it('改密后 panel.json 里没有明文密码，只有盐与哈希', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    const r = auth.setPassword('env-pass', 'my-secret-pass')
    expect(r.ok).toBe(true)
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('my-secret-pass')
    expect(raw).not.toContain('env-pass')
    const parsed = JSON.parse(raw)
    expect(parsed.hash).toBeTruthy()
    expect(parsed.salt).toBeTruthy()
    expect(parsed.rounds).toBeGreaterThan(0)
  })

  it('改密后 panel.json 优先于 .env：新密码生效、旧引导密码失效', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    auth.setPassword('env-pass', 'file-pass')
    expect(auth.passwordSource()).toBe('file')
    expect(auth.verify('file-pass')).toBe(true)
    expect(auth.verify('env-pass')).toBe(false)
    // 重新构造（模拟重启）后仍然只认新密码
    const again = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    expect(again.verify('file-pass')).toBe(true)
    expect(again.verify('env-pass')).toBe(false)
  })

  it('panel.json 被手工改坏时按未设置处理，不抛异常也不锁死', () => {
    fs.writeFileSync(file, '{ not json')
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    expect(auth.passwordSource()).toBe('env')
    expect(auth.verify('env-pass')).toBe(true)
    expect(() => auth.verify('x')).not.toThrow()
  })

  it('panel.json 里 hash 长度异常时 verify 返回 false 而不是抛异常', () => {
    fs.writeFileSync(file, JSON.stringify({ salt: 'AAAA', hash: 'AAAA', rounds: 16384 }))
    const auth = new PanelAuth({ file })
    expect(auth.hasPassword()).toBe(true)
    expect(() => auth.verify('whatever')).not.toThrow()
    expect(auth.verify('whatever')).toBe(false)
  })

  it('新密码过短被拒，且不改动已有密码', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    expect(auth.setPassword('env-pass', 'abc')).toMatchObject({ ok: false, code: 400 })
    expect(auth.verify('env-pass')).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('旧密码不对时拒绝改密', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    expect(auth.setPassword('wrong', 'new-password')).toMatchObject({ ok: false, code: 401 })
    expect(auth.verify('env-pass')).toBe(true)
  })

  it('相同密码两次改密产生不同盐与哈希（盐是随机的）', () => {
    const a = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    a.setPassword('env-pass', 'same-password')
    const first = JSON.parse(fs.readFileSync(file, 'utf8'))
    a.setPassword('same-password', 'same-password')
    const second = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(second.salt).not.toBe(first.salt)
    expect(second.hash).not.toBe(first.hash)
  })
})

describe('PanelAuth：会话 token', () => {
  it('登录签发的 token 有效，未签发的无效', () => {
    const auth = new PanelAuth({ file })
    const t = auth.create()
    expect(auth.valid(t)).toBe(true)
    expect(auth.valid('made-up')).toBe(false)
    expect(auth.valid('')).toBe(false)
    expect(auth.valid(undefined)).toBe(false)
  })

  it('会话表里不驻留明文 token', () => {
    const auth = new PanelAuth({ file })
    const t = auth.create()
    expect([...auth.sessions.keys()]).not.toContain(t)
    expect(auth.valid(t)).toBe(true)
  })

  it('token 过期后失效', () => {
    let clock = 1_000_000
    const auth = new PanelAuth({ file, now: () => clock })
    const t = auth.create()
    clock += 6 * 24 * 60 * 60_000
    expect(auth.valid(t)).toBe(true)
    clock += 2 * 24 * 60 * 60_000
    expect(auth.valid(t)).toBe(false)
  })

  it('logout 只吊销自己那一个 token', () => {
    const auth = new PanelAuth({ file })
    const a = auth.create()
    const b = auth.create()
    expect(auth.revoke(a)).toBe(true)
    expect(auth.valid(a)).toBe(false)
    expect(auth.valid(b)).toBe(true)
  })

  it('改密吊销全部旧会话，但返回的新 token 可用', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    const old = auth.create()
    const r = auth.setPassword('env-pass', 'next-password')
    expect(auth.valid(old)).toBe(false)
    expect(auth.valid(r.token)).toBe(true)
  })

  it('会话数达到上限后仍能登录（淘汰最旧的，不把用户锁在门外）', () => {
    const auth = new PanelAuth({ file })
    const tokens = []
    for (let i = 0; i < 260; i += 1) tokens.push(auth.create())
    expect(auth.sessions.size).toBeLessThanOrEqual(200)
    const newest = auth.create()
    expect(auth.valid(newest)).toBe(true)
    expect(auth.valid(tokens[0])).toBe(false) // 最旧的已被淘汰
  })
})

describe('PanelAuth：访问判定', () => {
  it('本机默认放行（无密码也能进）', () => {
    const auth = new PanelAuth({ file })
    expect(auth.allow(local())).toBe(true)
    expect(auth.status(local()).passwordRequired).toBe(false)
  })

  it('关闭 localBypass 后本机也要凭据', () => {
    const auth = new PanelAuth({ file, localBypass: false })
    expect(auth.allow(local())).toBe(false)
    const t = auth.create()
    expect(auth.allow(local({ 'x-panel-token': t }))).toBe(true)
  })

  it('非本机未设置密码时一律拒绝（不引入默认口令）', () => {
    const auth = new PanelAuth({ file })
    const s = auth.status(remote())
    expect(s.passwordRequired).toBe(true)
    expect(s.hasPassword).toBe(false)
    expect(auth.allow(remote())).toBe(false)
    expect(auth.allow(remote({ 'x-panel-token': 'anything' }))).toBe(false)
  })

  it('非本机可用 token 通过', () => {
    const auth = new PanelAuth({ file })
    const t = auth.create()
    expect(auth.allow(remote({ 'x-panel-token': t }))).toBe(true)
    // `?panel=` 兼容参考项目的用法
    expect(auth.allow(req({ query: { panel: t } }))).toBe(true)
    expect(auth.allow(req({ query: { panel: ['x', t] } }))).toBe(false)
  })

  it('非本机可用 x-panel-password 直接带密码（旧脚本兼容）', () => {
    const auth = new PanelAuth({ file, bootstrapPassword: 'env-pass' })
    expect(auth.allow(remote({ 'x-panel-password': 'env-pass' }))).toBe(true)
    expect(auth.allow(remote({ 'x-panel-password': 'nope' }))).toBe(false)
  })

  it('status 报告 authenticated，便于前端决定是否显示登录页', () => {
    const auth = new PanelAuth({ file })
    expect(auth.status(local()).authenticated).toBe(true)
    expect(auth.status(remote()).authenticated).toBe(false)
    const t = auth.create()
    expect(auth.status(remote({ 'x-panel-token': t })).authenticated).toBe(true)
  })

  it('中间件：拒绝时回 401 且带可操作提示，通过时进入 next', () => {
    const auth = new PanelAuth({ file })
    const mw = auth.middleware()
    let called = false
    const res = {
      statusCode: 0,
      status(c) { this.statusCode = c; return this },
      json(body) { this.body = body; return this },
    }
    mw(remote(), res, () => { called = true })
    expect(called).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body.error.message).toMatch(/panel password/)
    expect(res.body.panel.hasPassword).toBe(false)
    mw(local(), res, () => { called = true })
    expect(called).toBe(true)
  })
})
