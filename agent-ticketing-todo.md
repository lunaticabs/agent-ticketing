# Agent 票务系统 · 实现 TODO

> **配套文档**：先读 [`agent-ticketing-concept.md`](./agent-ticketing-concept.md)（为什么这么做）
> **本文档**：做什么、按什么顺序、怎么验收
> **交付对象**：编程 Agent
> **时间约束**：ETHGlobal Tokyo 2026，约 48 小时。**按 P0 → P1 → P2 顺序做，P0 没全绿不要碰 P1。**

---

## 0. 开工前必读

### 0.1 这是什么

一个活动排队与名额流转系统：用户的 agent 替他排队，名额到手时要求真人做一次**新鲜验证**；人不在，名额**顺延**给下一个真人背书的 agent。名额可按主办方策略转让，转让有摩擦、有留痕、有上限。

**这不是票务商店。** 不做商品浏览、不做购物车、不做支付网关集成。核心是**队列 + 授权 + 流转**。

### 0.2 技术栈（已定，不要再选型）

按最省事的路走。每一项都是为了让 48 小时里少踩一个坑。

| 层 | 选择 | 为什么 |
|---|---|---|
| 语言 | **TypeScript** | World 的全部官方示例（IDKit / HITL / AgentKit / MiniKit）都是 TS，遇到问题能直接抄 |
| 应用 | **Next.js 15 · App Router** | 一个进程同时提供 UI 和 API route，不用分别起前后端 |
| 样式 | **Tailwind CSS** | 看板 UI 出得快 |
| 数据 | **SQLite + `better-sqlite3`** | 零外部依赖、文件型、**同步 API**；`UNIQUE` 约束天然满足红线 5；重置 = 删文件重跑 seed |
| World ID | **`openid-client`** 走 sandbox 的 OIDC | sandbox 的 "World ID for Agents" 就是 OIDC 形态（Human Continuity IdP）；`openid-client` 是 Node 生态的标准实现 |
| Agent 进程 | **独立 Node 脚本**，用 `tsx` 直接跑 TS | 必须是独立进程（证明 agent ≠ 网站）；终端里能现场展示 |
| 实时看板 | **1 秒轮询** | 比 SSE / WebSocket 稳，会场 wifi 不可信 |
| 公网回调 | **`cloudflared` 或 `ngrok`** | OIDC 回调地址 + 手机访问都需要公网 HTTPS |

**不要引入**：Prisma（codegen 拖时间）、Redis、Docker Compose、任何要注册账号的托管数据库。

> 一个 SQLite 文件足够撑完 demo。唯一需要"真数据库"的地方是并发唯一约束，SQLite 已经给了。

### 0.3 项目布局

> **实现时调整**：原计划新建 `presence/` 子目录，实际直接把项目放在仓库根目录，
> 少一层嵌套。下文树状图已按实际结构更新。

项目即仓库根目录，两份规划文档与代码同级，让编程 agent 在一个工作区里看到全部上下文。

```
./
├── agent-ticketing-concept.md   ← 为什么这么做
├── agent-ticketing-todo.md      ← 本文档
├── README.md
├── RUN_DEMO.md                  ← 六拍演示 runbook
├── SPIKE_NOTES.md               ← Day 0 产出
├── FAILURE_MATRIX.md            ← T-7.1 产出
├── INTEGRATION_DEBRIEF.md       ← T-7.4 产出（赛道硬性要求）
├── app/                         Next.js 页面 + API route
├── lib/                         业务逻辑（队列 / 抽签 / 转让 / 策略 / 审计）
├── worldid/                     ⭐ World ID 适配层，唯一出口
├── agent/                       agent 进程（独立运行）
├── mcp/                         MCP 接入面（T-3.4）
├── scripts/                     spike · e2e · mcp-check · security-check · bot-army
├── tests/                       不变量测试
└── db/                          schema.sql · seed · reset
```

### 0.4 开工前先接上官方给 agent 的工具 ⭐️

World 官方提供了给 coding agent 用的工具。**开工第一步就把它们接上，能省掉大量"翻文档"的时间。**

| 工具 | 怎么用 | 对我们的价值 |
|---|---|---|
| **World Docs MCP** | 见 [文档](https://docs.world.org/model-context-protocol/world-docs) | 让 coding agent 直接搜 World 文档，不用人肉复制粘贴 |
| **Developer Portal MCP** | `https://developer.world.org/api/mcp`，`Authorization: Bearer api_...`（团队 API key，[创建方法](https://docs.world.org/model-context-protocol/developer-portal)） | agent 可自行 `create_app` / `configure_world_id` / `create_world_id_action`，**不用点 dashboard** |
| **sandbox 的 MCP** | `sandbox.auth.world.org/mcp`（文档原话："let it guide you through the integration"） | sandbox 集成的向导 |
| **`SKILL.md`** | `https://world.id/SKILL.md` | 见下面的限制说明 |

#### ⚠️ 关于 `SKILL.md` 的适用范围

`SKILL.md` 是一份写得很好的官方 Agent Skill（8 个 Phase + checklist + gotchas 表），**但它针对的是 IDKit / World ID 4.0 生产路径，不是 sandbox 的 Human Continuity IdP。**

- ✅ **可复用**：它的纪律与坑（不要把 proof JSON 重新编码、signing key 绝不上客户端、nullifier 必须有 `UNIQUE` 约束、环境必须端到端匹配、不能用 `^2.x/^3.x` 的旧示例）
- ❌ **不可直接套用**：代码路径。我们走 OIDC，不是 IDKit widget

> 📝 **这一条差异请写进 `INTEGRATION_DEBRIEF.md`**：IDKit 路径有完整的 `SKILL.md`，sandbox 路径有 MCP 但没有对应的 skill。这正是赛道要的那种具体反馈。

#### 官方给「运行期 agent」的三样东西（了解即可，别指望现成）

| 东西 | 方向 | 对我们的用处 |
|---|---|---|
| `@worldcoin/agentkit` + AgentBook | **服务端识别 agent 背后是否有真人**（不是 agent 调用 World） | 参考它的**按人计数**设计（同一人的多个 agent 共享计数器）——正是我们 continuity 入账上限要的形状 |
| `@worldcoin/human-in-the-loop` | in-framework，靠 prompt 提醒模型调 `approveAction` | **反面教材**：这正是"prompt 层强制"的弱点（见概念文档） |
| **sandbox IdP 作为 MCP 的 OAuth 授权服务器** | MCP 客户端通过 World ID 认证用户（RFC 6750/7009/8414/**8628**/**9728**） | ⭐️ **我们 MCP 接入面的原生做法**——不用自己造授权层 |

**结论**：官方没有"暴露你自己的受保护动作给任意 MCP 客户端"的现成东西（只有你知道你的动作是什么）。但 sandbox IdP 可以直接当 MCP 的授权服务器，这让 T-3.4 比预想的省事。

### 0.5 官方开发者工具全清单：哪些**别自己造** ⭐️

> **这一节的目的：避免 TODO 里出现重复造轮子。**
> 下表用 npm registry 逐个核对过版本（2026-09-25）。

#### A. 运行期 SDK（实测版本）

| 包 | 版本 | 用途 | 我们用吗 |
|---|---|---|---|
| `@worldcoin/idkit` | 4.3.0 | React widget | 仅当同时投 IDKit 赛道 |
| `@worldcoin/idkit-core` | 4.3.0 | 原生 JS 核心（request / session / invite-code） | 同上 |
| **`@worldcoin/idkit-server`** | 1.1.1 | **服务端 RP 签名** | ⚠️ **一旦走 IDKit 路径就用它，别自己实现签名** |
| `@worldcoin/agentkit` / `-core` | 0.2.1 | x402 + AgentBook（按人计数） | 当**参考实现**读，不引入 |
| `@worldcoin/agentkit-cli` | 0.2.0 | agent 注册 / 状态查询 | 可选 |
| `@worldcoin/human-in-the-loop` / `-react` | 0.2.1 / 0.1.1 | agent 中途等真人批准 | ❌ **刻意不用**，见 B① |
| `@worldcoin/toolrouter` | 0.1.3 | ToolRouter 的 MCP 适配器 | ❌ 无关，见 B③ |
| `@worldcoin/provekit` | 0.1.1 | Noir 证明浏览器 SDK | ❌ 属另一赛道 |
| `@worldcoin/minikit-js` / `-react` | 2.0.3 | Mini App 运行时 | ❌ 不做 Mini App |
| `@worldcoin/create-mini-app` | 0.4.1 | Mini App 脚手架 | ❌ 不适用 |
| `@worldcoin/nucleus` | 0.2.11 | 设计 token | ❌ 无关 |

#### B. 三个「看似能省事、实际不能」的东西

**① `@worldcoin/human-in-the-loop` —— 刻意不用**

它提供 `requestHumanAuthorization` 和 `<HumanApproval>`，看起来正好是我们要的。**但它是 prompt 层强制**：靠 system instructions 里写 *"Before performing any sensitive action, call approveAction first"* 来约束模型。

而我们的整个论点是**闸门放在服务端**（见概念文档 §4.2）。用它等于把项目最核心的设计换掉。

> ⚠️ **给编程 agent 的明确指令**：**不要**用 `@worldcoin/human-in-the-loop` 替换我们的审批流。可以读它的源码当参考，但**强制点必须在服务端**。

**② `@worldcoin/agentkit` 的按人计数 —— 照抄设计，不引入依赖**

官方原文：

> "Usage counters are tracked **per human** per endpoint. **Two agents backed by the same human share the same counter.**"

这正是我们 continuity 入账上限要的形状。但它是 **x402 计费用**的，和我们的名额模型不通用——**抄设计思路，不要引入依赖**。

**③ `@worldcoin/toolrouter` —— 不是框架**

它是 **ToolRouter 服务的 MCP 适配器**（把 toolrouter.world 的搜索 / 邮件 / browser-use 等端点暴露给 MCP 客户端），**不是"把你的动作暴露给 MCP 客户端"的框架**。对 T-3.4 没有帮助。

不过它是 World 生态里 MCP server 打包方式的现成参考：`npx` 启动的 stdio 适配器 + World ID 验证过的账号发放 API key。

#### C. 不要重造轮子对照表 ⭐️

| TODO 任务 | 官方是否已提供 | 结论 |
|---|---|---|
| T-0.1 脚手架 | `create-mini-app`（Mini App 专用） | 自己搭 Next.js，**不算重造** |
| T-0.2 数据层 / nullifier `UNIQUE` | ❌ 无官方存储；SKILL.md 明说示例里的内存 Set 只是示意 | ✅ **我们的活** |
| T-0.3 `worldid/` 适配层 | IdP **无官方 SDK**（标准 OIDC）；IDKit 路径有 `idkit-server` 管 RP 签名 | ⚠️ 只做 OIDC 封装；**RP 签名别自己写** |
| T-1.1 入队唯一性 | 证明由 IdP / IDKit 提供 | ✅ 业务逻辑是我们的 |
| T-1.2 `action` 绑购买 | 原语提供（`nullifier = 人 × rp_id × action`） | ✅ **只需正确定义 action，零额外代码** |
| T-1.3 服务端校验 | verify endpoint | ✅ 调它即可 |
| T-2.x 队列 / 抽签 / 顺延 | ❌ **完全没有** | ✅ **我们的核心增量** |
| T-3.1 Agent 循环 | ❌ 没有 | ✅ 我们的活 |
| T-3.2 新鲜验证 | IdP 的 fresh auth（RFC 9470）提供**机制** | ⚠️ 机制是官方的，**策略**（多新算新、哪些动作要）是我们的 |
| T-3.3 闭环可观测 | ❌ 没有 | ✅ 我们的活 |
| T-3.4 MCP 接入面 | ❌ **无框架**；但 IdP 可当 MCP 的 OAuth AS（RFC 9728） | ⚠️ **用官方 MCP TS SDK + IdP 当授权服务器**，别自己写协议层 |
| T-4.x 转让三防线 | `signal` 绑定 + nullifier 一次性 = 原语 | ✅ **消费存储必须自己写**——官方 HITL 示例里 `consumeApproval` 是 `declare function`（只有声明，没有实现） |
| T-5.x grant 签发 | IdP 提供（"issues credentials for its APIs or MCP server"） | ⚠️ 用官方机制 |
| T-6.x demo 道具 | ❌ 没有 | ✅ 我们的活 |
| T-7.1 失败路径矩阵 | SKILL.md 的 Phase 6 有可直接抄的测试清单 | ⚠️ **抄清单，省时间** |

**一句话结论**：

> 官方提供的是**原语和协议**，不提供**产品**。
> 队列、抽签、顺延、转让策略、审计留痕、demo 道具——**这六样没有任何官方替代品，全是我们的增量**；
> 而 RP 签名、MCP 协议层、OIDC 流程——**都有现成的，一律不要自己写**。

### 0.6 十条红线（违反了整个项目就没有意义）

| # | 红线 | 理由 |
|---|---|---|
| 1 | **`action` 必须绑在「购买 / 过户」操作上，不是「验证」上** | `nullifier = 人 × rp_id × action`。绑错了，一个人可以买光全场（这是上一届获奖项目踩的坑） |
| 2 | **signing key 只在服务端**，前端只拿得到 `rp_context` | 泄露即被冒充 |
| 3 | **禁止信任客户端返回的验证结果**，服务端必须自己调 verify | 赛道硬性要求第 4 条 |
| 4 | **environment 由服务端 pin 死**，不接受客户端传参 | 否则 proof 可选 sandbox 绕过 |
| 5 | **每份 approval 只能消费一次**，以 nullifier 为唯一键 | 防重放 |
| 6 | **approval 必须绑定 `(action, signal)`**，参数不符即拒 | 防改金额 / 改收款人 |
| 7 | **顺延/接收窗口的 TTL 从「接收方打开」起算** | 从"发出"起算会在消息被看到前就过期 |
| 8 | **转让必须由接收方本人完成新鲜验证** | 由发送方代劳 = 摩擦归零 |
| 9 | **入账上限按 continuity 标识计**，不按账号/地址 | 换账号洗白是黄牛的主要手段 |
| 10 | **抽签必须与到达顺序无关** | 否则速度套利吃掉唯一性 |

#### 红线 1 / 4 / 5 / 6 有官方代码背书 ⭐️

这四条不是我们的臆测。官方 human-in-the-loop 文档的示例代码逐字印证了同一套设计：

```ts
// ── 红线 1：action 必须绑在「具体操作」上 ──
action: ({ input }) => `booking:${input.flightNumber}`,
// 注释原文：
// "Nullifiers repeat per person and action, so each person can book
//  a flight number once; add a unique booking ID to the action to allow more."

// ── 红线 4：environment 必须服务端 pin 死 ──
body: JSON.stringify({ ...approval, environment: 'production' }),
// 注释原文：
// "The approval is untrusted input: pin the environment so it can't
//  select 'staging' or 'sandbox', which accept test proofs."

// ── 红线 5：一次性消费，键是 nullifier ──
if (!(await consumeApproval(`${expectedAction}:${nullifier}`))) {
  throw new Error('approval already used')
}
// 注释原文：
// "One-time use, keyed on the proof's nullifier. Parse it as the verifier
//  does, so '0x01' and '0x1' share a key."

// ── 红线 6：参数不符即拒 ──
if (approval.action !== expectedAction) {
  throw new Error(`approval does not match this booking`)
}
```

以及官方那段最重要的警告：

> "A required `approval` input is **not proof of authorization** — tool inputs are **LLM-generated**."
> "**Never trust that approveAction ran just because this tool was called**: check the binding, re-verify the proof, and consume it once."

> 📌 **给编程 agent**：实现红线 1/4/5/6 时，把上面这段注释抄进你的代码里。**这样后来者才知道这是官方背书的硬约束，不是可以"优化"掉的细节。**

### 0.7 术语

| 术语 | 含义 |
|---|---|
| **continuity 标识** | 同一个人在本服务里的稳定私有标识（OIDC pairwise `sub`）。**系统里"人"的唯一表示** |
| **新鲜验证 (fresh auth)** | 要求此刻重新认证一次，信号是 `auth_time`。**不是刷脸，不需要线下见面** |
| **名额 (slot)** | 一张票 / 一个入场资格 |
| **顺延** | 名额审批窗口过期后自动交给下一位候选人。**这是产品功能，不是错误处理** |
| **approval** | 一次针对具体操作的真人授权凭据 |
| ⚠️ **"sandbox" 有两个意思** | 见 §2 开头的警告——**这是最容易搞错的一处** |

---

## 1. 验收标准（Definition of Done）

### 1.1 赛道的 5 条硬性要求 → 可验证行为

| # | 赛道要求 | 必须能演示的行为 |
|---|---|---|
| 1 | 接入 sandbox 官方 World ID for Agents | 全流程跑在 sandbox 环境，不是生产环境 |
| 2 | 完整闭环 | 发起请求 → 用户完成 → 服务端校验 → 受保护动作执行（四段都有日志/界面证据） |
| 3 | **演示失败路径** | 拒绝 / 过期 / 取消时，受保护动作**确实没有发生** |
| 4 | 后端安全校验 | 见 §6 安全不变量，每条都要有对应测试 |
| 5 | 集成复盘 | 产出 `INTEGRATION_DEBRIEF.md`（见 T-7.4） |

### 1.2 Demo 六拍必须全部走通

- [ ] 拍 1：FCFS 队列被脚本碾压 → 切到抽签 → 速度优势归零
- [ ] 拍 2：名额到手 → agent 卡住 → 手机批准 → 成交
- [ ] 拍 3：人不批准 → 倒计时归零 → **名额顺延**
- [ ] 拍 4：**40 个账号接收转让 → 塌缩成 2 个 continuity 标识 → 第 3 次被拒**
- [ ] 拍 5：朋友间正常转让 → 走完 15 秒
- [ ] 拍 6：回放 / 改金额 / 换环境 → 三连拒

---

## 2. Day 0：前置验证（先做这个，不要先写业务代码）

### ⚠️ 先分清：World 文档里 "sandbox" 指两个**完全不同**的东西

这是最容易搞错的一处，编程 agent 极可能一头扎进错的那个。

| | **① IDKit 的 sandbox 环境** | **② `sandbox.auth.world.org`（我们要的）** |
|---|---|---|
| 是什么 | IDKit 的一个 `environment` 取值，测试用的证明终点 | **Human Continuity IdP** —— 一个 OIDC 身份提供方 |
| 文档位置 | `docs.world.org/world-id/sandbox/*` | `sandbox.auth.world.org/docs` |
| 怎么用 | `environment: "sandbox"`，证明仍发到**生产** verify endpoint | 在 portal 注册 **OIDC client**，走授权码流 |
| 提供什么 | 模拟验证，省掉真机/真凭证 | **continuity（pairwise `sub`）+ fresh auth + grant 签发** |
| 我们要吗 | ❌ **不是这个** | ✅ **就是它** |

> **赛道要求原文**是"接入赛事提供的 World ID for Agents dev 环境"，链接指向 `sandbox.auth.world.org`——**是 ②**。
> ① 是给 IDKit 路径做集成测试用的，**没有 continuity、没有 fresh auth、没有 MCP OAuth 面**。

**sandbox 的具体形态我们尚未全部确认。以下每一项都必须先验证，验不过就走 fallback。**

产出：`SPIKE_NOTES.md`，逐条记录「结论 / 证据 / 采用的 fallback」。

| ID | 待确认 | 怎么验 | 验不过的 fallback |
|---|---|---|---|
| S-0 | **公网 HTTPS 回调地址** | 起 `cloudflared tunnel --url http://localhost:3000`（或 ngrok），拿到一个固定域名，确认手机能打开 | 换另一个隧道工具；**这一项卡住会阻塞 S-2/S-3**，优先解决 |
| S-1 | **IdP 访问权限**（②，不是①） | 打开 [sandbox.auth.world.org](https://sandbox.auth.world.org/)，能用起来并读到 [docs](https://sandbox.auth.world.org/docs)；装 sandbox World ID 手机端用于完成验证 | 立刻找 World 现场 mentor（今天 17:30 有 workshop，5F） |
| S-2 | OIDC client 注册 | 在 [sandbox portal](https://sandbox.auth.world.org/portal) 注册 client，拿到 issuer / client_id / **回调地址填 S-0 的域名** | 用文档里的公共示例 client |
| S-3 | discovery 端点 | 拉 `/.well-known/openid-configuration`，记录 issuer、authorization/token endpoint、支持的 `grant_types`、`acr`/`amr` 能力 | —— |
| S-4 | **新鲜验证怎么触发** | 找 `max_age` / `acr_values` / `prompt=login` 哪个生效；验证 `auth_time` 出现在 ID token 里 | 若都不支持：退回"每次走完整授权码流"，并**明确记录这是 fallback**（仍然满足"此刻在场"） |
| S-5 | **device authorization grant 是否可用** | 查 discovery 的 `device_authorization_endpoint`。文档里 RFC 8628 挂在 MCP OAuth 面下，**不要假设 OIDC 面也有** | headless agent 退化为"打印授权链接 + 轮询"，GUI 弹窗作为主路径 |
| S-6 | pairwise `sub` / sector | 确认 `sub` 是否 pairwise、sector 怎么配、能否拿到稳定标识 | 若不稳定：改用 issuer+sub 组合哈希，并在文档中标注风险 |
| S-7 | **验证 endpoint 的准确形态** | 确认服务端校验的确切 URL、方法、请求体、**environment 字段名** | 按 `docs.world.org` 的 verify API 形态实现，预留适配层 |
| S-8 | 能否为自有 API / MCP server 签发凭证 | 按 sandbox 文档验证 | grant 功能降级为 P2（见 §5 M5） |
| S-9 | 吊销能力 | 确认 token revocation 端点 | grant 过期只能靠本地 TTL |
| S-10 | **Developer Portal MCP 是否覆盖 sandbox** | `developer.world.org/api/mcp` 管的是 Developer Portal 资源；sandbox 是独立环境（`sandbox.auth.world.org/portal`）。试 `get_team_context` 看能不能看到 sandbox 的 client | 不支持则 sandbox client 手动在 portal 注册（S-2 走人工）；**这条要写进 debrief** |
| S-11 | **MCP OAuth 面能否直接复用** | 按 RFC 9728 拉 `/.well-known/oauth-protected-resource`，确认我们的 MCP server 能否把 sandbox IdP 当授权服务器 | 不能则退化为"自签 token + 本地校验"，grant 降级为 P2 |

> ⚠️ **不要等 S 全部确认才开始写代码。** S-0~S-3、S-7 是阻塞项，先做；S-4~S-6、S-8~S-9 并行确认。
> **把所有 World ID 调用收敛到一个模块 `worldid/`**（见 T-0.3），S 项结论变化时只改那一层。

---

## 3. 架构

```
┌──────────────────────────────────────────────┐
│  Client（Web / Mini App）                     │
│  用户：入队、看状态、批准/拒绝、接收转让         │
│  Agent 面板：排队、监控、发起授权请求            │
└──────────────────┬───────────────────────────┘
                   │ HTTP
┌──────────────────▼───────────────────────────┐
│  Core service                                 │
│  ├─ Queue engine     入队 / 抽签 / 分配 / 顺延  │
│  ├─ Purchase gate    action 绑购买、nullifier  │
│  ├─ Approval gate    新鲜验证请求 / 窗口 / 超时  │
│  ├─ Transfer engine  三防线                    │
│  ├─ Grant engine     mentor/VIP scope（P2）    │
│  ├─ Policy engine    locked / gift / open      │
│  └─ Audit log        按 continuity 标识归集     │
└──────────────────┬───────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
┌───────▼────────┐   ┌────────▼─────────┐
│ worldid/       │   │ agent/           │
│ (唯一出口)      │   │ 排队循环 / 监控    │
│ OIDC + fresh   │   │ 拉真人 / 等待结果  │
└────────────────┘   └──────────────────┘
```

### 3.1 数据模型

```ts
Human {
  continuity_id      // 主键。issuer + sub 的稳定映射
  created_at
  last_fresh_auth_at // 用于新鲜度策略
}

Event {
  id
  name
  total_slots
  policy                  // 'locked' | 'gift' | 'open'
  approval_window_sec     // 名额审批窗口，默认 120
  lottery_window_sec      // 抽签时间窗，默认 600
  transfer_inbound_cap   // 每人最多接受几次转入，默认 2
}

Slot {
  id
  event_id
  state                   // 见 §3.2
  holder_continuity_id
  acquired_via            // 'lottery' | 'transfer'
  approval_deadline
}

QueueEntry {
  id
  event_id
  continuity_id
  joined_at
  lottery_drawn_at
  lottery_rank            // 中签后才有
}

Approval {
  id
  kind                    // 'purchase' | 'transfer'
  bound_action            // 形如 'buy_slot:event_1'
  bound_signal            // 形如 '{slot_id}:{recipient_continuity_id}'
  continuity_id
  nonce
  created_at
  expires_at
  state                   // PENDING → APPROVED → CONSUMED
                          //       ↘ DENIED / EXPIRED
  proof_ref
}

ConsumedProof {
  nullifier               // 唯一键
  bound_action
  consumed_at
}

Grant {                    // P2
  id
  event_id
  grantee_continuity_id
  scope                   // 'mentor:+3' | 'vip:skip_queue'
  issued_at
  expires_at
  revoked_at
}

AuditEvent {
  id
  continuity_id           // 所有记录按「人」归集，不是按账号
  type
  payload
  at
}
```

### 3.2 状态机（必须严格实现）

```
Slot:
  AVAILABLE
    → ALLOCATED           (抽签中签，写入 approval_deadline)
    → EXPIRED             (deadline 过) ──→ 回到 AVAILABLE 并顺延下一位
  ALLOCATED
    → CONFIRMED           (购买 approval 校验通过 + nullifier 已消费)
  CONFIRMED
    → TRANSFER_PENDING    (发起转让，写入接收方 TTL)
  TRANSFER_PENDING
    → TRANSFERRED         (接收方新鲜验证通过，inbound+1)
    → TRANSFER_EXPIRED    (TTL 过) ──→ 回到 CONFIRMED（原持有人）

Approval:
  PENDING → APPROVED → CONSUMED     (消费后不可再用)
  PENDING → DENIED
  PENDING → EXPIRED
  APPROVED 被重放 → 拒绝（见 §6 不变量 5）
```

---

## 4. 任务清单

> 优先级：**P0 = 不做完就没有 demo** · **P1 = 差异化，评委要看** · **P2 = stretch，有余力才做**

### M0 · 骨架与适配层

#### T-0.1 `[P0]` 项目初始化
**做什么**：
```bash
npx create-next-app@latest presence --typescript --tailwind --app --no-src-dir
cd presence && npm i better-sqlite3 openid-client && npm i -D @types/better-sqlite3 tsx
```
把两份 md 复制进项目根，加 `package.json` scripts：`dev` / `agent`（`tsx agent/runner.ts`）/ `seed`（`tsx db/seed.ts`）/ `reset`（删库 + seed）。

**同时把官方工具接上**（见 §0.4）：World Docs MCP + Developer Portal MCP + sandbox MCP。这三件事花不到 20 分钟，但能省掉后面几个小时翻文档。
**验收**：
- [ ] `npm run dev` 一条命令起服务
- [ ] `/health` 返回 200
- [ ] `npm run seed` 与 `npm run reset` 可用
- [ ] README 有 3 行以内的启动说明

#### T-0.2 `[P0]` 本地数据层
**做什么**：用 `better-sqlite3` 实现 §3.1 的数据模型，schema 写在 `db/schema.sql`，一个 `lib/db.ts` 做连接与查询封装。
**注意**：不要内存存储——重放防护和一次性消费**必须靠真实唯一约束**。
**验收**：
- [ ] `ConsumedProof.nullifier` 上有 `UNIQUE` 约束（不是应用层"查一遍再插"）
- [ ] 外键与状态字段有约束（`CHECK` 或 enum 校验）
- [ ] `Slot`、`Grant` 的过期时间可查询
- [ ] `npm run seed` 能造出一个活动 + N 个名额

#### T-0.3 `[P0]` `worldid/` 适配层（**最重要的一个模块**）
**做什么**：把所有 World ID 调用收敛到这里（`openid-client` + sandbox verify endpoint）。上层业务代码**不允许**直接调 OIDC 或 verify API。

**依赖边界（已核实，见 §0.5）**：
- **Human Continuity IdP 没有官方客户端 SDK** —— 官方原话是"通过 OIDC 集成"，所以要自己封装标准 OIDC。**这不是重造轮子，是本来就没有轮子。**
- **但如果走 IDKit 路径做 RP 签名，用 `@worldcoin/idkit-server`（1.1.1），不要自己实现** Keccak-256 + EIP-191 + secp256k1 那套。
- **不要引入 `@worldcoin/human-in-the-loop`**（见 §0.5 B①）——它是 prompt 层强制，与本项目的核心设计冲突。
对外暴露（建议接口，命名可调）：
```ts
startFreshAuth({ action, signal, continuityId? }) → { url | deviceCode, requestId }
awaitAuthResult(requestId)                        → { ok, continuityId, nullifier, authTime, proofRef }
verifyOnServer(proofRef, { action, signal })      → { ok, continuityId, nullifier } | { ok:false, reason }
isFresh(authTime, maxAgeSec)                      → boolean
```
**验收**：
- [ ] 上层代码里搜不到任何直接的 OIDC / verify endpoint 调用
- [ ] **environment 在本模块内硬编码 pin**，函数签名里没有 environment 参数
- [ ] signing key 只从服务端环境变量读取（`.env.local`），**且已加进 `.gitignore`**
- [ ] S-4 / S-5 / S-7 的结论变化时，只改这个模块

#### T-0.4 `[P0]` 一条最小端到端链路
**做什么**：**先打通"能验证一个真人并拿到稳定 continuity 标识"**，不做任何业务。
**验收**：
- [ ] 用 sandbox app 完成一次验证
- [ ] 服务端拿到并落库 continuity 标识
- [ ] 同一个人第二次验证 → **拿到同一个标识**（不是新的）
- [ ] 换一个人 → 拿到不同标识

> 🚩 **T-0.4 全绿之前不要开始 M1。** 这是整个项目的地基。

---

### M1 · 唯一性与购买闸门 ⭐️

#### T-1.1 `[P0]` 入队：真人唯一性
**做什么**：`POST /queue/join`，要求持久证明（是不是真人），落 `QueueEntry`。
**验收**：
- [ ] 未验证用户无法入队
- [ ] 同一个人重复入队 → 幂等（返回已有 entry，不新建）

#### T-1.2 `[P0]` **购买闸门：`action` 绑在购买上** ⭐️
**做什么**：这是红线 1。定义 action 形如 `buy_slot:{event_id}`，**不是** `verify_user`。购买时要求一份该 action 的 proof，服务端校验并消费 nullifier。
**为什么**：`nullifier = 人 × rp_id × action`。action 绑购买，nullifier 天然成为"这个人买过这个活动"的一次性钥匙 → **一人一票自动成立**。
**验收**：
- [ ] 同一个人对同一活动发**第二次**购买 proof → **失败**（nullifier 已消费）
- [ ] 同一个人对**另一个**活动 → 成功（action 不同）
- [ ] 两个不同的人对同一活动 → 都成功
- [ ] **反例测试**：把 action 改成通用的 `verify_user` 后，一个人能买多张 → 证明为什么必须绑购买（写进测试注释）

> 这条是全项目最关键的一处设计。**实现后请在代码注释里写明原因**，避免后来者"优化"掉。

#### T-1.3 `[P0]` 服务端校验
**做什么**：所有 proof 必须服务端校验，客户端只能说"我完成了"，不能给结论。
**验收**：
- [ ] 伪造一个 `{ok: true}` 的客户端响应 → 服务端拒绝
- [ ] 校验失败时受保护动作不发生

---

### M2 · 队列、抽签与顺延

#### T-2.1 `[P0]` 抽签（不是先到先得）⭐️
**做什么**：`lottery_window_sec` 内入队的人**机会均等**。窗口关闭后一次性抽签排序。开 `lottery_mode` 开关可在 demo 里切到 FCFS 做对照。
**验收**：
- [ ] 窗口内第 1 秒入队的人和第 599 秒入队的人，中签概率相同（跑 1000 次统计，差异在噪声内）
- [ ] 抽签结果与 `joined_at` 无关（把 `joined_at` 全改成同一时间，结果分布不变）
- [ ] 能切到 FCFS 模式并观察到"早到者通吃"

#### T-2.2 `[P0]` 名额分配与审批窗口
**做什么**：按抽签顺序分配名额，写入 `approval_deadline = now + approval_window_sec`。
**验收**：
- [ ] 名额数不超过 `total_slots`
- [ ] 每个 `ALLOCATED` 名额都有 deadline

#### T-2.3 `[P0]` 顺延（失败路径即产品）⭐️
**做什么**：deadline 过期 → 名额 `EXPIRED` → 自动交给下一位候选人，并保留顺延次数。
**验收**：
- [ ] 不批准 → 窗口到点后名额自动转移给下一位
- [ ] 顺延发生后，**原候选人不能再购买该名额**（哪怕带着有效 proof）
- [ ] 顺延事件写进 `AuditEvent`
- [ ] 连续顺延 3 次后名额仍能正常成交

---

### M3 · Agent 在环与新鲜验证

#### T-3.1 `[P0]` Agent 排队循环
**做什么**：`agent/runner.ts`，用 `npm run agent` 独立启动（**不是网站的一部分**）。循环：入队 → 轮询名额状态 → 中签时发起授权请求 → 等待 → 批准则继续、拒绝/超时则退出。终端里要打印**可读的状态流转**，因为这一段要现场展示。
**验收**：
- [ ] `npm run agent` 能独立跑起来，且 `npm run dev` 没起也能优雅报错提示
- [ ] agent 能无人值守完成"入队 → 等待 → 中签"（这一阶段不涉及验证）
- [ ] 名额到手时 agent 主动发起授权请求，并把链接/码打印到终端
- [ ] 拒绝/超时后 agent **不执行**受保护动作，并输出结构化原因（不是抛异常崩掉）
- [ ] 终端输出能在投屏上看清（这是 demo 的第二个视觉焦点）

#### T-3.2 `[P0]` 新鲜验证 ⭐️
**做什么**：名额到手时要求**新鲜**验证（`auth_time` 在窗口内），走 S-4 确认的机制。
**验收**：
- [ ] 用一份"很久以前"的会话 → 被要求重新认证
- [ ] 重新认证后 → 通过
- [ ] `auth_time` 被服务端校验，不是客户端自报
- [ ] **不要求摄像头**（如果实现里出现了刷脸，说明走错路径了 —— 见概念文档洞察三）

#### T-3.3 `[P0]` 完整闭环四段可观测
**做什么**：为赛道要求第 2 条提供证据：发起请求 / 用户完成 / 服务端校验 / 动作执行，四段各有日志和界面状态。
**验收**：
- [ ] 界面上能看到四个状态依次流转
- [ ] 服务端日志能按 requestId 串起四段

#### T-3.4 `[P1]` MCP 接入面 —— 让**任何** MCP 客户端都能参与排队

> **优先级说明**：P1。**P0 未全绿不要动这个。** 它不改变任何业务逻辑，只增加一个接入面。

**做什么**：把排队系统暴露成一个 MCP server，让 agent 不再局限于我们自己的 `runner.ts`。

对外三个 tool（**薄封装，直接调 `lib/` 里已有的函数，不要复制业务逻辑**）：

| Tool | 说明 | 需要 approval 吗 |
|---|---|---|
| `queue.join` | 加入队列 | 否 |
| `queue.status` | 查询名额状态 | 否 |
| `slot.claim` | 占用名额 | ✅ **必须带服务端可验证的 approval** |

**关键设计（这是 transport 层强制的落点）**：

`slot.claim` **必须**带一个 `approval` 参数，服务端**独立重新校验**它——绑定 `(action, signal)`、一次性消费 nullifier、environment 由服务端 pin。模型完全可以不带 approval 调用它，**结果只会是失败**。

> 官方原话：*"A required `approval` input is **not proof of authorization** — tool inputs are **LLM-generated**."*
> 所以：**绝不因为参数存在就放行，必须自己验。**

**不要自己写协议层**：
- 用官方 MCP TypeScript SDK（`@modelcontextprotocol/sdk`），不要手搓 JSON-RPC
- 授权层**优先复用 sandbox IdP 作为 OAuth 授权服务器**（RFC 9728 protected resource metadata 让客户端自动发现），依赖 S-11 的验证结论
- 打包方式参考 [`@worldcoin/toolrouter`](https://www.npmjs.com/package/@worldcoin/toolrouter)：`npx` 启动的 stdio 适配器

**验收**：
- [ ] MCP 客户端能列出三个 tool
- [ ] `queue.join` / `queue.status` 无需 approval 即可工作
- [ ] **不带 approval 调 `slot.claim` → 失败**（这是核心演示点）
- [ ] 带一份**已被消费过**的 approval 调 `slot.claim` → 失败
- [ ] 带一份**绑定到别的 slot** 的 approval → 失败
- [ ] MCP 路径与 HTTP 路径走**同一套校验函数**（搜代码确认没有第二条实现）
- [ ] `runner.ts` 仍可用（确定性兜底——**台上不要依赖 LLM 的表现**）

**若时间不够**：砍掉 OAuth 授权层，用服务端签发的短期 token；**但 `slot.claim` 的 approval 校验一条都不能省。**

---

### M4 · 转让三防线 ⭐️

#### T-4.1 `[P0]` 转让基础流
**做什么**：持有人发起转让 → 生成绑定 `slot_id` 的链接 → 接收方打开 → 完成新鲜验证 → 过户。
**验收**：
- [ ] **TTL 从接收方打开链接起算**（红线 7）—— 测：发起后等 5 分钟再打开，仍然有效
- [ ] 接收方完成验证后过户成功，`inbound` 计数 +1
- [ ] TTL 过期 → 名额回滚到原持有人

#### T-4.2 `[P0]` 防线一：必须接收方本人
**做什么**：转让 approval 的 `continuity_id` 必须是接收方的。
**验收**：
- [ ] 发送方拿自己的 proof 去完成转让 → 拒绝
- [ ] 任何第三方代劳 → 拒绝

#### T-4.3 `[P0]` 防线二：`signal` 绑定 + 一次性消费 ⭐️
**做什么**：`signal = "{slot_id}:{recipient_continuity_id}"`，服务端校验两者都匹配，且 nullifier 只消费一次。
**验收**：
- [ ] 改 `slot_id` 复用同一份 approval → 拒绝
- [ ] 改 `recipient_continuity_id` → 拒绝
- [ ] 同一份 approval 提交两次 → 第二次拒绝
- [ ] 并发同时提交两次 → **只有一次成功**（DB 唯一约束扛住）

#### T-4.4 `[P0]` 防线三：continuity 入账上限 ⭐️
**做什么**：按 `continuity_id` 统计转入次数，超过 `transfer_inbound_cap` 即拒。
**验收**：
- [ ] 同一人第 3 次接收 → 拒绝
- [ ] **同一人换新账号、换新 agent 再来 → 仍然拒绝**（这条是核心，必须显式测试）
- [ ] 拒绝时写 `AuditEvent`

#### T-4.5 `[P0]` 三级策略旋钮
**做什么**：`locked`（禁止转让）/ `gift`（可转一次）/ `open`（自由转让），由活动配置驱动。
**验收**：
- [ ] 切 `locked` → 转让接口直接拒绝
- [ ] 切 `gift` → 一个名额一生只能转一次，转过的不能再转
- [ ] 切换策略后已有数据不崩

---

### M5 · 委托授权（P2，可降级）

#### T-5.1 `[P2]` Grant 签发
**做什么**：`mentor` = 可带 N 人入场；`vip` = 队列优先/绕过。**不是数据库 role 字段**，而是带 scope 的授权记录。
**验收**：
- [ ] 签发 grant 后生效
- [ ] grant 过期后自动失效
- [ ] 吊销后立即失效

#### T-5.2 `[P2]` 为自有 API / MCP server 签发凭证
**做什么**：依赖 S-8。若 sandbox 不支持，**降级为本地签名 token + 文档说明**。
**验收**：
- [ ] 受保护接口拒绝无凭证请求
- [ ] 凭证带 scope 与过期

---

### M6 · 演示道具

#### T-6.1 `[P0]` 实时队列看板 ⭐️
**做什么**：一块肉眼可见的看板。**这是 demo 的核心道具，不是装饰。**
实现：`app/board/page.tsx`，1 秒轮询 `GET /api/board/state`，返回一个扁平 JSON 快照。**大字、高对比**，投屏用。
必须能看见：队列长度、当前中签者、审批倒计时、**顺延发生**、**拒绝发生**。
**验收**：
- [ ] 倒计时可见且实时（误差 < 1 秒）
- [ ] 顺延时看板上有明显变化（颜色/动画/文字）
- [ ] 拒绝时看板上有明显变化，并显示拒绝原因
- [ ] 投屏到外接屏幕后 3 米外能看清
- [ ] **演示配置**：seed 预设 `lottery_window_sec=15`、`approval_window_sec=90`，否则现场等 10 分钟没法演

#### T-6.2 `[P0]` 军团模拟器（拍 1 与拍 4 需要）⭐️
**做什么**：能造出"40 个账号，但只有 2 个 continuity 标识"的场景。

**关键实现点（不能等到最后才做）**：需要一个 **dev-only 的身份代役机制**——直接在 DB 里插入指定 `continuity_id` 的 `Human`，绕过真实 OIDC，并签发一个本地 session：

```
POST /api/dev/impersonate  { continuityId } → set-cookie session
```

没有这个机制，"40 个账号"根本无法演示（不可能找 40 个真人来验证）。**所以它属于 M1 就要预留的设施，不是收尾功能。**

**安全要求**：整个 `/api/dev/*` 由 `ENABLE_DEV_ROUTES=1` 控制，默认关闭；启用时在启动日志打印醒目警告。**它绝不能与真实验证路径共用代码分支**，以防演示时误把代役当成真验证。
**验收**：
- [ ] 一键生成 40 个"账号"，映射到 2 个 continuity 标识
- [ ] 看板上能看到它们**塌缩成 2 个 continuity 标识**
- [ ] 第 3 次转入被拒，且拒绝原因可见
- [ ] 一键重置演示状态
- [ ] `ENABLE_DEV_ROUTES` 未设置时 `/api/dev/*` 返回 404

#### T-6.3 `[P0]` 速度对照模式（拍 1 需要）
**做什么**：`Event.lottery_mode` 开关：`lottery` ↔ `fcfs` 一键切换。附 `scripts/bot-army.ts`——并发打 `POST /queue/join` 的"抢票机器人"。看板上加一个**「快进」按钮**，立刻关闭当前抽签/审批窗口（现场不能真等）。
**验收**：
- [ ] FCFS 模式下 `bot-army` 1 秒内抢光全部名额 → 人工用户拿不到
- [ ] 抽签模式下同一脚本 → 中签率与人工用户**无统计差异**
- [ ] 「快进」按钮能立即结算抽签 / 立即触发顺延
- [ ] 切换模式不影响已有数据

#### T-6.4 `[P0]` 攻击演示三连（拍 6）
**做什么**：把 §6 的三条不变量做成可视化演示：回放 / 改参 / 换环境。
**验收**：
- [ ] 三个按钮，每个触发一次攻击，每个都显示明确的拒绝原因
- [ ] 攻击失败后确认受保护动作**没有发生**（查数据库/链上状态）

---

### M7 · 收尾

#### T-7.1 `[P0]` 失败路径矩阵全绿
**做什么**：逐条跑一遍并记录：拒绝 / 过期 / 取消 / 未验证 / 凭据不可用 / 不符合资格。
**验收**：
- [ ] 每种情况都返回**结构化、模型/前端可读**的原因
- [ ] 每种情况下受保护动作都不发生
- [ ] 结果写进 `FAILURE_MATRIX.md`

#### T-7.2 `[P0]` 安全自检
**验收**：
- [ ] 前端 bundle 里 grep 不到 signing key / client secret
- [ ] 所有 verify 都发生在服务端
- [ ] `ConsumedProof` 有 DB 唯一约束
- [ ] environment pin 在服务端
- [ ] 并发重放测试通过

#### T-7.3 `[P0]` Demo 脚本彩排
**验收**：
- [ ] 六拍连续跑通，总时长 ≤ 3 分钟
- [ ] 断网/重试不会让演示崩掉
- [ ] 准备一个"一键重置 → 一键跑完"的兜底路径

#### T-7.4 `[P0]` `INTEGRATION_DEBRIEF.md`（赛道硬性要求第 5 条）
**必须包含**：
- [ ] 首次成功耗时（从读文档到第一份 proof 通过，记实际小时数）
- [ ] 遇到的具体摩擦（越具体越好，带报错原文）
- [ ] 缺失的能力或文档
- [ ] **影响最大的一个改进建议**（这一条评委会认真看）

> 写作要求：按 bug report 规格写（复现步骤 / 期望 / 实际 / 影响面）。
> **不要写"文档很清晰、体验很好"。** 这份文档是免费的加分项，大部分队伍会敷衍。

---

## 5. 明确不做

| 不做 | 原因 |
|---|---|
| 商品浏览 / 购物车 / 支付网关 | 不是本项目的价值 |
| 出席签到 | `present` 已被"购买那一刻的新鲜验证"用掉，再做签到是重复叙事 |
| 授权管理后台 | grant 做成 enum + 一次 scope 检查即可 |
| 多语言 / 深色模式 / 响应式打磨 | demo 用不上 |
| 自建身份系统 | 只做 World ID 的消费方 |
| 刷脸 / 活体 | 走 OIDC 路径**不需要摄像头**，加了反而说明走错 |

---

## 6. 安全不变量（每条都要有测试）

| # | 不变量 | 测试 |
|---|---|---|
| 1 | `action` 绑在购买/过户上 | 同人二次购买被拒 |
| 2 | signing key 仅服务端 | 前端 bundle grep |
| 3 | 服务端校验，不信客户端 | 伪造客户端成功响应 → 拒绝 |
| 4 | environment 服务端 pin | 客户端传 environment → 被忽略/拒绝 |
| 5 | nullifier 一次性 | 并发双击 → 只成功一次 |
| 6 | approval 绑 `(action, signal)` | 改参 → 拒绝 |
| 7 | TTL 从接收方打开起算 | 延迟打开仍有效 |
| 8 | 接收方本人验证 | 发送方代劳 → 拒绝 |
| 9 | 入账上限按 continuity | 换账号仍被拒 |
| 10 | 抽签与顺序无关 | 分布统计测试 |

### 一个需要主动披露的例外

T-6.2 的 `/api/dev/impersonate` 是一条**故意开的旁路**，用来模拟"40 个账号"（不可能找 40 个真人来验证）。

处理方式：

- [ ] 由 `ENABLE_DEV_ROUTES=1` 控制，默认关闭；关闭时 `/api/dev/*` 返回 404
- [ ] 与真实验证路径**不共用代码分支**
- [ ] 在 README 和 `INTEGRATION_DEBRIEF.md` 里**明确写出这是演示模拟**——主动披露比被评委问出来好

> demo 里模拟多个用户是行业惯例，**说明白就没有问题**；藏起来才是问题。

---

## 7. 已知风险与 fallback

| 风险 | 概率 | fallback |
|---|---|---|
| sandbox 不支持 step-up / `max_age` | 中 | 每次走完整授权码流（仍满足"此刻在场"），并在 debrief 里写明 |
| 不提供 device authorization grant | 中 | headless agent 打印授权链接 + 轮询；GUI 弹窗做主路径 |
| `sub` 不是 pairwise / 不稳定 | 低 | 用 issuer+sub 哈希自行构造，文档标注风险 |
| verify endpoint 形态与文档不符 | 中 | 适配层隔离（T-0.3），只改一处 |
| sandbox 环境不稳 / 限流 | 中 | 演示前录一段完整视频兜底 |
| **把 ①IDKit sandbox 误当成 ②IdP** | **高** | §2 开头的对照表；S-1/S-2 分别指向两个不同的地方 |
| 48 小时做不完 M5 | 高 | M5 是 P2，直接砍；grant 降级为文档里的设计说明 |

---

## 8. 提交物清单

- [ ] 可运行的系统（六拍 demo 走通）
- [ ] `README.md` —— 一句话说明 + 启动方式
- [ ] `SPIKE_NOTES.md` —— Day 0 的假设验证结论
- [ ] `FAILURE_MATRIX.md` —— 失败路径矩阵
- [ ] `INTEGRATION_DEBRIEF.md` —— **赛道硬性要求**
- [ ] 公开仓库（赛道通常要求开源可访问）
- [ ] Demo 视频（兜底用）

---

## 9. 给编程 Agent 的工作方式

1. **先读 [`agent-ticketing-concept.md`](./agent-ticketing-concept.md)**，特别是 §0.4 红线对应的「我们的增量」一节——**知道为什么，才不会把设计"优化"掉**。
2. **先做 §2 的 Day 0 spike**，把结论写进 `SPIKE_NOTES.md`，阻塞项（S-1~S-3、S-7）没结果就先别写业务代码。
3. **严格按 P0 → P1 → P2**。P0 未全绿不要开 P1。
4. **每个任务完成后自查验收清单**，未通过不要标记完成。
5. **遇到 sandbox 文档与实际不符**：以实际为准，记录到 `SPIKE_NOTES.md` 和最终的 `INTEGRATION_DEBRIEF.md`（这正是赛道要的反馈）。
6. **不要在 `worldid/` 之外调用任何 World ID API**（T-0.3）。
7. **红线（§0.4）不可为了"简化"而妥协**。特别是红线 1 和红线 5——那两条一旦失守，整个项目的论点就不成立了。
