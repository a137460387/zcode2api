import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 仓库卫生：**源码必须入库，密钥必须不入库**。
 *
 * 为什么需要这个测试（真实事故）：`.gitignore` 里写了不带前导斜杠的 `usage/`。
 * gitignore 的规则**不带 `/` 时匹配任意层级**，于是它既忽略了根目录的用量数据目录，
 * 也忽略了源码目录 `src/usage/` —— `src/usage/store.js` 因此**从未进过仓库**。
 *
 * 危险之处是它**完全静默**：本地一切正常（文件就在磁盘上），只有别人克隆时才暴露，
 * 而且症状是 "Cannot find module './usage/store.js'"，跟 .gitignore 看不出关系。
 *
 * 所以这里钉两个方向：
 * 1. **必须入库**：src/tests/scripts/docs 下的每个文件都不得被 ignore。
 * 2. **必须不入库**：`.env` / `panel.json` / `accounts/*` / `certs/*` / `usage/*` / `node_modules/*`。
 *    方向 2 同样重要——修方向 1 时最省事的做法就是删规则，那会把密钥提交上去。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 仓库根下**故意不入库**的名字（密钥/本机数据），做方向 1 时要排除它们。 */
const INTENTIONAL_ROOT_IGNORES = [/^\.env$/, /^panel\.json(\.tmp)?$/, /\.log$/]

const isRepo = (() => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

/**
 * 调 `git check-ignore --stdin` 批量判定**规则**是否命中。
 *
 * **必须加 `--no-index`**：默认行为会**跳过已在索引里的文件**（已跟踪的文件不再受 ignore
 * 规则约束），于是"规则明明会忽略它、只是它已经被 add 过"这种情况被判成"没被忽略"——
 * 本测试的第一版就是因此变成永真断言，拿掉 `--no-index` 后连重新引入原缺陷都测不出来。
 * 我们要问的是"这些规则会不会吞掉这个路径"，而不是"它当前是否被跟踪"。
 *
 * 退出码：**有任意一条命中返回 0，一条都没命中返回 1**（并抛异常），
 * 所以"全都没被忽略"这个正常结果会走到 catch 分支——不是错误。
 */
function ignoredAmong(paths) {
  if (!paths.length) return []
  const args = ['check-ignore', '--no-index', '--stdin']
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT, input: paths.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    if (e.status === 1) return []
    const out = String(e.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (out.length) return out
    throw e
  }
}

/** 已跟踪文件的集合（仓库相对路径）。 */
function trackedSet() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return new Set(out.split('\0').filter(Boolean))
}

/** 列出目录下所有文件（仓库相对路径，正斜杠）。 */
function walk(relDir, { recursive = true } = {}) {
  const abs = path.join(ROOT, relDir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { recursive, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => `${relDir}/${d.parentPath ? path.relative(abs, d.parentPath).replace(/\\/g, '/') + '/' : ''}${d.name}`)
    .map((p) => p.replace('//', '/'))
}

describe.skipIf(!isRepo)('仓库卫生：源码入库 / 密钥不入库', () => {
  /**
   * 主检查：**磁盘上的源码必须都已跟踪**。
   *
   * 这才是"新克隆缺文件"的正面判据，覆盖两种成因：
   * - 被 .gitignore 吞掉（本次事故）
   * - 从没 `git add` 过（同样会让克隆缺文件，而"只看 ignore 规则"查不出来）
   */
  it('src、tests、scripts、docs 下的每个文件都已入库', () => {
    const files = ['src', 'tests', 'scripts', 'docs'].flatMap((d) => walk(d))
    expect(files.length).toBeGreaterThan(40) // 目录结构本身崩了也要能发现
    const tracked = trackedSet()
    const untracked = files.filter((f) => !tracked.has(f))
    const detail = untracked.map((f) => {
      let why = '从未 git add'
      try {
        const r = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()
        if (r) why = `被规则忽略 → ${r}`
      } catch { /* 没命中规则就是单纯没 add */ }
      return `${f}  ←  ${why}`
    }).join('\n')
    expect(untracked, `以下源码/测试文件不在仓库里（新克隆会缺）：\n${detail}`).toEqual([])
  })

  /**
   * 规则层检查：**没有规则会去吞这些路径**。
   * 与上一条互补——上一条只看现状（"现在入库了吗"），这条看趋势
   * （"新增一个文件时规则会不会把它吞掉"）。本次事故正是后者：文件已经入库过一次之后，
   * 只有规则层检查才能发现"再加一个同目录文件仍会被吞"。
   */
  it('没有任何 .gitignore 规则会忽略 src/tests/scripts/docs 下的路径', () => {
    const files = ['src', 'tests', 'scripts', 'docs'].flatMap((d) => walk(d))
    const ignored = ignoredAmong(files)
    const detail = ignored.map((f) => {
      let rule = '(未知)'
      try {
        rule = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', f], { cwd: ROOT, encoding: 'utf8' }).trim()
      } catch { /* 忽略 */ }
      return `${f}  ←  ${rule}`
    }).join('\n')
    expect(ignored, `以下路径会被 .gitignore 吞掉（新克隆会缺文件）：\n${detail}`).toEqual([])
  })

  it('根目录的源码与配置文件也都入库', () => {
    const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((n) => !INTENTIONAL_ROOT_IGNORES.some((re) => re.test(n)))
    expect(rootFiles).toContain('package.json')
    const tracked = trackedSet()
    expect(rootFiles.filter((f) => !tracked.has(f))).toEqual([])
    expect(ignoredAmong(rootFiles)).toEqual([])
  })

  it('回归：src/usage/store.js 必须入库（曾被不锚定的 usage/ 吞掉）', () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'usage', 'store.js'))).toBe(true)
    expect(trackedSet().has('src/usage/store.js')).toBe(true)
    expect(ignoredAmong(['src/usage/store.js'])).toEqual([])
  })

  it('密钥与本机数据仍然不入库（修上面那条时不许把规则删掉）', () => {
    const mustIgnore = [
      '.env',
      'panel.json',
      'panel.json.tmp',
      'accounts/some-id.json',
      'certs/localhost.pem',
      'usage/usage.jsonl',
      'node_modules/some-pkg/index.js',
      '.superpowers/probe.mjs',
    ]
    const ignored = ignoredAmong(mustIgnore)
    const missed = mustIgnore.filter((p) => !ignored.includes(p))
    expect(missed, `以下路径本该被忽略却没有：${missed.join('、')}`).toEqual([])
  })

  it('certs/README.txt 是例外，必须能入库（否则 certs 目录在克隆里不存在）', () => {
    expect(ignoredAmong(['certs/README.txt'])).toEqual([])
  })
})
