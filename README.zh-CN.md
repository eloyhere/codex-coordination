# codex-coordination

一个 Codex 插件：在仓库旁边维护一份 **AMP（Attention Manifest Protocol）** 协调台账——严格符合 AMP v0.1 的 `Goal` 与 `Plan` 产物、在声明的 owner 与 assignee 之间流转的可追责交接，以及一条只追加、可导出并通过参照实现校验的 `ledger-snapshot` 链。

它是「一个 MCP 服务器 + 四个 skill」：零依赖、无构建步骤、不联网，只需要 Node.js。

**简体中文** · [English](README.md)

```
R:\project\codex-coordination
├─ .agents/plugins/marketplace.json          # Codex 读取的本地 marketplace
└─ plugins/codex-coordination/
   ├─ .codex-plugin/plugin.json              # 插件清单
   ├─ .mcp.json                              # 启动 MCP 服务器
   ├─ mcp/server.mjs                         # stdio JSON-RPC，零依赖
   ├─ mcp/lib/                               # AMP 原语、链、目标、计划、交接、审计
   ├─ skills/                                # 四个 Codex skill
   └─ scripts/launch-mcp.cmd                 # Windows 启动器（自动找 Node）
```

## 为什么需要它

Codex 会话短、可并行。让某个任务「算做完了」的判断往往只留在会话记录里，而下一次会话不会读它：于是同样的活重做一遍、半成品被宣布完成、也没人记录「本该由谁验收」。

这个插件把这段判断写进仓库旁边：承诺了什么、计划了哪些步骤、提交了什么证据、记录是否仍然自洽。它不是任务看板，而是会话记录里丢失的**可追责**那部分——并且用协议自己的对象形状写，另一个 AMP 读取方可以直接校验，而不是读一段只有本插件懂的自定义 JSON。

## 安装

需要 Codex CLI 0.166+ 与 Node.js 20+。

```powershell
codex plugin marketplace add R:\project\codex-coordination
codex plugin add codex-coordination@codex-coordination
```

之后新开一个会话，`coordination` MCP 服务器会按需启动。查看 Codex 是否识别：

```powershell
codex plugin list
codex mcp list          # coordination 服务器应显示 installed, enabled
```

Codex 把 MCP 工具调用纳入审批：交互式会话里会询问一次；审批策略为 `never` 的会话（例如非交互的 `codex exec`）会直接拒绝，报 "MCP tool call requires approval, but approval policy is never"。批准这些工具即可；若在可丢弃的目录里测试，也可以给该会话加 `--dangerously-bypass-approvals-and-sandbox`。

macOS / Linux 上把 `plugins/codex-coordination/.mcp.json` 里的 Windows 启动器换成直接调用 Node：

```json
{"mcpServers": {"coordination": {"command": "node", "args": ["mcp/server.mjs"], "cwd": "."}}}
```

## 严格接入 AMP v0.1

协议参照：`attention-manifest-protocol`（wire tag `0.1`，参照实现 `0.5.0`，Apache-2.0）。「严格」在这里有明确含义：**插件发出的每一个 AMP 对象，都能原样通过发布 schema 的校验，并用参照实现自己的函数验证通过**；不是照抄字段名的近似物。

### 产物一览

| 概念 | 本插件发出什么 | 进链方式 | schema 依据 |
| --- | --- | --- | --- |
| 结果承诺 | AMP `Goal` | 创建时一条 `kind:"goal"` | `plan.schema.json` 的 goal 分支 |
| 执行步骤 | AMP `Plan` | 每次变更一条 `kind:"plan"` | `plan.schema.json` 的 plan 分支 |
| 台账本身 | AMP `ledger-snapshot` | 由链导出，不另行存储 | `ledger-snapshot.schema.json` |
| 交接职责 | **宿主投影**（不冒充 AMP 类型） | `kind:"event"` 的有界事件 | 无（刻意如此） |

`Goal` 形如：

```json
{
  "amp": "0.1",
  "kind": "goal",
  "id": "deterministic-export",
  "statement": "相同输入导出相同字节",
  "success": [
    {"id": "same-bytes", "statement": "两次导出完全一致", "check": "导出两次并比较 sha256"}
  ],
  "value": 0.8,
  "priority": 1,
  "horizon": "task"
}
```

`Plan` 形如（`goal` 与 `abandon_if` 必填，`edges`/`status`/`created` 由服务端计算）：

```json
{
  "amp": "0.1",
  "kind": "plan",
  "id": "export-plan",
  "goal": {"kind": "goal", "id": "deterministic-export"},
  "tasks": [
    {
      "id": "pin-clock",
      "intent": "去掉写出路径上的墙钟时间戳",
      "actor": "self",
      "pre": [],
      "expect": {"observation": "导出路径上不再有 Date.now()", "check": "grep 并运行导出测试"},
      "irreversibility": 1,
      "status": "pending"
    }
  ],
  "edges": [],
  "commitment_window": 3,
  "budget": {},
  "abandon_if": [
    {"id": "network-clock", "statement": "写出路径最终需要联网时钟", "check": "阅读 writer 的时钟来源"}
  ],
  "status": "draft",
  "created": "2026-11-03T05:30:00.000Z"
}
```

### 链的构造

一条链目就是 AMP 的 `ChainEntry`：`{seq, kind, payload, prev, hash}`。

- `hash = sha256(canonicalJson({seq, kind, payload, prev}))`，即 `sha256:` + 64 位小写十六进制。
- `seq` 从 **0** 开始连续；`seq 0` 的 `prev` 是 `sha256:` 加 64 个零（genesis），不是 `null`。
- `kind` 只使用 AMP 的封闭词表；本插件实际写入 `goal`、`plan`、`event` 三种，其余五种（`frame`、`receipt`、`claim`、`hypothesis`、`unknown`）不产生，因为本宿主没有对应的观察面。
- **canonical JSON** 与参照实现一致：对象键按 UTF-16 排序、无空白、数组保持顺序；`undefined`、非有限数、`-0`、落单的 UTF-16 代理项一律拒绝，而不是让 `JSON.stringify` 悄悄改写——被改写过的值再算摘要，就不再绑定调用方实际传入的值。
- 链目上的 `at` 是宿主元数据，**不参与哈希**（相当于 AMP 的 `LogEntry.at`）；导出快照时会剥掉，因此快照里的条目恰好是五个字段。

导出与校验只有一条路径：`store.snapshotOf()` 派生快照，`store.verifySnapshot()` 按 AMP 规则逐条重算 `hash`、检查 `prev`/`seq` 连续性与 `tip`/`count`；`verifyChain()` 再补一项「文档自己声明的 `tip`/`count` 与链实际结果一致」，避免手改文件留下一个谁都不认的 tip。

### `ledger-snapshot`

`coordination_check` 的 `action:"snapshot"` 返回严格产物：

```json
{
  "amp": "0.1",
  "kind": "ledger-snapshot",
  "agent": "codex-coordination",
  "tip": "sha256:…",
  "count": 12,
  "entries": [
    {"seq": 0, "kind": "goal", "payload": {…}, "prev": "sha256:000…000", "hash": "sha256:…"}
  ]
}
```

链不通过时**拒绝导出**（工具返回 `INVALID_STATE`），因此拿到手的快照一定是可校验的。终端里等价的操作是：

```powershell
node scripts/amp-snapshot.mjs C:\work\project
```

想只看摘要而不拉整条链，用 `coordination_status` 的 `ledger.tip` / `ledger.count` / `ledger.verified`。

### 为什么「职责」不是 AMP 产物

AMP 用 `responsibility-assignment` 表达职责，而它要求 `authority`、`budget`、`window`（`from`/`to`）与 `version`。一个 Codex 会话没有组织目录、没有租约、也没有可声明的授权窗口；把这些字段填成占位值，比诚实的宿主投影更像谎言。

所以职责按宿主投影存储（`{id, role, owner, assignee, responsibilities, acceptance, reference?, status, summary, evidence, review, history}`），**不带** `amp`/`kind`，并在链上留下两类有界事件：

- `duty.assigned`：记录角色、双方身份、职责条目、验收条目与引用；
- `duty.transitioned`：记录迁移、actor，以及提交时的 summary/evidence、验收或驳回时的 review。

这样即使投影被手改，交付内容的证据仍在链上。

### 完整清单

对象模型、状态机、摘要构造、输入校验规则，以及「刻意不实现」的逐条理由，都写在 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。那份文档的写法是可核查的：每一条都指向文件与测试。

## 五个工具

每次调用都要传 `workspace`：仓库根的**绝对路径**。服务器不会替你猜——它自己的工作目录是插件安装目录。

| 工具 | 回答的问题 | 结果 |
| --- | --- | --- |
| `coordination_status` | 已经约定了什么、现在能开始什么、谁在等谁？ | 摘要 + `ledger.tip` |
| `coordination_goal` | 我们承诺的结果是什么，现在还算数吗？ | `goal` 产物 + `lifecycle` |
| `coordination_plan` | 有界的步骤有哪些，哪一步已经解锁？ | `plan` 产物 + `progress` |
| `coordination_handoff` | 谁欠谁什么，提交的结果被接受了吗？ | `duty` 投影 |
| `coordination_check` | 记录是否自洽？导出快照。 | `audit` 或 `ledger-snapshot` |

结果形状刻意把协议与宿主分开：`goal` 和 `plan` 就是 AMP 产物，可以直接拿去校验；生命周期、历史、进度放在旁边，不混进产物里。

### 示例：目标 → 计划 → 交接

```json
{"action":"create","workspace":"C:/work/project","goal":{"amp":"0.1","kind":"goal","id":"deterministic-export","statement":"相同输入导出相同字节","success":[{"id":"same-bytes","statement":"两次导出完全一致","check":"导出两次并比较 sha256"}],"value":0.8,"priority":1}}
```

```json
{"action":"create","workspace":"C:/work/project","plan":{"amp":"0.1","kind":"plan","id":"export-plan","goal":{"kind":"goal","id":"deterministic-export"},"commitment_window":2,"budget":{},"abandon_if":[{"id":"network-clock","statement":"写出路径最终需要联网时钟","check":"阅读 writer 的时钟来源"}],"tasks":[{"id":"pin-clock","intent":"去掉写出路径上的墙钟时间戳","actor":"self","expect":{"observation":"导出路径上不再有 Date.now()","check":"grep 并运行导出测试"}},{"id":"compare","intent":"比较两次导出","actor":"tool","pre":["pin-clock"],"expect":{"observation":"两个文件摘要一致","check":"sha256sum 两个输出文件"}}]}}
```

```json
{"action":"assign","workspace":"C:/work/project","duty":{"id":"review-digests","role":"qualification","owner":"codex-main","assignee":"codex-sub-1","responsibilities":["在干净检出上重跑一次比较"],"acceptance":["报告的两个摘要与本地运行一致"],"plan":"export-plan","task":"compare"}}
```

字段名用 AMP 拼写：`commitment_window`、`abandon_if`。驼峰写法会被拒绝并提示应使用的字段；`edges`、`status`、`created` 属于服务端计算，不接受输入。未知字段一律报错，而不是悄悄丢掉——写错一个字段名却以为记录下来了，是更糟的结果。

## 四个 skill

Codex 按需加载；每个 skill 都写清了服务器能强制的规则，以及它强制不了的诚实要求。

| Skill | 什么时候用 |
| --- | --- |
| `coordination-goals` | 结果要跨越一次回复 |
| `coordination-planning` | 目标需要有序步骤 |
| `coordination-handoffs` | 工作在两个身份之间流转 |
| `coordination-audit` | 宣布完成之前，或接续别人的工作时 |

## 台账文件

每个工作区一个宿主文档，首次写入时创建：

```
<workspace>/.codex-coordination/ledger.json
```

它同时装两样东西：

1. **投影**：`goals`、`plans`、`duties`（含历史与当前状态）；
2. **链**：`journal[]`，每条 `{seq, kind, payload, prev, hash, at}`，外加派生的 `tip`/`count`。

```jsonc
{
  "amp": "0.1",
  "kind": "coordination-ledger",   // 宿主文档，不是 AMP 产物
  "version": 2,
  "workspace": "C:/work/project",
  "agent": "codex-coordination",
  "tip": "sha256:…",
  "count": 1,
  "journal": [
    {
      "seq": 0,
      "kind": "goal",
      "payload": { "amp": "0.1", "kind": "goal", "id": "deterministic-export", "…": "…" },
      "prev": "sha256:000…000",
      "hash": "sha256:…",
      "at": "2026-11-03T05:30:00.000Z"
    }
  ],
  "goals": { "deterministic-export": { "artifact": { "…": "…" }, "lifecycle": { "state": "proposed" }, "history": [{ "at": "2026-11-03T05:30:00.000Z", "from": null, "to": "proposed" }] } },
  "plans": {},
  "duties": {}
}
```

宿主文档本身不冒充 AMP 产物：AMP 定义的是 `ledger-snapshot`，由链派生，二者是「存储」与「产物」的分工。想让协调轨迹进版本库就提交这个目录；不想就加进 `.gitignore`。

## 验证

```powershell
node scripts/validate.mjs        # 清单、skill frontmatter、工具引用、版本一致性
node --test "test/*.test.mjs"    # 47 个单元测试（含固定的参照摘要向量）
node scripts/mcp-smoke.mjs       # 真实 stdio 握手 + 快照导出 + 篡改拒绝
node scripts/amp-conformance.mjs --amp R:\project\attention-manifest-protocol
node scripts/amp-snapshot.mjs C:\work\project
```

`npm run check` 跑前三项；`npm run conformance` 跑第四项。一致性脚本会**导入参照实现本身**，用一次完整的目标/计划/交接写入，核对：

1. `canonicalJson` 与 `digestOf` 是否逐字节一致；
2. 每个 `Goal`、`Plan` 产物是否通过 `plan.schema.json`；
3. 导出的 `ledger-snapshot` 是否通过 `ledger-snapshot.schema.json`；
4. 参照实现的 `verifySnapshot` 是否接受该快照（本插件的校验器同时复核）；
5. 每条链目是否恰好是 `{seq, kind, payload, prev, hash}`，`seq` 是否从 0 连续。

本机实测输出（`attention-manifest-protocol` 0.5.0）：

```
PASS reference-import attention-manifest-protocol 0.5.0 loaded from R:\project\attention-manifest-protocol
PASS canonical-json   4 canonical JSON values byte-identical
PASS digest           4 digests match the reference
PASS chain-verify     12 entries verify under both verifiers
PASS entry-shape      every entry is exactly {seq, kind, payload, prev, hash}
PASS schema-goal      1 Goal artifact(s) validate against plan.schema.json
PASS schema-plan      4 Plan artifact(s) validate against plan.schema.json
PASS schema-snapshot  the ledger-snapshot validates against ledger-snapshot.schema.json
PASS projections      goal, plan and duty projections agree with the journal
```

> 一致性脚本需要 Node.js 24（参照实现的 `engines` 要求）；插件本身仍只需 Node 20+。它不是 `npm run check` 的一部分，因为插件必须能在没有任何依赖的克隆里运行。

## 它不做什么

这比它做什么更重要：

- **它不替你跑检查。** `achieved`、`done`、`verified` 只记录你声称跑过；审计查的是结构，不是事实。
- **它不认证身份。** `owner`、`assignee`、`actor` 都是声明字符串；两侧分工是为了自洽，不是安全边界。
- **它不修复被篡改的台账。** 摘要不匹配会报 `LEDGER_CHAIN` 并原样保留——悄悄重写哈希链会毁掉链唯一的意义。
- **它不截断链。** 截断后无法从 genesis 验起；AMP 的解法是签名 checkpoint，而本宿主没有可用的密钥，所以链保持完整。
- **它不迁移 0.1 台账。** 给旧条目重算哈希，等于用旧证据伪造新链。读到 `version 1` 会明确拒绝，由用户决定是否删除。

其余刻意不实现的 AMP 面（manifest 签名、frame/interrupt、receipt、claim/warrant、assignment/lease、checkpoint、discovery 等）在 [`docs/PROTOCOL.md`](docs/PROTOCOL.md) 第 7 节逐条给出理由。

## 从 0.1 升级

0.1 的台账是 `{seq, at, type, id, data, prev, digest}`，摘要不带 `sha256:` 前缀，也没有 AMP 链的形状。它**不迁移**：重算哈希会覆盖旧证据。升级后读到 0.1 文件会收到 `INVALID_STATE` 并指明版本；删掉该文件即可开新账，或把它留作归档。

## 开发

```powershell
node scripts/validate.mjs       # 清单、skill frontmatter、工具引用
node --test "test/*.test.mjs"   # 47 个单元测试
node scripts/mcp-smoke.mjs      # 真实 stdio 握手 + 工具调用 + 篡改检测
node plugins/codex-coordination/mcp/server.mjs   # 手动运行服务器
```

`npm run check` 一次跑完前三者。`PATH` 上的 `node` 需 20+；Windows 启动器也接受 `NODE_EXE`，并会回退到 Codex 桌面版自带的 Node 运行时。

| 路径 | 职责 |
| --- | --- |
| `mcp/lib/amp.mjs` | id、canonical JSON、摘要、链哈希、共享校验器 |
| `mcp/lib/store.mjs` | 台账事务、AMP 链、`ledger-snapshot` 导出与校验 |
| `mcp/lib/goals.mjs` | Goal 产物与生命周期 |
| `mcp/lib/plans.mjs` | Plan 产物、任务图、依赖闸门 |
| `mcp/lib/collaboration.mjs` | 职责与交接（宿主投影） |
| `mcp/lib/check.mjs` | 结构审计 |
| `mcp/lib/tools.mjs` | 五个工具定义 |
| `scripts/validate.mjs` | 包一致性 |
| `scripts/mcp-smoke.mjs` | 线级冒烟测试 |
| `scripts/amp-snapshot.mjs` | 写出并校验 `ledger-snapshot` |
| `scripts/amp-conformance.mjs` | 对参照实现与 schema 的一致性校验 |
| `test/` | 链、产物与闸门的单元测试 |

## 兼容性

- Codex CLI 0.166+（插件清单、本地 marketplace、stdio MCP）。
- AMP wire tag `0.1`；参照实现 `attention-manifest-protocol` 0.5.0。
- MCP 协议版本 `2025-06-18`、`2025-03-26`、`2024-11-05`。
- Node.js 20+（一致性脚本需 24）；自带 Windows 启动器，macOS/Linux 直接调用 `node`。

在 Windows 11 + Codex CLI `0.166.0-alpha.5.1` 上验证：marketplace 可被 `codex plugin marketplace add` 接受，插件按名安装，`codex mcp list` 显示 `coordination` 服务器及其启动命令、工作目录与环境变量转发。AMP 产物由 `scripts/amp-conformance.mjs` 对 `attention-manifest-protocol` 0.5.0 逐项验证。

## 相关项目

- [`attention-manifest-protocol`](https://github.com/eloyhere/attention-manifest-protocol)：AMP 的参照实现与 schema 来源，本项目的规范性依据。
- `deepseek-coordination`：同一协议体系的另一个 harness 适配（DSH 插件）。它覆盖更多 AMP 面（manifest、frame、receipt、checkpoint 等），本项目不复制其代码，只共用同一套对象模型与摘要规则；两者对「宿主能诚实声明什么」的取舍思路一致：能证明的才写入，不能证明的列成缺口。

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
