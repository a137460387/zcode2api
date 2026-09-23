# zcode2api 设计文档

> 日期：2026-09-23
> 状态：已与用户逐节确认
> 前置调研：`D:\code\Ai\zcode-proxy\NOTES.md`、`README-CLI.md`、`notes/cli-login.md`（ZCode 协议逆向全记录）
> 参考项目：`D:\code\Ai\workbuddy2api-intl`（Python，账号池/看板模式）、`D:\code\Ai\trae2api`（Node，模块化/双协议模式）

## 1. 目标

把 ZCode（智谱 Z.ai / BigModel 的 GLM Coding 套餐，ZCode 客户端专属额度）反代为本地
OpenAI / Anthropic 双协议兼容 API：

- 通过 **Web 看板 OAuth 登录**添加账号（BigModel 国内 + Z.AI 国际两套流程）
- 多账号池轮询、余额可视化、故障自动转移
- 上游双通道：oauth 账号走 zcode.z.ai（captcha 通道，吃 Start Plan 免费额度）；
  apikey 账号走 open.bigmodel.cn 标准端点（付费 GLM Coding Plan）

### 明确不做（YAGNI）

- 不做自动 token 刷新（官方 refresh 链路未文档化；401 → 停用 + 看板提示重登）
- 不做签到/福利/任务引擎（区别于 workbuddy2api 的国内版增值功能）
- 不做 Responses API（`/v1/responses`，有需要后加）
- 不做多用户系统：单管理员，看板本机免密、局域网面板密码

## 2. 事实依据（2026-09-23 实测，含本日复核）

| # | 事实 | 来源 |
|---|---|---|
| 1 | 模型端点 `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，Anthropic 格式，模型名大小写敏感（`GLM-5.3` / `GLM-5.3-Flash`） | zcode-proxy NOTES.md 任务2 + 本日实测 |
| 2 | 裸 JWT 请求模型端点 → `400 code 3007 captcha verify failed`（本日复核仍如此）。每次请求需一次性阿里云验证码 2.0 参数：`x-aliyun-captcha-verify-param` + `x-aliyun-captcha-verify-region: cn` | 本日实测 + NOTES.md 任务2 |
| 3 | 该端点**不签名**（`isUnsignedModelRequestPath` 集合内），签名只用于同 origin 其他 API | NOTES.md 任务2 |
| 4 | 完整官方引擎请求头集合已捕获（UA、http-referer、x-platform 等 20+ 头），引擎请求不带 Cookie | NOTES.md 任务2 / engine-fetch-log.txt |
| 5 | 余额端点免 captcha：`GET /api/v1/zcode-plan/billing/balance?app_version=x` + `authorization: <JWT>` + `x-device-mid: <任意非空>` → 200 全量套餐数据（本日实测 200，Global Build 1 亿 token 在账） | cli-login.md §5.4 + 本日实测 |
| 6 | 凭据库里 4 把铸造的 coding-plan key：3 把认证有效，但全部 `1113 无资源包`（bigmodel/z.ai、anthropic/openai 各端点均试）——**Start Plan 免费额度只能在 captcha 通道消费**，标准端点不认 | 本日实测（probe 脚本，已删） |
| 7 | `open.bigmodel.cn/api/anthropic`（Anthropic 格式）与 `/api/coding/paas/v4`（OpenAI 格式）是标准付费套餐端点，无 captcha；`/api/coding/paas/anthropic` 不存在（404） | 本日实测 + 内置 provider 配置 |
| 8 | BigModel OAuth broker：`POST https://zcode.z.ai/api/v1/oauth/token` `{provider:"bigmodel", code, redirect_uri, state}` → `{code:0, data:{token: <zcodeJWT>, bigmodel:{access_token, refresh_token}}}`，无需 appSecret，已实跑 200 | cli-login.md §5.2 |
| 9 | Z.AI OAuth 设备码流：authorize `https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai&state=<hex>&response_type=code`，本地轮询 status（1s 间隔，5min 超时）→ `accessToken/jwtToken/user` | cli-login.md §2 |
| 10 | captcha 参数农场机制已被证可行：playwright Chrome（headless/headed 均可）加载本地 farm 页跑阿里 SDK 无感验证，约 20s 产 5 参数，参数一次性、TTL ~8min | NOTES.md 农场架构节 |
| 11 | 风控码语义：`3007`=captcha 校验失败（换参数可解）；`3012`=行为风控拦截（账号+设备行为分，小时/天级衰减，高频失败风暴会触发）；`401`=凭据失效 | NOTES.md 任务3 / cli-login.md |

## 3. 技术决策（用户已确认）

| 决策点 | 选择 |
|---|---|
| 上游路线 | 双通道：captcha 通道（主线）+ 标准 apikey 通道（备选） |
| 技术栈 | Node.js（Express + ESM 模块化）；captcha 农场必须 playwright/Chrome |
| 对外协议 | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` 双协议，均支持流式 SSE |
| OAuth 渠道 | BigModel + Z.AI 两套都实现 |
| 账号管理 | 多账号池 + Web 看板 |
| 代码组织 | 全新模块化项目；glm-proxy.mjs 中验证过的代码段移植为模块 |

## 4. 架构

```
客户端（Claude Code / Cline / Cherry Studio / 任意 OpenAI SDK）
    │  Bearer <API_KEY>
    ▼
zcode2api（127.0.0.1:8787）
    ├─ protocol/   双协议编解码与转换（上游原生 Anthropic 格式）
    ├─ accounts.js 账号池：round-robin + 会话亲和 + 冷却/故障转移
    │     ├─ A「oauth」账号 → upstream/zcode-plan.js（captcha 通道）
    │     └─ B「apikey」账号 → upstream/bigmodel-api.js（标准通道）
    ├─ captcha/    playwright 常驻 Chrome farm → 一次性参数池（全局共享）
    ├─ auth/       两种 OAuth 登录流 + 账号文件存储
    ├─ billing.js  余额查询（免 captcha）+ 用量记录
    └─ dashboard/  单页看板
```

### 模块清单

```
zcode2api/
├─ src/
│  ├─ server.js            Express 入口、路由、鉴权中间件（Bearer API_KEY / x-api-key / ?key=）
│  ├─ config.js            环境变量解析与默认值
│  ├─ accounts.js          账号池：pick（round-robin + X-Session-Id 亲和）、
│  │                       冷却（cooldownUntil）、失败标记、启停、accounts/*.json 持久化
│  ├─ auth/
│  │  ├─ bigmodel.js       本地回调 server + broker 换 JWT（事实#8）
│  │  ├─ zai.js            authorize URL 生成 + status 轮询（事实#9；
│  │  │                    status 端点 URL 实现期从本机 zcode.cjs bundle 提取）
│  │  └─ store.js          账号文件读写（原子写、明文 JSON、目录 gitignore）
│  ├─ upstream/
│  │  ├─ headers.js        官方引擎头复刻 + 版本常量（可配置，随官方更新）
│  │  ├─ zcode-plan.js     A 通道：头构造 → POST → 3007/3012/401 分级处理 → SSE 透传
│  │  └─ bigmodel-api.js   B 通道：x-api-key 直转（/api/anthropic），模型名小写
│  ├─ captcha/
│  │  ├─ farm.js           playwright 常驻 Chrome、装载 farm 页、参数池管理（TTL/水位/消费）
│  │  ├─ farm-page/        farm 页静态文件（阿里 captcha 2.0 SDK 无感验证；
│  │  │                    siteKey 等配置提取逻辑移植自 zcode-proxy 工具）
│  │  └─ manual.js         降级：headed 窗口 / 人工过验证
│  ├─ protocol/
│  │  ├─ anthropic.js      Anthropic 请求/响应/SSE 编解码（上游原生，直通为主）
│  │  ├─ openai.js         OpenAI 编解码 + SSE 回放
│  │  └─ convert.js        OpenAI ↔ Anthropic 消息/工具/思考块转换
│  ├─ billing.js           /billing/balance 查询（x-device-mid 用随机 UUID）+ 用量流水
│  └─ dashboard/           index.html 单页看板
├─ accounts/               账号凭据与用量（.gitignore）
├─ docs/superpowers/specs/ 本文档
├─ .env.example / package.json / README.md / Dockerfile（可选）
└─ tests/                  vitest
```

## 5. 核心流程

### 5.1 A 通道请求链路（oauth → zcode.z.ai）

1. 模型名归一：`glm-5.3 → GLM-5.3`、`glm-5.3-flash → GLM-5.3-Flash`（大小写敏感）；
   `claude-*` 别名默认映射 `GLM-5.3-Flash`（可配关闭）
2. 账号池 pick：round-robin 光标 + 会话亲和（`X-Session-Id` 优先，TTL 2h）；跳过
   cooldownUntil 未到 / enabled=false / 需重登的账号
3. captcha 参数池消费一个参数（池 < 3 时 farm 加速补充；池空 → 等待至多 10s，仍无则 503）
4. 按事实#4 的完整头集合构造请求 → `POST /api/v1/zcode-plan/anthropic/v1/messages`
5. 响应处理：
   - 200 → SSE 透传（流式）或聚合（非流式）；从响应提取 usage 记账
   - 3007 → 换参数重试（≤2 次，不冷却——参数问题非账号问题）
   - 3012 → 该账号冷却 30min（可配）→ 换号重试（≤2 次）
   - 401 → 账号标记 `needsRelogin`，换号重试
6. 失败响应按客户端协议格式回传错误

### 5.2 B 通道请求链路（apikey → open.bigmodel.cn）

`x-api-key` 直转 `POST https://open.bigmodel.cn/api/anthropic/v1/messages`，模型名小写；
`1113` → 账号标记 `no_package` 并跳过（不冷却，余额包买了就恢复）；`401` → 标记失效。
OpenAI 格式客户端走 `/api/coding/paas/v4`。

### 5.3 OAuth 登录（看板发起）

**BigModel**：本地随机端口回调 server + state → 展示
`https://bigmodel.cn/login?redirect=<callback>&appId=zcode&state=<hex>` → 回调收
`authCode` → broker（事实#8）→ 存 `{provider:"bigmodel", type:"oauth", jwt, refreshToken,
accessToken, userInfo, planCache, ...}`

**Z.AI**：生成 state → 展示事实#9 的 authorize URL（回调由服务端承接，本地不监听）→
1s 轮询 status（pending/failed/ready，5min 超时）→ ready 存账号。
status 端点确切 URL 在实现期用 `tools/` 里的 bundle 扫描脚本提取（符号 `pollUntilReady`/
`createOAuthClient`），并留存提取记录到 docs。

### 5.4 captcha 农场

- 常驻 headless Chrome（路径可配）加载本地 farm 页（HTTPS + mkcert 自签或 http+localhost，
  实现期按阿里 SDK 要求定）；每 ~20s 产 5 参数，池上限 `POOL_SIZE=6`，TTL 8min
- 三级降级：无感连续失败 → headed 可见窗口 → 看板红灯 + 手动模式（弹窗人工过验证）
- farm 全局共享：参数与账号无关（验证的是浏览器环境，不是账号）

## 6. 风控对策（针对 09-08 的 3012 教训）

- 单账号请求最小间隔 2s（`ACCOUNT_MIN_INTERVAL_MS` 可配）；全局并发 ≤2
- 冷却梯度：3012 → 30min；同账号 24h 内第 3 次 3012 → 24h；连续 5 次风控类错误 → 停用待人工
- 3007 只换参数不冷却；但农场持续产出失败 → 看板告警
- README 风险提示：代理与官方桌面客户端共用账号行为分，建议错峰、避免高并发压测

## 7. 对外接口

| 接口 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 格式，流式/非流式 |
| `POST /v1/messages` | Anthropic 格式，流式/非流式 |
| `GET /v1/models` | `glm-5.3`、`glm-5.3-flash`（+ claude-* 别名） |
| `GET /health` | 免鉴权 |
| `/` | 看板：本机免密；非本机需面板密码（PBKDF2，参考 workbuddy） |
| `POST /accounts/login/bigmodel/start|poll|cancel` | BigModel 登录三段 |
| `POST /accounts/login/zai/start|poll|cancel` | Z.AI 登录三段 |
| `POST /accounts/set` / `POST /accounts/delete` | 启停/删除 |
| `GET /pool/status` | 账号池 + 参数池水位 |
| `GET /accounts/balance` | 触发全账号余额刷新（billing/balance） |

## 8. 错误处理

- 上游错误统一映射为结构化 `{status, code, msg}`，按客户端协议格式回传
  （OpenAI error object / Anthropic error object），保留上游 request_id 便于排查
- 账号池无可用账号 → 503 + 明确原因（全部冷却/需重登/无资源包）
- 参数池空 → 等待 10s → 503 `captcha pool empty`
- 所有账号级状态变化写看板事件流（最近 200 条）

## 9. 测试

- **单测（vitest，不碰网络）**：协议双向转换样例、模型名归一、账号池 pick/亲和/冷却、
  账号文件原子读写、错误分级映射
- **集成（mock 上游，本地 httptest）**：200/SSE/3007/3012/401/1113 全矩阵，
  验证重试次数、换号顺序、参数消费与补充、冷却时间推进（fake timer）
- **真机 E2E（手动，实现完成后跑一次）**：真实账号小请求（max_tokens=8）全链路验证
- 已知废案（不测试不实现）：MITM 反代、X-Client-Sig 签名、off-peak/ultra 端点、
  纯 CLI + 官方套餐（zcode-proxy 已证伪，见其 README「已证伪的路线」）

## 10. 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 监听端口（glm-proxy 同款，避开 8788/19950） |
| `HOST` | 127.0.0.1 | 默认只听本机，`--lan`/0.0.0.0 放开 |
| `API_KEY` | 必填 | 对外鉴权 |
| `POOL_DIR` | ./accounts | 账号文件目录 |
| `FARM_HEADLESS` | 1 | 农场浏览器无头 |
| `CHROME_PATH` | 自动探测 | Chrome 可执行文件 |
| `POOL_SIZE` | 6 | 参数池上限 |
| `ACCOUNT_MIN_INTERVAL_MS` | 2000 | 单账号最小请求间隔 |
| `COOLDOWN_3012_MIN` | 30 | 3012 冷却分钟数 |
| `MAX_RETRIES` | 2 | 换参数/换号重试上限 |
| `PANEL_PASSWORD` | 空 | 局域网看板密码（空=仅本机免密） |

## 11. 风险与开放问题

1. **3012 行为风控**（最大运营风险）：机制为账号+设备累积行为分，衰减小时/天级。
   对策见 §6。若仍高频命中，后续可探索多账号分流 + 更保守节流。
2. **Z.AI status 轮询端点 URL 未定**：实现期从 bundle 提取（工作量小，bundle 在本机）。
3. **JWT 有效期未知**：claims 未见 exp；以 401 实测为准，需重登时看板提示。
4. **farm 页依赖阿里 SDK 配置**：siteKey 等可能随官方更新失效，需留重新提取工具。
5. 免责：本项目仅供个人学习研究，遵守上游服务条款由使用者自负。
