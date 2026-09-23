import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const safe = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_')

export class AccountStore {
  constructor(dir) {
    this.dir = dir
    /** 按 id 串行化的进程内写链：同一 id 的读-改-写排队执行，不同 id 互不阻塞。 */
    this.locks = new Map()
    /**
     * 每个 id 上尚未 settle 的任务数。归零才释放链条，堵住"任务已完成、只剩一个
     * 恒等回调未跑"期间被误判为空闲、从而让后来者与尚未执行的 fn 并发的窗口。
     */
    this.depth = new Map()
    fs.mkdirSync(dir, { recursive: true })
  }

  fileFor(id) {
    return path.join(this.dir, safe(id) + '.json')
  }

  /**
   * 把 fn 排到 id 的写链尾，返回本次任务结果的 promise。
   * 同一 id 的任务严格按**调用顺序**执行（入队在调用栈内同步完成）；不同 id 互不阻塞。
   * fn 必须同步完成（返回值若为 thenable 会被 update() 显式拒绝）。
   *
   * 记账规则：每次入队给该 id 记一个 pending 计数，任务 settle 时递减；归零才删链。
   * 不能只靠"链尾 === 本次 tail"判断空闲——prev 可能已 settle，则 `.then(fn)` 会
   * **同步**执行 fn；若在 fn 内又同步入队后继任务，后继的 tail 替换了 Map 条目，
   * 而先前那个 tail 的回调仍会稍后触发并看到 `locks.get(key) === tail` 已为假……
   * 更糟的是当 fn 未同步入队时，一次"看起来空"的判定会连锁唤醒所有等待者。
   * 计数器与任务一一对应，不受 then 回调触发时序影响。
   */
  withLock(id, fn) {
    const key = String(id)
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1)

    const release = () => {
      const left = (this.depth.get(key) ?? 1) - 1
      if (left > 0) {
        this.depth.set(key, left)
        return
      }
      this.depth.delete(key)
      // 仅当链尾仍指向本次任务时才删；否则是后继任务已接上，交由它释放
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
    const tail = next.then(release, release)
    this.locks.set(key, tail)
    return next
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) } catch { return null }
      })
      .filter(Boolean)
  }

  get(id) {
    try { return JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8')) } catch { return null }
  }

  /**
   * 原子写盘（同步落盘，返回后 get()/list() 立即可见）。
   * 私有：**只允许在 withLock 临界区内调用**（内部名末尾的 Unlocked 即此意）。
   * 公开的 save()/update() 都经 withLock 进入，因此同一 id 的写永远不会互相覆盖。
   * 之所以另起名字而不复用公开的 save()：save() 会再排一次队，使写入插到队尾，
   * 从而可能越过已在等待的同 id 任务、静默打乱调用顺序（不是死锁，是排队语义被破坏）。
   */
  writeUnlocked(account) {
    const file = this.fileFor(account.id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2))
    fs.renameSync(tmp, file)
    return account
  }

  /**
   * 写入账号（新增或整体覆盖）。异步：返回 Promise<account>，**resolve 时磁盘已是该内容**。
   * 无条件经 withLock 入队——同一 id 上并发的 save()/update() 严格按**调用顺序**执行，
   * save() 携带的陈旧快照不会越过（也不会回滚）先前已入队的读-改-写。
   * 入队前先做参数校验，失败时返回 rejected promise 且不产生排队任务。
   *
   * 语义提醒：save() 是"把这份快照排到调用时刻的队尾"，resolve 只保证这份快照自身已落盘；
   * 该 id 上若还有后续任务，它们仍可能在此之后改写磁盘——那时它们才是最后一次逻辑写入。
   * 需要"某 id 全部写入已完成"的调用方可 await 该 id 的任意一个写，再读 store.get()。
   *
   * 使用约定：**新增账号用 save()，修改已有账号用 update()**。
   * 对已有账号做"get() 取快照 → save(快照)"式的更新在并发下不安全：get() 是同步读文件，
   * 不会等待排队中的写入，因此可能拿到旧值并把别人的写入整体覆盖掉
   * （实测：50 次 update 自增与该式 save 并发 → 计数只剩 1）。
   * update() 在锁内以最新快照调用函数式 patch，是修改已有账号的唯一安全方式。
   */
  save(account) {
    if (!account || typeof account !== 'object') return Promise.reject(new TypeError('account must be an object'))
    const { id } = account
    if (typeof id !== 'string' || id.length === 0) {
      return Promise.reject(new TypeError(`account.id is required (got ${id === undefined ? 'undefined' : JSON.stringify(id)})`))
    }
    // 不用 async 函数：入队必须发生在**调用**的同步阶段。
    // 若把 withLock 挪进 async 体内的微任务，已排队的 update() 会先跑完，
    // 随后这份陈旧快照再落盘把它回滚——正是本轮要修的缺陷（实测 requests 归零）。
    return Promise.resolve(this.withLock(id, () => this.writeUnlocked(account)))
  }

  /**
   * 读-改-写同一账号，整体按 id 串行化。
   * patch 为对象时保持契约浅合并 {...cur, ...patch}；为函数时在临界区内以最新快照调用
   * (cur) => patch，便于自增类统计（并发调用逐个看到前一个的结果，不丢更新）。
   *
   * 函数式 patch **必须同步**：返回 thenable 会抛 TypeError。withLock 按调用顺序记账，
   * 若在临界区内 await 一个 pending promise，锁会在其 settle 前被判定为空并释放，
   * 后续任务即与它并发读写——那正是"看起来被接受、实际破锁"的静默陷阱，故显式拒绝。
   * 需要异步取数时请在调用前 await 好，再传同步 patch。
   *
   * 返回 Promise<account|null>（找不到账号时为 null）；调用方 await 后读到的即最终值。
   */
  update(id, patch) {
    // 同 save()：withLock 在调用栈内同步入队，保证"调用顺序 == 执行顺序"
    return Promise.resolve(this.withLock(id, () => {
      const cur = this.get(id)
      if (!cur) return null
      const delta = typeof patch === 'function' ? patch(cur) : patch
      if (delta !== null && typeof delta === 'object' && typeof delta.then === 'function') {
        throw new TypeError('update(id, fn): the functional patch must be synchronous; it returned a thenable, which would release the per-id lock before it settles. Await the async work before calling update() and return a plain patch object.')
      }
      const next = { ...cur, ...delta }
      this.writeUnlocked(next)
      return next
    }))
  }

  delete(id) {
    try { fs.unlinkSync(this.fileFor(id)); return true } catch { return false }
  }
}

export function newAccountFields({ provider, type, jwt = null, apiKey = null, accessToken = null, refreshToken = null, userInfo = {} }) {
  userInfo = userInfo ?? {}
  const uid = userInfo.user_id ?? userInfo.id ?? crypto.randomUUID()
  return {
    id: `${provider}:${uid}`,
    provider,
    type,
    jwt,
    apiKey,
    accessToken,
    refreshToken,
    userInfo,
    enabled: true,
    cooldownUntil: 0,
    needsRelogin: false,
    noPackage: false,
    strikes: 0,
    planCache: null,
    stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null },
    createdAt: Date.now(),
  }
}
