import { describe, it, expect, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deriveCredentialKey,
  decryptCredential,
  credentialsPath,
  readLocalZcodeCredentials,
} from '../src/auth/local-import.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-imp-'))
})

/** 按官方格式加密：enc:v1:<b64url(iv)>.<b64url(tag)>.<b64url(ct)>（第二段是 authTag） */
function enc(plain, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`
}

const KEY = deriveCredentialKey({ platform: 'win32', home: 'C:\\Users\\tester', user: 'tester' })
const writeCreds = (obj, file = path.join(dir, 'credentials.json')) => {
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

describe('deriveCredentialKey / decryptCredential', () => {
  it('密钥派生与官方一致：sha256(fallback:platform:home:user)', () => {
    const expected = crypto.createHash('sha256').update('zcode-credential-fallback:win32:C:\\Users\\tester:tester').digest()
    expect(deriveCredentialKey({ platform: 'win32', home: 'C:\\Users\\tester', user: 'tester' }).equals(expected)).toBe(true)
  })

  it('可经 ZCODE_CREDENTIAL_SECRET 覆盖（与桌面端 env 覆盖行为一致）', () => {
    const a = deriveCredentialKey({ secret: 'custom-secret' })
    const b = crypto.createHash('sha256').update('custom-secret').digest()
    expect(a.equals(b)).toBe(true)
  })

  it('往返加解密', () => {
    expect(decryptCredential(enc('eyJhbGciOi.payload.sig', KEY), KEY)).toBe('eyJhbGciOi.payload.sig')
  })

  it('非密文原样返回（明文 json 文件也能读）', () => {
    expect(decryptCredential('plain-value', KEY)).toBe('plain-value')
  })

  it('格式非法与密钥不符都抛错（不静默返回垃圾）', () => {
    expect(() => decryptCredential('enc:v1:onlyonesegment', KEY)).toThrow(/malformed/)
    const otherKey = deriveCredentialKey({ platform: 'linux', home: '/root', user: 'root' })
    expect(() => decryptCredential(enc('secret', KEY), otherKey)).toThrow()
  })
})

describe('credentialsPath', () => {
  it('默认拼 home/.zcode/v2/credentials.json', () => {
    const p = credentialsPath({ home: '/home/u' })
    expect(p.endsWith(path.join('.zcode', 'v2', 'credentials.json'))).toBe(true)
  })
  it('可显式指定文件', () => {
    expect(credentialsPath({ home: '/home/u', file: '/tmp/x.json' })).toBe('/tmp/x.json')
  })
})

describe('readLocalZcodeCredentials', () => {
  it('文件不存在 → not_found（不抛异常）', () => {
    const r = readLocalZcodeCredentials({ file: path.join(dir, 'nope.json'), key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
    expect(r.message).toContain('未找到')
  })

  it('文件不是合法 JSON → unreadable', () => {
    const f = path.join(dir, 'bad.json')
    fs.writeFileSync(f, '{ not json')
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unreadable')
  })

  it('正常凭据 → 解出 jwt/provider/userInfo', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiNDIifQ.sig'
    const f = writeCreds({
      zcodejwttoken: enc(jwt, KEY),
      'oauth:active_provider': enc('bigmodel', KEY),
      'oauth:bigmodel:user_info': enc(JSON.stringify({ user_id: '42', email: 'a@b.c', name: '某人' }), KEY),
      'oauth:bigmodel:access_token': enc('AT', KEY),
      'oauth:bigmodel:refresh_token': enc('RT', KEY),
    })
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(true)
    expect(r.accounts).toHaveLength(1)
    const [a] = r.accounts
    expect(a.jwt).toBe(jwt)
    expect(a.provider).toBe('bigmodel')
    expect(a.accessToken).toBe('AT')
    expect(a.refreshToken).toBe('RT')
    expect(a.userInfo.email).toBe('a@b.c')
  })

  it('active_provider=zai 时读 zai 的 user_info', () => {
    const jwt = 'eyJx.y.z'
    const f = writeCreds({
      zcodejwttoken: enc(jwt, KEY),
      'oauth:active_provider': enc('zai', KEY),
      'oauth:zai:user_info': enc(JSON.stringify({ user_id: 'z1', email: 'z@a.b' }), KEY),
    })
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(true)
    expect(r.accounts[0].provider).toBe('zai')
    expect(r.accounts[0].userInfo.email).toBe('z@a.b')
  })

  it('密钥不符（跨机器复制的凭据）→ decrypt_failed 且提示明确', () => {
    const otherKey = deriveCredentialKey({ platform: 'linux', home: '/root', user: 'root' })
    const f = writeCreds({ zcodejwttoken: enc('eyJx.y.z', otherKey), 'oauth:active_provider': enc('bigmodel', otherKey) })
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('decrypt_failed')
    expect(r.message).toContain('重新登录')
  })

  it('没有 zcodejwttoken → no_jwt（区别于解密失败）', () => {
    const f = writeCreds({ 'oauth:active_provider': enc('bigmodel', KEY) })
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_jwt')
  })

  it('user_info 解不开不影响可用性（JWT 才是请求凭据）', () => {
    const jwt = 'eyJx.y.z'
    const f = writeCreds({
      zcodejwttoken: enc(jwt, KEY),
      'oauth:active_provider': enc('bigmodel', KEY),
      'oauth:bigmodel:user_info': 'enc:v1:broken',
    })
    const r = readLocalZcodeCredentials({ file: f, key: KEY })
    expect(r.ok).toBe(true)
    expect(r.accounts[0].jwt).toBe(jwt)
    expect(r.accounts[0].userInfo).toEqual({})
  })
})
