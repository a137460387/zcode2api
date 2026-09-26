import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 读取本机 ZCode 客户端的登录态，无需重新走 OAuth 即可把账号导入网关。
 *
 * **要扫的不止一处**（实测用户机器）：ZCode 多开管理器的每个实例有各自的数据目录，
 * 凭据分别在
 *   - 默认实例：`~/.zcode/v2/credentials.json`
 *   - 多开实例：`%APPDATA%\zcode-multi\<n>\data\.zcode\v2\credentials.json`
 * 只认默认实例的话，用户"另一个客户端里已登录的账号"永远扫不到——而这正是他会来问的
 * 场景（"我还有多开客户端的账号"）。
 *
 * 实测确认：**多开实例的密钥派生不受影响**（启动器只改数据目录，不改派生用的 home），
 * 所以同一个 key 能解开所有实例的凭据。
 *
 * 文件里每个值都是 `enc:v1:<iv>.<tag>.<ct>` 的 AES-256-GCM 密文，
 * 密钥 = sha256(ZCODE_CREDENTIAL_SECRET ?? `zcode-credential-fallback:<platform>:<home>:<user>`)。
 * **密钥绑定本机路径与用户名**：把 credentials.json 从别的机器/别的用户目录复制过来
 * 会解密失败（此时给出明确提示，而不是静默当成"未登录"）。
 */

const CRED_REL = path.join('.zcode', 'v2', 'credentials.json')

/**
 * 派生凭据解密密钥。暴露出来便于单测注入自定义 secret。
 *
 * `secret` 缺省时**读 `ZCODE_CREDENTIAL_SECRET`**：ZCode 客户端支持用这个环境变量覆盖密钥，
 * 那么它写出的 credentials.json 就只认那个密钥。原先注释写了这条、代码却没读——
 * 用户一旦给客户端设过该变量，导入就会以"解密失败"告终，而提示会误导他去重新登录。
 */
export function deriveCredentialKey({ platform = process.platform, home = os.homedir(), user = os.userInfo().username, secret = process.env.ZCODE_CREDENTIAL_SECRET } = {}) {
  const raw = secret?.trim() || `zcode-credential-fallback:${platform}:${home}:${user}`
  return crypto.createHash('sha256').update(raw).digest()
}

/** 解密单个 `enc:v1:` 值；非密文原样返回。解密失败抛出（由调用方决定如何呈现）。 */
export function decryptCredential(value, key) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value
  const parts = value.slice('enc:v1:'.length).split('.')
  if (parts.length !== 3) throw new Error('malformed enc:v1 value')
  const [iv, tag, ct] = parts
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

/** 默认凭据文件路径（可经 env/参数覆盖，便于隔离 profile 与测试）。 */
export function credentialsPath({ home = os.homedir(), file } = {}) {
  return file || process.env.ZCODE_CREDENTIALS_FILE || path.join(home, CRED_REL)
}

/**
 * 本机可能存有 ZCode 登录态的所有文件（带可读标签，便于面板告诉用户"这条来自哪个实例"）。
 *
 * 显式 `file` / `ZCODE_CREDENTIALS_FILE` 一旦给出就**只认它**：隔离 profile 与测试都靠这个，
 * 若此时还去扫别的实例，就会把用户不想动的账号也导进来。
 */
export function candidateCredentialFiles({ home = os.homedir(), appdata = process.env.APPDATA, file, env = process.env } = {}) {
  const explicit = file || env.ZCODE_CREDENTIALS_FILE
  if (explicit) return [{ label: '指定文件', file: explicit }]

  const out = [{ label: '默认实例', file: path.join(home, CRED_REL) }]
  const seen = new Set(out.map((c) => path.resolve(c.file)))
  const multiRoot = appdata ? path.join(appdata, 'zcode-multi') : null
  if (multiRoot) {
    let names = []
    try {
      names = fs.readdirSync(multiRoot)
    } catch {
      // 没用过多开管理器就没有这个目录——正常情况，不是错误
    }
    // 数字目录按数值排序，避免 "10" 排在 "2" 前面
    names.sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b))
    for (const n of names) {
      const f = path.join(multiRoot, n, 'data', CRED_REL)
      const abs = path.resolve(f)
      if (seen.has(abs)) continue
      seen.add(abs)
      out.push({ label: `多开实例 ${n}`, file: f })
    }
  }
  return out
}

/** Coding Plan 凭据的键名：account-provider:coding-plan:account:<planId>:account:<uid>:api-key */
const CODING_PLAN_KEY = /^account-provider:coding-plan:account:(.+):account:(.+):api-key$/

/**
 * 读**单个**文件。返回 `{ ok, reason?, message?, oauth?, apiKeys? }`——**不抛异常**。
 *
 * `apiKeys` 是客户端里绑定的 Coding Plan API Key（实测是真 key，`<id>.<secret>` 形态，
 * 可直接用于 `open.bigmodel.cn` 标准通道）。它们与 oauth 账号是两回事：走标准通道、
 * **不需要 captcha**，所以单独列出来。
 */
export function readInstanceCredentials(file, { key, log = () => {} } = {}) {
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'not_found', message: `未找到凭据文件：${file}（该实例尚未登录 ZCode？）` }
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `凭据文件无法解析：${e.message}` }
  }

  // 解密中途失败基本只有一个原因：密钥与文件来源不匹配（换机器/换用户复制过来的）。
  // 单独识别出来，避免它被误报成"未登录"。
  let jwt = null
  let activeProvider = null
  try {
    jwt = decryptCredential(raw.zcodejwttoken, key)
    activeProvider = decryptCredential(raw['oauth:active_provider'], key)
  } catch {
    return {
      ok: false,
      reason: 'decrypt_failed',
      message: '凭据解密失败：密钥与当前 HOME/用户名绑定，从其他机器或用户目录复制来的凭据无法解开。请在该机器上重新登录 ZCode，或改用看板的 OAuth 登录。',
    }
  }

  const apiKeys = []
  for (const [name, value] of Object.entries(raw)) {
    const m = CODING_PLAN_KEY.exec(name)
    if (!m) continue
    try {
      const plain = decryptCredential(value, key)
      // 只收看起来像 API Key 的值（`<id>.<secret>`）。解出来是别的东西时不猜、不入库。
      if (typeof plain === 'string' && /^[\x20-\x7e]{20,}$/.test(plain) && plain.includes('.')) {
        apiKeys.push({ plan: m[1], uid: m[2], apiKey: plain })
      }
    } catch (e) {
      log(`[import] Coding Plan 凭据解不开（${m[2]}）：${e?.message ?? e}`)
    }
  }

  if (typeof jwt !== 'string' || !jwt.startsWith('eyJ')) {
    // 没有 oauth 登录，但可能有 Coding Plan key —— 两者独立，别一起丢掉
    return {
      ok: apiKeys.length > 0,
      reason: apiKeys.length > 0 ? undefined : 'no_jwt',
      message: apiKeys.length > 0 ? undefined : '凭据文件里没有可用的 zcode JWT（zcodejwttoken 缺失或非 JWT）。请先在 ZCode 客户端登录。',
      oauth: null,
      apiKeys,
    }
  }

  const provider = activeProvider === 'zai' ? 'zai' : 'bigmodel'
  let userInfo = {}
  try {
    const info = decryptCredential(raw[`oauth:${provider}:user_info`], key)
    if (info) userInfo = JSON.parse(info)
  } catch {
    // user_info 解不开不影响可用性：JWT 才是请求凭据，用户信息只是看板展示用。
    userInfo = {}
  }

  let accessToken = null
  let refreshToken = null
  try {
    accessToken = decryptCredential(raw[`oauth:${provider}:access_token`], key)
    refreshToken = decryptCredential(raw[`oauth:${provider}:refresh_token`], key)
  } catch {
    /* 同上：非必需 */
  }

  return { ok: true, oauth: { provider, jwt, accessToken, refreshToken, userInfo }, apiKeys }
}

/**
 * 扫描本机所有 ZCode 实例的登录态与 Coding Plan 凭据。
 * 返回 `{ ok, reason?, message?, accounts: [...], sources: [...] }`——不抛异常。
 *
 * `accounts` 每项形如 `{ type, provider, jwt?, apiKey?, userInfo, source }`，可直接入库。
 * `sources` 是逐实例的诊断（含失败的），面板据此说明"哪个实例没扫到、为什么"。
 */
export function readLocalZcodeCredentials(opts = {}) {
  const key = opts.key ?? deriveCredentialKey(opts)
  const candidates = opts.files ?? candidateCredentialFiles(opts)
  const accounts = []
  const sources = []

  for (const c of candidates) {
    const r = readInstanceCredentials(c.file, { key, log: opts.log })
    const src = { label: c.label, file: c.file, ok: r.ok, reason: r.reason, message: r.message }
    if (r.oauth) {
      /**
       * 归一 user_id：真实文件里 user_info 顶层是 `id`（不是 `user_id`），
       * 而账号 id 由 `user_info.user_id ?? id` 决定。不归一的话每次扫描拿到的是同一个值，
       * 但面板展示与去重都会缺一个稳定标识。
       */
      const ui = r.oauth.userInfo ?? {}
      const uid = ui.user_id ?? ui.id ?? ui.rawProfile?.user_id ?? null
      accounts.push({
        type: 'oauth',
        provider: r.oauth.provider,
        jwt: r.oauth.jwt,
        accessToken: r.oauth.accessToken,
        refreshToken: r.oauth.refreshToken,
        userInfo: uid ? { ...ui, user_id: uid } : ui,
        source: { label: c.label, file: c.file },
      })
      src.oauth = true
    }
    if (r.apiKeys?.length) {
      for (const k of r.apiKeys) {
        accounts.push({
          type: 'apikey',
          // 实测 zai 与 bigmodel 两种 plan 的 key 都能打 open.bigmodel.cn 标准通道
          provider: 'bigmodel',
          apiKey: k.apiKey,
          userInfo: { id: `coding-plan:${k.uid}`, name: `${k.plan} · ${String(k.uid).slice(0, 8)}` },
          source: { label: c.label, file: c.file },
        })
      }
      src.apiKeys = r.apiKeys.length
    }
    sources.push(src)
  }

  // 同一个账号可能在多处出现（同一实例的多份数据、或同一个号在多开里登过），
  // 按"身份"去重并保留先出现的那条（默认实例优先，标签更好认）。
  const dedup = new Map()
  for (const a of accounts) {
    const ident = a.type === 'apikey'
      ? `apikey:${a.userInfo.id}`
      : `oauth:${a.provider}:${a.userInfo.user_id ?? a.jwt}`
    if (!dedup.has(ident)) dedup.set(ident, a)
  }
  const unique = [...dedup.values()]

  if (unique.length === 0) {
    const failed = sources.find((s) => s.reason && s.reason !== 'not_found')
    if (failed) return { ok: false, reason: failed.reason, message: failed.message, sources }
    return {
      ok: false,
      reason: 'not_found',
      message: `未找到任何 ZCode 凭据文件。已查找：${candidates.map((c) => c.label).join('、')}。请先在 ZCode 客户端（含多开实例）登录。`,
      sources,
    }
  }

  return { ok: true, accounts: unique, sources, source: sources.find((s) => s.ok)?.file }
}
