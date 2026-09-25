import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'

const tmpDirs = []

function tmpDirWithEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode2api-cfg-'))
  tmpDirs.push(dir)
  fs.writeFileSync(path.join(dir, '.env'), contents)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults without env', () => {
    const c = loadConfig({ rootDir: '/tmp/x', env: {} })
    expect(c.port).toBe(28630)
    expect(c.host).toBe('127.0.0.1')
    expect(c.farmPort).toBe(28631)
    expect(c.apiKey).toBe('')
    expect(c.panelPassword).toBe('')
    expect(c.chromePath).toBe('')
    expect(c.poolSize).toBe(6)
    expect(c.paramTtlMs).toBe(8 * 60_000)
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

  it('parses panel password, chrome path and param ttl', () => {
    const c = loadConfig({
      rootDir: '/tmp/x',
      env: { PANEL_PASSWORD: 'pw', CHROME_PATH: '/usr/bin/chrome', PARAM_TTL_MS: '60000' },
    })
    expect(c.panelPassword).toBe('pw')
    expect(c.chromePath).toBe('/usr/bin/chrome')
    expect(c.paramTtlMs).toBe(60000)
  })

  it('treats a whitespace-only numeric value as absent', () => {
    const c = loadConfig({ rootDir: '/tmp/x', env: { PORT: '   ', POOL_SIZE: '\t' } })
    expect(c.port).toBe(28630)
    expect(c.poolSize).toBe(6)
  })

  it('falls back to defaults for out-of-range numbers', () => {
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: '-1' } }).port).toBe(28630)
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: '70000' } }).port).toBe(28630)
    expect(loadConfig({ rootDir: '/tmp/x', env: { FARM_PORT: '0' } }).farmPort).toBe(28631)
    expect(loadConfig({ rootDir: '/tmp/x', env: { POOL_SIZE: '0' } }).poolSize).toBe(6)
    expect(loadConfig({ rootDir: '/tmp/x', env: { MAX_RETRIES: '-3' } }).maxRetries).toBe(2)
    expect(loadConfig({ rootDir: '/tmp/x', env: { PARAM_TTL_MS: '-1' } }).paramTtlMs).toBe(8 * 60_000)
    expect(loadConfig({ rootDir: '/tmp/x', env: { ACCOUNT_MIN_INTERVAL_MS: '-1' } }).minIntervalMs).toBe(2000)
    expect(loadConfig({ rootDir: '/tmp/x', env: { COOLDOWN_3012_MIN: '-1' } }).cooldown3012Ms).toBe(30 * 60_000)
  })

  it('rejects a zero account min interval so throttling cannot be disabled', () => {
    expect(loadConfig({ rootDir: '/tmp/x', env: { ACCOUNT_MIN_INTERVAL_MS: '0' } }).minIntervalMs).toBe(2000)
  })

  it('falls back to defaults for non-finite numbers', () => {
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: 'abc' } }).port).toBe(28630)
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: 'Infinity' } }).port).toBe(28630)
  })

  it('accepts boundary values', () => {
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: '1' } }).port).toBe(1)
    expect(loadConfig({ rootDir: '/tmp/x', env: { PORT: '65535' } }).port).toBe(65535)
    expect(loadConfig({ rootDir: '/tmp/x', env: { POOL_SIZE: '1' } }).poolSize).toBe(1)
    expect(loadConfig({ rootDir: '/tmp/x', env: { MAX_RETRIES: '0' } }).maxRetries).toBe(0)
    expect(loadConfig({ rootDir: '/tmp/x', env: { PARAM_TTL_MS: '0' } }).paramTtlMs).toBe(0)
  })

  it('does not pollute process.env when a custom env object is passed', () => {
    const dir = tmpDirWithEnv('PORT=9001\nAPI_KEY=from-dotenv\n')
    const env = {}
    const c = loadConfig({ rootDir: dir, env })

    expect(process.env.PORT).toBe(process.env.PORT_BEFORE ?? process.env.PORT)
    expect(process.env.API_KEY).toBe(undefined)
    expect(c.port).toBe(9001)
    expect(c.apiKey).toBe('from-dotenv')
    expect(env.PORT).toBe('9001')

    const later = loadConfig({ rootDir: '/tmp/x', env: {} })
    expect(later.port).toBe(28630)
    expect(later.apiKey).toBe('')
  })

  it('merges .env into the given env without overriding existing keys', () => {
    const dir = tmpDirWithEnv('PORT=9002\nAPI_KEY=from-dotenv\n')
    const env = { PORT: '9100' }
    const c = loadConfig({ rootDir: dir, env })

    expect(c.port).toBe(9100)
    expect(c.apiKey).toBe('from-dotenv')
    expect(process.env.API_KEY).toBe(undefined)
  })

  it('fills process.env itself when env is omitted', () => {
    const before = process.env.ZCODE2API_DOTENV_PROBE
    const dir = tmpDirWithEnv('ZCODE2API_DOTENV_PROBE=probe-value\n')
    try {
      loadConfig({ rootDir: dir })
      expect(process.env.ZCODE2API_DOTENV_PROBE).toBe('probe-value')
    } finally {
      if (before === undefined) delete process.env.ZCODE2API_DOTENV_PROBE
      else process.env.ZCODE2API_DOTENV_PROBE = before
    }
  })
})
