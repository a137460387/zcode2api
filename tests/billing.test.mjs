import { describe, it, expect } from 'vitest'
import { fetchBalance } from '../src/billing.js'

describe('fetchBalance', () => {
  it('queries with bare jwt + x-device-mid and normalizes balances', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return {
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            plans: [{ plan_id: 'p1', name: 'Start Plan', status: 'active' }],
            balances: [{
              entitlement_id: 'ent1', show_name: 'GLM-5.3-Flash', meter: 'model_usage',
              total_units: 100, used_units: 30, available_units: 70, expires_at: 'x',
            }],
          },
        }),
      }
    }
    const r = await fetchBalance({ jwt: 'JWT', fetchImpl })
    expect(calls[0].url).toBe('https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.11.2')
    expect(calls[0].init.headers.authorization).toBe('JWT')
    expect(calls[0].init.headers['x-device-mid'].length).toBeGreaterThan(0)
    expect(r.plans[0].name).toBe('Start Plan')
    expect(r.balances[0]).toEqual({
      entitlementId: 'ent1', modelName: 'GLM-5.3-Flash', meter: 'model_usage',
      total: 100, used: 30, remaining: 70, expiresAt: 'x',
    })
  })

  it('throws on business error', async () => {
    const fetchImpl = async () => ({ status: 401, json: async () => ({ code: 3001 }) })
    await expect(fetchBalance({ jwt: 'J', fetchImpl })).rejects.toThrow('balance query failed')
  })
})

describe('fetchBalance 错误信息不泄露响应体', () => {
  it('错误信息只含 status 与 code，不回显可能含凭据的响应体', async () => {
    const fetchImpl = async () => ({
      status: 401,
      json: async () => ({ code: 3001, token: 'LEAKED_JWT_VALUE', nested: { secret: 'LEAKED_SECRET' } }),
    })
    let err = null
    try { await fetchBalance({ jwt: 'J', fetchImpl }) } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('code=3001')
    expect(err.message).not.toContain('LEAKED_JWT_VALUE')
    expect(err.message).not.toContain('LEAKED_SECRET')
  })
})
