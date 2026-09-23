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
  it('saves, lists, gets, updates, deletes accounts atomically', () => {
    const store = new AccountStore(dir)
    const acc = store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'eyJ.a.b', userInfo: { user_id: '42', email: 'a@b.c' } }))
    expect(acc.id).toBe('bigmodel:42')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length).toBe(0)

    expect(store.list().length).toBe(1)
    expect(store.get('bigmodel:42').jwt).toBe('eyJ.a.b')

    const updated = store.update('bigmodel:42', { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(store.get('bigmodel:42').enabled).toBe(false)

    expect(store.update('nope:1', { enabled: false })).toBeNull()

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
})
