import fs from 'node:fs'
import path from 'node:path'

/**
 * 运行期设置：面板读取 + 热更新 + 写回 `.env`。
 *
 * 为什么写回 `.env` 而不是另存一份 settings.json：配置的**唯一来源**应当只有一个。
 * 参考项目把面板密码与 Key 存进 settings.json，于是 `.env`/环境变量与面板值并存，
 * 出现"改完重启又变回去"这类只有读代码才能解释的行为。这里让面板改的就是 `.env`
 * 本身——重启后仍生效，且用户 `cat .env` 看到的与面板显示的一致。
 *
 * 写回纪律：**只改我们管理的键**，其余行（注释、空行、顺序、未管理的键）逐字节保留。
 * 解析失败的行原样保留，绝不因为"看不懂"就把它删掉。
 */

/** 面板可改的键 → .env 变量名。集中在此，避免"改了内存没写盘"这类漏配。 */
const ENV_KEYS = {
  apiKey: 'API_KEY',
  minIntervalMs: 'ACCOUNT_MIN_INTERVAL_MS',
  cooldown3012Min: 'COOLDOWN_3012_MIN',
  paramTtlMs: 'PARAM_TTL_MS',
  poolSize: 'POOL_SIZE',
  maxRetries: 'MAX_RETRIES',
}

/**
 * 掩码：只留头尾，中间用 `…` 顶掉。太短（< 10）则整体隐去——
 * 一个 4 字符的"掩码"等于没掩。
 */
export function maskSecret(value) {
  const s = String(value ?? '')
  if (!s) return ''
  if (s.length < 10) return '…'
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

/** 读 `.env` 为有序行数组；不存在时返回空数组。 */
export function readEnvLines(envFile) {
  try {
    return fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * 把 `patch`（env 变量名 → 字符串值）写回 `.env`：命中的行**原地替换**，未命中的追加到末尾。
 * 返回 `{ changed, appended }` 供调用方报告。
 */
export function updateEnvFile(envFile, patch) {
  const lines = readEnvLines(envFile)
  const pending = new Map(Object.entries(patch))
  const changed = []
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!m || !pending.has(m[1])) return line
    const key = m[1]
    const value = pending.get(key)
    pending.delete(key)
    changed.push(key)
    return `${key}=${value}`
  })
  const appended = [...pending.keys()]
  // 文件末尾若没有换行，直接 append 会把新键粘在最后一行上，产出一个坏行。
  if (next.length && next[next.length - 1] !== '') next.push('')
  for (const [key, value] of pending) next.push(`${key}=${value}`)
  const body = next.join('\n').replace(/\n*$/, '\n')
  fs.mkdirSync(path.dirname(envFile), { recursive: true })
  const tmp = `${envFile}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, envFile)
  return { changed, appended }
}

const int = (v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (v === undefined || v === null || String(v).trim() === '') return { error: 'required' }
  const n = Number(v)
  if (!Number.isFinite(n)) return { error: 'must be a number' }
  const i = Math.floor(n)
  if (i < min || i > max) return { error: `must be between ${min} and ${max}` }
  return { value: i }
}

export class RuntimeSettings {
  constructor({ config, pool, paramPool, envFile, panelFile, log = () => {}, version = '0.1.0' } = {}) {
    this.config = config
    this.pool = pool
    this.paramPool = paramPool
    this.envFile = envFile
    this.panelFile = panelFile
    this.log = log
    this.version = version
  }

  view({ farmUrl = '', usageDir = '', paramPoolStatus = null } = {}) {
    const c = this.config
    return {
      version: this.version,
      envFile: this.envFile,
      panelFile: this.panelFile,
      accountsDir: c.poolDir,
      usageDir: usageDir || c.usageDir || '',
      farmUrl,
      listen: { host: c.host, port: c.port, farmPort: c.farmPort },
      // 密钥只回掩码：面板要显示"配没配、是不是这一条"，不需要看到原文。
      // 原文一旦进过浏览器/日志/截图，就等于多了一处泄露面。
      apiKeySet: Boolean(c.apiKey),
      apiKeyMasked: maskSecret(c.apiKey),
      runtime: {
        minIntervalMs: this.pool?.minIntervalMs ?? c.minIntervalMs,
        cooldown3012Min: Math.round((this.pool?.cooldown3012Ms ?? c.cooldown3012Ms) / 60_000),
        paramTtlMs: this.paramPool?.ttlMs ?? c.paramTtlMs,
        poolSize: this.paramPool?.maxSize ?? c.poolSize,
        maxRetries: c.maxRetries,
        farmHeadless: c.farmHeadless,
        farmAutoBrowser: c.farmAutoBrowser,
      },
      paramPool: paramPoolStatus,
    }
  }

  /**
   * 应用并持久化。逐字段校验：**合法字段照常生效，非法字段单独报错**，
   * 不搞"一个字段写错就整份拒绝"（用户改了 4 项，不该因为第 5 项填错而全丢）。
   * 返回 `{ applied, errors, env }`。
   */
  save(patch = {}) {
    const applied = {}
    const errors = {}
    const envPatch = {}
    const c = this.config

    if (patch.apiKey !== undefined) {
      const v = String(patch.apiKey ?? '').trim()
      if (!v) errors.apiKey = 'API key 不能为空'
      else {
        c.apiKey = v
        envPatch[ENV_KEYS.apiKey] = v
        applied.apiKey = maskSecret(v)
      }
    }

    const applyInt = (field, { min, max }, fn) => {
      if (patch[field] === undefined) return
      const r = int(patch[field], { min, max })
      if (r.error) {
        errors[field] = r.error
        return
      }
      fn(r.value)
      envPatch[ENV_KEYS[field]] = String(r.value)
      applied[field] = r.value
    }

    applyInt('minIntervalMs', { min: 1, max: 600_000 }, (v) => {
      c.minIntervalMs = v
      // 热更新到**实例**：AccountPool 在 pick() 里读 this.minIntervalMs，改实例即刻生效，
      // 无需重启（只改 config 是无效的——池在构造时就把它拷走了）。
      if (this.pool) this.pool.minIntervalMs = v
    })
    applyInt('cooldown3012Min', { min: 0, max: 24 * 60 }, (v) => {
      c.cooldown3012Ms = v * 60_000
      if (this.pool) this.pool.cooldown3012Ms = v * 60_000
    })
    applyInt('paramTtlMs', { min: 0, max: 24 * 60 * 60_000 }, (v) => {
      c.paramTtlMs = v
      if (this.paramPool) this.paramPool.ttlMs = v
    })
    applyInt('poolSize', { min: 1, max: 1000 }, (v) => {
      c.poolSize = v
      // ParamPool.maxSize 有"必须为非负整数"的硬约束（负数会让淘汰循环死循环），
      // 构造时钳制过；这里同样走钳制后的赋值，并顺带裁掉超出的旧参数。
      if (this.paramPool) {
        this.paramPool.maxSize = Math.max(0, Math.floor(v))
        if (this.paramPool.items.length > this.paramPool.maxSize) {
          this.paramPool.items.splice(0, this.paramPool.items.length - this.paramPool.maxSize)
        }
      }
    })
    applyInt('maxRetries', { min: 0, max: 10 }, (v) => { c.maxRetries = v })

    let env = null
    if (Object.keys(envPatch).length) {
      try {
        env = updateEnvFile(this.envFile, envPatch)
        this.log(`[panel] 设置已写入 ${path.basename(this.envFile)}：${[...env.changed, ...env.appended].join(', ')}`)
      } catch (e) {
        // 写盘失败**必须回显**：内存已改、重启后会变回去，用户有权知道这份改动是临时的。
        errors._persist = `写入 .env 失败（本次修改重启后会丢失）：${e?.message ?? e}`
      }
    }
    return { applied, errors, env }
  }
}
