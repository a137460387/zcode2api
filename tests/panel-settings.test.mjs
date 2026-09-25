import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeSettings, updateEnvFile, maskSecret, readEnvLines } from '../src/panel/settings.js'
import { ParamPool } from '../src/captcha/pool.js'
import { PanelAuth } from '../src/panel/auth.js'

let dir, envFile
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-settings-'))
  envFile = path.join(dir, '.env')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const baseConfig = () => ({
  host: '127.0.0.1', port: 28630, farmPort: 28631,
  apiKey: 'sk-zcode2api-local', poolDir: path.join(dir, 'accounts'),
  minIntervalMs: 2000, cooldown3012Ms: 30 * 60_000, paramTtlMs: 480_000, poolSize: 6,
  maxRetries: 2, farmHeadless: true, farmAutoBrowser: true,
})

const make = (over = {}) => {
  const config = baseConfig()
  const pool = { minIntervalMs: config.minIntervalMs, cooldown3012Ms: config.cooldown3012Ms }
  const paramPool = new ParamPool({ ttlMs: config.paramTtlMs, maxSize: config.poolSize })
  return { config, pool, paramPool, settings: new RuntimeSettings({ config, pool, paramPool, envFile, panelFile: path.join(dir, 'panel.json'), log: () => {}, ...over }) }
}

describe('maskSecret', () => {
  it('保留头尾、中间隐去', () => {
    expect(maskSecret('sk-zcode2api-local')).toBe('sk-zco…ocal')
  })
  it('过短的密钥整体隐去（短掩码等于没掩）', () => {
    expect(maskSecret('abc')).toBe('…')
    expect(maskSecret('123456789')).toBe('…')
  })
  it('空值回空串', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret(null)).toBe('')
  })
})

describe('updateEnvFile：只改我们管理的键', () => {
  it('命中的键原地替换，注释、空行、顺序、未管理键全部保留', () => {
    fs.writeFileSync(envFile, [
      '# 顶部注释',
      'API_KEY=old-key',
      '',
      'HOST=127.0.0.1',
      '# 关于节流的说明',
      'ACCOUNT_MIN_INTERVAL_MS=2000',
      'PORT=28630',
      '',
    ].join('\n'))
    const r = updateEnvFile(envFile, { API_KEY: 'new-key', ACCOUNT_MIN_INTERVAL_MS: '5000' })
    expect(r.changed.sort()).toEqual(['ACCOUNT_MIN_INTERVAL_MS', 'API_KEY'])
    expect(r.appended).toEqual([])
    const lines = readEnvLines(envFile)
    expect(lines[0]).toBe('# 顶部注释')
    expect(lines[1]).toBe('API_KEY=new-key')
    expect(lines[3]).toBe('HOST=127.0.0.1')
    expect(lines[4]).toBe('# 关于节流的说明')
    expect(lines[5]).toBe('ACCOUNT_MIN_INTERVAL_MS=5000')
    expect(lines[6]).toBe('PORT=28630')
  })

  it('未命中的键追加到末尾，且与最后一行之间有空行分隔', () => {
    fs.writeFileSync(envFile, 'HOST=127.0.0.1')
    const r = updateEnvFile(envFile, { POOL_SIZE: '10' })
    expect(r.appended).toEqual(['POOL_SIZE'])
    expect(readEnvLines(envFile)).toEqual(['HOST=127.0.0.1', '', 'POOL_SIZE=10', ''])
  })

  it('.env 不存在时创建（只含被写入的键）', () => {
    updateEnvFile(envFile, { API_KEY: 'k' })
    expect(fs.readFileSync(envFile, 'utf8')).toBe('API_KEY=k\n')
  })

  it('原文件末尾无换行时也不会把新键粘在旧行上', () => {
    fs.writeFileSync(envFile, 'HOST=127.0.0.1')
    updateEnvFile(envFile, { POOL_SIZE: '10' })
    const raw = fs.readFileSync(envFile, 'utf8')
    expect(raw).not.toContain('HOST=127.0.0.1POOL_SIZE')
    expect(raw.split('\n')).toContain('HOST=127.0.0.1')
  })

  it('只替换第一个同名键，重复键保持原样（不静默删行）', () => {
    fs.writeFileSync(envFile, 'API_KEY=a\nAPI_KEY=b\n')
    updateEnvFile(envFile, { API_KEY: 'c' })
    expect(readEnvLines(envFile).slice(0, 2)).toEqual(['API_KEY=c', 'API_KEY=b'])
  })

  it('无法解析的行原样保留', () => {
    fs.writeFileSync(envFile, '这不是一个配置行\nAPI_KEY=x\n')
    updateEnvFile(envFile, { API_KEY: 'y' })
    expect(readEnvLines(envFile)[0]).toBe('这不是一个配置行')
  })

  it('写入是原子的（先写 .tmp 再 rename）', () => {
    updateEnvFile(envFile, { API_KEY: 'k' })
    expect(fs.existsSync(`${envFile}.tmp`)).toBe(false)
  })
})

describe('RuntimeSettings.view', () => {
  it('密钥只回掩码，绝不回原文', () => {
    const { settings } = make()
    const v = settings.view({ farmUrl: 'http://127.0.0.1:28631/farm' })
    expect(v.apiKeySet).toBe(true)
    expect(v.apiKeyMasked).toBe('sk-zco…ocal')
    expect(JSON.stringify(v)).not.toContain('sk-zcode2api-local')
  })

  it('运行参数取自实例（而不是 config 的初始值）', () => {
    const { settings, pool, paramPool } = make()
    pool.minIntervalMs = 7777
    paramPool.ttlMs = 12345
    paramPool.maxSize = 9
    const v = settings.view()
    expect(v.runtime.minIntervalMs).toBe(7777)
    expect(v.runtime.paramTtlMs).toBe(12345)
    expect(v.runtime.poolSize).toBe(9)
    expect(v.runtime.cooldown3012Min).toBe(30)
  })

  it('未配置 API Key 时 apiKeySet 为 false', () => {
    const { settings, config } = make()
    config.apiKey = ''
    const v = settings.view()
    expect(v.apiKeySet).toBe(false)
    expect(v.apiKeyMasked).toBe('')
  })
})

describe('RuntimeSettings.save：热更新 + 写回 .env', () => {
  it('改 API Key：config 立即生效、.env 落盘、返回掩码', () => {
    const { settings, config } = make()
    fs.writeFileSync(envFile, 'API_KEY=sk-old-key-value\n')
    const r = settings.save({ apiKey: 'sk-brand-new-key-123456' })
    expect(r.errors).toEqual({})
    expect(config.apiKey).toBe('sk-brand-new-key-123456')
    expect(r.applied.apiKey).toBe('sk-bra…3456')
    expect(fs.readFileSync(envFile, 'utf8')).toContain('API_KEY=sk-brand-new-key-123456')
  })

  it('空 API Key 被拒且不改动现状', () => {
    const { settings, config } = make()
    const r = settings.save({ apiKey: '   ' })
    expect(r.errors.apiKey).toBeTruthy()
    expect(config.apiKey).toBe('sk-zcode2api-local')
  })

  it('节流间隔热更新到池实例（只改 config 对运行中的池无效）', () => {
    const { settings, config, pool } = make()
    const r = settings.save({ minIntervalMs: 5000 })
    expect(r.errors).toEqual({})
    expect(pool.minIntervalMs).toBe(5000)
    expect(config.minIntervalMs).toBe(5000)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('ACCOUNT_MIN_INTERVAL_MS=5000')
  })

  it('3012 冷却分钟数转成毫秒写入池', () => {
    const { settings, pool } = make()
    settings.save({ cooldown3012Min: 45 })
    expect(pool.cooldown3012Ms).toBe(45 * 60_000)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('COOLDOWN_3012_MIN=45')
  })

  it('参数 TTL 与池大小热更新，且缩池时裁掉多余参数', () => {
    const { settings, paramPool } = make()
    for (let i = 0; i < 6; i += 1) paramPool.push(`p${i}`)
    expect(paramPool.items).toHaveLength(6)
    settings.save({ paramTtlMs: 60_000, poolSize: 2 })
    expect(paramPool.ttlMs).toBe(60_000)
    expect(paramPool.maxSize).toBe(2)
    expect(paramPool.items).toHaveLength(2)
    const raw = fs.readFileSync(envFile, 'utf8')
    expect(raw).toContain('PARAM_TTL_MS=60000')
    expect(raw).toContain('POOL_SIZE=2')
  })

  it('非法字段单独报错，合法字段照常生效（不整份拒绝）', () => {
    const { settings, pool, config } = make()
    const r = settings.save({ minIntervalMs: 'abc', maxRetries: 3, poolSize: -1 })
    expect(r.errors.minIntervalMs).toBe('must be a number')
    expect(r.errors.poolSize).toBe('must be between 1 and 1000')
    expect(r.applied.maxRetries).toBe(3)
    expect(config.maxRetries).toBe(3)
    expect(pool.minIntervalMs).toBe(2000) // 未被非法值污染
  })

  it('越界值被拒（节流不得为 0，池大小不得为 0）', () => {
    const { settings } = make()
    expect(settings.save({ minIntervalMs: 0 }).errors.minIntervalMs).toBeTruthy()
    expect(settings.save({ poolSize: 0 }).errors.poolSize).toBeTruthy()
    expect(settings.save({ cooldown3012Min: 99999 }).errors.cooldown3012Min).toBeTruthy()
  })

  it('maxRetries 允许 0（等于不重试，是合法配置）', () => {
    const { settings, config } = make()
    expect(settings.save({ maxRetries: 0 }).errors).toEqual({})
    expect(config.maxRetries).toBe(0)
  })

  it('未传的字段不动（不会把没提交的项清零）', () => {
    const { settings, config } = make()
    settings.save({ minIntervalMs: 3000 })
    expect(config.poolSize).toBe(6)
    expect(config.apiKey).toBe('sk-zcode2api-local')
    expect(config.maxRetries).toBe(2)
  })

  it('写 .env 失败时明确回显"本次修改重启后会丢失"', () => {
    const { settings, config } = make()
    // 把 .env 的父路径做成一个文件，令 mkdir/write 必然失败
    const blocked = path.join(dir, 'blocked')
    fs.writeFileSync(blocked, 'x')
    const s2 = new RuntimeSettings({ config, pool: null, paramPool: null, envFile: path.join(blocked, '.env'), log: () => {} })
    const r = s2.save({ minIntervalMs: 4000 })
    expect(r.errors._persist).toMatch(/重启后会丢失/)
    expect(config.minIntervalMs).toBe(4000) // 内存仍生效
  })

  it('空 patch 是安全的 no-op', () => {
    const { settings, config } = make()
    const before = { ...config }
    const r = settings.save({})
    expect(r).toEqual({ applied: {}, errors: {}, env: null, restartRequired: [] })
    expect(config).toEqual(before)
  })
})

/**
 * 「完全免密」开关与监听地址。
 * 存在这两项是因为：本机访问本来就免密，用户说"设置免密"时唯一没被覆盖的场景就是
 * **从其他设备访问**——而那被两道门挡着（只监听 127.0.0.1 + 非本机要求密码）。
 */
describe('完全免密开关', () => {
  const makeWithAuth = (disableAuth = false) => {
    const config = baseConfig()
    const pool = { minIntervalMs: config.minIntervalMs, cooldown3012Ms: config.cooldown3012Ms }
    const paramPool = new ParamPool({ ttlMs: config.paramTtlMs, maxSize: config.poolSize })
    const auth = new PanelAuth({ file: path.join(dir, 'panel.json'), disableAuth, log: () => {} })
    config.panelDisableAuth = disableAuth
    const settings = new RuntimeSettings({ config, pool, paramPool, auth, envFile, panelFile: path.join(dir, 'panel.json'), log: () => {} })
    return { config, settings, auth }
  }

  it('打开后即时作用于 PanelAuth（不需要重启），并写回 .env', () => {
    const { settings, auth } = makeWithAuth(false)
    expect(auth.allow({ socket: { remoteAddress: '203.0.113.9' }, query: {}, get: () => undefined })).toBe(false)
    const r = settings.save({ panelDisableAuth: true })
    expect(r.errors).toEqual({})
    expect(r.applied.panelDisableAuth).toBe(true)
    expect(auth.disableAuth).toBe(true)
    expect(auth.allow({ socket: { remoteAddress: '203.0.113.9' }, query: {}, get: () => undefined })).toBe(true)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('PANEL_DISABLE_AUTH=1')
  })

  it('关闭后非本机重新需要密码', () => {
    const { settings, auth } = makeWithAuth(true)
    settings.save({ panelDisableAuth: false })
    expect(auth.disableAuth).toBe(false)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('PANEL_DISABLE_AUTH=0')
  })

  it('省略该字段时不动现有开关（不会因为别处保存设置而被悄悄关掉）', () => {
    const { settings, auth } = makeWithAuth(true)
    settings.save({ minIntervalMs: 5000 })
    expect(auth.disableAuth).toBe(true)
  })

  it("接受 '1'/'true'/'0' 字符串（表单提交的形态）", () => {
    const { settings, auth } = makeWithAuth(false)
    settings.save({ panelDisableAuth: '1' })
    expect(auth.disableAuth).toBe(true)
    settings.save({ panelDisableAuth: '0' })
    expect(auth.disableAuth).toBe(false)
  })
})

describe('监听地址', () => {
  it('允许 0.0.0.0 并标记需重启（不能热改，app.listen 已绑好）', () => {
    const { settings, config } = make()
    fs.writeFileSync(envFile, 'HOST=127.0.0.1\n')
    const r = settings.save({ host: '0.0.0.0' })
    expect(r.errors).toEqual({})
    expect(config.host).toBe('0.0.0.0')
    expect(r.restartRequired).toContain('host')
    expect(fs.readFileSync(envFile, 'utf8')).toContain('HOST=0.0.0.0')
  })

  it('非法地址被拒且不改动现状', () => {
    const { settings, config } = make()
    const r = settings.save({ host: 'not-an-ip' })
    expect(r.errors.host).toBeTruthy()
    expect(config.host).toBe('127.0.0.1')
  })

  it('接受具体网卡地址与回环别名', () => {
    const { settings } = make()
    for (const h of ['192.168.0.107', 'localhost', '::']) {
      expect(settings.save({ host: h }).errors).toEqual({})
    }
  })
})

describe('entryUrls：入口地址（回答"怎么进"）', () => {
  it('只监听本机时只列本机地址（列出连不上的局域网地址是误导）', () => {
    const { settings, config } = make()
    config.host = '127.0.0.1'
    const urls = settings.entryUrls()
    expect(urls).toEqual([`http://127.0.0.1:${config.port}/`])
  })

  it('监听 0.0.0.0 时列出本机与所有非内网回环的 IPv4 地址', () => {
    const { settings, config } = make()
    config.host = '0.0.0.0'
    const urls = settings.entryUrls()
    expect(urls[0]).toBe(`http://127.0.0.1:${config.port}/`)
    expect(urls.length).toBeGreaterThanOrEqual(1)
    for (const u of urls) expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/)
  })

  it('绑定具体网卡地址时把它列出来', () => {
    const { settings, config } = make()
    config.host = '192.168.0.107'
    expect(settings.entryUrls()).toEqual([`http://127.0.0.1:${config.port}/`, `http://192.168.0.107:${config.port}/`])
  })
})

// 入口清单里混进虚拟网卡会让用户照着第一个去试，然后得出"从手机打不开"的错误结论。
// 实测本机 3 个非回环地址里两个是 VMware 宿主-only 网卡，手机连不上。
describe('entryUrls 滤掉虚拟网卡', () => {
  it('VMware/WSL/Docker 等虚拟网卡不进清单，物理网卡保留', () => {
    const { settings, config } = make()
    config.host = '0.0.0.0'
    const urls = settings.entryUrls()
    for (const u of urls) {
      const ip = u.match(/\/\/([0-9.]+):/)[1]
      const names = os.networkInterfaces()
      const owner = Object.entries(names).find(([, as]) => (as ?? []).some((a) => a.address === ip))
      if (owner) expect(owner[0]).not.toMatch(/vmnet|virtualbox|hyper-?v|docker|wsl/i)
    }
    // 至少包含本机地址本身
    expect(urls[0]).toBe(`http://127.0.0.1:${config.port}/`)
  })

  it('只有虚拟网卡时退回未过滤列表（有得试好过空着）', () => {
    const { settings, config } = make()
    config.host = '0.0.0.0'
    const urls = settings.entryUrls()
    expect(urls.length).toBeGreaterThanOrEqual(1)
  })
})
