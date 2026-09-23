import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('returns defaults without env', () => {
    const c = loadConfig({ rootDir: '/tmp/x', env: {} })
    expect(c.port).toBe(8787)
    expect(c.host).toBe('127.0.0.1')
    expect(c.farmPort).toBe(8789)
    expect(c.apiKey).toBe('')
    expect(c.poolSize).toBe(6)
    expect(c.minIntervalMs).toBe(2000)
    expect(c.cooldown3012Ms).toBe(30 * 60_000)
    expect(c.maxRetries).toBe(2)
    expect(c.farmHeadless).toBe(true)
  })

  it('parses numeric and boolean env values', () => {
    const c = loadConfig({
      rootDir: '/tmp/x',
      env: { PORT: '9000', API_KEY: 'sk-test', POOL_SIZE: '3', FARM_HEADLESS: '0', COOLDOWN_3012_MIN: '5' },
    })
    expect(c.port).toBe(9000)
    expect(c.apiKey).toBe('sk-test')
    expect(c.poolSize).toBe(3)
    expect(c.farmHeadless).toBe(false)
    expect(c.cooldown3012Ms).toBe(5 * 60_000)
  })
})
