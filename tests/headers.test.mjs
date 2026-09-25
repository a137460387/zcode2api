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
    expect(h['x-query-id']).toBeUndefined()
    expect(h['x-zcode-app-version']).toBeTruthy()
    expect(h['accept-encoding']).toBe('gzip')
    expect(h['x-zcode-agent']).toBe('glm')
    // 官方形态（start-plan 路径）不带 x-session-id —— 见 headers.js 注释
    // 官方形态只带 x-request-id 与 x-zcode-trace-id（无 x-query-id）
    for (const k of ['x-request-id', 'x-zcode-trace-id']) {
      expect(h[k]).toMatch(/[0-9a-f-]{36}/)
    }
    expect(h['content-type']).toBe('application/json')
  })

  // 上游要求的是"同一 token 双写"，不是"两个头各自等于某个值"。
  // 用两个不同的入参做构造性证明：authorization 去掉 Bearer 前缀后必须恒等于 x-api-key。
  it('writes the same token into both authorization and x-api-key', () => {
    for (const jwt of ['eyJ.aaa.bbb', 'another-token', 'x']) {
      const h = buildZcodePlanHeaders({ jwt, param: 'P', sessionId: 'S' })
      expect(h.authorization).toBe(`Bearer ${jwt}`)
      expect(h['x-api-key']).toBe(jwt)
      expect(h.authorization.slice('Bearer '.length)).toBe(h['x-api-key'])
    }
  })

  // 完整性：captcha 双头缺一不可（缺 param 或 region 都会被上游 3007 拒绝）。
  it('always carries both captcha headers', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    expect(Object.keys(h)).toContain('x-aliyun-captcha-verify-param')
    expect(Object.keys(h)).toContain('x-aliyun-captcha-verify-region')
  })

  it('generates fresh UUIDs on every call', () => {
    const a = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    const b = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    for (const k of ['x-request-id', 'x-zcode-trace-id']) {
      expect(a[k]).not.toBe(b[k])
    }
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
