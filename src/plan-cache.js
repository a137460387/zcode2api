/**
 * 1005 驱动的套餐缓存（planCache）刷新器。
 *
 * 为什么存在：planCache 唯一的常规写入方是面板「刷新套餐额度」（panel/api.js，手动触发），
 * 而额度会在运行中途被耗尽——上游此时回 1005（HTTP 200 包业务码），且 1005 不属于池的
 * 任何冷却/停用信号（`noPackage` 只认 1113），账号在缓存跟上前始终"健康"、被反复调度
 * （实测：9efaa210 连吃 15 次 1005 后 ecddf87c 接棒，轮询每转到一次就死一个请求）。
 *
 * 设计：让"收到 1005"这个事件本身触发一次真实上游查询，把 planCache 拉回真实值；
 * `AccountPool.healthy()` 里现成的 `modelQuotaExhausted` 随即在下次 pick 时把死号排除。
 * 网关侧在刷新后复检 healthy，不可用就换号重试——当前请求也自愈，客户端无感。
 *
 * 去重两道闸（上游查询不是免费的，且同一秒可能有 N 个并发请求同时吃 1005）：
 * - in-flight 共享：同一账号的并发刷新等同一个 promise，只发一次查询；
 * - minInterval：距上次发起刷新不足窗口的账号直接跳过——上一轮刷新的结果已写进
 *   store，网关随后的 healthy 复检查的就是 store，照样能拿到最新值。
 *
 * refresh() 绝不抛错：刷新失败（网络/凭据问题）只记日志并返回 false，网关随后的
 * healthy 复检会基于旧缓存得出"仍可用"→ 走原有 502 透传路径，行为与修复前一致。
 */
export function createPlanCacheRefresher({
  store,
  fetchBalance,
  minIntervalMs = 30_000,
  log = () => {},
  now = Date.now,
} = {}) {
  /** accountId → 上次"发起"刷新的时刻。窗口内重复触发直接跳过（结果已在 store）。 */
  const lastStartedAt = new Map()
  /** accountId → 在途刷新 promise。并发触发共享同一次上游查询。 */
  const inflight = new Map()

  async function refresh(account) {
    // apikey 账号没有 JWT、余额接口也不认它（见 panel/api.js 的同款过滤），无从刷新。
    if (!account?.jwt) return false
    const pending = inflight.get(account.id)
    if (pending) return pending
    const started = lastStartedAt.get(account.id) ?? 0
    if (now() - started < minIntervalMs) return false
    const p = (async () => {
      lastStartedAt.set(account.id, now())
      try {
        const b = await fetchBalance({ jwt: account.jwt })
        await store.update(account.id, { planCache: b })
        log(`[plan-cache] ${account.id} 套餐缓存已刷新（${(b.balances ?? []).length} 条 entitlement）`)
        return true
      } catch (e) {
        log(`[plan-cache] ${account.id} 套餐缓存刷新失败（按旧缓存继续）：${e.message}`)
        return false
      } finally {
        inflight.delete(account.id)
      }
    })()
    inflight.set(account.id, p)
    return p
  }

  return { refresh }
}
