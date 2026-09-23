import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const safe = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_')

export class AccountStore {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  fileFor(id) {
    return path.join(this.dir, safe(id) + '.json')
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) } catch { return null }
      })
      .filter(Boolean)
  }

  get(id) {
    try { return JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8')) } catch { return null }
  }

  save(account) {
    const file = this.fileFor(account.id)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2))
    fs.renameSync(tmp, file)
    return account
  }

  update(id, patch) {
    const cur = this.get(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    this.save(next)
    return next
  }

  delete(id) {
    try { fs.unlinkSync(this.fileFor(id)); return true } catch { return false }
  }
}

export function newAccountFields({ provider, type, jwt = null, apiKey = null, accessToken = null, refreshToken = null, userInfo = {} }) {
  const uid = userInfo.user_id ?? userInfo.id ?? crypto.randomUUID()
  return {
    id: `${provider}:${uid}`,
    provider,
    type,
    jwt,
    apiKey,
    accessToken,
    refreshToken,
    userInfo,
    enabled: true,
    cooldownUntil: 0,
    needsRelogin: false,
    noPackage: false,
    strikes: 0,
    planCache: null,
    stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null },
    createdAt: Date.now(),
  }
}
