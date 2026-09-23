import fs from 'node:fs'
import path from 'node:path'

function loadDotEnv(rootDir) {
  const file = path.join(rootDir, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

export function loadConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  loadDotEnv(rootDir)
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
  const bool = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true')
  return {
    rootDir,
    port: num(env.PORT, 8787),
    host: env.HOST || '127.0.0.1',
    farmPort: num(env.FARM_PORT, 8789),
    apiKey: env.API_KEY || '',
    panelPassword: env.PANEL_PASSWORD || '',
    poolDir: env.POOL_DIR || path.join(rootDir, 'accounts'),
    certDir: env.CERT_DIR || path.join(rootDir, 'certs'),
    farmHeadless: bool(env.FARM_HEADLESS, true),
    chromePath: env.CHROME_PATH || '',
    poolSize: num(env.POOL_SIZE, 6),
    paramTtlMs: num(env.PARAM_TTL_MS, 8 * 60_000),
    minIntervalMs: num(env.ACCOUNT_MIN_INTERVAL_MS, 2000),
    cooldown3012Ms: num(env.COOLDOWN_3012_MIN, 30) * 60_000,
    maxRetries: num(env.MAX_RETRIES, 2),
  }
}
