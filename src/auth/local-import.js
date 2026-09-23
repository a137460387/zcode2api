import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 读取本机 ZCode 客户端的登录态（`~/.zcode/v2/credentials.json`），
 * 无需重新走 OAuth 即可把当前账号导入网关。
 *
 * 文件里每个值都是 `enc:v1:<iv>.<tag>.<ct>` 的 AES-256-GCM 密文，
 * 密钥 = sha256(ZCODE_CREDENTIAL_SECRET ?? `zcode-credential-fallback:<platform>:<home>:<user>`)。
 *
 * **密钥绑定本机路径与用户名**：把 credentials.json 从别的机器/别的用户目录复制过来
 * 会解密失败（此时给出明确提示，而不是静默当成"未登录"）。
 */

const CRED_REL = path.join('.zcode', 'v2', 'credentials.json')

/** 派生凭据解密密钥。暴露出来便于单测注入自定义 secret。 */
export function deriveCredentialKey({ platform = process.platform, home = os.homedir(), user = os.userInfo().username, secret } = {}) {
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
 * 扫描本机 ZCode 登录态。
 * 返回 `{ ok, reason?, accounts: [...] }`——**不抛异常**，便于直接作为接口结果返回。
 * 每个账号形如 `{ provider, jwt, accessToken, refreshToken, userInfo }`，可直接交给
 * `newAccountFields` 入库。
 */
export function readLocalZcodeCredentials(opts = {}) {
  const file = credentialsPath(opts)
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'not_found', message: `未找到 ZCode 凭据文件：${file}（本机尚未登录 ZCode 桌面端？）` }
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `凭据文件无法解析：${e.message}` }
  }

  const key = opts.key ?? deriveCredentialKey(opts)
  const decrypt = (k) => {
    if (raw[k] === undefined) return null
    return decryptCredential(raw[k], key)
  }

  // 解密中途失败基本只有一个原因：密钥与文件来源不匹配（换机器/换用户复制过来的）。
  // 单独识别出来，避免它被误报成"未登录"。
  let jwt = null
  let activeProvider = null
  try {
    jwt = decrypt('zcodejwttoken')
    activeProvider = decrypt('oauth:active_provider')
  } catch {
    return {
      ok: false,
      reason: 'decrypt_failed',
      message: '凭据解密失败：密钥与当前 HOME/用户名绑定，从其他机器或用户目录复制来的凭据无法解开。请在该机器上重新登录 ZCode，或改用看板的 OAuth 登录。',
    }
  }

  if (typeof jwt !== 'string' || !jwt.startsWith('eyJ')) {
    return { ok: false, reason: 'no_jwt', message: '凭据文件里没有可用的 zcode JWT（zcodejwttoken 缺失或非 JWT）。请先在 ZCode 桌面端登录。' }
  }

  const provider = activeProvider === 'zai' ? 'zai' : 'bigmodel'
  let userInfo = {}
  try {
    const info = decrypt(`oauth:${provider}:user_info`)
    if (info) userInfo = JSON.parse(info)
  } catch {
    // user_info 解不开不影响可用性：JWT 才是请求凭据，用户信息只是看板展示用。
    userInfo = {}
  }

  let accessToken = null
  let refreshToken = null
  try {
    accessToken = decrypt(`oauth:${provider}:access_token`)
    refreshToken = decrypt(`oauth:${provider}:refresh_token`)
  } catch {
    /* 同上：非必需 */
  }

  return {
    ok: true,
    source: file,
    accounts: [{ provider, jwt, accessToken, refreshToken, userInfo }],
  }
}
