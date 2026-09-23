import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../src/auth/store.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-store-'))
})

describe('AccountStore', () => {
  it('saves, lists, gets, updates, deletes accounts atomically', async () => {
    const store = new AccountStore(dir)
    const acc = store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'eyJ.a.b', userInfo: { user_id: '42', email: 'a@b.c' } }))
    expect(acc.id).toBe('bigmodel:42')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length).toBe(0)

    expect(store.list().length).toBe(1)
    expect(store.get('bigmodel:42').jwt).toBe('eyJ.a.b')

    const updated = await store.update('bigmodel:42', { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(store.get('bigmodel:42').enabled).toBe(false)

    expect(await store.update('nope:1', { enabled: false })).toBeNull()

    expect(store.delete('bigmodel:42')).toBe(true)
    expect(store.list().length).toBe(0)
    expect(store.delete('bigmodel:42')).toBe(false)
  })

  it('sanitizes unsafe ids into filenames', () => {
    const store = new AccountStore(dir)
    const acc = store.save(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: { user_id: 'a/b:c' } }))
    expect(acc.id).toBe('zai:a/b:c')
    expect(fs.readdirSync(dir)[0]).not.toContain('/')
    expect(store.get('zai:a/b:c')).not.toBeNull()
    // 钉住 id→文件名映射（本机自用且账号数极少，不做哈希后缀），防止将来无意改变
    expect(store.fileFor('zai:a/b:c')).toBe(path.join(dir, 'zai_a_b_c.json'))
    expect(fs.readdirSync(dir)).toEqual(['zai_a_b_c.json'])
  })

  it('rejects save() without an id', () => {
    const store = new AccountStore(dir)
    expect(() => store.save({ provider: 'zai' })).toThrow(TypeError)
    expect(() => store.save({ id: '', provider: 'zai' })).toThrow(TypeError)
    expect(() => store.save({ id: null, provider: 'zai' })).toThrow(TypeError)
    expect(() => store.save(null)).toThrow(TypeError)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('newAccountFields defaults', () => {
    const f = newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k' })
    expect(f.id).toMatch(/^bigmodel:/)
    expect(f.enabled).toBe(true)
    expect(f.cooldownUntil).toBe(0)
    expect(f.needsRelogin).toBe(false)
    expect(f.noPackage).toBe(false)
    expect(f.strikes).toBe(0)
    expect(f.stats).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null })
  })

  it('newAccountFields tolerates userInfo: null and falls back to provider:uuid', () => {
    const f = newAccountFields({ provider: 'zai', type: 'oauth', userInfo: null })
    expect(f.userInfo).toEqual({})
    expect(f.id).toMatch(/^zai:[0-9a-f-]{36}$/)
    expect(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: undefined }).id).toMatch(/^zai:[0-9a-f-]{36}$/)
  })
})

describe('AccountStore concurrency', () => {
  it('serializes read-modify-write per id so concurrent update() never loses an increment', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'conc' } }))

    await Promise.all(Array.from({ length: 50 }, (_, i) => store.update('bigmodel:conc', (cur) => ({
      stats: { ...cur.stats, requests: cur.stats.requests + 1, inputTokens: cur.stats.inputTokens + i },
    }))))

    const stats = store.get('bigmodel:conc').stats
    expect(stats.requests).toBe(50)
    expect(stats.inputTokens).toBe((49 * 50) / 2)
  })

  it('does not lose one writer when a slow writer and a fast writer race on the same account', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'zai', type: 'oauth', userInfo: { user_id: 'race' } }))

    await Promise.all([
      store.update('zai:race', { cooldownUntil: 123 }),
      store.update('zai:race', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })),
      store.update('zai:race', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } })),
    ])

    const after = store.get('zai:race')
    expect(after.cooldownUntil).toBe(123)
    expect(after.stats.requests).toBe(2)
  })

  it('does not serialize across different ids', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'p1' } }))
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'p2' } }))

    await Promise.all([
      ...Array.from({ length: 20 }, () => store.update('bigmodel:p1', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))),
      ...Array.from({ length: 20 }, () => store.update('bigmodel:p2', (cur) => ({ stats: { ...cur.stats, requests: cur.stats.requests + 1 } }))),
    ])

    expect(store.get('bigmodel:p1').stats.requests).toBe(20)
    expect(store.get('bigmodel:p2').stats.requests).toBe(20)
  })

  it('releases the per-id lock after the chain settles', async () => {
    const store = new AccountStore(dir)
    store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'gc' } }))
    await store.update('bigmodel:gc', { enabled: false })
    expect(store.locks.size).toBe(0)
  })

  it('save() itself is serialized and keeps the last write visible on disk', async () => {
    const store = new AccountStore(dir)
    const acc = newAccountFields({ provider: 'bigmodel', type: 'oauth', userInfo: { user_id: 'sv' } })
    store.save(acc)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...acc, strikes: i })))
    expect(store.get('bigmodel:sv').strikes).toBe(19)
  })
})
