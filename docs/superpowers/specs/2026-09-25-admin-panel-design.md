# 网关后台管理面板 设计

参考实现：`D:\code\Ai\workbuddy2api-intl`（`dashboard.html` + `wb_proxy.py` 的 `/panel/*`、`/accounts/*`、`/usage/*`）。
本文只记**决策与契约**，不重复参考项目的实现细节。

## 1. 目标

把 zcode2api 的看板从「只读展示 + 少量开关」升级为**可用的账号管理后台**：

1. 账号全生命周期：新增（OAuth / API Key / 本机导入）、启用停用、批量操作、刷新额度、删除。
2. 账号健康可见：套餐余量、冷却剩余、3012 strikes、最近错误、是否需重登。
3. 用量可分析：持久化请求日志，按今日/累计、按账号、按模型聚合，含首字延迟与生成速度。
4. 面板自身可管理：访问密码、运行参数、密钥，且**改完重启仍在**。

## 2. 面板鉴权（新增，参考项目最值得抄的部分）

现状缺陷：非本机访问靠 `x-panel-password` 请求头校验，而浏览器打开 `http://host:28630/`
**无法设置请求头**——即非本机用户根本打不开看板，该分支等于死代码。

方案（`src/panel/auth.js`）：

| 项 | 决定 |
|---|---|
| 密码存储 | `panel.json`（rootDir），`scrypt(N=16384,r=8,p=1)` + 16 字节随机盐，只存盐与哈希 |
| 引导密码 | 未生成 `panel.json` 时用 `.env` 的 `PANEL_PASSWORD`；两者都无 → 视为**未设置密码** |
| 未设置密码时 | 本机放行；**非本机一律 401**（不引入参考项目那种默认 `admin` 弱口令） |
| 会话 | 内存 Map，键为 `sha256(token)`（不驻留明文 token），值 `{at}`，TTL 7 天，上限 200 条 |
| token 传递 | `x-panel-token` 请求头（主） / `?panel=`（兼容参考项目用法） / `x-panel-password`（旧脚本兼容） |
| 改密 | 校验旧密码 → 写新哈希 → **吊销全部会话**并签发新 token（返回给调用方，避免自己也被踢出） |
| 本机判定 | `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；可用 `PANEL_LOCAL_BYPASS=0` 关闭放行 |
| 比较 | `crypto.timingSafeEqual`，长度不等先归一到等长再比，避免长度侧信道 |

## 3. 账号管理 API（全部挂 `panelAuth`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/panel/status` | **免鉴权**：`{ passwordRequired, authenticated, localBypass, passwordSource, hasPassword }` |
| POST | `/panel/login` | `{password}` → `{token}`；错误密码 401 |
| POST | `/panel/logout` | 吊销当前 token |
| POST | `/panel/password` | `{current,new}` → `{token}` |
| GET | `/accounts` | 账号列表（**脱敏**：只回 `hasJwt/hasApiKey` + 掩码，绝不回 jwt/apiKey/accessToken） |
| POST | `/accounts/set` | `{id,enabled}` |
| POST | `/accounts/set-all` | `{enabled}` 批量 |
| POST | `/accounts/delete` | `{id}` |
| POST | `/accounts/add-apikey` | `{name,apiKey}` → 建 `apikey` 类型账号（补上「手工丢文件」的体验缺口） |
| POST | `/accounts/balance/refresh` | `{id?}`；不传 id 刷全部 oauth 账号 |
| POST | `/accounts/import/local` | 已有 |
| POST | `/accounts/login/:provider/{start,poll,cancel}` | 已有 |
| GET | `/pool/status` | 已有，保留（旧看板/脚本兼容） |

`GET /accounts` 每项字段：
`id, provider, type, enabled, needsRelogin, noPackage, strikes, cooldownRemainMs, cooldownUntilIso,
name, email, userId, planCache, stats{requests,inputTokens,outputTokens,lastUsedAt,lastUsedAtIso,lastError,lastErrorIso},
createdAt, createdAtIso, hasJwt, hasApiKey, secretMask, healthy`

**关键**：`stats.lastUsedAt` 是池内时钟值（注入假时钟时不是真纪元），面板渲染绝对时间会得到 1970。
故服务端额外给出 `lastUsedAtIso`——用**真实时钟**在管理面换算，前端只显示它。

## 4. 用量持久化（`src/usage/store.js`）

现状：`createRequestLog` 只在内存里存 200 条，重启即丢，无法做分析。

新增 `UsageStore`：

- 落盘 `usage/usage.jsonl`，每请求一行（JSON）。写入走串行链（并发不丢行、不撕裂）。
- 单行字段：`at, iso, model, account, stream, status, error, prompt_tokens, completion_tokens,
  cache_read_tokens, cache_creation_tokens, total_tokens, elapsed_ms, ttft_ms, tokens_per_sec`
- 内存环形缓冲保留最近 200 条供 `recent()`（不每次读盘）。
- 分析用**全量扫描 + 按 (size,mtime) 缓存**：文件未变则复用上次聚合结果。
- 超过 `maxBytes`（默认 32MB）时轮转为 `usage.jsonl.1`（只保留一代，避免无界增长）。
- 坏行（写一半、手改坏）**跳过并计数**，不让一行脏数据毁掉整个分析接口。
- 时间边界用**本机时区当日零点**；`now` 可注入以便测试。

`GET /usage/recent?limit=`、`GET /usage/analytics`、`GET /usage/by-account` 三个端点。

`cache_hit_pct = cache_read / (prompt_tokens + cache_read) * 100`（与参考项目同口径）。

## 5. 性能指标来源

`ttft_ms` / `tokens_per_sec` 需在服务端量：**不改 stream.js 的签名**，在 `server.js` 里包一层
`write` 记录首个字节时刻即可（流式与非流式两条路径都能算 `elapsed_ms`；非流式没有首字节信号，
`ttft_ms` 记 `null` 而不是伪造一个等于 `elapsed_ms` 的值）。

计时起点取 `gateway.complete()` 调用前——它包含等参数/等节流的真实用户可见延迟。

## 6. 前端（`src/dashboard/index.html`，单文件无构建）

抄参考项目的**信息架构**，不抄它的注入写法：

- 三个页签：`网关与运维` / `用量分析` / `设置`；主题切换（深/浅，localStorage）。
- 顶部状态点 + 元信息；`toast()` 右下角自消；**数据过期横幅**（某源刷新失败就明说，不装作最新）。
- 网关页：KPI 卡片（可用账号池 / 套餐余额 / captcha 参数池 / 成功率）、参数池与农场卡片、
  账号工具栏、账号表、模型清单、最近请求。
- 用量分析页：今日↔累计切换、KPI 卡、账号透视表（含模型 pills）、模型表。
- 设置页：面板密码、API Key、运行参数、运行信息、退出登录。
- 轮询：看板 5s、账号 15s；**面板解锁后才开始轮询**（锁定状态不刷 401）。
- `/build` 构建号变化 → 整页重载（避免旧标签页跑旧 JS）。

**XSS 纪律（与现有 `tests/dashboard-xss.test.mjs` 同一条）**：动态值一律 `esc()` 转义，
事件一律 `data-*` + 事件委托，**绝不**把动态值拼进 `onclick="..."` 的 JS 字符串字面量。
参考项目 `dashboard.html` 大量使用 `onclick="toggleAccount(&quot;uid&quot;)"`——这正是
zcode2api 之前修过的存储型 XSS 形态，**明确不抄**。

## 7. 设置持久化（`src/panel/settings.js`）

`GET /settings` 回运行信息 + 脱敏密钥；`POST /settings/save` 支持：

- `apiKey`（写回 `.env` 并热更新 `config.apiKey`，`/v1` 立即用新 key）
- `minIntervalMs` / `cooldown3012Min` / `paramTtlMs` / `poolSize`（热更新到 `pool`/`paramPool` 实例）
- 面板密码走 `/panel/password`，不在这里

`.env` 写回：**只改我们管理的键**，其余行（含注释）原样保留；不存在则追加；写临时文件再 rename。

## 8. 测试

| 文件 | 覆盖 |
|---|---|
| `tests/panel-auth.test.mjs` | 登录/登出/状态、错密码、token TTL、改密吊销全部会话、scrypt 不存明文、非本机无密码时拒绝、本机放行开关 |
| `tests/panel-api.test.mjs` | 账号列表脱敏（断言响应串不含 jwt/apiKey 原文）、set/set-all/delete、add-apikey 校验、settings 读写与 `.env` 回写保序 |
| `tests/usage-store.test.mjs` | 追加/最近/聚合、今日边界、错误计数、性能均值、缓存命中、坏行跳过、并发追加不丢、轮转 |
| `tests/dashboard-xss.test.mjs` | 扩到新面板：真实渲染函数产物里不得出现 `onclick=` 动态拼接 |

## 9. 不做的事

- 不做多 API Key 分出口（zcode2api 只有一个上游出口，抄过来是无用复杂度）。
- 不做参考项目的成长任务/邀请/签到（WorkBuddy 业务专属）。
- 不在面板里回显任何凭据原文（jwt/apiKey/refreshToken 一律掩码）。
