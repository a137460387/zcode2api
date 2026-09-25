export class ParamPoolEmpty extends Error {
  constructor() {
    super('captcha param pool is empty')
    this.name = 'ParamPoolEmpty'
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class ParamPool {
  /**
   * `usableMs` 是"参数被上游接受的时效"，**短于** `ttlMs`（后者只是内存里保留多久）。
   *
   * 为什么必须区分这两个时间：实测陈参数会被上游判 `3007`，而池里可能全是陈参数——
   * 一次请求把 4 个陈参数挨个试完（初次 + 2 次重试）全部 3007，客户端拿到 400。
   * 与其把明知无用的参数递给上游换一个错误，不如在这里就丢掉它。
   *
   * 默认 40s 取自实测：48s 的参数已被判 3007，40s 留了一点余量。
   */
  constructor({ ttlMs = 8 * 60_000, maxSize = 6, usableMs = 40_000, now = Date.now, sleep = defaultSleep } = {}) {
    this.ttlMs = ttlMs
    this.usableMs = Math.max(0, Math.floor(Number.isFinite(usableMs) ? usableMs : 0))
    // 钳制为非负整数：maxSize 为负数会让 push() 的淘汰循环永不退出
    // （对空数组 shift() 返回 undefined 且长度恒为 0），同步死循环会挂死整个进程。
    this.maxSize = Math.max(0, Math.floor(Number.isFinite(maxSize) ? maxSize : 0))
    this.now = now
    this.sleep = sleep
    this.items = []
    this.received = 0
    this.used = 0
    /** 因超出 usableMs 被丢弃的数量：面板据此发现"产出跟不上/池在空转"。 */
    this.discarded = 0
    this.lastPushAt = 0
    this.lastConsumeAt = 0
  }

  prune() {
    this.items = this.items.filter((it) => this.now() - it.bornAt < this.ttlMs)
  }

  push(param) {
    this.prune()
    this.items.push({ param, bornAt: this.now() })
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize)
    }
    this.received += 1
    this.lastPushAt = this.now()
  }

  takeSync() {
    this.prune()
    /**
     * 先丢掉队首那些**已过可用时效**的参数。items 是按出生时间入队的，
     * 故只需看队首：队首可用则后面的都可用（更晚出生）。
     * 这些参数递给上游只会换回 3007，还会白耗一次换参重试。
     */
    while (this.items.length && this.now() - this.items[0].bornAt >= this.usableMs) {
      this.items.shift()
      this.discarded += 1
    }
    const it = this.items.shift()
    if (!it) return null
    this.used += 1
    this.lastConsumeAt = this.now()
    return it.param
  }

  async take({ waitMs = 10_000 } = {}) {
    const deadline = this.now() + waitMs
    while (true) {
      const p = this.takeSync()
      if (p) return p
      if (this.now() >= deadline) throw new ParamPoolEmpty()
      await this.sleep(Math.min(250, Math.max(0, deadline - this.now())))
      this.prune()
    }
  }

  status() {
    this.prune()
    const t = this.now()
    // 最新参数的年龄（ms）：农场页据此判断"池里还有没有新鲜参数可补"。
    // 只看池的数量是不够的——池满时农场会停止产出，池里参数逐渐变陈，
    // 取到陈参数会被上游判 3007（实测：池稳定在 3 个但最新参数已 48s 大）。
    const newestAgeMs = this.items.length
      ? t - Math.max(...this.items.map((it) => it.bornAt))
      : null
    /**
     * `usable` 是**还能被上游接受**的参数个数（年龄 < usableMs）。
     * 农场页的产出判据要用它而不是 `pool`：池里 6 个全陈时 `pool=6` 看着很健康，
     * 实际一个都不能用，而按 `pool` 判断的农场会一直不补货。
     */
    const usable = this.items.filter((it) => t - it.bornAt < this.usableMs).length
    return {
      pool: this.items.length,
      usable,
      received: this.received,
      used: this.used,
      discarded: this.discarded,
      usableMs: this.usableMs,
      lastPushAt: this.lastPushAt,
      lastConsumeAt: this.lastConsumeAt,
      newestAgeMs,
    }
  }
}
