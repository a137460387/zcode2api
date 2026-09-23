// 边界闭环 1：gate 的 blocking 必须用"健康"集合（healthy()），earliestWaitMs 的 blockingEnd 也用 healthy()。
// 读代码：pick 的 healthy = all.filter(healthy)；blocking = used.filter(nextThrottleAt > t) 且 used 来自 healthy。
// earliestWaitMs 的 healthyAccs = all.filter(healthy)。→ 两者同一集合、同一 lastUsed、同一 minIntervalMs。
// 唯一差异：pick 用 nextThrottleAt（含 cooldownUntil 的 max）；earliestWaitMs 的 blockingEnd 只用 used+MIN。
//   对健康号 cooldownUntil <= t，故 nextThrottleAt = max(cooldownUntil, used+MIN)。
//   若 cooldownUntil > used+MIN（但仍 <= t，因为健康），则 pick 的 nextThrottleAt = cooldownUntil <= t → 不算 blocking；
//   而 earliestWaitMs 的 blockingEnd = used+MIN > t 会把它算成 blocking → **两者判定不一致！**
// 这是"第二套判据"的残留：earliestWaitMs 的 blockingEnd 用 used+MIN，pick 的门用 max(cooldownUntil, used+MIN)。
// 复现：号 H，cooldownUntil = t-1（刚过冷却，健康），used = t-500 → used+MIN = t+1500 > t
//   pick 门：nextThrottleAt = max(t-1, t+1500) = t+1500 > t → blocking → 不发号 ✓
//   这时两者一致（t+1500 都 > t）。要找不一致需 cooldownUntil > used+MIN 且 cooldownUntil <= t：
//   used = t-1900（used+MIN = t+100）且 cooldownUntil = t-1（> t+100? 否）。数学上 cooldownUntil <= t，
//   而 used+MIN > t（窗内）→ used+MIN > t >= cooldownUntil → nextThrottleAt = used+MIN。两者一致。
//   反过来若窗内（used+MIN > t）则 used+MIN 一定 > cooldownUntil(<=t) → 恒一致。
//   → 对健康号，pick 的门与 earliestWaitMs 的 blockingEnd **恒一致**。证明成立，无需测试。
console.log('推理：对健康号（cooldownUntil <= t），若 used+MIN > t 则 nextThrottleAt = used+MIN > t，两者恒一致。')
console.log('唯一残留差异：earliestWaitMs 的 blockingEnd/healthyAccs 是**当前时刻**的健康集合，')
console.log('忽略"冷却号解禁之后会变成 blocking 号"——即 r3d 的最小复现。')

// 边界闭环 2：一次确认 earliestWaitMs 在"冷却号解禁时其节流窗仍剩"下报出的值，是否使 waitMs 非单调。
// 已由 r3d 证实。这里补充：非单调会不会导致 T15 的"严格按 waitMs 等待"出现负数/倒退？
// 不会：每次都是一个正数。但会多一次 round-trip（r3e 实测 2 次重试）。
console.log('结论：不变量（minIntervalMs）不破；仅 waitMs 在"冷却解禁但节流窗未清"时偏小一次，')
console.log('      造成一次多余 round-trip，且 waitMs 序列非单调。')
