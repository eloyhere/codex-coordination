# AMP → Codex 接线审计报告

## 修复复核（2026-11-07）

当前依赖已升级并锁定至 AMP **0.7.8**、semantic-typescript **2.0.1**。0.7.8 的 `discover` 支持字符串、字符串数组与正则查询，本项目已同步暴露并回归。最近一次完整检查通过：**266/266** 单测、**162** 工具验证、普通/打包各 **458** 项 MCP 检查、UI 2 个场景。新增日志解析回归已验证。下面保留上一阶段修复记录；全面语义差异和本轮新确认的错误以 [AMP-075-GAP-REPORT.md](AMP-075-GAP-REPORT.md) 为准，不能根据已注册数量推断功能完整。

以下为修复后的接线概况；后面的原审计保留为修复前历史，不应再用作当前覆盖数字。

- 实际工具数 **162**；AMP 0.7.8 的 49 个标准动词为 **42 native + 3 durable-submission + 4 unbound**。3 个 submission 现有独立宿主审核消费者。仍未绑定的是 `turn.current/respond/clarify/report`，没有用观察事件伪造这些 Codex 控制端口。
- 新增 `session.report_status`、受审 whole-file UTF-8 `workspace.write`（真实 ActionAttempt、租约/CAS、文件回执）、本地持久 `cooperation.inbox/send/report_result`。Cooperation 不声称远程投递，写入回执不等于业务验收。
- `submission_review` 消费 focus/clarification/goal-evidence 提案，检查目标版本、作用域和证据新鲜度；澄清/证据只生成审阅附件，不自动接受 Intent 或完成 Goal。
- UserPromptSubmit hook 可交付有界的 Attention 摘要，恢复明确保留对象并重置临时挂载。此为 hook `additionalContext` 路径，仍不证明桌面已加载新插件或接管原生模型循环。
- Discovery 补上文件、大纲与显式选中聊天的观察消息来源；修复大纲使用原始字节哈希校验规范化文本的问题。网络来源仍明确不可用。MCP 保持全目录暴露，没有宣称已改为 discovery-only 动态加载。
- MCP-facing legacy 高权力入口增加独立宿主审批，纯读取/计算保留；未声称消除所有 legacy 依赖或将 Codex 内建工具统一迁入该执行器。
- 修复截图中的失败：写入测试按 `Turn.interpreting → Intent.confirmed/accepted → Mission.active` 建立上下文，在 Plan draft 阶段创建 Task DAG；补上写入 Mission 准入检查，以及幂等重放提前返回时关闭 Store；工具计数及 stdio 精确名称清单更新至 153。

| 本次实际重跑 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | **142/142 通过，0 失败** |
| `npm run build:server` / `build:app` | 通过 |
| `npm run validate` | 1 plugin、153 tools 通过 |
| `npm run smoke` | **440 项通过** |
| `npm run smoke:package` | **440 项通过** |
| Playwright（`msedge` channel） | **3/3 场景通过** |
| `npm run conformance` | **9 项通过，基线为 legacy 0.6.3**，不代表 0.7.2 全量 conformance |

修复后清单见 [AMP-MIGRATION-INVENTORY.json](AMP-MIGRATION-INVENTORY.json)。测试日志位于工作区 `.tmp/amp-fix-*.log`。未改动安装缓存，也未把尚缺真实宿主接口的 Turn、远程投递、完整业务验收或全工具取消链标为完成。

## 原审计（修复前历史快照）

- 审计日期：2026-11-07（Asia/Shanghai）
- 对象：当前工作区源码、MCP 工具注册与调用、Codex plugin/hooks、AMP agent gateway、宿主服务/执行/持久化以及测试证据。
- 原审计规范基线：当时项目安装并锁定的 `attention-manifest-protocol@0.7.2`，另参照 AMP 项目 `refract.md` v1.8。此处保留历史语境；当前基线已升级到 0.7.8，详见文首及 [AMP-075-GAP-REPORT.md](AMP-075-GAP-REPORT.md)。

## 结论

**否：当前项目没有把 AMP 的全部功能和模块一一接线到 Codex。**这是一个具备大量实际功能、仍在迁移中的部分集成，不是“只有占位工具”：MCP 有完整工具目录和真实处理器；标准 AMP agent surface 的 49 个动词中有 40 个已注册（37 native、3 durable submission），9 个未注册；另有 26 个模块的 tier/动词 inventory。可是工具能被列出/调用，不代表它连到了当前 Codex 主对话生命周期、控制了其 Action/工具调用，或将结果作为经 AMP 验证的业务事实回写。

主要缺口：Turn API 四个动词、Session 状态汇报、canonical workspace CAS write、canonical cooperation 三动词均缺；Action 仅接 read，执行仅允许受控 read contract；attention context 是 MCP 工具结果预览，不是 Codex 隐式上下文注入；三个 submission 中只有 Plan proposal 找到 native draft 消费路径。Codex hook 主要提供真实事件观察与 Session 映射，尚未形成 Turn/Action/验证闭环。

**host 与 hidden tier 不应作为 agent 工具开放。**它们在 surface 中没有模型动词是协议有意的信任边界，不是缺工具。但项目另有 legacy `coordination_*` 工具直接承载密钥、runtime、domain invoke、registry 管理能力；这些可用能力不能冒充 canonical 0.7.2 host tier 的自动安全隔离，需独立评审其授权与用户意图。

## 统计及其解释

[AMP-MIGRATION-INVENTORY.json](AMP-MIGRATION-INVENTORY.json) 从已安装的 0.7.2 surface 和当前构建的 `TOOLS` 生成：**49 standard verbs = 37 native + 3 durable-submission + 9 unbound**，全工具目录 **146 项**。Inventory 的 `native` 表示绑定到具体 handler/category，不表示每项都连到 Codex thread，或执行语义完整；例如 progress 明确是未验证 claim，execution 只收只读 contract。

## 49 动词覆盖矩阵（按模块）

| 模块 | Tier | 已绑定/未绑定动词 | 实际含义与限制 |
|---|---|---|---|
| session | agent | `get/list` native；`report_status` unbound | 查询真实 hook 创建的本项目 Session 映射；未提供标准 status 报告写接口 |
| turn | agent | `current/respond/clarify/report` 全部 unbound | 事件可观察到 turn_id，不等于标准 Turn 状态/响应/澄清处理 |
| intent | agent | `get/list` native；`submit_clarification` durable submission | 后者入待审队列，未找到转为真实 Intent/host decision 的消费者 |
| mission | agent | `get` native | 读取所选的插件 native workflow；不是当前 Codex thread mission lifecycle |
| goal | agent | `get/list` native；`submit_evidence` durable submission | 查询 workflow goal；Codex Goal sync 只是独立观察快照，不自动形成 AMP verified Goal |
| plan | agent | `get/list/ready_tasks/propose_draft` native | proposal 有 draft 物化和 host review；不等于已执行或完成 |
| task | agent | `get/list_ready/report_progress` native | progress 是带 task version 的 agent claim、`verified:false`；不绑定当前 ActionAttempt |
| action | agent | `get/list` native | 查询路径已接；当前 adapter 未见 ActionAttempt 创建/启动/结算执行链 |
| attention | agent | `get/context` native；`request_focus` durable submission | context 走 AMP compiler 但只回工具预览；focus 入队，不改变驻留状态 |
| project | agent | 六项全 native | 0.7 Project rules/metadata/environment 的持久化和 CAS；environment 是声明，不直接改变进程或安装包 |
| workspace | agent | `list/read/outline/document_outline/diff` native；`write` unbound | 读/预览受路径、大小、freshness 限制；canonical CAS 写未注册。其它 legacy 写 API 不等同于此 verb |
| cooperation | agent | `inbox/send/report_result` 全部 unbound | 旧 MCP/A2A/team transport 存在，但不是 canonical cooperation surface 绑定 |
| evidence | agent | `get/list/cite` native | evidence ledger、freshness、独立宿主 review 辅助工具存在；citation 不等于 acceptance |
| execution | agent | `find_tools/inspect_tool/run/read_handle` native | pin、PEP、预算、journal、receipt 实际接入，但只允许 read-only tools；receipt 不证明业务成功 |
| budget | agent | `remaining` native | 插件 read execution quota；明确不是 Codex token 计量 |
| workflow | hidden | 无 agent verbs | 单写者 lifecycle 留宿主，符合 tier 设计；额外 review API 是受限宿主审批通道 |
| policy | hidden | 无 agent verbs | policy decision 应宿主掌握；检查 legacy API 是否另有暴露，不能仅看此表 |
| profession | hidden | 无 agent verbs | 由宿主配置以限制权限 |
| behaviour | hidden | 无 agent verbs | 发布治理需独立评测/审批 |
| capability | host | 无 agent verbs | 信任根，宿主负责 |
| manifest | host | 无 agent verbs | pinning/endpoint identity，宿主负责 |
| provenance | host | 无 agent verbs | 执行链创建 provenance |
| receipt | host | 无 agent verbs | host 写不可变执行事实；agent 可 cite evidence |
| verification | host | 无 agent verbs | 独立验证权归宿主 |
| retrieval | host | 无 agent verbs | 经 execution discovery 使用，不直接开放内部工具 |
| model | host | 无 agent verbs | 模型本身不可作为 tool 被调用 |
| runtime | host | 无 agent verbs | 经 execution facade；任意内部 runtime 不是 canonical agent surface |

未绑定的 9 项是：`session.report_status`、`turn.current/respond/clarify/report`、`workspace.write`、`cooperation.inbox/send/report_result`。按 0.7.2 tier 分类，host/hidden 无 agent verbs 本身是正确行为；不是统计里的第 50 项或缺失工具。

## 核心接线与断点

### 1. Codex 生命周期：Session 有限映射，Turn 仅作观察

Plugin manifest 配置了 MCP、skills 和 hooks，hook entry 收实际 session/turn id 并将原始 hook 事件写入项目 Store。`syncNativeSession` 仅在 `SessionStart/SessionEnd` 创建/转移 native session（结束时 suspend，避免伪造 closed）。标准 session get/list 按 hook 映射查询；这是有效但有限的 session 接线。

Hook 收到 `UserPromptSubmit/PreToolUse/PostToolUse/PreModelRequest/PostModelRequest/Stop/Interrupt` 并不表示实现了 AMP Turn 管理：hook 的 `additionalContext` 仅在 SessionStart/UserPromptSubmit 加固定工具提示；其它返回 `{}`。event bridge 是 observation，不是对话流/调用控制端口。测试也明确保证只创建 native Session，不推断 native Turn。Codex Goal getter/setter 同步的是 `codex.sync.goal` 快照/事件，不是构造 native Intent/Goal/Action 或完成业务验证；goal push 有 digest preflight，但 Codex API 无原子 CAS，存在并发窗口。

**判断：**不能据现有代码宣称 AMP 对当前 Codex Turn 的响应/澄清/中断与 Intent 捕获闭环。refract v1.8 §4.2/§15 同样把 Turn 当作输入至响应的边界，但此处作为设计参考而非 0.7.2 surface 动词要求。

### 2. Action、execution 与真实副作用

`action.get/list` 通过 workflow query 可用；计划/任务导入、draft、ready、有限 host review 也有原生路径。execution 使用 Manifest pin、参数 schema、host PEP、workspace/principal quota、durable journal、execution receipt 与 result handle。代码筛选执行工具时仅接受 read-only canonical `project/goal/plan/task/mission/intent/action/evidence/workspace` handler，并注释 write contracts 等 Action/attempt fencing 接好才开放。预算中 token quota 为 0，`budget.remaining` 文案也说明这是 plugin costs 而非 Codex usage。

**判断：**这是有价值的只读执行子系统，不等同于“Codex 的每个 Action 都经过 AMP”。本 adapter 没有把 Codex 自身 shell/editor/模型循环强制放进 AMP `execution.run`，也没有标准 ActionAttempt 启动/settle/reconcile 的完整管线。与 refract 的行动-Receipt-验证闭环相比仍未闭合；不要将普通执行 receipt 说成验证或任务完成。

### 3. Attention 编译不是隐式上下文注入

`attention.get/context` 使用宿主观察到的 thread、映射的 session 与当前活跃 observed turn；执行 scope、版本、mount/expiry/staleness、byte cap 检查并调 AMP `compileContext`。其返回明确标记 `tool-result-preview; no hidden Codex context injection`；未见 Codex PreModelRequest 注入 compiler output，亦未见模型可写的 mount/unmount/persist API。`request_focus` 的实现只是持久待审 submission。

**判断：**context 编译/查询有接线，Codex 上下文调度闭环没有。不能用 hook 提示语替代实际注入/Turn 边界 attention reset。

### 4. Durable submission 与消费

四个提案入口中 `plan.propose_draft` 会被 draft adapter 消费并生成 native draft；`intent.submit_clarification`、`goal.submit_evidence`、`attention.request_focus` 只记录 `pending_host_review`。存在 submission 队列读取工具不意味着它们已经被批准、转换或实施。没有发现其余三项消费者；这是**流程覆盖缺口**，不据此推断越权或漏洞。

### 5. Discovery 与渐进披露

`surface.mts` 的标准 canonical surface 会和已注册工具取交集，但 MCP `tools/list` 仍直接返回完整 `TOOLS`（146项），没有使用 AMP Gateway 所定义的 discovery-only bootstrap 后动态加载 selected contracts。Discovery provider 当前仅 `host_modules`；schema 可请求 `amp/session_files/session_outlines/conversation/network`，这些未安装 provider 时应被明确报告 unavailable。工具说明已承认此界限。不能宣称所有来源 provider 均接入，也不能把 surface metadata 的模块清单当授权清单。

### 6. Host/hidden 边界与 legacy 工具面

标准 0.7.2 Gateway 的责任是检查 binding、暴露 surface、身份注入、mutating idempotency、authorize 和 journal；policy/budget/lease 仍由 host 实现。canonical modules 遵循分层的代码路径是一个优点。

但对“严格 AMP 模块全都接线/完全由 canonical 面控制”的审计，还需看 0.6.3 legacy tools：旧 `coordination_keys` 支持 key generate/rotate/revoke 与 sign operations；`coordination_runtime` 可运行另一个 CognitiveRuntime/KernelRuntime/GovernedTask provider turn；`coordination_amp` 允许受限 domain resource create/invoke；registry 可编辑已安装行为模板。它们是独立 legacy host adapter，不会出现在 canonical 49 动词矩阵，但确实在同一 MCP tool list 可被调用。因此：

- 不把 host/hidden tier 直接注册成标准 canonical verbs，符合设计。
- 同时不能只凭 canonical tier 表就声称 legacy 路由也遵循同一 policy/approval 生命周期。应逐操作检查权限、宿主确认和消费者边界；尤其签名/key lifecycle 与行为/策略编辑属于高权力入口。
- 本报告不据这些接口直接下“存在可利用漏洞”结论；结论是统一 authority boundary/审计覆盖仍需针对 legacy routes 单独证明。

## 验证

| 命令 | 结果 | 证明范围/局限 |
|---|---|---|
| TypeScript 源与 app typecheck | 通过 | 类型兼容，不等于端到端生命周期验证 |
| `npm test` | 123/123 passed | 当前工作区套件；包含 canonical surface、Codex bridge、execution/filesystem 等行为，不证明桌面 Codex 已重载/信任插件 |
| `npm run validate` | 通过：1 plugin，146 tools | 包结构和工具 schema/注册 |
| `npm run smoke` | 426 checks passed | stdio MCP 启动、列工具、调用、结果 round-trip |
| `npm run conformance` | 9/9 passed against `amp-legacy@0.6.3` | 仅 legacy 0.6.3 的 canonical JSON/digest/Goal/Plan/ledger snapshot conformance；不是 0.7.2 的 49 verbs conformance |
| 独立 agent surface 对照 | 40/49 canonical verbs 注册 | 对照 0.7.2 `createAgentSurface()` 与工具 handler 集；并非 live desktop 调用测试 |

早先在受限 sandbox 下的单文件测试出现 `EPERM`、symlink/path 断言失败及隔离模式模块冲突；开放权限下标准 `npm test` 全部通过，故它们按环境受限处理，不作为产品失败计数。没有验证真实 desktop hook trust、运行中 Codex 工具快照是否已更新、完整 app-server stream、外部模型/远程协作与生产审批可用性。项目迁移记录也说明最新源码早于已安装 0.6.2 checkpoint 的部署状态；源码测试不自动证明已部署现场相同。

## 结论分级

- **P1 接线缺口：**Turn 标准接口未绑定；hook 是观察而非主循环控制；Attention compile 未注入 Codex；Action attempt 执行链未闭环。
- **P1 权限面需独立验证：**legacy key/runtime/domain/registry handlers 与 canonical host/hidden 分层是两个面；需要确认每个高权力操作的真实 host approval/authority enforcement，不能只凭标准 gateway 的测试下安全结论。
- **P2 能力缺口：**canonical workspace.write 与 cooperation 三动词未接；三个 durable submissions 暂无已检索到的消费路径；Discovery provider 来源有限。
- **已正确分层：**canonical hidden/host module 没有直接生成 agent 动词；执行结果/evidence/citation 未自动提升为 business acceptance；Codex event 未被伪造成 AMP verified fact。

## 建议顺序

1. 分别盘点 source 与 installed plugin build，确认桌面加载版本、hook trust 和 `tools/list`。
2. 有真实 Codex host lifecycle contract 后绑定 `turn.current/respond/clarify/report` 与 `session.report_status`；没有端口时继续明确 unavailable，不模拟。
3. 建立 ActionAttempt/lease/cancellation epoch/reconcile 与预算、执行、Receipt、独立 verification 的写副作用路径，再启用 canonical workspace.write。
4. 给 clarification/evidence/focus submissions 定义明确审批人、消费事务、拒绝/重试/版本冲突语义。
5. 为 Discovery 每个 provider source 明确可用性与动态工具加载契约；同步厘清 146 项 MCP 工具直接暴露与 discovery 的定位。
6. 针对 legacy keys/runtime/registry/domain API 建立逐操作 authority/approval matrix 和负向测试；保持与标准 canonical surface 的边界透明。
7. 为每个 37 个 native binding 自动跑 schema/authorization/scope/CAS/idempotency/restart/错误路径测试，单独标注真实 Codex host 验证和 simulation。

## 主要依据

- 规范与绑定清单：[AMP-MIGRATION-INVENTORY.json](AMP-MIGRATION-INVENTORY.json)、[AMP-07-MIGRATION.md](AMP-07-MIGRATION.md)、[CODEX-SYNC.md](CODEX-SYNC.md)。
- Gateway/工具列出：[surface.mts](../src/mcp/amp/surface.mts)、[server.mts](../src/mcp/server.mts)、[tools.mts](../src/mcp/lib/tools.mts)。
- 原生 canonical adapters：[workflow.mts](../src/mcp/amp/workflow.mts)、[progress.mts](../src/mcp/amp/progress.mts)、[draft.mts](../src/mcp/amp/draft.mts)、[workflow-review.mts](../src/mcp/amp/workflow-review.mts)、[execution.mts](../src/mcp/amp/execution.mts)、[evidence.mts](../src/mcp/amp/evidence.mts)、[filesystem.mts](../src/mcp/amp/filesystem.mts)、[attention.mts](../src/mcp/amp/attention.mts)、[proposals.mts](../src/mcp/amp/proposals.mts)。
- Codex bridge：[hooks.json](../plugins/codex-coordination/hooks/hooks.json)、[hook.mts](../src/mcp/codex/hook.mts)、[events.mts](../src/mcp/codex/events.mts)、[session.mts](../src/mcp/codex/session.mts)、[session-tools.mts](../src/mcp/codex/session-tools.mts)、[goals.mts](../src/mcp/codex/goals.mts)。
- Legacy operations：[host.mts](../src/mcp/amp/host.mts)、[keys.mts](../src/mcp/amp/keys.mts)、[CODEX-SYNC.md](CODEX-SYNC.md)。
- 测试与验证入口：[amp-surface.test.mjs](../test/amp-surface.test.mjs)、[amp-execution.test.mjs](../test/amp-execution.test.mjs)、[codex-sync.test.mjs](../test/codex-sync.test.mjs)、[mcp-smoke.mjs](../scripts/mcp-smoke.mjs)。
