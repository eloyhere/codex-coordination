# wire.md — AMP 0.7.9 × Codex 严格接线规格

- 状态：**草案（Draft）**，只定义接线，不含实现改动
- 基线：`attention-manifest-protocol@0.7.9`，`codex-coordination@0.6.3`
- 日期：2026-11-08（Asia/Shanghai）
- 范围：15 个 AMP `agent` 模块、49 个标准动词、独立 `replace` 工具；8 个 `host` 与 4 个 `hidden` 模块的边界
- 本轮约束：只新增本文件；源码、构建产物、依赖锁均未修改

---

## 0. 结论摘要

AMP 0.7.9 的模型可见表面是 **50 个工具契约**：

- 15 个 `agent` 模块共 **49 个动词**；
- 1 个独立工具 `attention_manifest_protocol_replace`（0.7.9 新增）；
- 8 个 `host` 模块和 4 个 `hidden` 模块**不生成模型工具**，这是协议有意的信任边界。

当前仓库的工具注册面已经接近完整：**45/49 个标准动词有 handler**（42 个 native、3 个 durable submission），剩余 **4 个全部是 `turn` 动词**；加上 `replace`，共 **46/50 个工具契约**有执行入口。以下 1–7 是**接入前审计快照**，最新实施状态见 [0.1 实施进度](#01-实施进度2026-11-09)：

1. `goal`、`plan`、`task`、`action`、`intent`、`mission` 的读取目前绑定在**导入的旧 ledger 快照**上，不是当前 Codex thread 的活体工作流。
2. `turn.current/respond/clarify/report` 没有真实宿主端口，继续标为未绑定是正确行为；不能用 hook 观察事件伪造。
3. `workspace.write` 只支持整文件 UTF-8 覆盖，未实现 AMP `WriteTarget` 的 line/byte/outline 定位；`replace` 未进入 ActionAttempt/Receipt 执行链。
4. `execution.run` 只接纳只读契约；写契约仍被隔离。
5. `attention.context` 是工具结果预览，不是 Codex 隐式上下文注入；`PreModelRequest` 按官方文档是 diagnostic-only，不能改模型上下文。
6. `cooperation` 是本地 durable 队列；没有远程投递或多拓扑执行。
7. `budget.remaining` 是插件原生 I/O 配额，不是 Codex token 计量。

因此本文件的“严格接线”定义为三层门禁：

- **L0 契约门禁**：名称、动词、authority、JSON Schema 与 AMP 0.7.9 完全一致；
- **L1 宿主语义门禁**：每个 handler 必须绑定真实宿主端口、真实 scope、真实存储和真实副作用链，不能返回占位或推断事实；
- **L2 独立验收门禁**：副作用必须有 receipt，证据必须有独立 verification，Task/Goal 完成只能由独立 acceptance 产生。

未通过 L1 的动词只能保持 **unbound + 明确 unavailable**，不能注册一个“看起来能调用”的 handler。

---

## 0.1 实施进度（2026-11-09）

本轮已按互斥子代理逐个落地以下工作包，全部通过独立复核：

| 工作包 | 结果 |
|---|---|
| workspace.write target | line/byte/outline + expectedBufferVersion，预审批 planner，Action/attempt/receipt 保留 |
| replace 执行链 | ActionAttempt + `file_flush_receipt` + evidence freshness 白名单 |
| planned digest / 预算 | `plannedContentDigest` 写入 journal；reservation 覆盖实际文件效果；unknown-outcome 故障注入 |
| reconciliation | 同时支持 write（含 target）与 replace；动态 receipt toolId/journal；legacy whole-file 回退 |
| live Turn/Intent | `UserPromptSubmit` host capture、`Stop` 合法收尾、确定性 ID、幂等、失败不丢 observation |
| live reads | `session.get` 选中 thread 后，intent/mission/goal/plan/task/action 直接读取 live session；imported 优先 |
| Mission/Goal bootstrap | 新扩展工具 `attention_manifest_protocol_workflow_bootstrap`，独立审批创建/激活 proposed/active |
| live plan/task | `propose_draft`、`workflow_review`、`task.report_progress` 支持 live scope |
| live write/replace | `write`/`replace` 通过 live-aware scope 在 live ready task 上执行，产生 attempt/receipt/evidence |
| live governance | cancellation / acceptance / evidence lifecycle / reconciliation 通过 live-aware scope 接入；新增 live 矩阵测试 |
| attention scheduler | 还原 typed `attention-schedule.mts`，新增宿主扩展工具 `attention_manifest_protocol_attention_schedule`，只读 L3 路由预览 |
| execution boundary | `budget.remaining` 明确 `usageScope:'plugin-native-io'` / `tokens:0` / `notCodexTokenUsage:true`；write/replace 明确不进入 `execution.run` |
| boundary tests | 新增 `test/amp-module-boundaries.test.mjs`：turn 未注册/未发现、attention scheduler 为扩展、cooperation 本地队列、budget 非 token、action/goal/task 的 host-only 动词不暴露 |

当前门禁：**334/334 单测通过**，`npm run validate` **165 tools**，`npm run smoke` **464 checks**，`npm run smoke:package` **464 checks**，`npm run conformance` **9 项通过（仍以 amp-legacy 0.6.3 为基线）**，Playwright Edge **2/2 场景通过**；`npm run typecheck`、`npm run build`（含 app）通过。工具数 165 中包含 canonical 50 契约中的 46 个已绑定 handler（4 个 turn 动词仍未绑定），其余为宿主扩展/旧协调工具。

仍未闭合、不得宣称完成的部分：

- `turn.current/respond/clarify/report`：没有真实 Codex Turn API，保持 unbound；Interrupt 也尚未写持久 interruption snapshot。
- `attention`：canonical get/context/request_focus 已绑定；新增的 L3 scheduler 只是只读路由预览，context 仍不是隐式注入，也不产生 mount/retention。
- `execution.run`：仍只接纳只读契约，写执行契约尚未开放（这是显式边界，不是遗漏）。
- `cooperation`：仍为本地 durable 队列，无远程投递/多拓扑。
- `budget`：仍是插件 I/O 配额，不是 Codex token 计量；`usageScope` 是字段名。
- live 的 Goal achievement/invalidation 尚不可达：live Plan 没有 host completion 路径，完成后 environment 变化会让旧 file receipt/evidence stale；live Task dispute 路径已验证。
- legacy targeted write / pre-WP3 replace journal 无 `plannedContentDigest` 时必须 fail closed，不能恢复。
- `replace` 直接使用 AMP file API（而非 vendor `createReplaceToolHandler`）以支持合法的空白 target；行为/receipt 已对齐，但仍是需要记录的实现偏差。

---

## 1. 已搜索的开发文档与事实来源

### 1.1 AMP（attention-manifest-protocol）

| 来源 | 用途 | 关键结论 |
|---|---|---|
| [npm registry 元数据](https://registry.npmjs.org/attention-manifest-protocol) | 版本、依赖、发布信息 | 最新版 **0.7.9**；依赖 `semantic-typescript@2.0.1`、`@elastic/elasticsearch@^9.5.1`；Node `>=24` |
| [0.7.9 tarball](https://registry.npmjs.org/attention-manifest-protocol/-/attention-manifest-protocol-0.7.9.tgz) | 直接读取发布包 | 包内含 `lib/`、`README.md`、`CHANGELOG.md`；本文件按包内实现而非旧 README 版本号判断 |
| `lib/agent/surface.js`（0.7.9 包内） | 模型表面 | `SURFACE_MODULES` 共 27 个模块；15 个 agent 模块共 49 个动词；`REPLACE_TOOL` 单独 1 个；`SURFACE_PREFIX = "attention_manifest_protocol"` |
| `lib/agent/gateway.d.ts`（0.7.9 包内） | 网关契约 | 绑定校验、保留参数拒绝、mutating 必须 idempotencyKey、authorize、每次调用一条 journal；gateway 不实现 policy/budget/lease |
| `README.md`（0.7.9 包内） | 开发模型 | `AgentGateway`、`createAgentSurface`、discovery providers、三层 tier、Execution/Evidence/Governance 边界 |
| [CHANGELOG.md](https://github.com/eloyhere/attention-manifest-protocol)（包内） | 版本差异 | 0.7.9 仅新增 `attention_manifest_protocol_replace`；0.7.8 增加 `discover` 的字符串数组与 `regex`；0.7.6 调整 `safeStringify` 小数舍入 |

0.7.9 的 15 个 agent 模块与动词数：

| 模块 | 动词数 | 动词 |
|---|---:|---|
| session | 3 | `get`、`list`、`report_status` |
| turn | 4 | `current`、`respond`、`clarify`、`report` |
| intent | 3 | `get`、`list`、`submit_clarification` |
| mission | 1 | `get` |
| goal | 3 | `get`、`list`、`submit_evidence` |
| plan | 4 | `get`、`list`、`ready_tasks`、`propose_draft` |
| task | 3 | `get`、`list_ready`、`report_progress` |
| action | 2 | `get`、`list` |
| attention | 3 | `context`、`get`、`request_focus` |
| project | 6 | `rules`、`metadata`、`environment`、`describe_environment`、`configure_environment`、`put_rule` |
| workspace | 6 | `list`、`read`、`outline`、`document_outline`、`diff`、`write` |
| cooperation | 3 | `inbox`、`send`、`report_result` |
| evidence | 3 | `get`、`list`、`cite` |
| execution | 4 | `find_tools`、`inspect_tool`、`run`、`read_handle` |
| budget | 1 | `remaining` |
| **合计** | **49** | 另有独立 `replace` |

### 1.2 Codex 插件开发文档

| 来源 | 用途 | 关键结论 |
|---|---|---|
| [OpenAI Plugins 仓库](https://github.com/openai/plugins) | 官方插件示例与脚手架 | 插件根目录必须有 `.codex-plugin/plugin.json`；可选 `skills/`、`.mcp.json`、`hooks.json`、`commands/`、`assets/` |
| [Plugin JSON 规范](https://cdn.jsdelivr.net/gh/openai/plugins@main/.agents/skills/plugin-creator/references/plugin-json-spec.md) | manifest 字段 | `name`、`version`、`description`、`author`、`skills`、`hooks`、`mcpServers`、`apps`、`interface`；marketplace 使用 `.agents/plugins/marketplace.json` |
| [Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks) | 生命周期事件与输出契约 | 事件包括 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`、`PreModelRequest`、`PostModelRequest`；`PreToolUse` 可阻断/改写；`additionalContext` 可注入 developer context；**`PreModelRequest/PostModelRequest` 输出仅诊断，不能改变模型上下文** |
| [Codex Plugins 页面](https://developers.openai.com/codex/plugins) | 插件能力概览 | 插件可提供 skills、MCP servers、hooks、app connectors |
| [第三方 Codex 扩展性参考](https://github.com/a5c-ai/babysitter/blob/main/library/specializations/meta/harnesses/codex/README.md) | 交叉核对（**非权威**） | 与官方 hooks/manifest 结论一致；其中“5 个 hook 事件”的表述已过时，不能作为事件白名单 |

说明：本环境直接访问 `https://developers.openai.com/codex/hooks` 与 `/codex/plugins` 会返回 403/Vercel deny；上述 hooks 事实取自同站官方文档的 `learn.chatgpt.com/docs/hooks` 镜像页，并用仓库现有 `plugins/codex-coordination/hooks/hooks.json` 的事件名交叉核对。正式实施前仍应在目标 Codex 版本上用 `/hooks` 与真实事件验证，不能把本文件当作运行时保证。

### 1.3 本地事实

- `package.json`、`package-lock.json` 均已锁定 `attention-manifest-protocol@0.7.9`；`amp-legacy` 仍为 `npm:attention-manifest-protocol@0.6.3`。
- `scripts/mcp-smoke.mjs` 当前期望 **165** 个工具，并已包含 `attention_manifest_protocol_replace` 与 `attention_manifest_protocol_attention_schedule`；`docs/` 中多处 **162**、**98** 的计数已落后，不能作为当前基线。
- `src/mcp/amp/surface.mts` 通过 `createAgentSurface()` 取标准描述符，再与已注册工具取交集；`replace` 通过 `replaceBinding` 注册。
- 原先 `plugins/codex-coordination/mcp/amp/attention-schedule.mjs` 是只有构建产物、没有源码的孤立文件；本轮已还原 `src/mcp/amp/attention-schedule.mts`，并在 `surface.mts` 注册为宿主扩展 `attention_manifest_protocol_attention_schedule`。
- 本机没有全局 `node`/`npm` 在 PATH 中；本轮通过 `R:\environment\nodejs` 的 Node 24 与 npm 运行全部门禁，未使用全局安装。

---

## 2. 严格接线的 12 条规则（S1–S12）

**S1 — 名称与动词不可改写。**
工具名必须是 `attention_manifest_protocol_<module>.<verb>`，独立工具名必须是 `attention_manifest_protocol_replace`。不得用 `_v2`、别名或大小写变体冒充。

**S2 — 身份只来自宿主。**
`tenantId`、`principalId`、`sessionId`、`turnId`、`attemptId`、`operationId`、`policyVersion`、`cancellationEpoch`、`owner`、`lease`、`fence`、`authority` 不能被模型参数提供；`assertModelParameters()` 必须在任何 handler 入口执行，且递归检查嵌套对象。

**S3 — 每个 mutating 调用必须可重放。**
入口先冻结规范化请求快照；同一 `principalId + idempotencyKey` 的重复请求返回原结果；不同请求使用同一 key 必须报错；禁止在 `await` 之后继续读取可变入参。

**S4 — 不得伪造宿主事实。**
hook 观察不等于 native Turn/Intent/Action；`observed`、`verified:false`、`origin` 必须显式出现在结果中。没有真实端口时保持 unbound，不能把事件聚合结果包装成标准动词。

**S5 — tier 边界不可穿透。**
`host` 模块（`capability`、`manifest`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime`）与 `hidden` 模块（`workflow`、`policy`、`profession`、`behaviour`）永远不注册为模型工具。宿主扩展工具不得使用标准 `<module>.<verb>` 名称。

**S6 — scope 在每个边界检查。**
workspace、workflow、session、principal、project root、文件路径、attention scope 在读取、审批前、审批后、提交前都要检查；跨 scope 一律拒绝。

**S7 — 审批是独立的宿主决定。**
使用关联的 MCP elicitation/审批端口，展示**不可变**的精确参数；拒绝不改变状态；审批等待后必须重新验证版本、scope、文件/环境哈希、workflow head。

**S8 — receipt、verification、evidence、acceptance 不可互相冒充。**
`file_flush_receipt` 只证明文件操作；`verifyBusinessSemantics` 只产生 verification；Evidence 只是可引用证据；Task/Goal 完成必须另有 acceptance。任何 handler 都不得因“执行成功”自动完成 Task/Goal。

**S9 — 所有副作用共用预算账本。**
直接读、`execution.run` 子调用、`workspace.write`、`replace` 都从同一 `native-read:<principal>` 账户 reserve/settle；失败也计费；0 余额必须拒绝；`budget.remaining` 不得声称是 Codex token 用量。

**S10 — unavailable 必须显式。**
未绑定动词要在 `attention_manifest_protocol_surface`、discovery、测试和文档中一致报告；禁止注册“总是抛 not implemented”的占位 handler。

**S11 — 持久化单写者、可重放、可审计。**
每个项目一个 `.codex-coordination/amp-07/store.sqlite`；写入必须经过 Store 事务；重启后 rehydrate 并报告 `skipped`；旧数据不静默改写。

**S12 — 完成必须有证据。**
每个动词至少覆盖：schema parity、scope 拒绝、idempotency 重放、版本冲突、重启恢复、审批拒绝；涉及副作用的再加 stale/unknown_outcome/reconciliation；涉及证据的再加独立 verification。

---

## 3. Codex 宿主真实能力与限制

### 3.1 可作为 AMP 端口的宿主能力

| 能力 | 端口 | 可支持的 AMP 语义 |
|---|---|---|
| MCP stdio tools | `tools/list`、`tools/call` | 模型可见工具；顺序调用；每次调用可绑定 connection identity |
| Hooks | `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`、`PreModelRequest`、`PostModelRequest` | 真实 session/turn id、prompt、tool input/response、last assistant message、interrupt reason；`additionalContext` 注入 |
| Plugin manifest / skills | `.codex-plugin/plugin.json`、`skills/` | 打包与说明，不是运行时授权 |
| App-server control socket | 当前仅使用 `thread/goal/get`、`thread/goal/set` | Codex Goal 观察/推送；**没有 turn 控制接口** |
| MCP Apps | resources | 设置界面；不是业务执行端口 |

当前 [hooks.json](plugins/codex-coordination/hooks/hooks.json) 只注册了 11 个事件：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreModelRequest`、`PostModelRequest`、`PreCompact`、`PostCompact`、`Stop`、`Interrupt`。官方文档另有 `PermissionRequest`、`SubagentStart`、`SubagentStop`；是否补齐由宿主观察需求决定，补齐也不产生 canonical 动词，更不改变 `turn` 未绑定的结论。

### 3.2 不能作为 AMP 端口的宿主能力

- **没有** `turn.current/respond/clarify/report` 的对等 API；hook 的 `turn_id` 是观察标识，不是可控 Turn 状态机。
- **没有** 中间 assistant 消息流；`Stop` 只有 `last_assistant_message`。
- **没有** 让 `PreModelRequest` 改写模型上下文的契约；官方文档明确 diagnostic-only。
- **没有** Codex 主循环的 token 计量端口；`budget` 只能是插件自己的 I/O 配额。
- **没有** 任意 Action 启动/结算/取消 API；文件副作用只能由插件自己的执行链产生。

### 3.3 对 15 个模块的直接后果

| 模块 | 可严格绑定到 Codex 的部分 | 必须保持 unbound/明确 unavailable 的部分 |
|---|---|---|
| session | hook 创建/恢复 native session；get/list/report claim | create/close/archive（host-only，本来就不在 surface） |
| turn | 只读观察可作为宿主扩展 | `respond/clarify/report` 及无法确认 classification 的 `current` |
| intent | 宿主 capture（UserPromptSubmit）+ get/list；submit_clarification durable | accept/capture 的模型动词（本来就不在 surface） |
| mission | 宿主创建 + get | 生命周期转移（host-only） |
| goal | 宿主导入 + get/list；submit_evidence durable | achieve/invalidate/revalidate（host/verifier） |
| plan | get/list/ready_tasks；propose_draft + host review | activate/complete/supersede（host） |
| task | get/list_ready；report_progress | claim/accept/fail（host） |
| action | get/list attempts | start/settle/reconcile（host） |
| attention | get/context；request_focus durable；hook additionalContext | mount/unmount/persist（host）；隐式注入不可承诺 |
| project | 六个动词全部 native | views/outline/mindmap（surface 有意 withheld） |
| workspace | list/read/outline/document_outline/diff/write | storage/writeBytes（host/plugin） |
| cooperation | inbox/send/report_result 本地队列；host review 创建 delegation | delegate/transfer/cancel（host） |
| evidence | get/list/cite | add/revoke（host/verifier） |
| execution | find/inspect/run（只读契约）/read_handle | 写契约必须等 Action/attempt fencing |
| budget | remaining（插件 I/O） | grant/configure（host） |

---

## 4. 覆盖矩阵（以当前源码为准）

状态图例：

- **✅**：handler 存在，语义与动词契约一致，scope/authority/错误路径已覆盖；
- **◐**：handler 存在，但语义被收窄或只在导入快照上可用，必须补门禁或明确标注；
- **○**：durable submission 已实现，但没有执行；不是“已完成”；
- **✗**：没有 handler，保持未绑定；
- **⊘**：host/hidden，正确不暴露。

| # | 模块 | 动词 | 已绑定 | 形式 | 当前实现 | 严格缺口 |
|---:|---|---|---:|---|---|---|
| 1 | session | get/list/report_status | 3/3 | ◐ | [session-tools.mts](src/mcp/codex/session-tools.mts) | `report_status` 是 claim/事件，不改 session 生命周期；surface 标 non-mutating |
| 2 | turn | current/respond/clarify/report | 0/4 | ✗ | 仅 [events.mts](src/mcp/codex/events.mts) 观察 | 无宿主 Turn API；不得伪造 |
| 3 | intent | get/list/submit_clarification | 3/3 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts)、[proposals.mts](src/mcp/amp/proposals.mts) | live capture + read 已接；submit 仍 durable，accept 仅 host |
| 4 | mission | get | 1/1 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts)、[workflow-bootstrap.mts](src/mcp/amp/workflow-bootstrap.mts) | live bootstrap 创建/激活；读取 live；无 model 写入口 |
| 5 | goal | get/list/submit_evidence | 3/3 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts)、[proposals.mts](src/mcp/amp/proposals.mts)、[workflow-bootstrap.mts](src/mcp/amp/workflow-bootstrap.mts) | live bootstrap 创建/激活；achieve/invalidate 仍 host/verifier |
| 6 | plan | get/list/ready_tasks/propose_draft | 4/4 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts)、[draft.mts](src/mcp/amp/draft.mts) | live draft + review 已接；plan complete 仍无 model 入口 |
| 7 | task | get/list_ready/report_progress | 3/3 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts)、[progress.mts](src/mcp/amp/progress.mts) | live read/progress 已接；progress 是 claim |
| 8 | action | get/list | 2/2 | ◐ | [workflow.mts](src/mcp/amp/workflow.mts) | write/replace 都产生 attempt；start/settle 仍 host |
| 9 | attention | context/get/request_focus | 3/3 | ◐ | [attention.mts](src/mcp/amp/attention.mts)、[proposals.mts](src/mcp/amp/proposals.mts)、[attention-schedule.mts](src/mcp/amp/attention-schedule.mts) | context 是预览；L3 scheduler 是只读扩展；无隐式注入 |
| 10 | project | 6 | 6/6 | ✅ | [project.mts](src/mcp/amp/project.mts) | views 等为 host 扩展，不是 canonical |
| 11 | workspace | 6 + replace | 6/6 + 1 | ◐ | [filesystem.mts](src/mcp/amp/filesystem.mts)、[write.mts](src/mcp/amp/write.mts)、[replace.mts](src/mcp/amp/replace.mts) | write 支持整文件/line/byte/outline；replace 已有 attempt/receipt；仍只改已存在 UTF-8 |
| 12 | cooperation | inbox/send/report_result | 3/3 | ◐ | [cooperation.mts](src/mcp/amp/cooperation.mts) | 仅本地 durable 队列；无远程/多拓扑 |
| 13 | evidence | get/list/cite | 3/3 | ✅ | [evidence.mts](src/mcp/amp/evidence.mts) | 证据创建依赖 host review；不是自动验收 |
| 14 | execution | find_tools/inspect_tool/run/read_handle | 4/4 | ◐ | [execution.mts](src/mcp/amp/execution.mts) | 显式只读边界；write/replace 不进入 execution.run |
| 15 | budget | remaining | 1/1 | ◐ | [execution.mts](src/mcp/amp/execution.mts) | 插件 I/O 配额；显式 usageScope/tokens/notCodexTokenUsage |

合计：**45/49 个模块动词有 handler**（42 native + 3 durable），**4 个 turn 动词未绑定**；加 `replace` 为 **46/50 个工具契约**有执行入口。严格语义完成度远低于此数字，不能以 46/50 宣称“全部接入”。

---

## 5. 逐模块接线规格

以下每个模块按同一模板：**契约 → 当前 → 缺口 → 严格改法 → 验收**。

### 5.1 session

**契约**：`get`（read，`session:read`）、`list`（read，`session:read`）、`report_status`（surface 标 non-mutating，`session:report`）。

**当前**：

- `SessionStart`/`SessionEnd` 通过 [session.mts](src/mcp/codex/session.mts) 创建/挂起 native Session；`SessionEnd` 只 suspend，不 close，允许 resume。
- [session-tools.mts](src/mcp/codex/session-tools.mts) 的 `get` 必须提供真实 hook 观察到的 `threadId`；`list` 只列本项目 hook 映射；`report_status` 要求 `threadId`、`expectedVersion`、`status`、`idempotencyKey`，写入 `codex.amp.session.status` 事件并标 `verified:false`。

**缺口**：

- `report_status` 在 AMP surface 中是非 mutating，但当前会持久化事件并要求 idempotency；必须明确它是“会话状态声明”，不是 Session 生命周期转移。
- `list` 不返回非 hook 创建的 native session（例如导入快照），这是正确的，但描述必须说清。
- `SessionEnd` 的 suspend 语义不是 close；如果用户显式关闭，需要宿主端口，当前没有。

**严格改法**：

1. 保留 `report_status` 为 **claim**：结果字段固定包含 `source:'agent-session-status-claim'`、`verified:false`、`sessionVersion`、`threadId`；禁止改 `Session.state`。
2. 在描述和 `attention_manifest_protocol_surface` 中标明“非生命周期”；测试断言 session version 不变。
3. `get/list` 继续只读 hook 映射；导入快照不得出现在 session 列表。
4. 增加 `SessionEnd` 与随后 `SessionStart` 的 resume 回归，确认重复 start 不产生重复 transition。

**验收**：

- 同 `threadId` 重复 `get` 稳定；跨项目不可见；
- `report_status` 同 key 重放；不同内容同 key 报错；旧 `expectedVersion` 报错；
- 重启后 claim 仍可读；
- 断言 `report_status` 不改变 `session.state`/`session.version`。

### 5.2 turn

**契约**：`current`（read）、`respond`（mutate）、`clarify`（mutate）、`report`（mutate），authority `turn:read` / `turn:write`。

**当前**：

- 没有任何 `turn.*` handler。
- [events.mts](src/mcp/codex/events.mts) 把 `UserPromptSubmit`/`Stop`/`Interrupt` 聚合成 observed turn；`readCodexThread` 返回 `turns`，但这不是 AMP `Turn` 实体，也没有 classification。
- `codex_sync` 工具暴露观察结果；没有注册标准 `turn.current`。

**缺口**：

- AMP `Turn` 必须有 `classification`（`steering`/`status`/`cancel`/`new_intent`）和合法状态机；Codex hook 不提供 classification。
- `respond` 需要把模型响应写回当前 turn；Codex 没有这个 API。
- `clarify` 需要把澄清问题交付给用户并建立 continuation；插件只能返回工具结果，不能控制 Codex 对话。
- `report` 需要 turn 版本/epoch；没有宿主端口。

**严格改法（推荐）**：

- **保持 4 个动词全部 unbound**，并在 `surface`/discovery/README 中明确 `turn` 是 blocked-on-host-API，不是遗漏。
- 如果未来要绑定 `turn.current`，宿主必须提供 `CodexTurnPort`（见下），且由宿主创建 native Turn；不能用 observed event 直接伪装：
  ```ts
  interface CodexTurnPort {
    current(threadId: string): { turnId: string; state: TurnState; classification: InputClassification; version: number } | undefined
    respond(turnId: string, expectedVersion: number, response: string): void
    clarify(turnId: string, expectedVersion: number, question: string): void
    report(turnId: string, expectedVersion: number, summary: string): void
  }
  ```
- 在既有 hook 路径中只保留 `codex_sync` 的 observation 字段；禁止新增 `turn.current` 的“观察别名”。

**验收**：

- `tools/list` 中不存在 `attention_manifest_protocol_turn.*`；
- `attention_manifest_protocol_surface` 对 turn 报告 unbound 原因；
- 负向测试：调用 `turn.current` 返回 unknown tool，不得回退到 observed turn；
- 如果实现 CodexTurnPort，必须通过 restart、stale version、interrupt、classification 不可由模型提供等测试。

### 5.3 intent

**契约**：`get`/`list`（read）、`submit_clarification`（mutate，durable submission），authority `intent:read` / `intent:clarify`。

**当前**：

- [workflow.mts](src/mcp/amp/workflow.mts) 提供 get/list，但要求先用 `workflow_scope` 选择导入快照，且实体 `sessionId` 必须等于选中 scope。
- [proposals.mts](src/mcp/amp/proposals.mts) 把 `submit_clarification` 写成 `pending_host_review` 事件；[submission-review.mts](src/mcp/amp/submission-review.mts) 在独立审批后附加 reviewed reference，不 accept Intent。

**缺口**：

- 没有从 `UserPromptSubmit` 捕获 live Intent；因此 `intent.get/list` 对当前 Codex 对话不可用。
- 没有 host accept/confirm 的消费路径；`submit_clarification` 只有附件，不会推进 Intent 状态。
- `intent.capture`/`accept` 本来就是 host-only，不能注册成模型工具。

**严格改法**：

1. 新增宿主 capture（不是模型工具）：`UserPromptSubmit` 在 native Store 中创建 `Intent(state:'captured', originTurnId, text)`，以 `turn_id` + prompt digest 幂等；文本上限、跨项目隔离。
2. 宿主可按显式策略 `captured -> interpreted`（例如记录解释摘要），但不得自动 `confirmed/accepted`；accept 必须独立审批。
3. `intent.get/list` 优先 live session scope；导入 scope 必须显式选择，并在结果中带 `origin:'imported-workflow'`。
4. `submit_clarification` 保持 durable；review 只能附加引用，结果固定 `acceptanceGranted:false`。

**验收**：

- 同一 `turn_id` 重复 prompt 只创建一个 Intent；
- 跨项目/跨 session 读取拒绝；
- clarification 重放、审批拒绝、版本变化；
- 断言任何路径都不能把 Intent 置为 `accepted`。

### 5.4 mission

**契约**：`get`（read，`mission:read`）。

**当前**：

- 只有 [workflow.mts](src/mcp/amp/workflow.mts) 的导入快照读取。

**缺口**：

- 没有 live Mission；Mission 必须由 host 在 Intent accept 后创建。
- 当前读取会把导入快照的 Mission 当成当前任务，用户可能误以为它属于当前 Codex thread。

**严格改法**：

1. host 在 Intent 独立 accept 后创建 `Mission(state:'proposed'/'active', intentId)`；模型不能创建。
2. `mission.get` 先解析 live session；没有 live mission 时返回明确的 `not_found`/`unavailable`，不得回退到导入快照，除非显式选择导入 scope。
3. 结果带 `origin`、`sessionId`、`state`；不要返回“当前 mission”而不说明来源。

**验收**：

- 未 accept 前无 Mission；
- 导入 scope 与 live scope 不混用；
- 重启后 Mission 可读且版本稳定。

### 5.5 goal

**契约**：`get`/`list`（read）、`submit_evidence`（mutate，durable submission），authority `goal:read` / `goal:evidence`。

**当前**：

- [workflow.mts](src/mcp/amp/workflow.mts) 读取导入 workflow 的 Goal。
- [proposals.mts](src/mcp/amp/proposals.mts) 的 `submit_evidence` 只记录 `pending_host_review`。
- [events.mts](src/mcp/codex/events.mts) 的 `mirrorGoal` 把 Codex Goal 写成 `codex.sync.goal` 观察，不是 native Goal。
- `goal.submit_evidence` 不会被自动 accept；`evidence_review` 可以创建 Evidence，但不会 achieve Goal。

**缺口**：

- Codex Goal 与 AMP Goal 没有 host 映射；当前只有观察快照。
- 没有 host 创建/激活/完成 Goal 的路径；`goal.get/list` 只能看导入快照。
- `submit_evidence` 没有消费者把它转成 native Goal evidence（review 只附加）。

**严格改法**：

1. 定义 host 导入：Codex Goal（`thread/goal/get` 或只读 DB）→ `codex.sync.goal` 观察；只有独立 host review 后才创建 native `Goal(state:'proposed', validity:'verification_pending', contractVersion, acceptanceCriteria)`。
2. 模型只能 `get/list/submit_evidence`；achieve/invalidate/revalidate 永远 host/verifier。
3. `submit_evidence` 保持 durable；review 只附加 reviewed reference，结果 `acceptanceGranted:false`。
4. 结果中明确区分 `codexGoal`（观察）与 `nativeGoal`（AMP 事实）。

**验收**：

- Codex Goal complete 不会改变 native Goal 状态；
- evidence review 不会 achieve Goal；
- Goal 版本/CAS、跨 scope、重启、审批拒绝；
- 断言 `goal.achieve` 等 host-only 动词没有被注册。

### 5.6 plan

**契约**：`get`/`list`/`ready_tasks`（read）、`propose_draft`（mutate），authority `plan:read` / `plan:propose`。

**当前**：

- [workflow.mts](src/mcp/amp/workflow.mts) 读取导入快照。
- [draft.mts](src/mcp/amp/draft.mts) 在选中 workflow 的 active Goal 下创建 native draft plan + pending task DAG；校验 bounds、DAG、重复 id、未来 deadline；idempotent。
- [workflow-review.mts](src/mcp/amp/workflow-review.mts) 提供 host 审批的有限状态转移。

**缺口**：

- draft 只能在“导入快照 + active goal”下创建；没有 live goal/plan 路径。
- `ready_tasks` 依赖 session 状态和依赖完成；导入 session 是 suspended，通常返回空。
- 没有模型可见的 plan activate/complete；这是正确的 host-only。

**严格改法**：

1. 在 live Goal 建立后，允许 `propose_draft` 对 live workflow 创建 draft；bounds 必须未来，DAG 必须无环。
2. `ready_tasks` 只返回 live session active/idle 且依赖完成的 ready task；导入 session suspended 时明确 `executionAuthorized:false`。
3. plan approval 仍通过 host review；模型不能 activate/complete。
4. 记录 draft 与 submission 的消费关系，重放不重复创建。

**验收**：

- 有环/缺依赖/重复 id/过期 bounds 全部拒绝；
- 同一 key 重放返回同一 plan/tasks；
- approval 前后 scope/head 变化拒绝；
- 模型调用 activate/complete 不存在。

### 5.7 task

**契约**：`get`/`list_ready`（read）、`report_progress`（mutate），authority `task:read` / `task:progress`。

**当前**：

- [workflow.mts](src/mcp/amp/workflow.mts) 读取导入快照；`task.get` 附带最近 20 条 progress 事件。
- [progress.mts](src/mcp/amp/progress.mts) 通过 [attempt-scope.mts](src/mcp/amp/attempt-scope.mts) 解析**唯一 running attempt**；要求 task version、非终态、active/idle session；写入 `verified:false` claim。

**缺口**：

- task 读取仍只在导入快照；live task 需要 live plan。
- `report_progress` 是 claim，不是任务状态变化；这是正确语义，但必须在描述中说明。
- 没有 model claim/accept/fail；这些是 host-only。

**严格改法**：

1. live workflow 下 task 由 draft 创建；`task.get/list_ready` 使用 live scope。
2. `report_progress` 保持 claim；必须存在唯一 running attempt；记录 attemptId/executionId/operationId/epoch；不改变 task state。
3. 任务完成只能由 host acceptance；模型不能调用 accept/fail。

**验收**：

- 无 running attempt 拒绝；多 running attempt 拒绝；stale task version 拒绝；
- cancellation epoch 变化拒绝；
- 重放不重复写 claim；
- 断言 report_progress 不改变 task state。

### 5.8 action

**契约**：`get`/`list`（read，`action:read`），返回 ActionAttempt，不是 Action aggregate。

**当前**：

- [workflow.mts](src/mcp/amp/workflow.mts) 的 `action.get` 用 `scopedAttempt` 返回 attempt；`action.list` 按 taskId 返回 attempts。
- [write.mts](src/mcp/amp/write.mts) 与 [replace.mts](src/mcp/amp/replace.mts) 都创建 Action + attempt；`execution.run` 不创建 ActionAttempt（只创建 execution invocation/receipt），因为执行面显式只读。

**缺口**：

- `replace` 和未来写执行必须产生真实 ActionAttempt，否则 `action.get/list` 看不到它们。
- 没有 start/settle/reconcile 模型动词；这是 host-only，正确。
- 需要统一 attempt 身份字段：`actionId`、`attemptId`、`executionId`、`operationId`、`cancellationEpoch`。

**严格改法**：

1. 所有副作用入口共用 `createActionAttempt` 辅助：Action declared→pending→ready→executing，`startAttempt`，settle。
2. `action.get/list` 只返回 attempt；跨 scope 拒绝；尝试重复 attempt id 必须拒绝。
3. 记录 unknown_outcome 与 reconciliation 入口；模型不能 settle。

**验收**：

- write/replace 都产生 attempt；
- attempt 与 action/task 的 sessionId/operationId 一致；
- 跨 scope、重复 id、epoch 变化拒绝；
- 重启后 attempt 可读。

### 5.9 attention

**契约**：`context`/`get`（read）、`request_focus`（mutate，durable submission），authority `attention:read` / `attention:focus`。

**当前**：

- [attention.mts](src/mcp/amp/attention.mts) 的 `get` 按 observed thread + native session + principal/tenant 过滤；`context` 用最新 active observed turn，调用 `compileContext`，检查 mount/expiry/stale/version/32 KiB 上限；结果明确 `tool-result-preview; no hidden Codex context injection`。
- [proposals.mts](src/mcp/amp/proposals.mts) 的 `request_focus` 入 durable queue；[submission-review.mts](src/mcp/amp/submission-review.mts) 可批准 mount。
- [hook.mts](src/mcp/codex/hook.mts) 在 `UserPromptSubmit` 通过 `prepareHookAttention` 返回有界 `additionalContext`。

**缺口**：

- canonical 面没有 route/focus/blur/switch/suppress 动词；本轮已把只读 `AttentionScheduler.route` 作为宿主扩展 `attention_manifest_protocol_attention_schedule` 接入，不改变 residency。
- 没有 mount/unmount/persist 模型动词（host-only）；`request_focus` 只是提案。
- 不能声称“注入了 Codex 上下文”；`PreModelRequest` 不能改上下文。

**严格改法**：

1. `attention.context` 保持 preview 语义，字段固定 `delivery:'tool-result-preview; no hidden Codex context injection'`；测试断言没有隐式注入路径。
2. L3 scheduler 已作为**宿主扩展工具** `attention_manifest_protocol_attention_schedule` 注册并明确非 canonical；只读 route 结果，不 mount、不改 retention、不授权。原孤立构建文件已由 `src/mcp/amp/attention-schedule.mts` 取代。
3. `request_focus` 的 review 只能 mount；不能改 retention/expiry。
4. hook delivery 保持有界摘要；`additionalContext` 需要 `additionalContextLimit`；不返回 secrets。

**验收**：

- scope/expiry/stale/mount/byte cap；
- request_focus 审批拒绝不改 residency；
- hook 输出不超过上限；
- 负向测试：不存在“hidden injection”或“PreModelRequest 注入”断言。

### 5.10 project

**契约**：6 个动词；`project:read` / `project:write`。

**当前**：

- [project.mts](src/mcp/amp/project.mts) 使用 native `Project` + `createProjectToolHandlers`；`bindProject` rehydrate/flush；`put_rule`/`configure_environment` 带 CAS 和 idempotency journal；metadata 只读；environment 是声明，不改进程/安装。
- [project-views.mts](src/mcp/amp/project-views.mts) 提供 host 扩展的 views/anchor review。

**缺口**：

- `views`/`outline`/`mindmap` 按 surface 是 withheld（§13.5），不能注册；host 扩展只能作为扩展。
- `putMetadata`/`putView` 是 host-only；当前通过 `project_review` 实现，必须保持独立审批。

**严格改法**：

1. 六个 canonical 动词保持现状；确保 rule/environment CAS、重启 replay、迁移分支。
2. `project_views`/`project_review` 明确标为 host extension，不计入 50；不得命名为 `project.views`。
3. environment 输出继续声明“不安装依赖、不改环境变量”。

**验收**：

- rule/environment 版本冲突、重放、迁移；
- 环境声明与进程环境隔离；
- views/anchor 只在审批后写。

### 5.11 workspace

**契约**：`list`/`read`/`outline`/`document_outline`/`diff`/`write`（`workspace:read` / `workspace:write`）+ 独立 `replace`。

**当前**：

- [filesystem.mts](src/mcp/amp/filesystem.mts) 提供有界只读：路径/符号链接/ADS/遍历拒绝，16 MiB 文件、256 KiB 文本、500 节点 outline、深度 4/500 目录项。
- [write.mts](src/mcp/amp/write.mts) 是**整文件 UTF-8 CAS 覆盖**：要求 active workflow task、ActionAttempt、lease/CAS、host 审批、file_flush_receipt、budget；不支持 create/delete/binary/line/byte/outline。
- [replace.mts](src/mcp/amp/replace.mts) 支持 string/regex/line/byte/outline + expectedBufferVersion/expectedBaseHash，但只用自定义 journal/budget，没有 ActionAttempt 和 native receipt。

**缺口**：

- AMP `workspace.write` 的契约是 `write(content, target?, editOptions?)`，支持 `WriteTarget`（line/byte/outline）和 `expectedBufferVersion`/`expectedBaseHash`；当前只实现整文件。
- `replace` 没有进入 Action/attempt/receipt 链；审批和 journal 是真实的，但“执行事实”不完整。
- 两者都没有把 `onFileReceipt` 映射为 native receipt；`write` 是手工构造 receipt，`replace` 则完全没有 receipt。

**严格改法**：

1. `workspace.write` 增加可选 `target`（line/byte/outline）与 `expectedBufferVersion`；内部调用 `WorkspaceFile.write(content, target, editOptions)`，保留 CAS/lease/审批/attempt/receipt。
2. `replace` 改为标准 handler 路径：先 `gateway.call`（authorize/idempotency），再创建 Action + `startAttempt`，调用 `createReplaceToolHandler`，从 `onFileReceipt`/snapshot 生成 `file_flush_receipt`，settle 实际字节，记录 unknown_outcome + reconciliation。
3. 两者共用同一个 `ScopedWriteStorage`/审批/预算辅助，禁止两套语义。
4. 明确 create/delete/binary 暂不支持：`workspace.write` 只对已存在 UTF-8 文件；`writeBytes` 是 host-only（surface withheld）。

**验收**：

- 整文件、line、byte、outline 四种写；expectedBufferVersion/BaseHash 冲突；
- 非 UTF-8/不存在/超过 1 MiB 拒绝；
- 审批拒绝、审批期文件变化、未知结果、重启、跨 scope；
- write/replace 都产生 attempt + receipt；receipt 能被 evidence freshness 消费。

### 5.12 cooperation

**契约**：`inbox`（read）、`send`/`report_result`（mutate），authority `cooperation:read` / `cooperation:send` / `cooperation:result`。

**当前**：

- [cooperation.mts](src/mcp/amp/cooperation.mts) 使用 native `CooperationCoordinator`，本地 durable 队列，`topology:'star'`、`sharing.isolation:'isolated'`；每次读写同步 native cancellation fence；`send`/`report_result` 需 host-approved delegation。
- `cooperation_review` 创建 cooperation/delegation；不启动远程 agent，不远程投递。
- 结果固定 `transport:'local-durable-queue'`、`remoteDelivery:false`、`verified:false`。

**缺口**：

- 没有远程传输、mesh/pipeline/hierarchical/consensus、merge/arbiter 端口。
- `delegate`/`transfer`/`cancel` 是 host-only；当前只有 review 创建 delegation。
- 没有真实的“另一个 Codex agent”启动；不能声称远程协作。

**严格改法**：

1. 保持 canonical 三动词的本地队列语义，但把 `transport`/`remoteDelivery` 写进每个结果与工具描述；不得暗示远程。
2. `send/report_result` 每次都重新检查 native workflow task/plan/goal/mission/session、cancellationEpoch、fence；状态分叉必须拒绝。
3. `inbox` 只返回本 principal、本 cooperation、本 scope 的消息；payload 上限 32 KiB。
4. `cooperation_review` 保持独立审批；审批后重新验证 head。
5. 远程/多拓扑作为后续 host 扩展，不阻塞 canonical 三动词的严格本地接线。

**验收**：

- 无 delegation/错误 owner/错误 epoch/fence 变化拒绝；
- 同 key 重放；不同 payload 同 key 拒绝；
- 跨 scope、跨 principal、跨 cooperation 不可见；
- 取消后 send/report 拒绝。

### 5.13 evidence

**契约**：`get`/`list`/`cite`（`evidence:read` / `evidence:cite`）。

**当前**：

- [evidence.mts](src/mcp/amp/evidence.mts) 用 `EvidenceLedger` + `bindEvidence`；`cite` 检查 `getConsumable`、environment、receipt 存在、file freshness；结果 `acceptanceGranted:false`。
- `evidence_review` 校验 receipt 完整性、宿主独立确认、environment/anchor、文件 freshness，批准后才创建 verification + evidence。
- `evidence_lifecycle_review` 处理 revoke/stale 传播。

**缺口**：

- `add`/`revoke` 是 host/verifier；不能注册模型工具。
- `cite` 不等于 acceptance；必须在描述中保持。
- 证据依赖图/消费者传播仍需按上游能力核对。

**严格改法**：

1. 保持三个 canonical 动词；`cite` 只返回引用摘要，不返回“已验证完成”。
2. `evidence_review` 只能由 host 审批；拒绝不创建 verification/evidence。
3. `evidence_lifecycle_review` 的 revoke/stale 必须传播到 goal/task（当前已部分实现），并保留 fail-closed。

**验收**：

- 过期/撤销/stale/环境变化/文件变化拒绝；
- receipt 篡改拒绝；
- 审批期间 receipt/environment 变化拒绝；
- 重放不重复创建 evidence。

### 5.14 execution

**契约**：`find_tools`/`inspect_tool`/`run`/`read_handle`（`execution:find` / `execution:run` / `execution:handle`）。

**当前**：

- [execution.mts](src/mcp/amp/execution.mts) 用 native ManifestStore/Executor/LcpService；pin toolId+digest+schema；`run` 只接纳 `isNativeReadContract` 的只读契约；BudgetLedger + journal + issued receipt + handle TTL。
- 写契约被明确 withheld，直到 Action/attempt fencing 接好。

**缺口**：

- `execution.run` 的动词契约是“Run typed child calls through policy, budget and journal”，当前只读是收窄。
- `run` 不创建 ActionAttempt；不覆盖写副作用。
- 取消/中断/未知结果只有部分路径。

**严格改法（二选一，必须显式）**：

- **E1（保守）**：保持只读，文档/工具描述/`surface` 明确“read-only execution”；不宣称完整 `execution.run`。这是当前状态，可接受为 ◐。
- **E2（严格完整）**：在 workspace/replace 的 Action/attempt 链完成后，把写契约加入 manifest；每个子调用创建/绑定 attempt，reserve/settle 同一预算，生成 receipt；取消 epoch 和 unknown_outcome 走 reconciliation。

**验收**：

- pin 错误/stale digest/schema 不匹配拒绝；
- 0 预算拒绝；重放；未知结果不自动重试；
- handle 过期/跨 connection 拒绝；
- E2 还要验收写子调用的 attempt/receipt。

### 5.15 budget

**契约**：`remaining`（read，`budget:read`）。

**当前**：

- [execution.mts](src/mcp/amp/execution.mts) 的 `budget.remaining` 读取 `native-read:<principal>` 的 durable BudgetLedger；quota 固定 1000 calls / 64 MiB / 1h / tokens 0 / concurrency 8。
- 直接读、`execution.run`、`workspace.write`、`replace` 共用该账户。

**缺口**：

- 不是 Codex token/费用计量；tokens 恒为 0。
- 没有 Session→Turn→Goal→Plan→Task→Action 的 BudgetTree 层级。
- 没有按 workflow scope 的预算隔离。

**严格改法**：

1. 保持 `remaining` 的插件 I/O 语义，输出明确 `quotaSource:'host-fixed'`、`usageScope:'plugin-native-io'`、`tokens:0`、`notCodexTokenUsage:true`。
2. 如果实现 live workflow，建立 BudgetTree 父子关系；`remaining` 返回当前 scope 的余额，不用全局值冒充。
3. `grant/configure` 永远 host-only。

**验收**：

- 0 余额拒绝读/执行/写/replace；
- 失败计费；重放不双计费；
- 父子预算耗尽传播；
- 输出不含“Codex token”误导字段。

### 5.16 独立 replace（0.7.9 新增）

**契约**：`attention_manifest_protocol_replace`，mutating，`workspace:write`；支持 string/regex/line/byte/outline、all/occurrence、expectedBufferVersion/expectedBaseHash；调用 `createReplaceToolHandler(workspace)` 并 flush。

**当前**：[replace.mts](src/mcp/amp/replace.mts) 已实现参数校验、审批、journal、budget、CAS/stale 检查；但没有 Action/attempt、没有 native receipt、没有 `onFileReceipt` 映射。

**严格改法**：

1. 在审批前冻结参数；审批后重验 workflow head、文件 inode/dev/mtime/raw hash、policy。
2. 创建 Action + `startAttempt`；用 attempt identity 作为 mount owner。
3. 调用 `createReplaceToolHandler`；从返回 snapshot 和 `onFileReceipt` 生成 `file_flush_receipt`；settle 实际字节。
4. 失败/异常走 unknown_outcome + reconciliation；不能自动重试。
5. 与 `workspace.write` 共享同一套 storage/审批/预算辅助。

**验收**：

- 五种 mode；all/occurrence；CAS 冲突；
- 审批拒绝/审批期文件变化；
- 产生 attempt + receipt；receipt 可被 evidence 消费；
- 重启后 journal/result 可读；同 key 重放。

### 5.17 host/hidden 模块

**host（8）**：`capability`、`manifest`、`provenance`、`receipt`、`verification`、`retrieval`、`model`、`runtime`。它们由宿主使用，不能注册为模型工具；当前 `execution`/`evidence`/`budget` 通过内部 API 使用其中一部分，这是正确的。

**hidden（4）**：`workflow`、`policy`、`profession`、`behaviour`。它们没有模型动词；任何“查看/编辑”都必须走宿主审批扩展，不能使用标准 `<module>.<verb>`。

**现有宿主扩展**（不属于 50 个 canonical 契约，必须保持命名与计数分离）：

- `attention_manifest_protocol_codex_sync`
- `attention_manifest_protocol_submissions`
- `attention_manifest_protocol_submission_review`
- `attention_manifest_protocol_workflow_scope`
- `attention_manifest_protocol_workflow_review`
- `attention_manifest_protocol_workflow_cancel_review`
- `attention_manifest_protocol_workflow_acceptance_review`
- `attention_manifest_protocol_workflow_reconciliation_review`
- `attention_manifest_protocol_evidence_review`
- `attention_manifest_protocol_evidence_lifecycle_review`
- `attention_manifest_protocol_receipt_evaluation`
- `attention_manifest_protocol_governance`
- `attention_manifest_protocol_governance_review`
- `attention_manifest_protocol_project_views`
- `attention_manifest_protocol_project_review`
- `attention_manifest_protocol_cooperation_review`
- `attention_manifest_protocol_migration`
- `attention_manifest_protocol_discover`
- `attention_manifest_protocol_surface`
- 以及构建产物中的孤儿 `attention_manifest_protocol_attention_schedule`（如果保留，需正式登记为扩展并测试）

规则：扩展工具必须明确标 `host extension`，不得在 `attention_manifest_protocol_surface` 中计入 canonical 覆盖，也不得用 `_review` 隐藏真实授权要求。

---

## 6. 关键设计：从“导入快照读取”到 live Codex 工作流

### 6.1 现状

`workflow_scope` 选择的是旧 ledger 导入的快照；`goal/plan/task/action/intent/mission` 的读取和 `propose_draft` 都要求这个选中 scope。对于普通 Codex 对话（没有导入快照），这些 canonical 动词实际上不可用。这是当前最大的“已注册但未接入”问题。

### 6.2 目标

为每个真实 Codex thread 建立一条 **host-owned live workflow**：

```
Codex thread
  └─ Session (hook 创建，已存在)
       └─ Turn (UserPromptSubmit 创建)
            └─ Intent (host capture)
                 └─ Mission (host accept 后创建)
                      └─ Goal (host review 导入/激活)
                           └─ Plan (模型 propose_draft + host approve)
                                └─ Task (draft 创建，host ready)
                                     └─ Action/Attempt (write/replace/execution)
                                          └─ Receipt → Verification → Evidence → Acceptance
```

模型只负责：读取、提议、报告 claim、请求 focus/clarification/evidence。所有创建/接受/完成/取消都是 host。

### 6.3 事件映射

| Codex 事件 | 宿主动作 | AMP 实体/状态 | 是否模型可见 |
|---|---|---|---|
| `SessionStart` | 创建/恢复 native Session | `created → active` / `suspended → resumed → active` | 是（session.get/list） |
| `UserPromptSubmit` | 创建 Turn + Intent（幂等） | Turn `received → interpreting`；Intent `captured → interpreted` | 是（intent.get/list；turn.current 仅在实现 TurnPort 后） |
| `Stop` | Turn 完成；记录 last assistant message 观察 | `responding → completed`；不自动 fulfill Intent | 是（session/turn 扩展观察） |
| `Interrupt` | Turn interrupt snapshot | `interrupted`；pending intent 记录 | 是 |
| `SessionEnd` | suspend | `active/idle → suspended` | 是 |
| `PreToolUse`/`PostToolUse` | 只观察；只有 AMP 自身执行链的调用才创建 attempt | 不创建 native Action | 是（codex_sync 观察） |
| `PreModelRequest`/`PostModelRequest` | 只观察，不注入 | 无 | 否（诊断） |
| `SubagentStart`/`SubagentStop` | 可选观察；不自动 delegation | 无 | 是（扩展观察） |
| `thread/goal/get` | 镜像 Codex Goal 观察 | 不创建 native Goal | 是（codex_sync） |
| host review | 导入/激活 Goal、accept Intent、approve Plan | native Goal/Mission/Plan 状态 | 是 |

### 6.4 classification 策略（host 唯一决定）

`Turn.classification` 不能由模型提供。宿主必须使用显式策略并记录 `classificationPolicyVersion`：

- 新 thread 的第一条 prompt → `new_intent`；
- 已有 active turn 时的后续 prompt → `steering`；
- 显式取消文本只由宿主策略识别 → `cancel`；
- 不能确定时 → 不创建 Turn，返回 unavailable，而不是猜 `new_intent`。

这条策略必须进入测试与审计；模型参数中出现 `classification` 必须被 `assertModelParameters` 拒绝。

### 6.5 与导入快照隔离

- `workflow_scope` 只用于**导入快照**；live workflow 由 `threadId` 自动解析，不需要 `workflow_scope`。
- 任何读取都必须返回 `origin: 'codex-live' | 'imported-workflow'`；两者不能混在同一结果。
- 导入快照的 session 保持 suspended；不得变成 live session。
- 旧 ledger 导入仍然是显式操作，不自动转换。

### 6.6 失败与回退

- hook 缺 `turn_id` → 不创建 Turn/Intent；只记 observation。
- 重复 hook 投递 → 用 `turn_id` + event hash 幂等；不重复 transition。
- Classification 不确定 → 不创建；`turn.current` 返回 unavailable。
- 数据库写失败 → observation 不阻断 Codex；返回中性 hook 输出，错误写 stderr。
- 任何“回退到导入快照”的行为必须显式选择 scope，不能静默。

---

## 7. 横切接线

### 7.1 工具注册与命名

- 标准面：15 个 agent 模块的 49 个动词 + `replace` = 50。
- 扩展面：`codex_sync`、`submissions`、`workflow_*`、`evidence_*`、`governance*`、`project_*`、`cooperation_review`、`migration`、`discover`、`surface`。
- `TOOLS` 的数量必须等于“标准面 + 扩展面”，并在 `scripts/mcp-smoke.mjs` 中维护精确名单；不能用“至少 N 个”掩盖缺漏。
- `attention_manifest_protocol_surface` 应分别返回 `canonical`、`extensions`、`unbound`，避免把扩展数混入 49。

### 7.2 Gateway、身份、idempotency

- 每个 canonical handler 必须经 `AgentGateway.call()`，除非它是独立 `replace`（也要自行实现等价检查）。
- `binding` 由 connection 创建，`sessionId` 不能来自模型；workflow scope 只能来自宿主选择/导入选择。
- mutating 动词必须在入口取 `idempotencyKey`，并在 Gateway 层与 handler 层双重检查；`report_status` 虽在 surface 标 non-mutating，仍要自行检查 key。
- 失败也写 journal；`onCall` 不得吞掉错误。

### 7.3 审批

- 使用 `requestHostApproval()` 的 correlated elicitation；审批消息必须展示精确参数、workspace、目标版本/哈希、workflow scope。
- 审批前冻结参数；审批后重新打开 Store 并校验 head/version/文件哈希/环境；不一致返回 `stale_after_approval`，不改变状态。
- 拒绝不写副作用；拒绝也要 journal。
- 审批不可用时 fail closed（不能默认批准）。

### 7.4 存储与迁移

- 每个项目一个 `.codex-coordination/amp-07/store.sqlite`；`openNativeStore` 已拒绝越界路径/链接。
- 所有写入在 Store 事务内；跨 SQLite 与文件系统不能原子提交，必须记录 started/unknown_outcome 并走 reconciliation。
- 旧 `amp-legacy` 数据只读迁移；不静默重写；不把旧 ledger 的断言提升为 native verification。
- 重启必须 `restoreAll()` 并检查 `skipped`；有 skipped 就 fail closed。

### 7.5 预算

- 统一账户 `native-read:<principal>`；直接读、execution.run、write、replace 都 reserve/settle。
- 预算不足必须在产生副作用前拒绝；不能先写后扣。
- `budget.remaining` 输出必须包含 `quotaSource`、`usageScope`、`tokens`、`notCodexTokenUsage`。
- 未来 BudgetTree 接入后，`remaining` 返回当前 scope 的父子余额，不用全局值冒充。

### 7.6 receipt / evidence / acceptance

- 每个真实副作用生成 issued receipt；receipt 记录 invocation/observation/workspaceAnchor。
- `evidence_review` 必须是独立 host 确认；`cite` 只引用 consumable evidence。
- Task/Goal 完成必须有独立 acceptance；当前 `workflow_acceptance_review` 是扩展，不得被普通执行成功绕过。
- 证据撤销/stale 要传播；不能只改 evidence 行。

### 7.7 Discovery 与工具列表

- 当前 `tools/list` 直接暴露全部工具；`discover` 只是检索，不是动态加载。
- 严格接线不要求改成 discovery-only，但必须保证：
  - `discover` 的 `amp` source 只包含有真实 handler 的 canonical 契约；
  - `host_modules` 包含扩展工具；
  - `network` 明确 unavailable；
  - 未绑定动词不出现在 `amp` source。
- 如果未来改用 discovery-only 引导，必须保持同一套 schema/authority/审批，不得让 discovery 结果成为授权。

### 7.8 错误映射

- 统一使用稳定 code：`invalid_parameters`、`version_conflict`、`stale`、`unauthorized`、`unknown_outcome`、`not_found`、`unavailable`。
- 模型可见错误不能泄露宿主路径、密钥、其他 session 数据。
- `unknown_outcome` 必须引导到 reconciliation，而不是自动重试。

---

## 8. 实施顺序（逐个模块）

### 8.1 规范顺序（按 AMP 模块编号）

| 顺序 | 模块 | 完成门禁 |
|---:|---|---|
| 1 | session | claim 语义固定；生命周期不变；测试通过 |
| 2 | turn | 保持 unbound；或实现 CodexTurnPort 后 4/4 |
| 3 | intent | live capture + get/list；submit 仍 durable |
| 4 | mission | live host 创建；get 不再回退导入 |
| 5 | goal | host 导入/激活；submit_evidence 仍 durable |
| 6 | plan | live draft；DAG/bounds；host approval |
| 7 | task | live read；report_progress 绑定 current attempt |
| 8 | action | 所有副作用产生 attempt；get/list 只读 attempt |
| 9 | attention | preview 语义固定；scheduler 作为可审计扩展 |
| 10 | project | 维持 6/6；扩展隔离 |
| 11 | workspace | write 支持 line/byte/outline；replace 进 attempt/receipt |
| 12 | cooperation | 本地队列语义固定；拒绝远程暗示 |
| 13 | evidence | cite/review/lifecycle 完整；无自动 acceptance |
| 14 | execution | 明确只读，或写契约完整接入 |
| 15 | budget | I/O 语义固定；BudgetTree 可选 |

### 8.2 依赖实施顺序（推荐）

**Phase 0 — 基线对齐（不改语义）**

- 确认 `package-lock` 0.7.9 与构建产物一致；
- 处理 `attention-schedule.mjs` 孤儿：删除或正式登记；
- 把 162/98 等旧计数更新为 163/50；
- 重建 plugin，确认 `tools/list` 精确 163。

**Phase 1 — 副作用基础（workspace + replace + evidence）**

- `workspace.write` 支持 `WriteTarget`；
- `replace` 接入 Action/attempt + receipt；
- write/replace 的 receipt 进入 evidence freshness；
- 验收：attempt/receipt/预算/审批/unknown_outcome。

**Phase 2 — live workflow bootstrap（session + turn/intent）**

- `UserPromptSubmit` 创建 Turn/Intent（host policy）；
- `session.get/list` 与 live scope 对接；
- `intent.get/list` 优先 live；
- 验收：幂等、classification、scope、重启。

**Phase 3 — mission/goal/plan/task/action**

- host 创建 Mission/导入 Goal；
- `propose_draft` 对 live goal；
- `task.report_progress` 对 live attempt；
- `action.get/list` 覆盖所有副作用；
- 验收：完整 DAG + approval + no acceptance。

**Phase 4 — attention**

- 固定 preview 语义；
- L3 scheduler 作为扩展（如果保留）；
- hook additionalContext 有界；
- 验收：不声称注入。

**Phase 5 — cooperation + budget**

- 本地队列 fence/cancellation 完整；
- 预算统一/树形（可选）；
- 验收：远程 false、预算拒绝。

**Phase 6 — turn（阻塞）**

- 只有 Codex 提供真实 Turn API 后才实施；
- 否则保持 unbound，并在 README/surface 中写明。

**Phase 7 — 回归与发布**

- `npm run check` 全绿；
- 更新 docs/inventory/README；
- 安装包 smoke；
- 记录真实 Codex desktop 验证边界。

---

## 9. 验收矩阵

### 9.1 每模块最低测试

| 模块 | 必测 |
|---|---|
| session | 重复 start/end、resume、report claim、跨项目 |
| turn | 负向：工具不存在；surface unbound；不得伪造 |
| intent | prompt→intent 幂等、scope、clarification review |
| mission | 无 live mission 时 not_found；导入隔离 |
| goal | Codex goal 不自动 achieve；evidence 不 achieve |
| plan | DAG/环/过期 bounds/审批/重放 |
| task | 无 attempt/多 attempt/stale/cancel epoch |
| action | attempt 身份/scope/跨 task |
| attention | expiry/stale/mount/byte cap/无注入 |
| project | rule/environment CAS/迁移 |
| workspace | 四种 write + 五种 replace + CAS + stale |
| cooperation | send/report/inbox/fence/cancel |
| evidence | integrity/environment/file/revoke |
| execution | pin/schema/policy/budget/replay/handle |
| budget | 0 余额/失败计费/重放 |

### 9.2 命令

```powershell
npm run typecheck
npm test
npm run validate
npm run smoke
npm run smoke:package
npm run conformance
npm run test:ui
```

本文件撰写环境没有 node/npm，以上命令未执行；实施时必须逐项记录结果，不能用旧日志代替。

### 9.3 文档更新

- `docs/AMP-INTEGRATION.md`：版本 0.7.9，工具数 163，replace 说明；
- `docs/AMP-REPAIR-STATUS.md`：当前状态与未完成项；
- `docs/AMP-075-GAP-REPORT.md` / `AMP-CODEX-AUDIT.md`：标注历史快照，不覆盖历史；
- `docs/AMP-MIGRATION-INVENTORY.json`：重新生成，canonical 50 / extensions 分离；
- `README.md` / `README.zh-CN.md`：工具数与能力描述更新；
- `scripts/mcp-smoke.mjs`：精确名单（已是 163，保持）；
- `wire.md`：实施后更新状态列。

---

## 10. 风险与未决

1. **Codex hook 版本漂移**：14 个事件名来自官方文档；不同 Codex 版本可能缺失事件或字段。实施前用 `/hooks` 和目标版本验证。
2. **Turn 永久阻塞**：没有 Turn API 时，4 个动词只能 unbound；这是严格性要求，不是缺陷。
3. **审批可用性**：Codex MCP elicitation 不可用时必须 fail closed；不能默认批准。
4. **Node 24**：插件依赖 Node 24+；安装器/launcher 需确认。
5. **构建产物漂移**：`attention-schedule.mjs` 与源码不一致；必须在 Phase 0 解决。
6. **旧 `amp-legacy` 高权力工具**：`coordination_keys`/`coordination_runtime`/`coordination_amp` 等不属于 canonical 50，不能因为 canonical 面严格就默认它们也严格；需要独立 authority matrix。
7. **conformance 基线仍是 0.6.3**：`npm run conformance` 不能证明 0.7.9 全模块符合；需要新增 0.7.9 surface/schema/行为校验。
8. **token 计量**：Codex 主循环 token 不可得；任何“预算”表述必须限定为插件 I/O。
9. **文件系统与 SQLite 非原子**：未知结果只能 reconciliation，不能自动重试。
10. **文档旧计数**：162/98 与实际 163/50 不一致，发布前必须统一。

---

## 11. Definition of Done（严格接线完成）

- [ ] 50 个工具契约全部有明确状态：**strict handler** 或 **explicit unbound**；没有占位 handler。
- [ ] 15 个 agent 模块逐个通过 L0/L1/L2 门禁；覆盖矩阵无“注册即完成”的表述。
- [ ] live Codex workflow 至少覆盖 session/turn(可选)/intent/mission/goal/plan/task/action 的读取与提案。
- [ ] `workspace.write` 支持 line/byte/outline；`replace` 进入 ActionAttempt/Receipt。
- [ ] `execution.run` 明确只读，或写契约完整接入。
- [ ] attention 不声称隐式注入；scheduler（若保留）为显式扩展。
- [ ] cooperation 明确本地队列；不暗示远程。
- [ ] budget 明确插件 I/O；不是 Codex token。
- [ ] host/hidden 模块不注册；扩展工具不计入 50。
- [ ] 所有测试通过；重启/审批/scope/重放/未知结果覆盖。
- [ ] 文档、inventory、README、smoke 名单一致。
- [ ] 安装包与源码构建一致；真实 Codex host 验证边界单独记录。

---

*本文件是接线规格，不是完成声明。任何“已接入”结论都必须附带对应模块的 L1/L2 证据；注册数量本身不构成证据。*
