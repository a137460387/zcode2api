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
    this.maxSize = maxSize
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
    while (this.items.length > this.maxSize) this.items.shift()
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
    return {
      pool: this.items.length,
      received: this.received,
      used: this.used,
      lastPushAt: this.lastPushAt,
      lastConsumeAt: this.lastConsumeAt,
    }
  }
}
