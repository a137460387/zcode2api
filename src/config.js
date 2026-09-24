import fs from 'node:fs'
import path from 'node:path'

// 解析 `.env` 后回填到 `target`。已有的键不覆盖（与既有语义一致）。
// 调用方传入自定义 env 时只合并进该对象，绝不碰 process.env。
function loadDotEnv(rootDir, target) {
  const file = path.join(rootDir, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || target[m[1]] !== undefined) continue
    target[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

// 数值解析：缺省、全空白、非数字、非有限数或超出 [min, max] 一律回退默认值。
function num(v, d, min = -Infinity, max = Infinity) {
  if (v === undefined || String(v).trim() === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return d
  return n
}

export function loadConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  loadDotEnv(rootDir, env)
  const bool = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true')
  return {
    rootDir,
    port: num(env.PORT, 8787, 1, 65535),
    host: env.HOST || '127.0.0.1',
    farmPort: num(env.FARM_PORT, 8789, 1, 65535),
    apiKey: env.API_KEY || '',
    panelPassword: env.PANEL_PASSWORD || '',
    poolDir: env.POOL_DIR || path.join(rootDir, 'accounts'),
    certDir: env.CERT_DIR || path.join(rootDir, 'certs'),
    farmHeadless: bool(env.FARM_HEADLESS, true),
    // 手动模式：关闭自动农场浏览器，改用用户自己的真实 Chrome 打开 farm 页。
    // 必要性：playwright 驱动的浏览器（即便覆盖 UA）仍带自动化特征，产出的 captcha 参数
    // 会被上游判低风险分并返回 3012；真实 Chrome 环境产出的参数才能通过（详见 README）。
    farmAutoBrowser: bool(env.FARM_AUTO_BROWSER, true),
    chromePath: env.CHROME_PATH || '',
    poolSize: num(env.POOL_SIZE, 6, 1),
    paramTtlMs: num(env.PARAM_TTL_MS, 8 * 60_000, 0),
    minIntervalMs: num(env.ACCOUNT_MIN_INTERVAL_MS, 2000, 1),
    cooldown3012Ms: num(env.COOLDOWN_3012_MIN, 30, 0) * 60_000,
    maxRetries: num(env.MAX_RETRIES, 2, 0),
  }
}
