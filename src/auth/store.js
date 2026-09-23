import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const safe = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_')

export class AccountStore {
  constructor(dir) {
    this.dir = dir
    /** 按 id 串行化的进程内写链：同一 id 的读-改-写排队执行，不同 id 互不阻塞。 */
    this.locks = new Map()
    fs.mkdirSync(dir, { recursive: true })
  }

  fileFor(id) {
    return path.join(this.dir, safe(id) + '.json')
  }

  /**
   * 把 fn 排到 id 的写链尾并立即返回本次任务的结果 promise；fn 可返回 promise。
   * 同一 id 的任务严格按入队顺序执行，不同 id 的链条互不阻塞。
   * 链尾结算且无后续等待者时释放 Map 条目，避免长期运行下 Map 无限增长。
   */
  withLock(id, fn) {
    const key = String(id)
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }, () => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
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

  /** 原子写盘（同步落盘，返回后 get()/list() 立即可见）。 */
  write(account) {
    const file = this.fileFor(account.id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2))
    fs.renameSync(tmp, file)
    return account
  }

  /**
   * 写入账号。写盘同步完成（返回时磁盘已是最新），签名与返回类型保持不变（account 本身）。
   * 若该 id 上已有排队中的 update()，本次写入同样排队，从而不会越过前面的读-改-写。
   * 返回 account 对象本身（非 Promise）：写入已完成，不存在未结算的落盘。
   */
  save(account) {
    if (!account || typeof account !== 'object') throw new TypeError('account must be an object')
    const { id } = account
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(`account.id is required (got ${id === undefined ? 'undefined' : JSON.stringify(id)})`)
    }
    if (this.locks.has(String(id))) this.withLock(id, () => this.write(account))
    else this.write(account)
    return account
  }

  /**
   * 读-改-写同一账号，整体按 id 串行化。
   * patch 为对象时保持契约浅合并 {...cur, ...patch}；为函数时在临界区内以最新快照调用
   * (cur) => patch，便于自增类统计（并发调用逐个看到前一个的结果，不丢更新）。
   * 返回 Promise<account|null>（找不到账号时为 null）；调用方 await 后读到的即最终值。
   */
  update(id, patch) {
    return this.withLock(id, () => {
      const cur = this.get(id)
      if (!cur) return null
      const delta = typeof patch === 'function' ? patch(cur) : patch
      const next = { ...cur, ...delta }
      this.write(next)
      return next
    })
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
