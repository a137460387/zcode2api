// 1005 连续熔断（benched1005）契约——2026-09-30 凌晨事故驱动。
//
// 事故：368d44de 的余额接口坚称 GLM-5.3 remaining=300 万，模型端点却每请求必回 1005。
// 两套上游口径打架时，modelQuotaExhausted 读到的永远"健康"，调度器反复派发必然失败的
// 请求（当晚 21 次 1005 全部来自该号）；客户端 retryable 重试 + 网关换号在 44 秒内连打
// 5 个号，诱发上游 3012 行为风控全池级联（15 号冷却 30 分钟）。
//
// 修复语义：同一（账号, 模型）连续 c1005Trip 次 1005 → 不看余额，对该模型雪藏
// c1005BenchMs；成功一次清零计数；雪藏按模型隔离；计数只存进程内存（this.c1005）。
import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'
import { createGateway } from '../src/gateway.js'

const mkPool = (store, clock, over = {}) => new AccountPool(store, {
  minIntervalMs: 0, // 测试不考节流；clock 完全可控
  cooldown3012Ms: 30 * 60_000,
  c1005Trip: 3,
  c1005BenchMs: 30 * 60_000,
  now: () => clock.t,
  ...over,
})

const cur = (store, acc) => store.list().find((a) => a.id === acc.id)

describe('1005 连续熔断（benched1005）', () => {
  let store, clock, pool, a1, a2
  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-c1005-'))
    store = new AccountStore(dir)
    clock = { t: 1_000_000 }
    pool = mkPool(store, clock)
    a1 = await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J' }))
    a2 = await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J' }))
    for (const a of [a1, a2]) {
      // 双模型余额都"满"——正是事故形态：余额接口说谎，端点打不出额度
      await store.update(a.id, {
        planCache: {
          plans: [],
          balances: [
            { modelName: 'GLM-5.3', total: 3_000_000, remaining: 3_000_000 },
            { modelName: 'GLM-5.3-Flash', total: 5_000_000, remaining: 5_000_000 },
          ],
        },
      })
    }
  })

  it('连续 2 次 1005 不雪藏（给瞬时型留余地），第 3 次起对该模型失效', () => {
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(true)
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(false)
    // 雪藏按模型隔离：flash 与账号级判定不受牵连
    expect(pool.healthy(cur(store, a1), 'glm-5.3-flash')).toBe(true)
    expect(pool.healthy(cur(store, a1))).toBe(true)
  })

  it('pick 按模型绕开被雪藏的号；另一模型照常选中它', () => {
    // 对称雪藏（a1@glm-5.3、a2@flash）：断言与随机生成的账号 id 排序无关
    for (let i = 0; i < 3; i++) pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    for (let i = 0; i < 3; i++) pool.markError(a2, { status: 200, code: 1005, model: 'glm-5.3-flash' })
    expect(pool.pick(null, { model: 'glm-5.3' }).account.id).toBe(a2.id)
    expect(pool.pick(null, { model: 'glm-5.3-flash' }).account.id).toBe(a1.id)
  })

  it('markSuccess 清零计数：2 败 + 1 成 + 2 败 = 不雪藏', async () => {
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    await pool.markSuccess(a1, 'glm-5.3')
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(true)
  })

  it('雪藏到期自动解除，计数从零重新累计', () => {
    for (let i = 0; i < 3; i++) pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(false)
    clock.t += 30 * 60_000 + 1
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(true)
    // 解禁后重新数：1 次不雪藏
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(true)
  })

  it('其他业务码（3012）不进入 1005 计数', () => {
    pool.markError(a1, { status: 405, code: 3012, model: 'glm-5.3' })
    pool.markError(a1, { status: 405, code: 3012, model: 'glm-5.3' })
    pool.markError(a1, { status: 200, code: 1005, model: 'glm-5.3' })
    expect(pool.healthy(cur(store, a1), 'glm-5.3')).toBe(true)
  })

  it('网关集成：1005 熔断生效 → healthy 复检失败 → 换号成功，不再透传 502', async () => {
    // c1005Trip=1：免去对"随机生成的账号 id 决定谁先被选中"的依赖——
    // 网关第一个尝试的号就是事故号，一次 1005 即熔断换号。
    const pool1 = mkPool(store, clock, { c1005Trip: 1 })
    let failingId = null
    let failCalls = 0
    const senders = {
      oauth: async ({ account }) => {
        if (failingId === null) failingId = account.id
        if (account.id === failingId) {
          failCalls++
          return { status: 200, text: async () => '{"code":1005,"msg":"exceed quota limit"}' }
        }
        return { status: 200, text: async () => '{"code":0}' }
      },
      apikey: async () => ({ status: 200, text: async () => '{"code":0}' }),
    }
    const g = createGateway({
      pool: pool1,
      paramPool: { take: async () => 'P' },
      senders,
      config: { maxRetries: 2 },
      refreshPlanCache: async () => {}, // 与生产同型：刷新后复检 healthy（此时熔断已生效）
      log: () => {},
    })
    const r = await g.complete({ model: 'glm-5.3' }, {})
    expect(r.response.status).toBe(200)
    expect(r.account.id).not.toBe(failingId)
    expect(failCalls).toBe(1) // 熔断后复检即失败，事故号只被打一次
  })
})
