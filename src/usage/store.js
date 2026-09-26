import fs from 'node:fs'
import path from 'node:path'

/**
 * 请求用量持久化 + 聚合。
 *
 * 为什么需要它：原先 `createRequestLog` 只在内存里留 200 条，重启即丢，无法回答
 * "这个月用了多少 token""哪个账号在被用""是不是变慢了"。管理面板要展示用量，
 * 就必须有一条能跨重启、可聚合的账。
 *
 * 设计取舍：
 * - **JSONL 追加**而不是 SQLite：无依赖、可 `tail`、写一行就是一次 `appendFile`，
 *   崩溃最多丢最后一行（半行由 `JSON.parse` 失败兜住）。本机工具的数据量（单文件
 *   上限 32MB，约十万条）用全量扫描完全够，且聚合结果按 `(size, mtimeMs)` 缓存，
 *   前端 5s 轮询不会反复扫盘。
 * - 写入串行化：`appendFile` 并发调用在多数平台上不会撕裂行，但不保证**顺序**；
 *   串行链让"落盘顺序 == 调用顺序"，也让 `flush()` 有明确语义（测试需要）。
 * - 坏行跳过并计数，**不抛异常**：一行脏数据不该让整个分析接口 500。
 */

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_RECENT_MAX = 200

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}
/**
 * 可空数值。**必须先挡 null/undefined/'' 再转数**：`Number(null) === 0`，
 * 直接转会把"没有这个指标"（非流式请求没有首字延迟）当成"首字延迟 0ms"混进均值，
 * 把平均首字延迟系统性拉低——这正是本模块测试抓到的第一处缺陷。
 */
const nullableNum = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const localIso = (at) => {
  const d = new Date(at)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 本机时区当日零点。用 `new Date(y,m,d)` 而不是 `at - at % 86400000`：后者按 UTC 切日。 */
const startOfLocalDay = (at) => {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function emptyBucket() {
  return {
    requests: 0,
    errors: 0,
    stream_requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    elapsed_ms_sum: 0,
    elapsed_ms_n: 0,
    ttft_ms_sum: 0,
    ttft_ms_n: 0,
    speed_sum: 0,
    speed_n: 0,
    /** 只有 summary 桶收集原始值用于算 P50；per-model / per-account 桶只留均值以省内存。 */
    ttft_values: null,
  }
}

function accumulate(bucket, rec, { keepValues = false } = {}) {
  bucket.requests += 1
  if (rec.error) bucket.errors += 1
  if (rec.stream) bucket.stream_requests += 1
  const prompt = num(rec.prompt_tokens)
  const completion = num(rec.completion_tokens)
  const cacheRead = num(rec.cache_read_tokens)
  const cacheCreation = num(rec.cache_creation_tokens)
  bucket.prompt_tokens += prompt
  bucket.completion_tokens += completion
  bucket.cache_read_tokens += cacheRead
  bucket.cache_creation_tokens += cacheCreation
  // 总账必须含缓存：Anthropic 口径下 `input_tokens` 不含缓存部分，
  // 只加 prompt+completion 会把命中缓存的输入整体漏掉（实测一次请求少算 35 倍）。
  bucket.total_tokens += num(rec.total_tokens) || (prompt + cacheRead + cacheCreation + completion)
  const elapsed = nullableNum(rec.elapsed_ms)
  if (elapsed !== null) {
    bucket.elapsed_ms_sum += elapsed
    bucket.elapsed_ms_n += 1
  }
  const ttft = nullableNum(rec.ttft_ms)
  if (ttft !== null) {
    bucket.ttft_ms_sum += ttft
    bucket.ttft_ms_n += 1
    if (keepValues) bucket.ttft_values.push(ttft)
  }
  const speed = nullableNum(rec.tokens_per_sec)
  if (speed !== null) {
    bucket.speed_sum += speed
    bucket.speed_n += 1
  }
}

const avg = (sum, n) => (n > 0 ? sum / n : null)
const round = (v, digits = 1) => (v === null ? null : Number(v.toFixed(digits)))

function p50(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function finalize(bucket) {
  // 命中率的分母是**全部输入**：未命中缓存的输入 + 命中缓存的 + 本次写入缓存的。
  // 只用 prompt+cache_read 会让"写入缓存"那部分凭空消失，命中率被高估。
  const cacheDenom = bucket.prompt_tokens + bucket.cache_read_tokens + bucket.cache_creation_tokens
  return {
    requests: bucket.requests,
    errors: bucket.errors,
    stream_requests: bucket.stream_requests,
    prompt_tokens: bucket.prompt_tokens,
    completion_tokens: bucket.completion_tokens,
    cache_read_tokens: bucket.cache_read_tokens,
    cache_creation_tokens: bucket.cache_creation_tokens,
    total_tokens: bucket.total_tokens,
    elapsed_ms_avg: round(avg(bucket.elapsed_ms_sum, bucket.elapsed_ms_n)),
    ttft_ms_avg: round(avg(bucket.ttft_ms_sum, bucket.ttft_ms_n)),
    // P50 比均值更能代表"通常多快"：少数慢请求会把均值拉高，让人误判整体变慢。
    ttft_ms_p50: bucket.ttft_values ? round(p50(bucket.ttft_values)) : null,
    speed_avg: round(avg(bucket.speed_sum, bucket.speed_n)),
    cache_hit_pct: cacheDenom > 0 ? round((bucket.cache_read_tokens / cacheDenom) * 100) : null,
    success_rate_pct: bucket.requests > 0 ? round(((bucket.requests - bucket.errors) / bucket.requests) * 100) : null,
  }
}

export class UsageStore {
  constructor({ dir, file, maxBytes = DEFAULT_MAX_BYTES, recentMax = DEFAULT_RECENT_MAX, now = Date.now, log = () => {} } = {}) {
    this.dir = dir ?? path.dirname(file)
    this.file = file ?? path.join(this.dir, 'usage.jsonl')
    this.maxBytes = maxBytes
    this.recentMax = Math.max(0, Math.floor(recentMax))
    this.now = now
    this.log = log
    this.recentBuf = []
    this.badLines = 0
    /** 上一次聚合的缓存：`size:mtimeMs` → 结果。文件未变就直接复用。 */
    this.cache = null
    this.chain = Promise.resolve()
    this.pending = 0
  }

  get logFile() {
    return this.file
  }

  #rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file)
      if (st.size <= this.maxBytes) return
      // 只保留一代：本机工具不需要长期归档，而无界增长会把磁盘吃光。
      fs.renameSync(this.file, `${this.file}.1`)
      this.cache = null
      this.log(`[usage] 用量日志超过 ${Math.round(this.maxBytes / 1024 / 1024)}MB，已轮转为 ${path.basename(this.file)}.1`)
    } catch {
      // 文件不存在（首次写入）或轮转失败（占用中）：继续追加，不阻断请求记账。
    }
  }

  /**
   * 追加一条记录。返回的 promise 在**该行已落盘**后 resolve。
   * 记账失败只记日志、不抛：用量是观测数据，绝不能因为它写不进去而让一个正常的
   * 模型请求变成 500——那是把观测面变成了故障面。
   */
  record(entry) {
    const at = Number(entry?.at) || this.now()
    const prompt = num(entry?.prompt_tokens)
    const completion = num(entry?.completion_tokens)
    const cacheRead = num(entry?.cache_read_tokens)
    const cacheCreation = num(entry?.cache_creation_tokens)
    const rec = {
      at,
      iso: entry?.iso || localIso(at),
      model: entry?.model ?? null,
      account: entry?.account ?? null,
      stream: entry?.stream === true,
      status: Number(entry?.status) || 0,
      error: entry?.error ?? null,
      prompt_tokens: prompt,
      completion_tokens: completion,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      // 缺省补齐时**必须含缓存**：`input_tokens` 不含缓存部分，只加 prompt+completion
      // 会把命中缓存的输入整体漏掉（与 accumulate 里同一处坑，见那里的注释）。
      total_tokens: num(entry?.total_tokens) || (prompt + cacheRead + cacheCreation + completion),
      elapsed_ms: nullableNum(entry?.elapsed_ms),
      ttft_ms: nullableNum(entry?.ttft_ms),
      tokens_per_sec: nullableNum(entry?.tokens_per_sec),
    }
    if (this.recentMax > 0) {
      this.recentBuf.unshift(rec)
      if (this.recentBuf.length > this.recentMax) this.recentBuf.length = this.recentMax
    }
    this.pending += 1
    this.chain = this.chain.then(() => {
      try {
        this.#rotateIfNeeded()
        fs.mkdirSync(this.dir, { recursive: true })
        fs.appendFileSync(this.file, JSON.stringify(rec) + '\n')
        this.cache = null
      } catch (e) {
        this.log(`[usage] 写入用量日志失败（已忽略，不影响请求）：${e?.message ?? e}`)
      } finally {
        this.pending -= 1
      }
    })
    return this.chain
  }

  /** 等待所有已入队的写入落盘。测试与优雅退出用。 */
  flush() {
    return this.chain
  }

  recent(limit = 50) {
    const n = Math.max(0, Math.floor(Number(limit) || 0))
    return this.recentBuf.slice(0, n)
  }

  #readRecords() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return { records: [], bad: 0 }
    }
    const records = []
    let bad = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed)
        if (rec && typeof rec === 'object') records.push(rec)
        else bad += 1
      } catch {
        // 写一半的半行 / 手改坏的行：跳过。计数让人能发现"账对不上"而不是静默少算。
        bad += 1
      }
    }
    return { records, bad }
  }

  #statKey() {
    try {
      const st = fs.statSync(this.file)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return 'absent'
    }
  }

  /**
   * 聚合分析。`{ summary:{today,all_time}, accounts:[…], models:[…] }`。
   * 按 `(size,mtimeMs)` 缓存：前端 5s 轮询时若期间没有新请求，不会重复扫全文件。
   */
  analytics({ now = this.now() } = {}) {
    const key = this.#statKey()
    if (this.cache && this.cache.key === key) return this.cache.value
    const { records, bad } = this.#readRecords()
    const todayStart = startOfLocalDay(now)

    const today = emptyBucket()
    today.ttft_values = []
    const allTime = emptyBucket()
    allTime.ttft_values = []
    const accounts = new Map()
    const models = new Map()

    for (const rec of records) {
      const at = Number(rec.at) || 0
      accumulate(allTime, rec, { keepValues: true })
      if (at >= todayStart) accumulate(today, rec, { keepValues: true })

      const acctKey = typeof rec.account === 'string' && rec.account ? rec.account : '(unattributed)'
      if (!accounts.has(acctKey)) {
        accounts.set(acctKey, { account: acctKey, today: emptyBucket(), all_time: emptyBucket(), today_models: {}, all_models: {} })
      }
      const acct = accounts.get(acctKey)
      const acctBucket = at >= todayStart ? acct.today : null
      accumulate(acct.all_time, rec)
      if (acctBucket) accumulate(acctBucket, rec)
      const modelKey = typeof rec.model === 'string' && rec.model ? rec.model : '(unknown)'
      const bump = (bag) => {
        const modelBucket = bag[modelKey] ?? (bag[modelKey] = emptyBucket())
        accumulate(modelBucket, rec)
      }
      bump(acct.all_models)
      if (at >= todayStart) bump(acct.today_models)

      if (!models.has(modelKey)) {
        models.set(modelKey, { id: modelKey, today: emptyBucket(), all_time: emptyBucket(), accounts: {} })
      }
      const m = models.get(modelKey)
      accumulate(m.all_time, rec)
      if (at >= todayStart) accumulate(m.today, rec)
      m.accounts[acctKey] = (m.accounts[acctKey] ?? 0) + 1
    }

    const value = {
      logFile: this.file,
      since: records.length ? records[0].iso ?? localIso(Number(records[0].at) || 0) : null,
      total_records: records.length,
      bad_lines: bad,
      summary: { today: finalize(today), all_time: finalize(allTime) },
      accounts: [...accounts.values()].map((a) => ({
        account: a.account,
        today: finalize(a.today),
        all_time: finalize(a.all_time),
        today_models: Object.fromEntries(Object.entries(a.today_models).map(([k, v]) => [k, finalize(v)])),
        all_models: Object.fromEntries(Object.entries(a.all_models).map(([k, v]) => [k, finalize(v)])),
      })),
      models: [...models.values()].map((m) => ({
        id: m.id,
        today: finalize(m.today),
        all_time: finalize(m.all_time),
        accounts: m.accounts,
      })),
    }
    this.badLines = bad
    this.cache = { key, value }
    return value
  }

  /** 按账号聚合（面板「账号透视」直接用）。 */
  byAccount(opts) {
    return this.analytics(opts).accounts
  }
}

/** 兼容旧的纯内存请求日志（`/pool/status` 仍在用），保持原有 200 条上限语义。 */
export function createRequestLog({ max = 200 } = {}) {
  const entries = []
  return {
    add(entry) {
      entries.unshift({ ...entry, at: Date.now() })
      if (entries.length > max) entries.length = max
    },
    list(limit = 50) {
      return entries.slice(0, limit)
    },
  }
}
