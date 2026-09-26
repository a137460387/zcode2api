# zcode2api

把 ZCode（zcode.z.ai GLM 套餐）反代为本地 OpenAI / Anthropic 双协议 API，带管理面板。
设计文档：`docs/superpowers/specs/2026-09-23-zcode2api-design.md`（主体）、
`docs/superpowers/specs/2026-09-25-admin-panel-design.md`（管理面板）。

> **✅ 状态：已跑通，正在消费官方额度（2026-09-25 实测）**
>
> - ✅ **双协议可用**：`/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI），
>   含流式 SSE、工具调用、思考块（`reasoning_content`）。
> - ✅ **真实用上官方额度**：实测请求后余额消耗；面板记账与上游计费**逐单位一致**
>   （一轮非流式 + 一轮流式 = 3,418 = 3,418）。
> - ✅ **管理面板**：账号增删启停、**扫描本机多实例登录**（含 Coding Plan key）、套餐余量、
>   参数池与农场状态、用量分析（含首字延迟 / 生成速度 / 缓存命中率）、
>   运行参数热更新与 `.env` 回写、面板密码、局域网/免密访问开关。
> - ✅ 439 个单元/集成测试 + 端到端冒烟全通过。
>
> **关键突破（曾经 3012 的根因）**：上游网关对请求做**内容检查**——`system` 字段里
> 必须含 ZCode 身份块，否则直接返回 `3012 "method not allowed"`（对外文案为
> "request has been blocked due to unusual activity"）。
> 官方客户端的请求体是 **~8.5KB**（含身份块 + 环境信息 + `<system-reminder># currentDate`），
> 而此前的实现只发"裸请求"（~100 字节）。详见
> [3012 的根因与修复](#3012-的根因与修复)。


## 快速开始

```bash
npm install
cp .env.example .env   # 至少配置 API_KEY
npm start
```

- API：`http://127.0.0.1:28630/v1`（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`）
- **管理面板**：`http://127.0.0.1:28630/` —— 本机直接开，**不需要密码**（见 [怎么进后台](#怎么进后台)）
- farm 页：`http://127.0.0.1:28631/farm`
  - **默认后台模式**（`FARM_AUTO_BROWSER=1` + `FARM_HEADLESS=1`）：playwright 启动无头浏览器
    自动产参数，**无任何可见窗口**，无需人工干预。
  - 手动模式（`FARM_AUTO_BROWSER=0`）：用你自己的 Chrome 打开上述地址并保持标签页。
    产出成功的标志是页面顶部出现绿色 `param 产出并推送成功`，且"池内 param"不为 `-`。
  - 两种模式的参数**实测均可被上游接受**（headless 3/3 成功；手动模式同样可用）。
    无头模式必须覆盖 UA（启动器已自动处理，见 `src/captcha/browser.js`）。
  - 农场按**可用参数数**补货：服务端会丢弃超过 `PARAM_USABLE_MS`（默认 40s）的参数，
    农场只在"可用参数不足 2 个"时产新的。**不是定时滴灌**——定时产出（曾经每 20s 一个，
    约 180 次/小时）会在空转时也持续做验证，实测跑到约 25 次后被阿里云风控判 `F001`
    （`verifyResult:false`），此后一个参数都产不出来；页面现在还会在连续失败时自动整页重载
    以复位 SDK 状态。
  - 后台模式下农场页不可见，故页面会把自身状态（最近一条日志、失败次数、退避时长）上报给
    服务端，面板「captcha 参数池与农场」里直接显示——卡住时会标红，不必去猜。

> **改端口后**：手动模式需用新地址重开 farm 页（旧标签页会持续 `Failed to fetch`，参数推不进池）；
> 后台模式无需处理（服务启动时自动指向新端口）。


## 怎么进后台

**本机（运行服务的这台电脑）**：浏览器打开 `http://127.0.0.1:28630/`，**不需要密码**。
启动日志里也会把入口地址打出来，面板「设置」页顶部同样列着（含局域网地址）。

**从手机或其他电脑**：默认进不去，因为有两道门——服务只监听 `127.0.0.1`，且非本机要求密码。
两种开法，面板「设置 → 从其他设备访问」里一键设置：

| 想要 | 怎么做 | 代价 |
|---|---|---|
| 免密直接进 | ① 监听地址改 `0.0.0.0`（需重启）② 打开「完全免密」 | 同一局域网内**任何人**都能管理账号与 API Key |
| 要密码 | ① 监听地址改 `0.0.0.0`（需重启）② 在「面板访问密码」里设一个 | 每次要输密码 |
| 不开放 | 什么都不做 | 只有那台电脑能进 |

「完全免密」默认**关**，开启后面板上会持续显示红色警示（不是一次性提示——这个状态决定
谁能管凭据，得随时看得见）。开启/关闭**即时生效**，不用重启。

注意：从非本机访问时把「完全免密」关掉，那台设备会**立刻**失去访问权限；如果那时还没设
密码，就只能回到运行服务的那台电脑上重新打开。面板会在这种情况下先弹确认框说清后果。

启动日志也会提示当前门槛：

```
[zcode2api] 管理面板 → http://127.0.0.1:28630/   http://192.168.0.107:28630/
[panel] ⚠️ 已开启完全免密（PANEL_DISABLE_AUTH=1）：任何能连到这个端口的人都能管理账号与 API Key。
```

> 入口清单会**滤掉虚拟网卡**（VMware / VirtualBox / WSL / Docker 等）。实测本机有 3 个
> 非回环地址，其中两个是 VMware 宿主-only 网卡，手机连不上；把它们混在列表里会让人
> 照着第一个去试，然后得出"从手机打不开"的错误结论。


## 管理面板

三个页签：**网关与运维** / **用量分析** / **设置**。深色主题，5 秒自动刷新，锁定状态下不轮询。

**网关与运维**

- KPI 卡片：可用账号池、套餐剩余、captcha 参数池（含最新参数年龄）、累计产出参数。
- 参数池与农场：池内数量、最新参数年龄、累计产出/消费、农场浏览器模式、**农场页自报状态**。
- 账号表：账号（凭据只显示掩码）、类型、状态徽标（可用 / 已停用 / 冷却 / 需重登 / 无资源包 /
  **密钥无效** / 风控次数 / 最近错误 `状态码/业务码`）、**套餐余量进度条**（按模型）、
  请求数、输入/缓存/输出 tokens、最近使用时间。
  > 徽标与卡片文案都按**实际状态**实时统计，不写死原因——曾经写"不可用（停用/冷却/需重登）"，
  > 而当时 6 个不可用账号的真实原因是"5 个无资源包 + 1 个密钥无效"，一个都对不上。
  > 账号行的请求数与 token **取自 `usage/usage.jsonl`**（与「用量分析」同源），
  > 不读账号自带的计数器——那个计数器存在账号文件里，任何整条覆盖式的写入都会让它归零，
  > 于是面板会出现"账号行 请求 0"与"最近请求 共 5 条"自相矛盾（实测踩到）。
- 工具栏：BigModel / Z.AI OAuth 登录、**新增 API Key 账号**、**扫描本机 ZCode 登录**
  （含多开实例，见 [添加账号](#添加账号)）、刷新套餐额度、全部启用 / 停用。
- **模型清单：只有 2 个模型**（`glm-5.3`、`glm-5.3-flash`）。像 `claude-*`、`GLM_5P3` 这类是
  **别名**——只是"客户端写这些名字也能用"，不是模型，单独一张表列，不计入模型数。
  （早先把两者混排在同一张"模型清单"里，2 个模型看起来像 3 个。）目录由服务端
  `modelCatalog()` 给出，并有测试断言"别名声称的映射 == 实际 `mapToZcodePlan` 的结果"，
  面板不会与服务端各说各话。
- 最近请求（含耗时、首字延迟、生成速度、缓存量）。

**用量分析**：今日↔累计切换；KPI（token、平均速度、首字延迟 P50、成功率、缓存命中率、流式占比）；
账号透视（含每账号的模型细分）；模型用量与性能表。数据来自 `usage/usage.jsonl`（重启不丢）。

**设置**：入口地址、从其他设备访问（监听地址 / **完全免密**开关）、面板密码、对外 API Key、
运行参数（节流间隔 / 3012 冷却 / 参数 TTL / **参数可用时效** / 池上限 / 重试上限）、运行信息。
改动**即时生效并写回 `.env`**（重启后仍在）；只有监听地址需重启。

### 面板访问密码

- 本机访问默认免密（`PANEL_LOCAL_BYPASS=1`）。要在其他机器上打开，见上一节两种开法。
- 密码以 **scrypt** 哈希存在 `panel.json`（只存盐与哈希，不存明文）；改密会**吊销全部已登录会话**。
- 未设置任何密码且未开完全免密时，非本机请求一律 401——不提供默认口令（弱口令比没有口令更危险：
  它让"没配密码"看起来像"配了密码"）。
- 设 `PANEL_LOCAL_BYPASS=0` 可让本机也必须带密码（面板挂在反向代理后面时应当这么设）。

### 面板不显示凭据原文

`jwt` / `apiKey` / `accessToken` / `refreshToken` **从不回给前端**，只回 `hasJwt` / `hasApiKey`
与掩码（如 `eyJhbG…hoY4`）。凭据一旦进过浏览器、日志或截图就等于多了一处泄露面。


## 验证

```bash
npm test        # 单元/集成测试（439 项，不碰网络与真实上游）
npm run e2e     # 端到端冒烟：真实 server + 真实 Response 走通双协议四条路径 + 管理面 API
```

`npm run e2e` 用本地假上游起真实服务，覆盖「OpenAI/Anthropic × 流式/非流式」四条路径，
并核对 captcha 参数送达、SSE 透传、usage 记账与管理面接口。它存在的原因是：单元测试把上游桩成
普通对象，会掩盖只有真实 `Response` 才暴露的缺陷（例如 `Response.body` 是一次性流）。

真实上游实测（2026-09-25）：面板记录的 `total_tokens` 与上游 `used_units` 增量**完全一致**
（一轮非流式 + 一轮流式 = 3,418 = 3,418），这是"面板数字不是自说自话"的最终裁判。


## 添加账号

1. 面板 →「+ BigModel 登录」或「+ Z.AI 登录」→ 浏览器完成授权 → 自动入库。
2. 面板 →「+ API Key 账号」→ 填备注名与 key → 入库（付费 GLM Coding Plan 通道，不需要 captcha）。
3. 面板 →「**⤓ 扫描本机 ZCode 登录**」→ 不用重新授权、不用手工编辑文件，一次收齐本机所有凭据。
   对已存在的账号重复导入只**刷新凭据**，请求数/token 统计、风控次数、停用状态都会保留
   （早先会整条覆盖，导致面板上的历史统计被清零）。

### 扫描本机登录：一次收齐所有实例

它扫**本机所有 ZCode 实例**，而不只是默认那个：

| 实例 | 凭据文件 |
|---|---|
| 默认实例 | `~/.zcode/v2/credentials.json` |
| 多开管理器实例 N | `%APPDATA%\zcode-multi\<N>\data\.zcode\v2\credentials.json` |

每个实例收两类东西：

- **OAuth 账号**（`zcodejwttoken`）→ 走一次性 captcha 的免费通道
- **Coding Plan API Key**（客户端里绑定的 `account-provider:coding-plan:...:api-key`）
  → 走 `open.bigmodel.cn` 标准通道，**不需要 captcha**

实测确认：多开实例的密钥派生不变（启动器只改数据目录，不改派生用的 home），
所以同一个密钥能解开所有实例的凭据。

收完会**逐条实测**，结果直接写进账号状态：

- OAuth 账号 → 查余额接口（即时显示套餐余量）
- API Key → 发一个 1 token 的最小请求，判 `可用` / `无资源包(1113)` / `密钥无效(401)`

> 为什么要实测：从客户端扫进来的 Coding Plan key 里**有死 key**（实测一台机器 6 个里
> 5 个不可用：4 个 `1113 无可用资源包`、1 个 `401 身份验证失败`）。不实测的话它们会以
> "可用"的样子留在选号池里，直到某个真实请求撞上去才暴露——那是一次白白失败的请求。
> 401/1113 都发生在计费之前（实测余额不变），所以这次探测不花额度。

扫描结果按实例分别报告：哪个实例导入了什么、哪个实例没登录、哪个实例凭据解不开。

> `401` 对两类账号含义不同：OAuth 是"凭据失效，重新登录能救回来"（`需重登`）；
> API Key 是"密钥被吊销或填错，没有重新登录这回事"（`密钥无效`）。混为一谈会让一个
> 失效的 key 在面板上显示成"需重登"——那是个点不动的死路，用户会找不到该做什么。

手工放置（等价于第 2 条，便于脚本化）：把 `accounts/<id>.json` 放入目录，
`{"id":"bigmodel:manual-1","provider":"bigmodel","type":"apikey","apiKey":"<key>", ...}`（其余字段同 oauth 账号默认值），重启生效。

## 两种账号通道

| 账号类型 | 上游 | 需 captcha | 适用 |
|---|---|---|---|
| oauth | `zcode.z.ai/api/v1/zcode-plan/anthropic` | 每请求一个一次性参数（farm 供给） | Start Plan / Global Build 免费额度 |
| apikey | `open.bigmodel.cn/api/anthropic` | 否 | 付费 GLM Coding Plan key |

## 客户端接入

- Claude Code：`ANTHROPIC_BASE_URL=http://127.0.0.1:28630` + `ANTHROPIC_AUTH_TOKEN=<API_KEY>`
- OpenAI SDK：`base_url=http://127.0.0.1:28630/v1`，`api_key=<API_KEY>`
- 模型：`glm-5.3`、`glm-5.3-flash`（`claude-*` 自动映射 GLM-5.3-Flash）

## 用量账的口径（对账时看这里）

`usage/usage.jsonl` 每行一次请求。字段口径按 Anthropic 语义，**不是**简单的"输入+输出"：

- `prompt_tokens` = **未命中缓存**的输入（对应上游 `input_tokens`）
- `cache_read_tokens` = 命中缓存复用的输入；`cache_creation_tokens` = 本次写入缓存的输入
- `completion_tokens` = 输出
- `total_tokens` = **上面四项之和**

最后一条容易踩坑：上游的 `input_tokens` **不含**缓存部分。实测一次流式请求
`input=40 / cache_read=1664 / output=8`，上游计费 +1712；若按 `input+output` 记总账，面板会显示
48（少 35 倍）。agent 类客户端（Claude Code、dsh）每轮重发一大段系统提示，命中缓存是常态，
所以这个偏差是**系统性**的——面板的「缓存命中率」也正是为此而设。

另一处实测坑：流式响应里 `message_start` 的 `input_tokens` 是 **0**，真正的值在最后那帧
`message_delta` 里。只读 `message_start` 会让每个流式请求都记成 0 输入 token，
并让发给 OpenAI 客户端的 `prompt_tokens` 恒为 0（对外可见的错误数据）。

## 3012 的根因与修复

**上游网关会对请求做内容检查**：如果 `system` 字段里看不到 ZCode 身份块，
直接返回 `3012 "method not allowed"`（对外文案 `request has been blocked due to unusual activity`）。

这解释了此前所有排查都失败的原因——**发出去的是"裸请求"**：

| | 官方客户端 / 现在的实现 | 修复前 |
|---|---|---|
| 请求体大小 | **~8.3–8.6 KB** | ~100 字节 |
| `system` 字段 | 3 块官方身份块（带 `cache_control: ephemeral`） | 无 / 仅用户 system |
| 首轮 user 消息 | 前挂 `<system-reminder>…# currentDate…</system-reminder>` | 纯用户文本 |
| 模型名 | 小写 `glm-5.3` | 大写 `GLM-5.3` |
| `user-agent` | `ZCode/3.14.3 ai-sdk/anthropic/3.0.81` | `…ai-sdk/provider-utils/4.0.27 runtime/node.js/24` |
| `x-zcode-app-version` | `3.14.3` | 缺失 |
| `accept-encoding` | `gzip` | 缺失 |
| `x-title` | `Z Code@cli` | `Z Code@electron` |
| `x-query-id` / `x-session-id` | 不带 | 带了 |

**修复**：新增 `src/upstream/system-prompt.js`（按官方形态组装三块身份 + 上下文前缀），
`src/upstream/zcode-plan.js` 在发送前调用 `shapeZcodePlanBody()` 补齐请求体，
`src/upstream/headers.js` 按抓包复刻请求头。文案资产在 `src/upstream/zcode-system.json`。

### 实测结果（2026-09-25）

```
/v1/messages        → 200 {"content":[{"type":"text","text":"SYSTEM-FIX-OK"}],"usage":{"input_tokens":1707}}
/v1/chat/completions → 200 {"choices":[{"message":{"content":"OPENAI-OK"}}]}
流式 SSE            → 200 完整事件流（message_start → content_block_delta → …）
GLM-5.3-Flash       → 200（含 thinking 块）
余额复查            → GLM-5.3 used=129333｜Flash used=1730   ← 真实消耗官方额度
```

### 排查方法学（值得记下的教训）

定位过程中走了很长弯路，以下方法最终有效，也澄清了几个误区：

1. **以余额变化为最终判据** —— 只有 `used_units` 增长才证明请求被接受。
   `3007`/`3012` 都发生在计费之前，故余额不变。
2. **区分中间环节与最终结果** —— captcha 验证通过 ≠ 模型请求成功；
   连接建立 ≠ 响应返回。（曾把 captcha SDK 回调误读为"请求成功"。）
3. **对比一个已知可用的第三方实现**是最高效的定位手段——
   同样的账号/机器它能通，就能确定问题在自身实现而非环境。
4. **已排除的因素**（供参考）：captcha 参数格式与新鲜度、certifyId 重复、
   账号状态、额度、出口 IP、浏览器指纹（真实 Chrome 同）、TLS 指纹
   （Electron 原生网络栈同）、`x-client-sig`/`x-client-pow` 签名头（上游不校验）。
   **这些都不是原因**——真正的原因是请求体形态。

## 风险与已知限制

- 上游对模型端点有风控：`3012` 会触发账号冷却（默认 30min，24h 内第 3 次起 24h，5 次停用）。
  **请勿压测**——每次失败都在消耗账号行为分。
- **`system` 字段形态与上游策略强耦合**：若官方客户端升级后改变身份块结构，
  需要同步更新 `src/upstream/zcode-system.json` 与组装逻辑，否则会重新出现 3012。
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`）。该配置由服务端下发，
  可用 `GET https://zcode.z.ai/api/v1/client/configs`（带 JWT）读取，便于核对是否变更。
- farm 的浏览器 UA 必须覆盖且版本要真实：playwright 在 headless 下默认 UA 含
  `HeadlessChrome/<ver>`，SDK 见之即返回 `F001`（verifyResult:false）导致**一个参数都产不出来**。
  `src/captcha/browser.js` 会自动探测本机 Chrome 版本并构造桌面 UA。
  注：SDK 不检查 `navigator.webdriver`（实测该标志始终为 true，不影响结果）。
- 手动模式：`FARM_AUTO_BROWSER=0` 时不启动自动浏览器，改用你自己的真实 Chrome 打开
  farm 页（`http://127.0.0.1:28631/farm`）。
- 纯 CLI 无法直接使用官方套餐（官方 `account:*` provider 不在 headless 注册表内）——
  这正是本项目存在的意义：让官方额度可被程序调用。
- 测试超时：`vitest.config.mjs` 把 `testTimeout` 设为 30s（并发/落盘类测试在慢机器上波动较大）。
- 仅供个人学习研究，遵守上游服务条款。
