export class ParamPoolEmpty extends Error {
  constructor() {
    super('captcha param pool is empty')
    this.name = 'ParamPoolEmpty'
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class ParamPool {
  constructor({ ttlMs = 8 * 60_000, maxSize = 6, now = Date.now, sleep = defaultSleep } = {}) {
    this.ttlMs = ttlMs
    // 钳制为非负整数：maxSize 为负数会让 push() 的淘汰循环永不退出
    // （对空数组 shift() 返回 undefined 且长度恒为 0），同步死循环会挂死整个进程。
    this.maxSize = Math.max(0, Math.floor(Number.isFinite(maxSize) ? maxSize : 0))
    this.now = now
    this.sleep = sleep
    this.items = []
    this.received = 0
    this.used = 0
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
    // 最新参数的年龄（ms）：农场页据此判断"池里还有没有新鲜参数可补"。
    // 只看池的数量是不够的——池满时农场会停止产出，池里参数逐渐变陈，
    // 取到陈参数会被上游判 3007（实测：池稳定在 3 个但最新参数已 48s 大）。
    const newestAgeMs = this.items.length
      ? this.now() - Math.max(...this.items.map((it) => it.bornAt))
      : null
    return {
      pool: this.items.length,
      received: this.received,
      used: this.used,
      lastPushAt: this.lastPushAt,
      lastConsumeAt: this.lastConsumeAt,
      newestAgeMs,
    }
  }
}
