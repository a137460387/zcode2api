import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 面板访问鉴权。
 *
 * 为什么需要它：原先非本机访问只认 `x-panel-password` 请求头，而浏览器直接打开
 * `http://host:28630/` **无法设置请求头**——非本机用户根本进不了看板，那条分支等于死代码。
 * 本模块提供「密码 → 会话 token」这条路，浏览器可用，脚本仍可用旧请求头。
 *
 * 安全决策：
 * - 口令只存 scrypt 哈希 + 随机盐，**不存明文**（`panel.json` 权限之外再无泄露面）。
 * - 会话表以 `sha256(token)` 为键：内存里不驻留明文 token，日志/转储拿到表也换不回会话。
 * - 比较走 `timingSafeEqual`，长度不等先补齐再比，避免用长度做侧信道。
 * - 未配置任何密码时**非本机一律拒绝**，不学参考项目的默认口令 `admin`（弱口令比没有口令更危险：
 *   它让"没配密码"看起来像"配了密码"）。
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }
const SALT_BYTES = 16
const TOKEN_BYTES = 32
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000
/** 会话数上限：本机工具的正常使用远达不到；设上限只为让"不断登录"不变成内存增长。 */
const MAX_SESSIONS = 200
const MIN_PASSWORD_LEN = 4

const b64 = (buf) => Buffer.from(buf).toString('base64url')

const hashPassword = (password, salt, rounds = SCRYPT.N) =>
  crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: rounds, r: SCRYPT.r, p: SCRYPT.p })

/**
 * 定时安全比较。`timingSafeEqual` 对**长度不等**直接抛异常（且异常本身泄露长度），
 * 故先各自 sha256 归一到 32 字节再比：内容不同则哈希不同，长度信息被抹掉。
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export class PanelAuth {
  constructor({ file, bootstrapPassword = '', localBypass = true, now = Date.now, log = () => {} } = {}) {
    this.file = file
    this.bootstrapPassword = bootstrapPassword || ''
    this.localBypass = localBypass
    this.now = now
    this.log = log
    /** sha256(token) → { at }。键用哈希而非明文 token：见文件头注释。 */
    this.sessions = new Map()
    this.data = this.#read()
  }

  #read() {
    if (!this.file) return null
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw.hash === 'string' && raw.hash && typeof raw.salt === 'string' && raw.salt) {
        return {
          salt: raw.salt,
          hash: raw.hash,
          rounds: Number(raw.rounds) > 0 ? Number(raw.rounds) : SCRYPT.N,
          updatedAt: Number(raw.updatedAt) || 0,
        }
      }
      return null
    } catch {
      // 文件不存在 / 坏 JSON 都按"未设置面板密码"处理：坏文件不该把面板锁死，
      // 此时非本机仍然进不来（hasPassword() 为 false），安全性由"默认拒绝"兜底。
      return null
    }
  }

  #write(data) {
    const tmp = `${this.file}.tmp`
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.data = data
  }

  /** 是否已设置过面板密码（`panel.json` 优先，其次 `.env` 的引导密码）。 */
  hasPassword() {
    return Boolean(this.data || this.bootstrapPassword)
  }

  /** 密码来源，供面板提示用（`file` = 面板里改过；`env` = 用 .env 引导；`none` = 未设置）。 */
  passwordSource() {
    if (this.data) return 'file'
    if (this.bootstrapPassword) return 'env'
    return 'none'
  }

  verify(password) {
    if (!this.hasPassword()) return false
    if (this.data) {
      const candidate = hashPassword(password, this.data.salt, this.data.rounds)
      const stored = Buffer.from(this.data.hash, 'base64url')
      // 长度不等时 timingSafeEqual 会抛异常。`#read()` 只校验了 hash 是非空字符串，
      // 手工编辑过的 panel.json 完全可能是别的长度——那时应当"验证不通过"，而不是 500。
      if (stored.length !== candidate.length) return false
      return crypto.timingSafeEqual(candidate, stored)
    }
    // 引导密码来自 .env 明文，仍走 safeEqual：直接 `===` 会因提前返回而泄露前缀匹配长度。
    return safeEqual(password, this.bootstrapPassword)
  }

  #prune() {
    const t = this.now()
    for (const [key, s] of this.sessions) if (t - s.at >= SESSION_TTL_MS) this.sessions.delete(key)
  }

  #key(token) {
    return crypto.createHash('sha256').update(String(token)).digest('base64url')
  }

  create() {
    this.#prune()
    // 超限时删最旧的一条（Map 保持插入序）：比"拒绝新登录"更符合本机工具的使用直觉，
    // 且不会让攻击者用"刷满会话表"把正常用户锁在门外。
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      this.sessions.delete(oldest)
    }
    const token = b64(crypto.randomBytes(TOKEN_BYTES))
    this.sessions.set(this.#key(token), { at: this.now() })
    return token
  }

  valid(token) {
    if (!token) return false
    this.#prune()
    return this.sessions.has(this.#key(token))
  }

  revoke(token) {
    if (!token) return false
    return this.sessions.delete(this.#key(token))
  }

  revokeAll() {
    const n = this.sessions.size
    this.sessions.clear()
    return n
  }

  /**
   * 改密码：校验旧密码 → 写新哈希 → 吊销**全部**会话。
   * 吊销是必须的：旧密码可能已经泄露给他人，改了密码却不踢掉已建立的会话，
   * 等于"改了锁但没换钥匙"。调用方拿到返回的新 token 才不会把自己也踢出去。
   */
  setPassword(current, next) {
    if (!this.verify(current)) return { ok: false, error: 'current password is wrong', code: 401 }
    if (typeof next !== 'string' || next.length < MIN_PASSWORD_LEN) {
      return { ok: false, error: `new password must be at least ${MIN_PASSWORD_LEN} characters`, code: 400 }
    }
    const salt = b64(crypto.randomBytes(SALT_BYTES))
    this.#write({ salt, hash: b64(hashPassword(next, salt)), rounds: SCRYPT.N, updatedAt: this.now() })
    this.revokeAll()
    this.log('[panel] 面板密码已更新，所有旧会话已吊销')
    return { ok: true, token: this.create() }
  }

  isLocal(req) {
    const addr = req?.socket?.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /** 请求携带的会话 token：请求头优先，`?panel=` 兼容参考项目的用法。 */
  tokenFrom(req) {
    const header = (req.get?.('x-panel-token') || '').trim()
    if (header) return header
    const q = req.query?.panel
    const value = Array.isArray(q) ? q[0] : q
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * 该请求是否已获准访问管理面。
   * 本机放行可用 `localBypass: false` 关闭——那时本机也要带密码/token（多一层防护，
   * 也让"面板挂在反向代理后面"这种部署不会因为代理回源是本机而被无声放行）。
   */
  allow(req) {
    if (this.localBypass && this.isLocal(req)) return true
    if (this.valid(this.tokenFrom(req))) return true
    // 旧脚本兼容：直接带面板密码（.env 的 PANEL_PASSWORD 或 panel.json 里的那份）。
    const legacy = req.get?.('x-panel-password')
    if (legacy && this.verify(legacy)) return true
    return false
  }

  status(req) {
    return {
      // 非本机是否必须密码：本机放行开着且请求来自本机时，答案为 false（面板据此决定是否显示登录页）。
      passwordRequired: !(this.localBypass && this.isLocal(req)),
      authenticated: this.allow(req),
      localBypass: this.localBypass,
      hasPassword: this.hasPassword(),
      passwordSource: this.passwordSource(),
      // 用 .env 引导密码时提示去「设置」里改：.env 是明文且可能被同步/备份出去。
      usingBootstrapPassword: this.passwordSource() === 'env',
    }
  }

  /** Express 中间件：未获准则 401，并给出可操作的提示。 */
  middleware() {
    return (req, res, next) => {
      if (this.allow(req)) return next()
      const hint = this.hasPassword()
        ? '请在本机看板「设置」页设置面板密码后重试'
        : '面板密码未设置：请在本机打开看板并在「设置」页设置密码，之后才能从非本机访问'
      return res.status(401).json({
        error: { message: 'panel password required for non-local access', hint },
        panel: this.status(req),
      })
    }
  }
}
