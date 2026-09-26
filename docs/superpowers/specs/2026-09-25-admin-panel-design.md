# 网关后台管理面板 设计

参考实现：`D:\code\Ai\workbuddy2api-intl`（`dashboard.html` + `wb_proxy.py` 的 `/panel/*`、`/accounts/*`、`/usage/*`）。
本文只记**决策与契约**，不重复参考项目的实现细节。文中标「实测」的条目都对应一次真实踩坑。

## 1. 目标

把 zcode2api 的看板升级为**可用的账号管理后台**：

1. 账号全生命周期：新增（OAuth / API Key / 本机多实例扫描）、启用停用、批量操作、刷新额度、删除。
2. 账号健康可见：套餐余量、冷却剩余、3012 strikes、最近错误、以及"为什么不能用"。
3. 用量可分析：持久化请求日志，按今日/累计、按账号、按模型聚合，含首字延迟与生成速度。
4. 面板自身可管理：访问方式（本机/局域网/免密）、运行参数、密钥，且**改完重启仍在**。

## 2. 面板鉴权（`src/panel/auth.js`）

| 项 | 决定 |
|---|---|
| 密码存储 | `panel.json`（rootDir），`scrypt(N=16384,r=8,p=1)` + 16 字节随机盐，只存盐与哈希 |
| 引导密码 | 未生成 `panel.json` 时用 `.env` 的 `PANEL_PASSWORD`；两者都无 → 视为**未设置密码** |
| 会话 | 内存 Map，键为 `sha256(token)`（不驻留明文 token），值 `{at}`，TTL 7 天，上限 200 条 |
| token 传递 | `x-panel-token` 请求头（主） / `?panel=` / `x-panel-password`（旧脚本兼容） |
| 改密 | 校验旧密码 → 写新哈希 → **吊销全部会话**并签发新 token |
| 比较 | `timingSafeEqual`，长度不等先归一到等长再比，避免长度侧信道 |

### 访问门槛：三档，都由面板可设

| 档 | 条件 | 谁能进 |
|---|---|---|
| 仅本机 | 默认（`HOST=127.0.0.1` + `PANEL_LOCAL_BYPASS=1`） | 只有那台电脑 |
| 局域网要密码 | `HOST=0.0.0.0` + 设了面板密码 | 知道密码的人 |
| 局域网免密 | `HOST=0.0.0.0` + `PANEL_DISABLE_AUTH=1` | 能连到该端口的**任何人** |

决策依据：
- **完全免密默认关**。这个面板能改 API Key、删账号，默认敞开等于把凭据管理交出去。
- 开启后页面上**持续**显示红色警示，不是一次性 toast——这个状态决定谁能管凭据，得随时看得见。
- 不提供默认口令（如 `admin`）：弱口令比没有口令更危险，它让"没配密码"看起来像"配了密码"。
- `HOST` 改动**需重启**（`app.listen` 已绑好端口，热改无效），故 `save()` 返回 `restartRequired`。
  其余（免密开关、节流、冷却、参数时效、池上限、重试上限）都即时生效。
- 从非本机访问时关掉免密、且没设密码 → 那台设备**立刻**失去访问权（实测把自己关在门外过一次）。
  面板据此先弹确认框；`/panel/status` 因此必须返回 `fromLocal`，否则给不出精确的后果提示。

### 入口地址清单（`entryUrls()`）

- 只监听 `127.0.0.1` 时**只列本机地址**——列一个连不上的局域网地址是误导。
- 监听 `0.0.0.0` 时**滤掉虚拟网卡**（VMware/VirtualBox/Hyper-V/Docker/WSL…）。实测本机 3 个非回环
  地址里两个是 VMware 宿主-only 网卡，手机连不上；混在列表里会让人照着第一个去试，
  然后得出"从手机打不开"的错误结论。全滤空时退回未过滤列表。

## 3. 账号管理 API（全部挂 `panelAuth`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/panel/status` | **免鉴权**：`{passwordRequired, authenticated, fromLocal, disableAuth, hasPassword, passwordSource}` |
| POST | `/panel/login` `/panel/logout` `/panel/password` | 登录 / 登出 / 改密 |
| GET | `/accounts` | 账号列表（**脱敏**）+ 池状态 + 逐账号用量 |
| POST | `/accounts/set` `/accounts/set-all` `/accounts/delete` | 单个启停 / 批量 / 删除 |
| POST | `/accounts/add-apikey` | 面板新增 API Key 账号（重复 409） |
| POST | `/accounts/balance/refresh` | `{id?}`；不传刷全部 oauth 账号 |
| POST | `/accounts/import/local` | **扫描本机所有 ZCode 实例**（见 §4） |
| POST | `/accounts/login/:provider/{start,poll,cancel}` | OAuth 登录流程 |
| GET | `/models` | 模型目录（见 §7） |
| GET | `/usage/recent` `/usage/analytics` `/usage/by-account` | 用量 |
| GET | `/settings` `POST /settings/save` | 设置读写（见 §9） |
| GET | `/pool/status` `/health` `/build` | 兼容与运维 |

**脱敏是硬约束**：`jwt` / `apiKey` / `accessToken` / `refreshToken` **从不回给前端**，
只回 `hasJwt` / `hasApiKey` 与掩码。凭据一旦进过浏览器、日志或截图就等于多了一处泄露面。

**时间换算**：`stats.lastUsedAt` / `lastError.at` 存的是**池内时钟值**（与节流同轴，注入假时钟时
不是真纪元）。面板直接 `new Date()` 会得到 1970 附近的时刻，故服务端额外给出 `*Iso` 字段——
用真实时钟在管理面换算，前端只显示它。

**账号行的请求数/token 取自 `usage/usage.jsonl`**，不读账号自带的 `stats` 计数器。那个计数器存在
账号文件里，任何整条覆盖式的写入都会让它归零，于是面板出现"账号行 请求 0"与"最近请求 共 5 条"
自相矛盾（实测）。日志是只追加的事实账，两处同源后不会再对不上。

## 4. 本机登录扫描（`src/auth/local-import.js`）

### 要扫的不止一处

| 实例 | 凭据文件 |
|---|---|
| 默认实例 | `~/.zcode/v2/credentials.json` |
| 多开管理器实例 N | `%APPDATA%\zcode-multi\<N>\data\.zcode\v2\credentials.json` |

- 只认默认实例的话，"另一个客户端里已登录的账号"永远扫不到——而这正是用户会来问的场景。
- 实测确认**多开实例的密钥派生不变**（启动器只改数据目录，不改派生用的 home），
  所以同一个 key 能解开所有实例的凭据。这是能扫的前提。
- 显式 `file` / `ZCODE_CREDENTIALS_FILE` 一旦给出就**只认它**：隔离 profile 与测试靠这个，
  此时还去扫别的实例会把用户不想动的账号导进来。
- 数字目录按**数值**排序（`10` 不排在 `2` 前面）。

### 两类凭据一起收

- **OAuth 账号**（`zcodejwttoken`）→ 一次性 captcha 的免费通道
- **Coding Plan API Key**（`account-provider:coding-plan:...:api-key`，客户端里绑定的）
  → `open.bigmodel.cn` 标准通道，**不需要 captcha**

实测这两类都是**真凭据**：Coding Plan 的值是 49 字符含点号的 `<id>.<secret>`，可直接打标准通道。
只收"形态像 API Key"的值（含点号且 ≥20 字符），不像的不猜。

`user_id` 从 `user_info.user_id ?? id ?? rawProfile.user_id` 归一——真实文件顶层是 `id` 而非 `user_id`。

### 导入时逐条实测

| 类型 | 怎么测 | 判据 |
|---|---|---|
| oauth | 余额接口 | 显示套餐余量 |
| apikey | 发 1 token 最小请求 | `可用` / `无资源包(1113)` / `密钥无效(401)` |

**为什么必须测**：从客户端扫进来的 Coding Plan key 里**有死 key**——实测一台机器 6 个里 5 个
不可用（4 个 `1113`、1 个 `401`）。不测的话它们会以"可用"的样子留在选号池里，直到某个真实请求
撞上去才暴露，那是一次白白失败的请求。`401`/`1113` 都发生在**计费之前**（实测余额不变），
所以这次探测不花额度。探测通过会**清掉**旧的失效标记——key 可能已充值恢复。

### 导入是"刷新凭据"，不是"覆盖账号"

`store.upsertCredentials(fields)`：id 已存在则只更新凭据，保留 `stats` / `strikes` / `createdAt` /
`enabled` / `cooldownUntil`。理由：那些是历史事实，与凭据新旧无关。实测用户点了一次扫描导入，
面板上的请求数与 token 就被清零了（`save(newAccountFields(...))` 是全新快照，整条覆盖）。

只主动清 `needsRelogin`（重登成功本身就证明凭据可用，不清会让账号永远进不了选号池）。
**不**重新启用 `enabled`：被风控停用的号要不要恢复由用户决定，悄悄启用等于绕过风控。

## 5. 账号状态语义（`src/accounts.js`）

`healthy()` 排除五类：`enabled === false` / `needsRelogin` / `noPackage` / `invalidKey` / 冷却中。

| 标记 | 何时置 | 用户该做什么 |
|---|---|---|
| `needsRelogin` | oauth 账号 401 | 重新登录 |
| `invalidKey` | **apikey** 账号 401 | 换密钥 |
| `noPackage` | 1113（无资源包） | 充值 / 换账号 |
| `strikes` | 3012 累计（5 次停用） | 等风控衰减 |

`401` 必须按账号类型分开：API Key **没有"重新登录"这回事**，显示"需重登"是个点不动的死路
（实测 5 个 Coding Plan key 里就有 1 个 401）。`invalidKey` 与 `needsRelogin` 在 `newAccountFields`
里都显式声明（不让"字段缺席"与"字段为 false"两种状态并存）。

冷却**只能延长不能缩短**（`Math.max`）：并发在途请求先后 `markError` 时，短冷却不能盖掉长冷却。

## 6. 用量账口径（`src/usage/store.js`）

- 落盘 `usage/usage.jsonl`，写入走串行链（并发不丢行）；超 `maxBytes`(32MB) 轮转为 `.1`。
- 分析用全量扫描 + 按 `(size,mtimeMs)` 缓存；坏行跳过并计数，不让一行脏数据毁掉整个接口。
- 时间边界用**本机时区当日零点**（`new Date(y,m,d)`，不是 `at - at%86400000`）。

**`total_tokens` 必须含缓存命中**：Anthropic 口径下 `input_tokens` **不含**缓存部分，
`cache_read_input_tokens` 单独记。实测一次流式 `input=40 / cache_read=1664 / output=8`，
上游计费 +1712；按 `input+output` 记只显示 48（**少 35 倍**）。agent 客户端（Claude Code、dsh）
每轮重发大段系统提示，命中缓存是常态，所以这是**系统性**偏差，不是边角情况。

命中率分母 = 全部输入（未命中 + 命中 + 写入缓存），否则"写入缓存"那部分凭空消失、命中率被高估。

## 7. 模型目录（`src/models.js` → `GET /models`）

**只有 2 个模型**（`glm-5.3`、`glm-5.3-flash`）；`claude-*` / `GLM_5P3` 这类是**别名**，单独一张表。
早先前端把两者混排在同一张"模型清单"里，2 个模型看起来像 3 个（用户当场就问"不是只有两个模型吗"）。

- 目录由服务端 `modelCatalog()` 给出，**前端不再硬编码**——否则服务端改了映射，面板不会跟着变。
- 单独开 `/models`（面板鉴权）而不是让面板调 `/v1/models`：后者要 API Key，
  面板不该为了显示一张表而持有对外密钥。
- 不变量测试：别名目录里每一条声称的映射，必须与真实 `mapToZcodePlan()` 的结果一致。

## 8. 性能指标来源

`ttft_ms` / `tokens_per_sec` 在 `server.js` 里量：包一层 `write` 记录首字节时刻，**不改 stream.js 签名**。
计时起点取 `gateway.complete()` 调用前（含等参数/等节流，这才是用户感知的延迟）。

**两个实测坑**（都在 `src/protocol/stream.js`）：
- 流式响应里 `message_start` 的 `input_tokens` 是 **0**，真值在最后那帧 `message_delta` 里。
  只读前者会让每个流式请求都记成 0 输入 token，且发给 OpenAI 客户端的 `prompt_tokens` 恒为 0
  ——那是**对外可见的错误数据**。故两处都读，以更晚的 `message_delta` 为准。
- 缓存字段同理，`message_delta` 里才有 `cache_read_input_tokens`。

失败请求也要归属到账号：`GatewayError` 带 `accountId`（否则面板只能把它记成 `(unattributed)`，
而"哪个号在吃 429/3012"正是面板最该回答的）；`stream` 取**客户端请求的模式**，
不硬编码 false（流式失败仍是一次流式失败）。

## 9. 设置持久化（`src/panel/settings.js`）

写回**`.env` 本身**，不另存 settings.json：配置的唯一来源应当只有一个，否则会出现"改完重启又变回去"
这类只有读代码才能解释的行为。写回纪律：**只改受管的键**，其余行（注释、空行、顺序、未管理键）
逐字节保留；解析不了的行原样保留。

逐字段校验：**合法字段照常生效，非法字段单独报错**，不搞"一个字段写错就整份拒绝"。
写盘失败**必须回显**（内存已改、重启会变回去，用户有权知道这份改动是临时的）。

热更新要作用在**实例**上而不是 `config`：`AccountPool` 在构造时就把它拷走了，只改 `config`
对运行中的池无效。

## 10. 前端（`src/dashboard/index.html`，单文件无构建）

- 三个页签：网关与运维 / 用量分析 / 设置；深色为默认（避免"先渲染浅色再切深色"的闪白）。
- `toast()` 右下角自消；**数据过期横幅**（某源刷新失败就明说，不装作最新）。
- 轮询 5s，**面板解锁后才开始**（锁定状态不该反复打 401）；`/build` 变化 → 整页重载。

**XSS 纪律**：动态值一律 `esc()`，事件一律 `data-*` + 事件委托，**绝不**把动态值拼进
`onclick="..."` 的 JS 字符串字面量——HTML 解析器会先把 `&#39;` 解回 `'`，于是逃逸出字符串
执行任意 JS。参考项目大量使用 `onclick="f(&quot;uid&quot;)"`，**明确不抄**。

徽标/文案不许写死原因：账号卡片一度写"不可用（停用/冷却/需重登）"，而当时 6 个不可用账号的真实
原因是"5 个无资源包 + 1 个密钥无效"——写着的原因一个都对不上，用户会以为面板看错了。
现在按实际状态实时统计。

## 11. 测试

| 文件 | 覆盖 |
|---|---|
| `tests/panel-auth.test.mjs` | 登录/登出/状态、错密码、token TTL、改密吊销、scrypt 不存明文、非本机无密码时拒绝 |
| `tests/panel-settings.test.mjs` | 参数热更新与 `.env` 回写保序、免密开关、监听地址、入口清单滤虚拟网卡 |
| `tests/panel-api.test.mjs` | 账号脱敏（断言响应串不含凭据原文）、CRUD、add-apikey、导入探测、apikey 401 语义 |
| `tests/multi-instance-import.test.mjs` | 多实例候选清单、去重、逐实例诊断、Coding Plan key 解析 |
| `tests/local-import.test.mjs` | 密钥派生、解密失败、user_info 容错 |
| `tests/usage-store.test.mjs` | 追加/聚合、今日边界、性能分位、缓存命中、坏行跳过、并发、轮转 |
| `tests/models.test.mjs` | 目录与真实映射一致（防面板与服务端各说各话） |
| `tests/dashboard-xss.test.mjs` | 在假 DOM 上跑**真实**渲染函数，断言产物无 JS 上下文逃逸 |
| `tests/store.test.mjs` | per-id 锁、并发不丢更新、`upsertCredentials` 保留历史 |

真实上游对账（2026-09-25）：面板 `total_tokens` 与上游 `used_units` 增量**完全一致**
（3,418 = 3,418）。这是"面板数字不是自说自话"的最终裁判。

## 12. 不做的事

- 不做多 API Key 分出口（zcode2api 只有一个上游出口，抄过来是无用复杂度）。
- 不做参考项目的成长任务/邀请/签到（WorkBuddy 业务专属）。
- 不在面板里回显任何凭据原文。
- 不把"免密"设为默认——便利性不能替用户决定安全边界。
