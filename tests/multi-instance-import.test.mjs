import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import {
  deriveCredentialKey,
  decryptCredential,
  readLocalZcodeCredentials,
  candidateCredentialFiles,
  readInstanceCredentials,
} from '../src/auth/local-import.js'

const KEY = deriveCredentialKey({ platform: 'win32', home: 'C:\\Users\\tester', user: 'tester' })
let dir
const setup = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-mi-')) }

/** 与官方一致的加密（enc:v1:<iv>.<tag>.<ct>，第二段是 authTag） */
function enc(plain, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`
}

/**
 * 多开实例扫描。
 *
 * 实测用户机器：ZCode 多开管理器的每个实例有各自的数据目录
 *   - 默认实例：~/.zcode/v2/credentials.json
 *   - 多开实例：%APPDATA%\zcode-multi\<n>\data\.zcode\v2\credentials.json
 * 只认默认实例的话，"另一个客户端里已登录的账号"永远扫不到——而这正是用户来问的场景。
 * 实测确认多开实例的密钥派生不变（启动器只改数据目录，不改 home），同一个 key 能解开所有实例。
 */
describe('多开实例扫描', () => {
  const mkInstance = (appdata, n, obj) => {
    const f = path.join(appdata, 'zcode-multi', String(n), 'data', '.zcode', 'v2', 'credentials.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(obj))
    return f
  }
  const mkDefault = (home, obj) => {
    const f = path.join(home, '.zcode', 'v2', 'credentials.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(obj))
    return f
  }
  const oauthCreds = (uid, provider = 'bigmodel') => ({
    zcodejwttoken: enc(`eyJ.${uid}.sig`, KEY),
    'oauth:active_provider': enc(provider, KEY),
    [`oauth:${provider}:user_info`]: enc(JSON.stringify({ id: uid, username: 'u' + uid }), KEY),
  })

  it('候选清单包含默认实例 + 每个多开实例，且带可读标签', () => {
    setup()
    const home = path.join(dir, 'home')
    const appdata = path.join(dir, 'appdata')
    mkInstance(appdata, 1, {})
    mkInstance(appdata, 2, {})
    const list = candidateCredentialFiles({ home, appdata })
    expect(list.map((x) => x.label)).toEqual(['默认实例', '多开实例 1', '多开实例 2'])
    expect(list[1].file).toContain(path.join('zcode-multi', '1', 'data'))
  })

  it('没有多开目录时只有默认实例（不是错误）', () => {
    setup()
    const list = candidateCredentialFiles({ home: path.join(dir, 'h2'), appdata: path.join(dir, 'none') })
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('默认实例')
  })

  it('多开目录按数值排序（10 不排在 2 前面）', () => {
    setup()
    const appdata = path.join(dir, 'ad3')
    for (const n of [2, 10, 1]) mkInstance(appdata, n, {})
    const list = candidateCredentialFiles({ home: path.join(dir, 'h3'), appdata })
    expect(list.map((x) => x.label)).toEqual(['默认实例', '多开实例 1', '多开实例 2', '多开实例 10'])
  })

  it('显式指定 file 时只认它（隔离 profile 不该顺带扫别的实例）', () => {
    setup()
    const appdata = path.join(dir, 'ad4')
    mkInstance(appdata, 1, {})
    const list = candidateCredentialFiles({ home: path.join(dir, 'h4'), appdata, file: '/tmp/only.json' })
    expect(list).toEqual([{ label: '指定文件', file: '/tmp/only.json' }])
  })

  it('两个实例的账号一起导入，逐条带来源标签', () => {
    setup()
    const home = path.join(dir, 'h5')
    const appdata = path.join(dir, 'ad5')
    mkDefault(home, oauthCreds('111'))
    mkInstance(appdata, 1, oauthCreds('222'))
    const r = readLocalZcodeCredentials({ home, appdata, key: KEY })
    expect(r.ok).toBe(true)
    expect(r.accounts).toHaveLength(2)
    expect(r.accounts.map((a) => a.userInfo.user_id).sort()).toEqual(['111', '222'])
    expect(r.accounts.find((a) => a.userInfo.user_id === '222').source.label).toBe('多开实例 1')
  })

  it('user_id 从 user_info.id 归一（真实文件顶层是 id，不是 user_id）', () => {
    setup()
    const home = path.join(dir, 'h6')
    mkDefault(home, oauthCreds('81641790228295548'))
    const r = readLocalZcodeCredentials({ home, appdata: path.join(dir, 'none6'), key: KEY })
    expect(r.accounts[0].userInfo.user_id).toBe('81641790228295548')
  })

  it('多开实例没登录 → 该实例标 no_jwt，其他实例照常导入', () => {
    setup()
    const home = path.join(dir, 'h7')
    const appdata = path.join(dir, 'ad7')
    mkDefault(home, oauthCreds('111'))
    mkInstance(appdata, 1, {}) // 目录在但没登录
    const r = readLocalZcodeCredentials({ home, appdata, key: KEY })
    expect(r.ok).toBe(true)
    expect(r.accounts).toHaveLength(1)
    const s1 = r.sources.find((s) => s.label === '多开实例 1')
    expect(s1.ok).toBe(false)
    expect(s1.reason).toBe('no_jwt')
  })

  it('全部实例都扫不到 → not_found 且列出查找过的实例', () => {
    setup()
    const r = readLocalZcodeCredentials({ home: path.join(dir, 'h8'), appdata: path.join(dir, 'none8'), key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
    expect(r.message).toContain('默认实例')
  })

  it('某实例凭据解不开时，真实原因不被"未登录"掩盖', () => {
    setup()
    const home = path.join(dir, 'h9')
    const otherKey = deriveCredentialKey({ platform: 'linux', home: '/root', user: 'root' })
    const f = path.join(home, '.zcode', 'v2', 'credentials.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({
      zcodejwttoken: enc('eyJx.y.z', otherKey), 'oauth:active_provider': enc('bigmodel', otherKey),
    }))
    const r = readLocalZcodeCredentials({ home, appdata: path.join(dir, 'none9'), key: KEY })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('decrypt_failed')
  })

  it('同一个账号出现在多个实例时去重，保留默认实例那条', () => {
    setup()
    const home = path.join(dir, 'h10')
    const appdata = path.join(dir, 'ad10')
    mkDefault(home, oauthCreds('999'))
    mkInstance(appdata, 1, oauthCreds('999'))
    const r = readLocalZcodeCredentials({ home, appdata, key: KEY })
    expect(r.accounts).toHaveLength(1)
    expect(r.accounts[0].source.label).toBe('默认实例')
  })
})

/**
 * 客户端里绑定的 Coding Plan API Key。
 * 实测：这些值是真 key（`<id>.<secret>`，49 字符，含点号），能打 open.bigmodel.cn 标准通道，
 * 走标准通道**不需要 captcha**——所以与 oauth 账号分开列、一起收。
 */
describe('Coding Plan API Key', () => {
  const CP = (plan, uid) => `account-provider:coding-plan:account:${plan}:account:${uid}:api-key`
  const writeAt = (file, obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj))
    return file
  }

  it('解出 plan/uid/apiKey 三项，且与 oauth 账号并存', () => {
    setup()
    const f = path.join(dir, 'cp1.json')
    writeAt(f, {
      zcodejwttoken: enc('eyJx.y.z', KEY),
      'oauth:active_provider': enc('bigmodel', KEY),
      'oauth:bigmodel:user_info': enc(JSON.stringify({ id: '42' }), KEY),
      [CP('zai-individual-coding-plan', '5d6d2bf2-a949-47c5-a7f3-dc48cd2ad549')]: enc('aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb', KEY),
      [CP('bigmodel-individual-coding-plan', '81641790228295548')]: enc('cccccccccccccccccccccccc.dddddddddddddddddddddddd', KEY),
    })
    const r = readInstanceCredentials(f, { key: KEY })
    expect(r.ok).toBe(true)
    expect(r.oauth.jwt).toBe('eyJx.y.z')
    expect(r.apiKeys).toHaveLength(2)
    expect(r.apiKeys.map((k) => k.plan)).toContain('zai-individual-coding-plan')
    expect(r.apiKeys.map((k) => k.uid)).toContain('81641790228295548')
    expect(r.apiKeys[0].apiKey).toContain('.')
  })

  it('只有 Coding Plan key、没有 oauth 登录时也导入（两者独立）', () => {
    setup()
    const f = path.join(dir, 'cp2.json')
    writeAt(f, { [CP('bigmodel-individual-coding-plan', '777')]: enc('aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb', KEY) })
    const r = readInstanceCredentials(f, { key: KEY })
    expect(r.ok).toBe(true)
    expect(r.oauth).toBeNull()
    expect(r.apiKeys).toHaveLength(1)
  })

  it('解出来不像 API Key 的值不导入（不猜）', () => {
    setup()
    const f = path.join(dir, 'cp3.json')
    writeAt(f, {
      zcodejwttoken: enc('eyJx.y.z', KEY),
      'oauth:active_provider': enc('bigmodel', KEY),
      [CP('bigmodel-individual-coding-plan', '888')]: enc('no-dot-here', KEY),
    })
    expect(readInstanceCredentials(f, { key: KEY }).apiKeys).toEqual([])
  })

  it('两者都没有 → no_jwt（保持原有失败语义）', () => {
    setup()
    const f = path.join(dir, 'cp4.json')
    writeAt(f, { 'oauth:active_provider': enc('bigmodel', KEY) })
    expect(readInstanceCredentials(f, { key: KEY }).reason).toBe('no_jwt')
  })

  it('扫描结果里 apikey 条目 provider=bigmodel（实测两种 plan 都打这个通道）', () => {
    setup()
    const home = path.join(dir, 'hcp')
    writeAt(path.join(home, '.zcode', 'v2', 'credentials.json'), {
      [CP('zai-individual-coding-plan', 'zzz-1')]: enc('aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb', KEY),
    })
    const r = readLocalZcodeCredentials({ home, appdata: path.join(dir, 'nonecp'), key: KEY })
    const k = r.accounts.find((a) => a.type === 'apikey')
    expect(k).toBeTruthy()
    expect(k.provider).toBe('bigmodel')
    expect(k.userInfo.id).toBe('coding-plan:zzz-1')
  })
})
