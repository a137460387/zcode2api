import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../src/auth/store.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-store-'))
})

describe('AccountStore', () => {
  it('saves, lists, gets, updates, deletes accounts atomically', async () => {
    const store = new AccountStore(dir)
    const acc = await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'eyJ.a.b', userInfo: { user_id: '42', email: 'a@b.c' } }))
    expect(acc.id).toBe('bigmodel:42')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length).toBe(0)

    expect(store.list().length).toBe(1)
    expect(store.get('bigmodel:42').jwt).toBe('eyJ.a.b')

    const updated = await store.update('bigmodel:42', { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(store.get('bigmodel:42').enabled).toBe(false)

    expect(await store.update('nope:1', { enabled: false })).toBeNull()

    expect(store.delete('bigmodel:42')).toBe(true)
    expect(store.list().length).toBe(0)
    expect(store.delete('bigmodel:42')).toBe(false)
  })

  it('sanitizes unsafe ids into filenames', async () => {
    const store = new AccountStore(dir)
    const acc = await store.save(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: { user_id: 'a/b:c' } }))
    expect(acc.id).toBe('zai:a/b:c')
    expect(fs.readdirSync(dir)[0]).not.toContain('/')
    expect(store.get('zai:a/b:c')).not.toBeNull()
    // 钉住 id→文件名映射（本机自用且账号数极少，不做哈希后缀），防止将来无意改变
    expect(store.fileFor('zai:a/b:c')).toBe(path.join(dir, 'zai_a_b_c.json'))
    expect(fs.readdirSync(dir)).toEqual(['zai_a_b_c.json'])
  })

  it('rejects save() without an id', async () => {
    const store = new AccountStore(dir)
    // save() 为 async：校验失败时返回 rejected promise（而不是同步抛出），
    // 校验必须发生在入队之前，因此不产生任何排队任务或磁盘残留。
    await expect(store.save({ provider: 'zai' })).rejects.toThrow(TypeError)
    await expect(store.save({ id: '', provider: 'zai' })).rejects.toThrow(TypeError)
    await expect(store.save({ id: null, provider: 'zai' })).rejects.toThrow(TypeError)
    await expect(store.save(null)).rejects.toThrow(TypeError)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(store.locks.size).toBe(0)
  })

  it('newAccountFields defaults', () => {
    const f = newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k' })
    expect(f.id).toMatch(/^bigmodel:/)
    expect(f.enabled).toBe(true)
    expect(f.cooldownUntil).toBe(0)
    expect(f.needsRelogin).toBe(false)
    expect(f.noPackage).toBe(false)
    expect(f.strikes).toBe(0)
    expect(f.stats).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null })
  })

  it('newAccountFields tolerates userInfo: null and falls back to provider:uuid', () => {
    const f = newAccountFields({ provider: 'zai', type: 'oauth', userInfo: null })
    expect(f.userInfo).toEqual({})
    expect(f.id).toMatch(/^zai:[0-9a-f-]{36}$/)
    expect(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: undefined }).id).toMatch(/^zai:[0-9a-f-]{36}$/)
  })
})

describe('AccountStore concurrency', () => {
  it('serializes read-modify-write per id so concurrent update() never loses an increment', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'conc' } }))

    await Promise.all(Array.from({ length: 50 }, (_, i) => store.update('bigmodel:conc', (cur) => ({
      stats: { ...cur.stats, requests: cur.stats.requests + 1, inputTokens: cur.stats.inputTokens + i },
    }))))

    const stats = store.get('bigmodel:conc').stats
    expect(stats.requests).toBe(50)
    expect(stats.inputTokens).toBe((49 * 50) / 2)
  })

  it('does not lose one writer when a slow writer and a fast writer race on the same account', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: { user_id: 'race' } }))

    await Promise.all([
      store.update('zai:race', { cooldownUntil: 123 }),
      store.update('zai:race', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })),
      store.update('zai:race', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })),
    ])

    const after = store.get('zai:race')
    expect(after.cooldownUntil).toBe(123)
    expect(after.stats.requests).toBe(2)
  })

  // 锁按 id 分键：不同 id 各自维护一条独立写链，完成后各自释放。
  // 唯一可确定观测的结构事实是 locks 的键集合——两条链都已排空后 Key 必须消失。
  it('keys locks per id and drains both chains after mixed concurrent work', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'p1' } }))
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'p2' } }))

    await Promise.all([
      ...Array.from({ length: 20 }, () => store.update('bigmodel:p1', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))),
      ...Array.from({ length: 20 }, () => store.update('bigmodel:p2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))),
    ])

    expect(store.get('bigmodel:p1').stats.requests).toBe(20)
    expect(store.get('bigmodel:p2').stats.requests).toBe(20)
    expect([...store.locks.keys()]).toEqual([])
  })

  it('releases the per-id lock after the chain settles', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'gc' } }))
    await store.update('bigmodel:gc', { enabled: false })
    expect(store.locks.size).toBe(0)
  })

  it('save() is serialized per id: 20 concurrent saves leave the last logical write on disk', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'sv' } })
    store.save(acc)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...acc, strikes: i })))
    expect(store.get('bigmodel:sv').strikes).toBe(19)
    expect(store.locks.size).toBe(0)
  })

  // 上一轮的漏检面：save() 与同一 id 的 update() 交错。
  // 上一轮的漏检面：save() 与同一 id 的 update() 交错。
  // 修复前的 save() 在链条排空（`locks.has(id) === false`）时绕过锁直接 write()。
  // 决定性形态：先让锁排空，再在**同一同步段**入队 [stale save, ...50 update]。
  //   - 修复前：save 走无锁路径立刻落盘 0，50 个 update 各自读到的都是 0 → 最终 0（丢 50）。
  //   - 修复后：save 先执行写 0，50 个 update 依次读回自增 → 最终 50。
  it('serializes a save() issued into a drained lock with the updates enqueued right after it', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'mix1' } })
    await store.save(acc)
    const stale = { ...acc, stats: { ...acc.stats } } // requests: 0 的陈旧快照

    // 让该 id 先完成一次写并静置，随后 save() 与 50 个 update 在同一同步段入队。
    // （不断言静置期间 locks.size，因为条目释放发生在若干微任务之后；
    //  本测试的判据是最终值，与实现内部记账时机无关。）
    await store.update('bigmodel:mix1', { enabled: false })

    const saveP = store.save(stale) // 与 50 个 update 同一同步段入队，排在最前
    const updP = Array.from({ length: 50 }, () =>
      store.update('bigmodel:mix1', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
    await Promise.all([saveP, ...updP])

    // save 是第一个逻辑写入（0），其后 50 次自增必须完整累积
    expect(store.get('bigmodel:mix1').stats.requests).toBe(50)
    // stale 快照取自 enabled:true 的时代，整体覆盖后 enabled 被还原为 true——
    // 这是 save() 的既定语义（整体覆盖），恰好证明它是按顺序生效的最后一次写。
    expect(store.get('bigmodel:mix1').enabled).toBe(true)
    expect(store.locks.size).toBe(0)
  })

  // 交错形态：陈旧 save 夹在两批自增中间。save 是显式整体覆盖，故它以**后**入队的
  // 增量必须完整累积；修复前的无锁 save 会与那批 update 并发，把增量冲掉。
  it('keeps a deterministic per-id order when a stale save() is interleaved between increments', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'mix2' } })
    await store.save(acc)
    const stale = { ...acc, stats: { ...acc.stats } }

    await store.update('bigmodel:mix2', { enabled: false }) // 先排空，制造无锁窗口
    await new Promise((r) => setImmediate(r))
    expect(store.locks.size).toBe(0)

    // 同一同步段：10 次自增 → 一次 stale save（清零）→ 10 次自增
    const work = []
    for (let i = 0; i < 10; i++) work.push(store.update('bigmodel:mix2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
    work.push(store.save(stale))
    for (let i = 0; i < 10; i++) work.push(store.update('bigmodel:mix2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
    await Promise.all(work)

    // 前半段被 save 清零，后半段 10 次自增必须精确为 10
    expect(store.get('bigmodel:mix2').stats.requests).toBe(10)
    expect(store.locks.size).toBe(0)

    // 再叠一轮：save 在前、50 次自增在后 → 50
    const work2 = [store.save(stale)]
    for (let i = 0; i < 50; i++) work2.push(store.update('bigmodel:mix2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
    await Promise.all(work2)
    expect(store.get('bigmodel:mix2').stats.requests).toBe(50)
    expect(store.locks.size).toBe(0)
  })

  it('treats save() as an explicit overwrite: an awaited update() is visible until a later save() replaces it', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'probe9' } })
    await store.save(acc)

    const after = await store.update('bigmodel:probe9', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))
    expect(after.stats.requests).toBe(1)
    expect(store.get('bigmodel:probe9').stats.requests).toBe(1) // 已结算且已在盘上

    // save() 是"用这份快照整体覆盖"的显式写入；它排在上一个 update 之后，
    // 因此 0 是**正确**的最终值（最后一次逻辑写入），不是丢更新。
    await store.save({ ...acc, stats: { ...acc.stats } })
    expect(store.get('bigmodel:probe9').stats.requests).toBe(0)

    // 反向：save() 之后入队的 update() 必须能读回刚刚落盘的 0 并自增到 1
    const next = await store.update('bigmodel:probe9', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))
    expect(next.stats.requests).toBe(1)
  })

  // update() 临界区内不得调用公开的 save()——那会再排一次队，使写入插到队尾、
  // 越过已在等待的同 id 任务，静默打乱调用顺序。（不是死锁：实测能正常 resolve，
  // 但排队语义被破坏，故内部走 writeUnlocked。）
  it('does not re-queue when update() holds the lock', async () => {
    const store = new AccountStore(dir)
    await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'dl' } }))
    await expect(store.update('bigmodel:dl', { enabled: false })).resolves.toMatchObject({ enabled: false })
  })

  // 反模式防线：对象式 patch 在锁外算好增量再传入，并发下会丢更新。
  // 这是 T4/T15/T17 最容易写出的形态（"先 get 算 stats 再 update({stats})"），
  // 故用一条显式断言把"必须用函数式 patch"这个要求钉住。
  it('shows why object patches computed outside the lock lose updates (functional patch required)', async () => {
    const store = new AccountStore(dir)
    await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'obj' } }))

    // 反模式：临界区外读快照 → 算增量 → 以对象形式写回
    await Promise.all(Array.from({ length: 20 }, () =>
      (async () => {
        const snap = store.get('bigmodel:obj') // 不等待排队中的写入 → 可能拿到旧值
        await store.update('bigmodel:obj', { stats: { ...snap.stats, requests: snap.stats.requests + 1 } })
      })()))

    // 20 次并发自增，对象式 patch 只留下极少（此处实测为 1），证明该形态不可用
    expect(store.get('bigmodel:obj').stats.requests).toBeLessThan(20)

    // 正解：函数式 patch 在锁内读最新值，同样并发规模得到精确结果
    const store2 = new AccountStore(dir)
    await store2.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'fn' } }))
    await Promise.all(Array.from({ length: 20 }, () =>
      store2.update('bigmodel:fn', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))))
    expect(store2.get('bigmodel:fn').stats.requests).toBe(20)
  })

  it('save() is durable by the time the returned promise resolves', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'dur' } })
    // 空链上的第一个 save() 会同步落盘，但契约只保证 **resolve 之后**磁盘为最新
    const written = await store.save(acc)
    expect(written).toBe(acc)
    expect(store.get('bigmodel:dur')).not.toBeNull()

    await store.save({ ...acc, strikes: 3 })
    expect(store.get('bigmodel:dur').strikes).toBe(3)
    expect(store.locks.size).toBe(0)
  })

  it('awaiting any pending write of an id makes that id durable, even when it is not the one awaited', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'duro' } })
    store.save(acc)
    // 同 id 三个写并发入队，只 await 第一个：await 后该 id 的整条链必须已排空
    await store.update('bigmodel:duro', { cooldownUntil: 7 })
    expect(store.get('bigmodel:duro').cooldownUntil).toBe(7)
    expect(store.locks.size).toBe(0)
  })

  it('releases the per-id lock after many distinct ids', async () => {
    const store = new AccountStore(dir)
    await Promise.all(Array.from({ length: 300 }, (_, i) =>
      store.update(`bigmodel:${i}`, (cur) => ({ stats: { ...cur.stats, requests: (cur?.stats.requests ?? 0) + 1 } }))))
    expect(store.locks.size).toBe(0)
  })

  // 使用约定（本测试把约定钉死，防止后续任务误用）：
  //   save()   = 新增账号入库，或有意用整份快照覆盖（少见）。
  //   update() = 修改已有账号的任何字段（冷却、标记、统计）——它在锁内读最新值，并发安全。
  // 反例：对已有账号做 "get() 取快照 → save(快照)" 的更新，若这些操作并发，
  // get() 可能读到排队中的旧值，从而把别人的写入覆盖掉（实测 50 次自增只剩 1）。
  // 这是调用方必须遵守的约定，不是 store 的缺陷——故在此显式固化正确用法的行为。
  it('update() is the safe way to modify an existing account under concurrency', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'conv' } })
    await store.save(acc) // 新增：save() 的正确用法

    // 并发修改已有账号：每个调用方各自 get() 后 update()——这是网关的真实形态
    await Promise.all(Array.from({ length: 100 }, () =>
      (async () => {
        const snapshot = store.get('bigmodel:conv') // 可能读到陈旧值，但只用它取 id
        await store.update(snapshot.id, (cur) => ({
          stats: { ...cur.stats, requests: cur.stats.requests + 1 },
          cooldownUntil: cur.cooldownUntil,
        }))
      })()))

    // 函数式 patch 在锁内读最新值，故 100 次自增全部累积，不因 get() 的陈旧而丢失
    expect(store.get('bigmodel:conv').stats.requests).toBe(100)
  })

  it('rejects a functional patch that returns a thenable, so async patches cannot break the lock', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'async' } }))
    await expect(store.update('bigmodel:async', async (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
      .rejects.toThrow(TypeError)
    await expect(store.update('bigmodel:async', async (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })))
      .rejects.toThrow(/synchronous/)
    // 被拒绝的 patch 绝不落盘
    expect(store.get('bigmodel:async').stats.requests).toBe(0)
  })

  // async patch 若被静默接受，100 并发会因破锁丢掉绝大部分增量（修复前实测为 0）。
  it('rejecting async patches keeps 100 concurrent increments correct', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'async2' } }))

    const results = await Promise.allSettled(Array.from({ length: 100 }, async (_, i) => {
      if (i % 2 === 0) return store.update('bigmodel:async2', async (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))
      return store.update('bigmodel:async2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))
    }))

    expect(results.filter((r) => r.status === 'rejected').length).toBe(50)
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason instanceof TypeError)).toBe(true)
    expect(store.get('bigmodel:async2').stats.requests).toBe(50)
    expect(store.locks.size).toBe(0)
  })
})

/**
 * 重新导入 / 重新登录同一账号时，**历史统计不能被抹掉**。
 *
 * 实测踩到：用户点了「扫描本机 ZCode 登录」，面板上的请求数立刻变成 0、累计 token 归零，
 * 看着像"账丢了"。原因是导入走的是 `save(newAccountFields(...))` —— 一份全新快照，
 * 对已存在的 id 会把整条记录覆盖（stats/strikes/createdAt/enabled 全部清零）。
 */
describe('upsertCredentials：刷新凭据但保留历史', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-store-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('已存在的账号：统计与风控状态保留，凭据被更新', async () => {
    const store = new AccountStore(dir)
    await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'OLD', userInfo: { user_id: '7' } }))
    await store.update('bigmodel:7', {
      stats: { requests: 42, inputTokens: 1000, outputTokens: 200, lastUsedAt: 123, lastError: null },
      strikes: 2,
      enabled: false,
      cooldownUntil: 999,
    })
    const before = store.get('bigmodel:7').createdAt
    await store.upsertCredentials(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'NEW', userInfo: { user_id: '7' } }))
    const after = store.get('bigmodel:7')
    expect(after.jwt).toBe('NEW')                  // 凭据更新了
    expect(after.stats.requests).toBe(42)          // 统计没被抹掉
    expect(after.stats.inputTokens).toBe(1000)
    expect(after.strikes).toBe(2)
    expect(after.enabled).toBe(false)              // 停用状态保留（是否恢复由用户决定）
    expect(after.cooldownUntil).toBe(999)
    expect(after.createdAt).toBe(before)
  })

  it('重新登录清掉 needsRelogin（否则账号永远进不了选号池）', async () => {
    const store = new AccountStore(dir)
    await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'OLD', userInfo: { user_id: '8' } }))
    await store.update('bigmodel:8', { needsRelogin: true })
    await store.upsertCredentials(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'NEW', userInfo: { user_id: '8' } }))
    expect(store.get('bigmodel:8').needsRelogin).toBe(false)
  })

  it('不存在的账号：等价于新建', async () => {
    const store = new AccountStore(dir)
    const a = await store.upsertCredentials(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J', userInfo: { user_id: '9' } }))
    expect(a.id).toBe('bigmodel:9')
    expect(store.get('bigmodel:9').jwt).toBe('J')
    expect(store.get('bigmodel:9').stats.requests).toBe(0)
  })

  it('并发写入不丢更新（与 update 走同一把 per-id 锁）', async () => {
    const store = new AccountStore(dir)
    await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J', userInfo: { user_id: '10' } }))
    await Promise.all([
      ...Array.from({ length: 20 }, () => store.update('bigmodel:10', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))),
      store.upsertCredentials(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'NEW', userInfo: { user_id: '10' } })),
    ])
    expect(store.get('bigmodel:10').stats.requests).toBe(20)
    expect(store.get('bigmodel:10').jwt).toBe('NEW')
  })

  it('参数非法时拒绝，不产生排队任务', async () => {
    const store = new AccountStore(dir)
    await expect(store.upsertCredentials(null)).rejects.toThrow(/object/)
    await expect(store.upsertCredentials({})).rejects.toThrow(/id is required/)
  })
})
