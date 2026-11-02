# codex-coordination

一个 Codex 插件：在仓库旁边维护一份持久的协调台账（ledger）——带可观察成功条件的目标、最多 12 个任务的依赖校验计划、在声明的 owner 与 assignee 之间流转的交接，以及一条对每次变更做 SHA-256 哈希链的日志。

它是「一个 MCP 服务器 + 四个 skill」，零依赖、无构建步骤、不联网，只需要 Node.js。

```
R:\project\codex-coordination
├─ .agents/plugins/marketplace.json          # Codex 读取的本地 marketplace
└─ plugins/codex-coordination/
   ├─ .codex-plugin/plugin.json              # 插件清单
   ├─ .mcp.json                              # 启动 MCP 服务器
   ├─ mcp/server.mjs                         # stdio JSON-RPC，零依赖
   ├─ mcp/lib/                               # 台账、目标、计划、交接、审计
   ├─ skills/                                # 四个 Codex skill
   └─ scripts/launch-mcp.cmd                 # Windows 启动器（自动找 Node）
```

## 为什么需要它

Codex 会话短、可并行。让某个任务「算做完了」的判断往往只留在会话记录里，而下一次会话不会读它：于是同样的活重做一遍、半成品被宣布完成、也没人记录「本该由谁验收」。

这个插件把这段判断写进仓库旁边：承诺了什么、计划了哪些步骤、提交了什么证据、记录是否仍然自洽。它不是任务看板，而是会话记录里丢失的**可追责**那部分。

## 安装

需要 Codex CLI 0.166+ 与 Node.js 20+。

```powershell
codex plugin marketplace add R:\project\codex-coordination
codex plugin add codex-coordination@codex-coordination
```

之后新开一个会话，`coordination` MCP 服务器会按需启动。查看 Codex 是否识别：

```powershell
codex plugin list
```

macOS / Linux 上把 `plugins/codex-coordination/.mcp.json` 里的 Windows 启动器换成直接调用 Node：

```json
{"mcpServers": {"coordination": {"command": "node", "args": ["mcp/server.mjs"], "cwd": "."}}}
```

## 五个工具

每次调用都要传 `workspace`：仓库根的**绝对路径**。服务器不会替你猜——它自己的工作目录是插件安装目录。

| 工具 | 回答的问题 |
| --- | --- |
| `coordination_status` | 已经约定了什么、现在能开始什么、谁在等谁？ |
| `coordination_goal` | 我们承诺的结果是什么，现在还算数吗？ |
| `coordination_plan` | 有界的步骤有哪些，哪一步已经解锁？ |
| `coordination_handoff` | 谁欠谁什么，提交的结果被接受了吗？ |
| `coordination_check` | 记录本身是否自洽？ |

示例——先目标、再计划、再交接：

```json
{"action":"create","workspace":"C:/work/project","goal":{"amp":"0.1","kind":"goal","id":"deterministic-export","statement":"相同输入导出相同字节","success":[{"id":"same-bytes","statement":"两次导出完全一致","check":"导出两次并比较 sha256"}],"value":0.8,"priority":1}}
```

```json
{"action":"create","workspace":"C:/work/project","plan":{"id":"export-plan","goal":{"kind":"goal","id":"deterministic-export"},"tasks":[{"id":"pin-clock","intent":"去掉写出路径上的墙钟时间戳","actor":"self","expect":{"observation":"导出路径上不再有 Date.now()","check":"grep 并运行导出测试"}},{"id":"compare","intent":"比较两次导出","actor":"tool","pre":["pin-clock"],"expect":{"observation":"两个文件摘要一致","check":"sha256sum 两个输出文件"}}]}}
```

```json
{"action":"assign","workspace":"C:/work/project","duty":{"id":"review-digests","role":"qualification","owner":"codex-main","assignee":"codex-sub-1","responsibilities":["在干净检出上重跑一次比较"],"acceptance":["报告的两个摘要与本地运行一致"],"plan":"export-plan","task":"compare"}}
```

## 四个 skill

Codex 按需加载；每个 skill 都写清了服务器能强制的规则，以及它强制不了的诚实要求。

| Skill | 什么时候用 |
| --- | --- |
| `coordination-goals` | 结果要跨越一次回复 |
| `coordination-planning` | 目标需要有序步骤 |
| `coordination-handoffs` | 工作在两个身份之间流转 |
| `coordination-audit` | 宣布完成之前，或接续别人的工作时 |

## 台账

每个工作区一个文件，首次写入时创建：

```
<workspace>/.codex-coordination/ledger.json
```

里面是物化后的记录，外加一条只追加的日志：每条记录都带着上一条的摘要。想让协调轨迹进版本库就把它提交；不想就加进 `.gitignore`。

对象模型、状态机、摘要构造方式，以及与 AMP v0.1 相比**刻意削减**的部分，都写在 `docs/PROTOCOL.md`。

## 它不做什么

这比它做什么更重要：

- **它不替你跑检查。** `achieved`、`done`、`verified` 只记录你声称跑过；审计查的是结构，不是事实。
- **它不认证身份。** `owner`、`assignee`、`actor` 都是声明字符串；两侧分工是为了自洽，不是安全边界。
- **它不修复被篡改的台账。** 摘要不匹配会报 `LEDGER_CHAIN` 并原样保留——悄悄重写哈希链会毁掉链唯一的意义。

## 开发

```powershell
node scripts/validate.mjs       # 清单、skill frontmatter、工具引用
node --test "test/*.test.mjs"   # 30 个单元测试
node scripts/mcp-smoke.mjs      # 真实 stdio 握手 + 工具调用 + 篡改检测
node plugins/codex-coordination/mcp/server.mjs   # 手动运行服务器
```

`npm run check` 一次跑完三者。`PATH` 上的 `node` 需 20+；Windows 启动器也接受 `NODE_EXE`，并会回退到 Codex 桌面版自带的 Node 运行时。

## 兼容性

- Codex CLI 0.166+（插件清单、本地 marketplace、stdio MCP）。
- MCP 协议版本 `2025-06-18`、`2025-03-26`、`2024-11-05`。
- Node.js 20+；自带 Windows 启动器，macOS/Linux 直接调用 `node`。

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
