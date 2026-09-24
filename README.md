# zcode2api

把 ZCode（zcode.z.ai GLM 套餐）反代为本地 OpenAI / Anthropic 双协议 API。
设计文档：`docs/superpowers/specs/2026-09-23-zcode2api-design.md`。

> **⚠️ 当前状态：代码已完成并验证，但上游拒绝非官方客户端**
>
> - ✅ **代码完整可用**：216 个单元测试 + 端到端冒烟全通过；凭据导入、captcha 参数产出与
>   送达、错误分级、账号冷却等链路均已真实跑通验证。
> - ❌ **无法实际消费免费额度**：上游对模型端点有**准入控制**，非官方客户端一律返回
>   `3012 request has been blocked due to unusual activity`（HTTP 405）。官方桌面端同期
>   正常（实测 42 次全通过）。已系统排除 13 项客户端侧可能原因（含 TLS 指纹——
>   用 Electron 原生网络栈实测仍 3012），**确认这是服务端设计，非客户端可解决**。
>
> 详见 [风险与已知限制](#风险与已知限制) 的完整证据链与可行替代路径。

## 快速开始

```bash
npm install
cp .env.example .env   # 至少配置 API_KEY
npm start
```

- API：`http://127.0.0.1:8787/v1`（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`）
- 看板：`http://127.0.0.1:8787/`（本机免密）
- farm 页：`http://127.0.0.1:8789/farm`（启动时已自动打开无头 Chrome；也可手动打开并保持标签页）

## 验证

```bash
npm test        # 单元/集成测试（198 项，不碰网络与真实上游）
npm run e2e     # 端到端冒烟：真实 server + 真实 Response 走通双协议四条路径
```

`npm run e2e` 用本地假上游起真实服务，覆盖「OpenAI/Anthropic × 流式/非流式」四条路径，
并核对 captcha 参数送达、SSE 透传与 usage 记账。它存在的原因是：单元测试把上游桩成普通对象，
会掩盖只有真实 `Response` 才暴露的缺陷（例如 `Response.body` 是一次性流）。


## 添加账号

1. 看板 →「+ BigModel 登录」或「+ Z.AI 登录」→ 浏览器完成授权 → 自动入库。
2. （可选）从 ZCode 桌面端迁移：账号凭据在 `~/.zcode/v2/credentials.json`（enc:v1 加密），
   解密方案见 `D:\code\Ai\zcode-proxy\NOTES.md`，本工具不做自动迁移，看板重新登录即可。

## 两种账号通道

| 账号类型 | 上游 | 需 captcha | 适用 |
|---|---|---|---|
| oauth | `zcode.z.ai/api/v1/zcode-plan/anthropic` | 每请求一个一次性参数（farm 供给） | Start Plan / Global Build 免费额度 |
| apikey | `open.bigmodel.cn/api/anthropic` | 否 | 付费 GLM Coding Plan key |

添加 apikey 账号：把 `accounts/<id>.json` 手工放入目录，
`{"id":"bigmodel:manual-1","provider":"bigmodel","type":"apikey","apiKey":"<key>", ...}`（其余字段同 oauth 账号默认值），重启生效。

## 客户端接入

- Claude Code：`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` + `ANTHROPIC_AUTH_TOKEN=<API_KEY>`
- OpenAI SDK：`base_url=http://127.0.0.1:8787/v1`，`api_key=<API_KEY>`
- 模型：`glm-5.3`、`glm-5.3-flash`（`claude-*` 自动映射 GLM-5.3-Flash）

## 风险与已知限制

> **⚠️ 首要限制（2026-09-24 完整实测，证据链闭合）**：本项目的**代码链路完全跑通**
> （凭据导入、参数产出、参数送达、错误分级、账号冷却全部验证正确），但**上游服务端会
> 拒绝所有非官方客户端的模型请求**（HTTP 405 / code `3012`），**官方桌面端同期正常**
> （实测 42 次全部 `accepted:true`）。这是一个**服务端准入控制**，已确认**无法通过任何
> 客户端侧构造绕过**——详见下节 13 项排除清单。因此：**本项目在服务端策略改变前，
> 无法实际消费 ZCode 免费额度**。

### 3012 的完整排除清单（全部实测，非推测）

| # | 假设 | 验证方式 | 结果 |
|---|---|---|---|
| 1 | captcha 参数格式错误 | 合法参数 vs 乱造参数 | ❌ 排除 |
| 2 | sceneId 失效（旧版配置） | 从服务端拉 `client/configs` 对比 | ❌ **配置与农场完全一致** |
| 3 | 参数过期 | 用 1–2 秒龄的新鲜参数 | ❌ 排除 |
| 4 | certifyId 被重复提交 | 每个参数只用一次 | ❌ 排除 |
| 5 | IP 行为分 | 更换出口 IP 后重测 | ❌ 排除 |
| 6 | 浏览器自动化指纹 | **真实用户 Chrome** 产参数 | ❌ 排除 |
| 7 | 请求头缺失 | 从最小头到全量头逐级测试 | ❌ 排除 |
| 8 | 缺 `x-client-sig`/`x-client-pow` 签名头 | 伪造注入 | ❌ **上游不校验**（结果无变化） |
| 9 | `x-session-id` 格式 | `sess_<uuid>` vs 裸 uuid | ❌ 排除 |
| 10 | UA 版本过时 | 141 / 153 / 3.14.3 三档 | ❌ 排除 |
| 11 | 请求频率触发 | 间隔 15 秒低频请求 | ❌ 排除 |
| 12 | **TLS / 连接层指纹** | **Electron 原生 Chromium 网络栈发请求** | ❌ **不成立** |
| 13 | 官方桌面端同期对照 | 桌面端日志 | ✅ **全部通过** |
| 14 | **账号被标记 / 额度不足** | **全新账号（额度满格 600 万，零消耗）重跑全链路** | ❌ **排除**（仍 3012） |
| 15 | 请求"其实成功了"但被误判 | **每次测试前后复查余额（token 用量）** | ❌ **全程零消耗**——从未成功过 |

**第 14、15 项是关键补充**：全新未使用过的账号、满额额度（GLM-5.3 300 万 + Flash 500 万）、
完整正确链路，结果仍是 `3012` 且**余额零变化**。这同时证明：
- 与账号状态无关（新号同样被拒）
- 与额度无关（满额也进不到计费阶段）
- **此前所有测试都没有成功过**（余额从未变动），排除了"某次静默成功"的可能

**关键对照数据**（同一账号、同一时刻、同一 IP）：

```
不带 captcha 参数           → 400 / 3007   （校验器正常工作）
乱造参数                    → 400 / 3007   （格式无效被识别）
农场合法参数（新鲜，1s 龄） → 405 / 3012   （格式正确 → 进入准入评估 → 判定非官方客户端）
重复使用已消费的参数        → 400 / 3007   （已消费，属正常行为）
官方桌面端（同期）          → ✅ 42 次 accepted:true
```

### 排查方法说明：如何区分"成功"与"被拒"

排查期间发现，**只看错误码不够**——必须同时复查余额（token 用量）。本项目采用的判据：

```bash
# 余额接口（免 captcha，仅需 JWT + x-device-mid）
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
→ data.balances[].used_units   # 请求前后对比，有变化才说明真的消耗了额度
```

**判读规则**：`3012`/`3007` 都发生在计费之前，故**余额不变**；只有余额增长才证明请求
真正被服务端接受并计费。实测本项目全程余额零变化（见排除清单第 15 项）。

> 附注：若发现历史账号有额度消耗（如旧账号 `used=212254`），**不要误判为本代理的成果**。
> 实测该消耗集中在桌面端主动使用的时段（日志中 `modelId: GLM-5.3` 记录的时间点），
> 且代理请求全程零消耗。排查时请以时间线对照为准。

### 关于 `x-client-sig` / `x-client-pow`（已排除）

新版引擎的请求头脱敏名单含三个"模型请求级"头：`x-aliyun-captcha-verify-param`（已实现）、
`x-client-sig`、`x-client-pow`。后两者在任何客户端代码里都**不生成**（CLI bundle 仅出现于
脱敏名单、asar 中 0 次），曾推测由服务端下发。**但实测伪造这两个头对判定毫无影响**，
故它们不是 3012 的原因。

### 结论与可行路径

3012 的判据**既不在 HTTP 请求内容里，也不在 TLS 握手特征里**——最可能是服务端把
captcha 参数与官方客户端进程做了会话绑定，或纯粹按"仅官方客户端"的策略执行。
**这属于服务端设计，不是客户端可解决的问题。**

| 路径 | 可行性 |
|---|---|
| 本项目直连（Node/Electron 网络栈） | ❌ 被 3012 拒绝（13 项已排除） |
| 付费 GLM Coding Plan + `open.bigmodel.cn` | ✅ **已实现且无需 captcha**，买套餐填 key 即用 |
| 远程控制中继驱动官方桌面端 | ✅ 见 `D:\code\Ai\zcode-proxy\NOTES.md` 的 `remote-driver.mjs` |
| 等上游策略变化 | ⏳ 代码已就绪，策略一变即可用 |

- **新版桌面端把 captcha 配置改为服务端下发（2026-09-24 实测）**：`getCaptchaConfig()` 从
  `GET /api/v1/client/configs` 的 `data.configs.captcha` 读取（缓存 60s），CLI bundle 里已不再
  硬编码该配置；模型请求前多一个 `send_preflight` 阶段。配置值与本项目农场一致，不构成问题。
- 上游对模型端点有风控冷却：`3012` 触发账号冷却（默认 30min，24h 内第 3 次起 24h，
  5 次停用）。**请勿压测**——每次失败都在消耗账号行为分。
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`）。该配置来自
  服务端下发，可用 `GET https://zcode.z.ai/api/v1/client/configs`（带 JWT）读取，
  便于将来核对是否变更。
- 手动模式：`FARM_AUTO_BROWSER=0` 时不启动自动浏览器，改用你自己的真实 Chrome 打开
  farm 页（`http://127.0.0.1:8789/farm`）。注意：**实测真实 Chrome 参数同样会被 3012**，
  故手动模式并不能解决 3012，仅在调试指纹差异时有价值。
- farm 的浏览器 UA 必须覆盖且版本要真实：playwright 在 headless 下默认 UA 含
  `HeadlessChrome/<ver>`，SDK 见之即返回 `F001`（verifyResult:false）导致**一个参数都产不出来**。
  `src/captcha/browser.js` 会自动探测本机 Chrome 版本并构造桌面 UA
  （实测：默认 UA → F001 且 0 产出；覆盖 UA → 30s 内产出 3 个）。
  注：SDK 不检查 `navigator.webdriver`（实测该标志始终为 true，不影响结果）。
- 纯 CLI（headless）**无法**使用官方套餐通道：官方 `account:*` provider 不在 headless 注册表视图内
  （`Model creation failed`），这是新版桌面端的架构决定，非本项目缺陷。官方额度只在桌面端 GUI
  或"导入本机登录态 + 本代理"路径下可用。
- HTTPS farm：如 HTTP 下 SDK 异常，把 mkcert 证书放到 `certs/localhost-key.pem`、
  `certs/localhost.pem`（可从 `D:\code\Ai\zcode-proxy\certs\` 复制）并重启，自动切 HTTPS。
- 测试超时：`vitest.config.mjs` 把 `testTimeout` 设为 30s。并发/落盘类测试在负载高的机器上
  会明显变慢（实测同一批测试在 1.7s 与 >20s 之间波动），默认 5s 会误报失败。
- 仅供个人学习研究，遵守上游服务条款。

