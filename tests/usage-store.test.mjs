import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UsageStore, createRequestLog } from '../src/usage.js'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-usage-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const store = (opts = {}) => new UsageStore({ dir, log: () => {}, ...opts })

const read = (s) => fs.readFileSync(s.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

describe('UsageStore：落盘与最近记录', () => {
  it('record 落盘一行 JSONL，字段归一', async () => {
    const s = store()
    await s.record({ model: 'glm-5.3', account: 'bigmodel:1', stream: true, status: 200, prompt_tokens: 10, completion_tokens: 5, elapsed_ms: 120, ttft_ms: 40, tokens_per_sec: 12.5 })
    const lines = read(s)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ model: 'glm-5.3', account: 'bigmodel:1', stream: true, status: 200, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(lines[0].at).toBeGreaterThan(0)
    expect(lines[0].iso).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('total_tokens 缺省时用 prompt+completion 补齐', async () => {
    const s = store()
    await s.record({ prompt_tokens: 7, completion_tokens: 3 })
    expect(read(s)[0].total_tokens).toBe(10)
  })

  it('非法/负数指标被归零，不写入 NaN', async () => {
    const s = store()
    await s.record({ prompt_tokens: 'abc', completion_tokens: -5, elapsed_ms: NaN, ttft_ms: -1, tokens_per_sec: Infinity })
    const rec = read(s)[0]
    expect(rec.prompt_tokens).toBe(0)
    expect(rec.completion_tokens).toBe(0)
    expect(rec.elapsed_ms).toBeNull()
    expect(rec.ttft_ms).toBeNull()
    expect(rec.tokens_per_sec).toBeNull()
  })

  it('recent 按时间倒序返回，且受 recentMax 限制', async () => {
    const s = store({ recentMax: 3 })
    for (let i = 0; i < 5; i += 1) await s.record({ model: `m${i}`, at: 1000 + i })
    const r = s.recent(10)
    expect(r.map((x) => x.model)).toEqual(['m4', 'm3', 'm2'])
  })

  it('并发 record 不丢行（写入串行化）', async () => {
    const s = store()
    await Promise.all(Array.from({ length: 200 }, (_, i) => s.record({ model: `m${i % 4}`, account: 'a', at: 1000 + i })))
    await s.flush()
    expect(read(s)).toHaveLength(200)
  })

  it('目录不存在时自动创建', async () => {
    const nested = path.join(dir, 'deep', 'nested')
    const s = new UsageStore({ dir: nested, log: () => {} })
    await s.record({ model: 'm' })
    expect(fs.existsSync(path.join(nested, 'usage.jsonl'))).toBe(true)
  })

  it('写入失败不抛异常（观测面不该变成故障面）', async () => {
    const s = store()
    // 用一个"是目录"的路径当文件：appendFileSync 必然失败
    fs.mkdirSync(path.join(dir, 'as-dir'), { recursive: true })
    const broken = new UsageStore({ file: path.join(dir, 'as-dir'), log: () => {} })
    await expect(broken.record({ model: 'm' })).resolves.toBeUndefined()
    // 内存缓冲仍可用，面板至少能看到本进程的记录
    expect(broken.recent(1)).toHaveLength(1)
    void s
  })
})

describe('UsageStore：聚合分析', () => {
  it('空账返回零值结构，不抛异常', () => {
    const s = store()
    const a = s.analytics()
    expect(a.total_records).toBe(0)
    expect(a.summary.all_time.requests).toBe(0)
    expect(a.summary.all_time.success_rate_pct).toBeNull()
    expect(a.accounts).toEqual([])
    expect(a.models).toEqual([])
    expect(a.since).toBeNull()
  })

  it('按今日/累计分开统计（今日边界取本机零点）', async () => {
    const now = new Date(2026, 8, 25, 12, 0, 0).getTime() // 2026-09-25 12:00 本地
    const yesterday = new Date(2026, 8, 24, 23, 30, 0).getTime()
    const todayEarly = new Date(2026, 8, 25, 0, 5, 0).getTime()
    const s = store({ now: () => now })
    await s.record({ at: yesterday, model: 'glm-5.3', account: 'a', prompt_tokens: 100 })
    await s.record({ at: todayEarly, model: 'glm-5.3', account: 'a', prompt_tokens: 10 })
    await s.record({ at: now, model: 'glm-5.3', account: 'b', prompt_tokens: 1 })
    const a = s.analytics({ now })
    expect(a.summary.all_time.requests).toBe(3)
    expect(a.summary.all_time.prompt_tokens).toBe(111)
    expect(a.summary.today.requests).toBe(2)
    expect(a.summary.today.prompt_tokens).toBe(11)
  })

  it('错误计入 errors，成功率按 (requests-errors)/requests', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, status: 200, model: 'm' })
    await s.record({ at: now, status: 502, error: 'upstream HTTP 502', model: 'm' })
    await s.record({ at: now, status: 429, error: 'risk', model: 'm' })
    await s.record({ at: now, status: 200, model: 'm' })
    const a = s.analytics({ now })
    expect(a.summary.all_time.requests).toBe(4)
    expect(a.summary.all_time.errors).toBe(2)
    expect(a.summary.all_time.success_rate_pct).toBe(50)
  })

  it('性能均值只对"有值"的记录求平均（null 不参与、不当 0）', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm', elapsed_ms: 100, ttft_ms: 20, tokens_per_sec: 10 })
    await s.record({ at: now, model: 'm', elapsed_ms: 300, ttft_ms: 40, tokens_per_sec: 30 })
    await s.record({ at: now, model: 'm', elapsed_ms: 200, ttft_ms: null, tokens_per_sec: null })
    const a = s.analytics({ now }).summary.all_time
    expect(a.elapsed_ms_avg).toBe(200)
    expect(a.ttft_ms_avg).toBe(30)
    expect(a.speed_avg).toBe(20)
    expect(a.ttft_ms_p50).toBe(30)
  })

  it('P50 对偶数个样本取中间两个的均值', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    for (const ttft of [10, 20, 30, 40]) await s.record({ at: now, model: 'm', ttft_ms: ttft })
    expect(s.analytics({ now }).summary.all_time.ttft_ms_p50).toBe(25)
  })

  it('缓存命中率 = cache_read / 全部输入（含写入缓存那部分）', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm', prompt_tokens: 800, cache_read_tokens: 200, cache_creation_tokens: 50 })
    await s.record({ at: now, model: 'm', prompt_tokens: 1000, cache_read_tokens: 0 })
    const a = s.analytics({ now }).summary.all_time
    expect(a.prompt_tokens).toBe(1800)
    expect(a.cache_read_tokens).toBe(200)
    expect(a.cache_creation_tokens).toBe(50)
    // 200 / (1800 + 200 + 50) —— 分母含 cache_creation，否则命中率被高估
    expect(a.cache_hit_pct).toBe(9.8)
  })

  // 实测教训：Anthropic 口径下 input_tokens **不含**缓存部分。只按 prompt+completion
  // 记总账会把命中缓存的输入整体漏掉——实测一次流式请求 input=40/cache_read=1664/out=8，
  // 上游计费 +1712，而面板只显示 48（少 35 倍）。agent 客户端每轮重发大提示，这是常态。
  it('总 token 含缓存命中的输入（与上游计费口径一致）', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm', prompt_tokens: 40, cache_read_tokens: 1664, completion_tokens: 8 })
    const a = s.analytics({ now }).summary.all_time
    expect(a.total_tokens).toBe(1712)
    expect(a.prompt_tokens).toBe(40)
    expect(a.completion_tokens).toBe(8)
    expect(a.cache_hit_pct).toBe(97.7)
  })

  it('未显式给 total_tokens 时，回退算法也要含缓存', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm', prompt_tokens: 10, cache_read_tokens: 100, cache_creation_tokens: 5, completion_tokens: 1 })
    expect(s.analytics({ now }).summary.all_time.total_tokens).toBe(116)
  })

  it('无 prompt 与 cache 时命中率为 null（不伪造 0%）', () => {
    const s = store()
    expect(s.analytics().summary.all_time.cache_hit_pct).toBeNull()
  })

  it('按账号与按模型分别聚合，含每账号的模型细分', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'glm-5.3', account: 'bigmodel:1', prompt_tokens: 10 })
    await s.record({ at: now, model: 'glm-5.3', account: 'bigmodel:1', prompt_tokens: 20 })
    await s.record({ at: now, model: 'glm-5.3-flash', account: 'bigmodel:1', prompt_tokens: 5 })
    await s.record({ at: now, model: 'glm-5.3', account: 'zai:2', prompt_tokens: 1 })
    const a = s.analytics({ now })
    const byAcct = Object.fromEntries(a.accounts.map((x) => [x.account, x]))
    expect(byAcct['bigmodel:1'].all_time.requests).toBe(3)
    expect(byAcct['bigmodel:1'].all_time.prompt_tokens).toBe(35)
    expect(Object.keys(byAcct['bigmodel:1'].all_models).sort()).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(byAcct['bigmodel:1'].all_models['glm-5.3'].requests).toBe(2)
    expect(byAcct['zai:2'].all_time.requests).toBe(1)
    const byModel = Object.fromEntries(a.models.map((x) => [x.id, x]))
    expect(byModel['glm-5.3'].all_time.requests).toBe(3)
    expect(byModel['glm-5.3'].accounts).toEqual({ 'bigmodel:1': 2, 'zai:2': 1 })
    expect(byModel['glm-5.3-flash'].all_time.requests).toBe(1)
  })

  it('缺 account 的记录归入 (unattributed)，缺 model 归入 (unknown)', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm' })
    await s.record({ at: now, account: 'a' })
    const a = s.analytics({ now })
    expect(a.accounts.map((x) => x.account)).toContain('(unattributed)')
    expect(a.models.map((x) => x.model ?? x.id)).toContain('(unknown)')
  })

  it('坏行被跳过并计数，其余记录照常统计', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm' })
    fs.appendFileSync(s.logFile, '{"model":"broken"\n')     // 写一半的半行
    fs.appendFileSync(s.logFile, 'not json at all\n')
    fs.appendFileSync(s.logFile, '"just a string"\n')       // 合法 JSON 但不是对象
    fs.appendFileSync(s.logFile, '\n')                      // 空行
    const a = s.analytics({ now })
    expect(a.total_records).toBe(1)
    expect(a.bad_lines).toBe(3)
    expect(a.summary.all_time.requests).toBe(1)
  })

  it('文件未变时复用缓存，变化后重算', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm' })
    const first = s.analytics({ now })
    expect(s.analytics({ now })).toBe(first) // 同一对象 = 命中缓存
    await s.record({ at: now, model: 'm' })
    const third = s.analytics({ now })
    expect(third).not.toBe(first)
    expect(third.summary.all_time.requests).toBe(2)
  })

  it('since 取首条记录时间', async () => {
    const s = store()
    await s.record({ at: new Date(2026, 0, 2, 3, 4, 5).getTime(), model: 'm' })
    expect(s.analytics().since).toBe('2026-01-02 03:04:05')
  })

  it('byAccount 与 analytics().accounts 同源', async () => {
    const now = 1_800_000_000_000
    const s = store({ now: () => now })
    await s.record({ at: now, model: 'm', account: 'a' })
    expect(s.byAccount({ now })).toEqual(s.analytics({ now }).accounts)
  })
})

describe('UsageStore：轮转', () => {
  it('超过 maxBytes 时轮转为 .1 并重新开始，统计不串账', async () => {
    const now = 1_800_000_000_000
    const s = store({ maxBytes: 300, now: () => now })
    for (let i = 0; i < 20; i += 1) await s.record({ at: now, model: 'glm-5.3', account: 'a', prompt_tokens: 1 })
    expect(fs.existsSync(`${s.logFile}.1`)).toBe(true)
    const a = s.analytics({ now })
    // 轮转后当前文件里的记录数应显著少于总数，且不报错
    expect(a.total_records).toBeGreaterThan(0)
    expect(a.total_records).toBeLessThan(20)
    expect(a.summary.all_time.prompt_tokens).toBe(a.total_records)
  })
})

describe('createRequestLog（旧的内存日志，保留兼容）', () => {
  it('倒序返回且受 max 限制', () => {
    const log = createRequestLog({ max: 2 })
    log.add({ model: 'a' })
    log.add({ model: 'b' })
    log.add({ model: 'c' })
    expect(log.list().map((x) => x.model)).toEqual(['c', 'b'])
  })
})
