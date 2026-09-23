import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { launchFarmBrowser } from '../src/captcha/browser.js'

// launchFarmBrowser 的核心契约（brief Interfaces）：playwright 未安装或启动失败时
// 返回 null 并打日志，「绝不让它抛异常影响主服务」。浏览器行为本身属手动 E2E，
// 这里只锁住这条降级契约。用 vi.doMock + 动态 import 注入依赖，避免顶层 hoist
// 与测试间模块缓存串扰。
afterEach(() => {
  vi.doUnmock('playwright')
  vi.resetModules()
})

describe('launchFarmBrowser（降级契约：绝不抛异常）', () => {
  it('playwright 缺失时返回 null、打日志、不抛异常', async () => {
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright'")
    })
    const { launchFarmBrowser: fresh } = await import('../src/captcha/browser.js')
    const log = vi.fn()
    await expect(fresh({ url: 'http://127.0.0.1:8080/farm', log })).resolves.toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('playwright 未安装')
    expect(log.mock.calls[0][0]).toContain('http://127.0.0.1:8080/farm')
  })

  it('browser launch 抛错时返回 null、打日志、不抛异常', async () => {
    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => {
          throw new Error("Executable doesn't exist")
        },
      },
    }))
    const { launchFarmBrowser: fresh } = await import('../src/captcha/browser.js')
    const log = vi.fn()
    await expect(fresh({ url: 'http://127.0.0.1:8080/farm', log })).resolves.toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('自动农场启动失败')
    expect(log.mock.calls[0][0]).toContain("Executable doesn't exist")
  })

  it('goto 抛错时返回 null、打日志、不抛异常', async () => {
    const closeFn = vi.fn(async () => {})
    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => {
                throw new Error('net::ERR_CONNECTION_REFUSED')
              },
            }),
          }),
          close: closeFn,
        }),
      },
    }))
    const { launchFarmBrowser: fresh } = await import('../src/captcha/browser.js')
    const log = vi.fn()
    await expect(fresh({ url: 'http://127.0.0.1:1/farm', log })).resolves.toBeNull()
    expect(log.mock.calls[0][0]).toContain('自动农场启动失败')
    expect(log.mock.calls[0][0]).toContain('net::ERR_CONNECTION_REFUSED')
    // 启动成功后失败必须回收浏览器，否则每次失败都留下一组孤儿 Chrome 进程
    // （审查实测：goto 失败一次泄漏 8 个 chrome.exe 且持续存活）。
    expect(closeFn).toHaveBeenCalledTimes(1)
  })

  it('log 缺省为 no-op 时同样不抛异常', async () => {
    vi.doMock('playwright', () => {
      throw new Error('boom')
    })
    const { launchFarmBrowser: fresh } = await import('../src/captcha/browser.js')
    await expect(fresh({ url: 'http://127.0.0.1:8080/farm' })).resolves.toBeNull()
  })
})

// 【关键回归】headless 下必须覆盖 UA。
// 默认 UA 含 `HeadlessChrome/<ver>`，阿里验证码 SDK 据此判自动化并返回 F001
// （verifyResult:false），农场一个参数都产不出来。受控实验（headless=true）：
//   默认 UA → F001 失败、0 产出；覆盖桌面 UA → 正常产出 3 个。
// 注：SDK 不检查 navigator.webdriver（实验中该标志始终为 true，不影响结果）。
//
// 这里用源码契约断言而非 mock：这是"构造 context 时必须带 userAgent"的静态约定，
// 不依赖浏览器与进程状态，跑得快且稳定。
describe('launchFarmBrowser 的 UA 覆盖（契约）', () => {
  const source = fs.readFileSync(new URL('../src/captcha/browser.js', import.meta.url), 'utf8')

  it('newContext 必须传入 userAgent', () => {
    expect(source).toMatch(/newContext\(\{\s*userAgent:/)
  })

  it('UA 常量不含 HeadlessChrome，且为桌面 Chrome 形态', () => {
    const ua = source.match(/const DESKTOP_UA =\s*\n?\s*'([^']+)'/)?.[1]
    expect(typeof ua).toBe('string')
    expect(ua).not.toContain('HeadlessChrome')
    expect(ua).toContain('Chrome/')
    expect(ua).toContain('Windows NT')
  })
})
