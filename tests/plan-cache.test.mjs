import { describe, it, expect } from 'vitest'
import { createPlanCacheRefresher } from '../src/plan-cache.js'

/**
 * 假 store：只实现 refresh() 用到的 update(id, patch)（对象形态，与 AccountStore 一致）。
 */
function fakeStore() {
  const data = new Map()
  return {
    data,
    update: async (id, patch) => {
      const cur = data.get(id) ?? {}
      const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) }
      data.set(id, next)
      return next
    },
  }
}

const acc = (id = 'a1', jwt = 'J') => ({ id, type: 'oauth', jwt })

describe('plan-cache refresher', () => {
  it('刷新成功：把 fetchBalance 结果写进 store.planCache', async () => {
    const store = fakeStore()
    const balances = [{ modelName: 'GLM-5.3-Flash', remaining: 0 }]
    const refresher = createPlanCacheRefresher({
      store,
      fetchBalance: async () => ({ plans: [], balances }),
    })
    const ok = await refresher.refresh(acc('a1'))
    expect(ok).toBe(true)
    expect(store.data.get('a1').planCache.balances).toEqual(balances)
  })

  it('并发去重：同一账号的并发刷新共享一次上游查询', async () => {
    const store = fakeStore()
    let calls = 0
    const refresher = createPlanCacheRefresher({
      store,
      fetchBalance: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { plans: [], balances: [] } },
    })
    const [r1, r2] = await Promise.all([refresher.refresh(acc('a1')), refresher.refresh(acc('a1'))])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(calls).toBe(1)
  })

  it('minInterval 窗口内跳过，窗口过后恢复刷新', async () => {
    const store = fakeStore()
    let t = 1_000_000
    let calls = 0
    const refresher = createPlanCacheRefresher({
      store,
      fetchBalance: async () => { calls++; return { plans: [], balances: [] } },
      minIntervalMs: 30_000,
      now: () => t,
    })
    expect(await refresher.refresh(acc('a1'))).toBe(true)
    // 窗口内：跳过（不发上游查询）
    t += 1_000
    expect(await refresher.refresh(acc('a1'))).toBe(false)
    expect(calls).toBe(1)
    // 窗口外：再次刷新
    t += 31_000
    expect(await refresher.refresh(acc('a1'))).toBe(true)
    expect(calls).toBe(2)
  })

  it('不同账号互不影响去重窗口', async () => {
    const store = fakeStore()
    let calls = 0
    const refresher = createPlanCacheRefresher({
      store,
      fetchBalance: async () => { calls++; return { plans: [], balances: [] } },
      minIntervalMs: 30_000,
    })
    await refresher.refresh(acc('a1'))
    expect(await refresher.refresh(acc('a2'))).toBe(true)
    expect(calls).toBe(2)
  })

  it('无 jwt（apikey 等）不刷新', async () => {
    const store = fakeStore()
    let calls = 0
    const refresher = createPlanCacheRefresher({ store, fetchBalance: async () => { calls++; return {} } })
    expect(await refresher.refresh(acc('k1', null))).toBe(false)
    expect(await refresher.refresh(null)).toBe(false)
    expect(calls).toBe(0)
  })

  it('上游查询失败：返回 false、不写 store、不抛错（网关按旧缓存走透传）', async () => {
    const store = fakeStore()
    const refresher = createPlanCacheRefresher({
      store,
      fetchBalance: async () => { throw new Error('balance query failed: HTTP 500') },
    })
    await expect(refresher.refresh(acc('a1'))).resolves.toBe(false)
    expect(store.data.has('a1')).toBe(false)
  })
})
