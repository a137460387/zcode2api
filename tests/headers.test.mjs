import { describe, it, expect } from 'vitest'
import { buildZcodePlanHeaders, buildBigModelHeaders, buildBalanceHeaders } from '../src/upstream/headers.js'

describe('buildZcodePlanHeaders', () => {
  it('replicates the official engine header set', () => {
    const h = buildZcodePlanHeaders({ jwt: 'JWT', param: 'PARAM', sessionId: 'SESS' })
    expect(h.authorization).toBe('Bearer JWT')
    expect(h['x-api-key']).toBe('JWT')
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h['x-aliyun-captcha-verify-param']).toBe('PARAM')
    expect(h['x-aliyun-captcha-verify-region']).toBe('cn')
    expect(h['user-agent']).toContain('ZCode/')
    expect(h['http-referer']).toBe('https://zcode.z.ai')
    expect(h['x-zcode-agent']).toBe('glm')
    expect(h['x-session-id']).toBe('SESS')
    for (const k of ['x-request-id', 'x-query-id', 'x-zcode-trace-id']) {
      expect(h[k]).toMatch(/[0-9a-f-]{36}/)
    }
    expect(h['content-type']).toBe('application/json')
  })
})

describe('buildBigModelHeaders', () => {
  it('uses x-api-key auth', () => {
    const h = buildBigModelHeaders({ apiKey: 'KEY' })
    expect(h['x-api-key']).toBe('KEY')
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h.authorization).toBeUndefined()
  })
})

describe('buildBalanceHeaders', () => {
  it('bare jwt + non-empty x-device-mid', () => {
    const h = buildBalanceHeaders({ jwt: 'JWT' })
    expect(h.authorization).toBe('JWT')
    expect(h['x-device-mid'].length).toBeGreaterThan(0)
  })
})
