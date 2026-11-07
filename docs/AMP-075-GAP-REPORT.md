# AMP 0.7.5 与 Codex Coordination 差异审计

## 修复状态（后续更新）

本文保留审计时快照，下面是逐项处理结果；实际进度与验证证据以 [修复台账](AMP-REPAIR-STATUS.md) 为准。

- 主依赖已升级并锁定 **AMP 0.7.8**；`discover` 已支持并回归字符串、字符串数组与 `regex: true`。
- E1 审批参数可变、E2 Store 泄漏、E3 快照错配、E4 字节预算、E5 Attention 全库上限、E6 legacy 签名发送审批：均已修复并有构建产物回归。
- current-attempt progress、`action.get/list` 返回 attempt、cooperation canonical `active` 准入与原生取消 fence：已修复并有回归。
- 已验证的可实现接线：统一原生 I/O 预算（read/Executor/write 共用账户）、写入回执进入独立证据审核、Task/Goal 独立验收、取消级联审批。
- 已验证接入：证据撤销与目标失效（12/12）、未知写入结果协调（28/28）、profession/capability 治理端口（16/16）、Project 视图/锚点（18/18）。
- 仍未完成：原生 Turn 四动词（缺真实宿主 API，保持未绑定）、远程 cooperation/五拓扑执行、纠正计划与重验、behavior/cognition/learn/feedback/fusion/sediment/L3 scheduler 等模块接线。
- 工具总数现为 **161**，标准动词仍为 **42 native + 3 durable-submission + 4 unbound**。

审计对象：

- 上游规范/实现：`R:\project\attention-manifest-protocol`，`package.json` 版本 0.7.5。
- 当前项目：`R:\project\codex-coordination`。
- 当前依赖：`attention-manifest-protocol@0.7.5`、`semantic-typescript@2.0.1`；兼容别名 `amp-legacy@0.6.3` 仍保留。

## 结论摘要

依赖升级已经完成，当前项目的 307 个 AMP JavaScript 构建文件与上游 0.7.5 `lib` 文件一致；不是依赖版本本身造成的差异。当前项目仍不是上游 AMP 0.7.5 的完整宿主实现：它把部分新 API 接到了 Codex/MCP，但保留大量 legacy 0.6.3 runtime，并且存在若干可复现的适配错误。

本次门禁结果：

- `npm run check`：通过。
- 单元测试：143/143 通过。
- `npm run validate`：153 个工具通过。
- 普通 stdio MCP smoke：440 项通过。
- 独立打包 smoke：440 项通过。
- Playwright Edge：3/3 通过。
- `npm run conformance`：9 项通过，但脚本明确针对 `amp-legacy@0.6.3` 的 ledger/Goal/Plan，不是 AMP 0.7.5 全量 conformance。

测试通过不代表以下缺口不存在。核对结果包含 **7 项有独立运行复现的错误**（E1–E5、current-attempt progress、action attempt 查询）和 **3 项源码确认的问题**（legacy deliver 审批边界不一致、canonical active 被误拒、native task 与 delegation 副本状态分叉）。源码确认项没有声称完成真实生产端点验证；本轮未修复这些新发现，避免把审计与修复状态混淆。模块清单按具体功能边界列出，未将工具注册数量视为完整语义覆盖。

---

## 一、已确认的实现错误

### E1 — workspace.write 存在审批后的 TOCTOU（P1，进程内可复现）

当前 [write.mts](../src/mcp/amp/write.mts) 在第 78–86 行验证并构造 request，但第 109 行审批时展示原始 `args`，审批返回后第 121、143、153、163、167 行仍继续读取同一个可变 `args`。上游 AMP 执行器在 `src/execution/executor.ts` 第 176–177、239–240、261 行会先复制 calls/context/invocation arguments，再执行。

复现文件 `.tmp/amp-audit-scope-repro.mjs` 输出：

```text
approvalContainsA=true
approvalContainsB=false
actual="unapproved-B\n"
approved=true
```

含义：审批看到 A，审批等待期间参数变成 B，实际文件写入 B，但结果仍报告审批成功。这个复现需要宿主进程内保留对参数对象的可变引用；不能夸大为“仅通过 JSON wire 的模型必然可利用”，但它违反了 host adapter 应在审批前锁定 immutable request 的约束。

**应修复：**入口立即对受信参数做稳定深拷贝/规范化快照，审批、CAS、ActionAttempt、receipt 和 durable request 全部只使用快照；拒绝调用者在 await 期间修改原对象。

### E2 — workspace.write 的早期异常路径不关闭 Store（P2）

[write.mts](../src/mcp/amp/write.mts) 第 83 行打开 NativeStore，第 88 行构造 policy/storage；但 `try/finally` 从第 91 行才开始，第 107 行才关闭。因此 scope/policy 校验或 `ScopedWriteStorage` 构造异常会在进入 finally 前泄漏连接。

复现 `.tmp/amp-audit-write-close-repro.mjs` 输出：

```text
error="Filesystem policy belongs to another workspace"
opened=1
closed=0
```

上游 [service/store.ts](R:/project/attention-manifest-protocol/src/service/store.ts) 第 227–255、682–709 行说明 Store owner/pool 由 close 生命周期管理。

**应修复：**`openNativeStore` 之后立即进入外层 `try/finally`，policy、storage 和所有 admission 失败都必须落入 close；不要把资源构造放在 finally 保护区之外。

### E3 — Discovery 将两个不同文件快照拼接成一个候选（P2）

[discovery.mts](../src/mcp/amp/discovery.mts) 第 37–38 行先从 `raw()` 取得 version/hash，第 41–44 行再调用 `read()` 并使用第二次读取的 content；第 59–60 行大纲又把该 version 继续传给 outline 候选。文件在两次读取之间变化时，content 和 version 不再属于同一快照。

复现 `.tmp/amp-audit-discovery-repro.mjs` 输出：

```text
summary="new snapshot"
claimedVersion=sha256:401f...old...
actualVersion=sha256:f943...new...
oldVersion=sha256:401f...old...
```

上游 [discoveryProviders.ts](R:/project/attention-manifest-protocol/src/agent/discoveryProviders.ts) 第 24–25、132–142、157–162 行要求 version 绑定内容位置和候选 target。

**应修复：**一次性取得有界 raw snapshot，在同一 snapshot 上 decode/content/version；或让 storage 提供原子 `readSnapshot`，禁止 raw/read 两次独立访问。

### E4 — Discovery 的 bytes budget 使用了不一致单位（P2）

[discovery.mts](../src/mcp/amp/discovery.mts) 第 22 行将上限设为 2 MiB，第 39 行按原始 raw bytes 预检，第 42–43 行却累计 decode 后 UTF-8 bytes。UTF-16 等编码可使 decoded bytes 大于 raw bytes；同时第 37 行先完整读取 `NativeReadStorage.raw`，因此“内容不 materialize”并不等于 I/O 被 2 MiB 限制。

复现 `.tmp/amp-audit-budget-repro.mjs` 输出：

```text
files=35
estimatedMaterializedContentBytes=2100000
limit=2097152
```

35 个 UTF-16LE 文件均通过 raw 预检，但解码后累计内容超过声明的预算。上游 [discoveryProviders.ts](R:/project/attention-manifest-protocol/src/agent/discoveryProviders.ts) 第 61–62、126–146 行把有界、授权 reader 作为 host provider 责任。

**应修复：**统一按“实际返回 content 的 UTF-8 字节”预留预算，写入结果前检查剩余预算；raw 读取也应使用 bounded metadata/stream，不应对每个文件先完整读到 16 MiB。

### E5 — Attention hook 的 1000 条上限先按全库统计，外部对象可阻断当前会话（P2）

[attention-lifecycle.mts](../src/mcp/codex/attention-lifecycle.mts) 第 26–28 行先 `store.list('attention', {limit:1001})` 并判断全库长度，之后才在第 28 行按 tenant/principal/session 过滤。其他 principal/session 的 1001 条对象即可让当前会话抛 `Attention scope exceeds...`；[hook.mts](../src/mcp/codex/hook.mts) 的调用处会吞掉异常，最终丢掉本次 context。

复现 `.tmp/audit-scoped-repro.mjs` 输出：

```text
BUG_FOREIGN_ATTENTION_GLOBAL_LIMIT Attention scope exceeds the hook compilation limit
```

上游 [attention/validation.ts](R:/project/attention-manifest-protocol/src/attention/validation.ts) 第 90–96 行定义 scope；当前项目另一个 [attention.mts](../src/mcp/amp/attention.mts) 第 24–33 行已经采用先过滤再计数，说明 hook 路径是不一致实现。

**应修复：**在数据库查询层按完整 scope 过滤后再 limit；不要先拉取全库前 1001 条。

### E6 — legacy cooperation deliver 未进入 legacy-policy 审批门（P1/P2，配置端点范围）

[legacy-policy.mts](../src/mcp/amp/legacy-policy.mts) 第 24 行的包装名单不包含 `coordination_connections`；而 [host.mts](../src/mcp/amp/host.mts) 第 343–345 行仍把 connections 工具暴露给 MCP。`connections.mts` 第 163–172 行对 configured cooperation endpoint 调用 `HostKeys.pair()` 后发送签名消息，但没有 `requestHostApproval`。

同一项目通过 `coordination_keys` 进行签名操作时会经过 legacy-policy 第 28–31 行的审批门，形成 authority boundary 不一致：connections deliver 可在配置端点范围内直接使用 host signing key 发送 payload，而 keys 路径需要独立批准。

这不是任意 URL 漏洞：端点来自 host configuration。但对于配置 endpoint 的任意 deliver/sign 操作，审批策略不一致是确定的接线缺口。`listen`/`delegate` 是否需要审批还取决于 host 是否将其声明为预授权；当前未形成统一矩阵。

---

## 二、已确认的语义错位

### P1 — task.report_progress 不是“current attempt”的 progress

上游 [agent/surface.ts](R:/project/attention-manifest-protocol/src/agent/surface.ts) 第 230–235 行将该动词描述为当前 attempt 的 progress；上游 workflow 的 ActionAttempt 在 `src/workflow/types.ts` 第 54–81 行、`src/workflow/store.ts` 第 232–250 行定义。

当前 [progress.mts](../src/mcp/amp/progress.mts) 第 19–35 行只验证 task id/version/session/非终态，记录只有 taskVersion/taskState，允许 `pending` task 且没有 Action/Attempt。复现输出：

```text
BUG_PROGRESS_WITHOUT_ATTEMPT {"state":"pending","attemptId":null,"verified":false}
```

当前明确标记 `verified:false`，所以不是伪造验证；但它不是上游 contract 所要求的 current-attempt 语义。

### P2 — action.get/list 返回 Action aggregate，不是 ActionAttempt

当前 [workflow.mts](../src/mcp/amp/workflow.mts) 第 26–48 行对 action 使用 `workflow.get/list('action')`。上游 surface [surface.ts](R:/project/attention-manifest-protocol/src/agent/surface.ts) 第 243–246 行要求“Read an action attempt / List attempts for a task”，上游 [action/service.ts](R:/project/attention-manifest-protocol/src/action/service.ts) 第 21–28 行提供 `getAttempt/attempts`。

复现输出：

```text
action.get(attempt-1) -> action attempt-1 does not exist
action.list -> kind="action", attemptIds=["attempt-1"]
```

这是标准 agent contract 的语义错误，不是单纯少一个字段。

### 部分实现 — cooperation 只实现本地 star/isolated 队列，不是 0.7.5 五拓扑执行内核

当前 [cooperation.mts](../src/mcp/amp/cooperation.mts) 第 129–140 行硬编码 `topology:'star'`、`sharing.isolation:'isolated'`、本地 durable queue、固定 codex owner，并明确 `remoteAgentStarted:false`、`executionAuthorized:false`。

上游 [cooperation/execution.ts](R:/project/attention-manifest-protocol/src/cooperation/execution.ts) 第 20–34、154–158、200–345、347–403 行实现 star/mesh/pipeline/hierarchical/consensus、原子 merge receipt 与 human escalation。当前还没有桥接 `close/cancel/transfer/reportConflict/arbitrate/merge` 等 Coordinator 端口。

这应标为 partial，不应声称完整 cooperation 已接入。

### P2 — cooperation active task 被错误拒绝，且委派副本不随 native task 状态更新

上游 [task/types.ts](R:/project/attention-manifest-protocol/src/task/types.ts) 第 4–7、12–14 行明确 `active` 是 canonical、`running` 是 legacy alias。当前 cooperation review 第 122–123 行只接受 `ready/running/executing`，漏掉 `active`；同项目 write admission 第 65–66 行却正确接受 active，导致同一 workflow 的 delegation/write 状态准入不一致。

此外，cooperation 的 send/report 使用 Coordinator snapshot/task 状态（第 45–50 行），没有在每次发送/提交时重新检查 native workflow task、parent plan/goal、cancellationEpoch。native task 被 host blocked/cancelled 后，旧 cooperation delegation 仍可能继续 send/report；这是两个状态机分叉。

---

## 三、尚未闭合的交互、执行和验收链

| 编号 | 未实现或部分实现的功能 | 上游能力 | 当前实现及实际缺口 |
|---|---|---|---|
| C1 | 原生 Turn 生命周期与四个标准动词 | [TurnService](R:/project/attention-manifest-protocol/src/turn/service.ts) 第 116–256、309–329 行有分类、澄清关联、interrupt snapshot、resume 校验、supersede/compact | [events.mts](../src/mcp/codex/events.mts) 第 38–60 行仅聚合 observed turn；[session.mts](../src/mcp/codex/session.mts) 第 8–24 行仅处理 SessionStart/End。`turn.current/respond/clarify/report` 仍未绑定；不是可以用本地事件假装完成的端口。 |
| C2 | 自动 current thread/turn 绑定 | [agent/surface.ts](R:/project/attention-manifest-protocol/src/agent/surface.ts) 第 54–62、159–183 行声明 host-bound session/current turn | [surface.mts](../src/mcp/amp/surface.mts) 第 29–39 行使用 MCP connection 随机 ID，并由显式 `session.get(threadId)` 选择聊天；[attention.mts](../src/mcp/amp/attention.mts) 第 18–37 行用指定聊天的最新 observed turn。项目级选择存在，但不是 Codex 当前回合自动绑定。 |
| C3 | 层级预算与统一执行门 | [budget/tree.ts](R:/project/attention-manifest-protocol/src/budget/tree.ts) 第 88–102 行为 Session→下级预算树；[execution/executor.ts](R:/project/attention-manifest-protocol/src/execution/executor.ts) 第 249–261 行在 dispatch 前 reserve | [execution.mts](../src/mcp/amp/execution.mts) 第 19、22–25、67–85 行只为 native-read catalog 记账；[surface.mts](../src/mcp/amp/surface.mts) 第 44–49 行仍直接暴露源工具；write 也没有 ledger reserve/settle。已复现余额为 0 时 `execution.run` 失败，但直接 `workspace.read` 成功。这是预算覆盖不完整，不能把它说成上游 BudgetLedger 算法错误。 |
| C4 | 写入 Receipt → 独立验证 → Evidence | 上游 [kernel/kernel.ts](R:/project/attention-manifest-protocol/src/kernel/kernel.ts) 组合文件操作回执、验证和证据 | [write.mts](../src/mcp/amp/write.mts) 第 163–168 行已生成真实 `file_flush_receipt`；但 [evidence.mts](../src/mcp/amp/evidence.mts) 第 71 行的 source whitelist 不包含 write，[file-freshness.mts](../src/mcp/amp/file-freshness.mts) 第 7 行只包含 read/outline/document_outline，因此写回执无法进入当前 evidence_review。 |
| C5 | 取消、drain、未知结果 reconciliation | [workflow/store.ts](R:/project/attention-manifest-protocol/src/workflow/store.ts) 第 137–209、254–284 行和 workflow/service 有 epoch fencing、取消树、drain、未知结果协调 | [workflow-review.mts](../src/mcp/amp/workflow-review.mts) 第 12–19、54 行仅开放部分非终态 transition；写入虽会记录 unknown outcome 并阻止自动重试，但没有可用的宿主 reconciliation 接线。不要把“拒绝重试”算成“已完成恢复”。 |
| C6 | Task/Goal 独立 Acceptance、目标失效/纠正/重验 | [workflow/store.ts](R:/project/attention-manifest-protocol/src/workflow/store.ts) 第 287–315、479–507、532–534 行要求版本化验证及 evidence | [evidence.mts](../src/mcp/amp/evidence.mts) 第 88–105 行创建验证/证据；[submission-review.mts](../src/mcp/amp/submission-review.mts) 第 159–161 行只记 goal evidence attachment，并返回 acceptanceGranted:false。尚未把它们接到 Task.complete、Goal.achieve/invalidate/correct/revalidate。 |
| C7 | Discovery-only 渐进披露与 provider 完整覆盖 | [agent/gateway.ts](R:/project/attention-manifest-protocol/src/agent/gateway.ts) 的 tools/catalog 分离；[discovery.ts](R:/project/attention-manifest-protocol/src/agent/discovery.ts) 支持来源/权重；[elasticsearch.ts](R:/project/attention-manifest-protocol/src/agent/elasticsearch.ts) 提供受限索引 provider | [server.mts](../src/mcp/server.mts) 第 176–189 行仍直接 `TOOLS.map` 暴露全部 153 项，`listChanged:false`；surface 使用 local providers，没有接新 Elasticsearch provider 或 network provider。schema 也未暴露上游 discovery `weights`。网络明确 unavailable 是正确报告，但不是已实现该来源。 |

## 四、上游 0.7.5 已实现、当前未接入或仅由 legacy 替代的功能

以下不是“旧名字没有 import 就绝对未实现”，而是已对照实际调用图确认当前没有接入上游 0.7.5 对应实现；当前 legacy runtime 的同名功能不算等价实现。

### 1. Profession certification / restriction profile

上游 [profession/certification.ts](R:/project/attention-manifest-protocol/src/profession/certification.ts) 第 88–137、144–179 行实现阈值 certification/recertification、生命周期和 `restrict`。当前 [registries.mts](../src/mcp/amp/registries.mts) 第 8、19–27、73–88 行只有 legacy registry；vendor 的旧 profession 是任务职业锁/恢复，不是 0.7.5 certification profile。没有 native profession registry、certify/recertify/restrict 的 project/Codex 接线。

### 2. Capability lifecycle / fallback / propagation

上游 [capability/lifecycle.ts](R:/project/attention-manifest-protocol/src/capability/lifecycle.ts) 第 195–299 行提供 Tool/Skill/Protocol/Cognition 生命周期状态机；[capability/propagation.ts](R:/project/attention-manifest-protocol/src/capability/propagation.ts) 第 100–187 行把 tool unavailable/degraded、cognition demoted、behavior cooling 传播到 Skill。当前 registries 仍是 legacy template/priority/alias；connections 的 mirror/withdraw/pin 不是 capability lifecycle，未接 fallback/失效级联。

### 3. Behavior abstraction/evaluation/governance/cooling

上游 [behavior/governance.ts](R:/project/attention-manifest-protocol/src/behavior/governance.ts) 第 38–63、77–140 行实现独立样本候选、比较评估、publish、cooling/demote/shadow 审计；behavior index 还导出 abstraction/evaluation。当前 [registries.mts](../src/mcp/amp/registries.mts) 第 73–78 行只编辑 legacy template/priority，`cognitive.mts` 消费的是旧 BehaviorRegistry，未接新发布/回撤/冷却闭环。

### 4. Cognition strategy selection/evaluation

上游 [cognition/strategy.ts](R:/project/attention-manifest-protocol/src/cognition/strategy.ts) 第 135–181 行按 task type 和 cost ceiling 选择最低成本策略，第 184–328 行提供 trace evaluation 和 adopt/retire/hold/insufficient recommendation。当前 [cognitive.mts](../src/mcp/amp/cognitive.mts) 第 57–66 行运行 legacy CognitiveRuntime，未串 0.7.5 strategy/trace policy。

### 5. Learn / feedback lifecycle

上游 `src/learn/ledger.ts` 第 250–475 行实现 observe、reflect、独立验证、host adopt、retain/reinforce/decay；上游 `src/feedback/ledger.ts` 第 211–361 行实现 evidence capture、normalize/triage、typed adapter apply、verify/archive。当前只接 legacy session feedback/learning（cognitive.mts 第 75–81 行及 vendor learning/directive），未接 0.7.5 versioned evidence-gated lifecycle。

### 6. Fusion / Sediment

上游 [fusion/layer.ts](R:/project/attention-manifest-protocol/src/fusion/layer.ts) 第 266–325 行实现跨维度独立性加权融合和 insufficient 结果；上游 [sediment/pipeline.ts](R:/project/attention-manifest-protocol/src/sediment/pipeline.ts) 第 125–259 行实现 capture→denoise→abstract→shadowValidate→propose 的原子审计管线。当前 runtime.mts 第 2–64 行仍是完整 legacy module graph，未导入/接线新 FusionLayer/SedimentPipeline；旧 Bayesian/learning 不等价。

### 7. Kernel unified flow / budget exhaustion / receipt chain

上游 [kernel/kernel.ts](R:/project/attention-manifest-protocol/src/kernel/kernel.ts) 第 1–10 行和整体实现组合八个 workflow service、BudgetTree、attention/context、receipt→verification→evidence，并处理完整 Session→Turn→Intent→Mission→Goal→Plan→Task→Action flow。当前 [cognitive.mts](../src/mcp/amp/cognitive.mts) 第 25、57–66、79、88、92 行运行 legacy Kernel/Cognitive/GovernedTask；surface 手工组合若干新读/写 adapter，但没有接上游 `createKernel` 的统一 flow、预算树耗尽传播和统一 closure。

### 8. Project 高级对象

上游 Project 还包含 [project/types.ts](R:/project/attention-manifest-protocol/src/project/types.ts) 第 41–114 行的 view purpose/anchors/constraints/freshness/anchor registry，以及 project `outline.ts`/`mindmap.ts`/`kinds`/`serie`。当前 project adapter [project.mts](../src/mcp/amp/project.mts) 第 12–83 行仅绑定 rules/metadata/environment 六个 surface verbs；未接 native ProjectOutline、mindmap/anchor registry、project kinds/series agent tools。

### 9. File/Workspace 高级编辑和文档能力

上游 README 的 [工作区编辑契约](R:/project/attention-manifest-protocol/README.zh-CN.md) 第 63–112 行和 [file/core.ts](R:/project/attention-manifest-protocol/src/file/core.ts) 第 295–389 行支持 line/byte/outline write、string/regex replace、planWrite/planReplace/locate/apply、outline versionHash、binary writeBytes/flush、lease/fence。当前 native `workspace.write` 仅是已有 UTF-8 文件 whole-buffer replacement；没有 canonical line/byte/outline/regex/binary write 端口。当前上游 0.7.5 新增 `.log` parser 已通过本项目新增回归，但其它 0.7.0 内置格式必须以实际 parser 调用逐一验证，不能把 native read wrapper 当完整 File API。

### 10. L3 attention scheduler / mind-map routing

上游 [attention/scheduler.ts](R:/project/attention-manifest-protocol/src/attention/scheduler.ts) 第 5–13、15–95 行提供九阶段 route/focus/blur/switch/suppress、合法 stage transition 和 decision log；上游 project mindmap 还定义中心节点、边、深度/兄弟/edge 限制。当前 attention adapter只读/context 和受审 focus/mount，hook lifecycle只恢复 retention；没有统一 scheduler、route/switch/suppress/mindmap decision log 或 shared BudgetTree settlement。

### 11. Receipt rollback/evaluation/cross-agent verification

上游 receipt index 导出 rollback/evaluation/crossAgent（`src/receipt/index.ts` 第 1–6 行），包含 receipt aggregate、rollback plan/apply、foreign receipt verification。当前 evidence 只校验 receipt integrity/business semantics 并创建 evidence，[evidence.mts](../src/mcp/amp/evidence.mts) 第 55–105 行没有 rollback、aggregate、cross-agent receipt verification。

### 12. Evidence dependency/revocation propagation

当前 evidence 已使用 `bindEvidence.rehydrate()`、`getConsumable()` 和 freshness 检查，因此不能说完全没有撤销检查；但没有创建 `dependsOn/consumedBy` 依赖图，也没有 revoke→stale→goal correction/revalidation 的消费链。上游 [evidence/index.ts](R:/project/attention-manifest-protocol/src/evidence/index.ts) 导出 arbitration/fusion/crossAgent，上游 EvidenceLedger 的 dependency/cause/consumer/revoke API 未接入当前 workflow acceptance。

---

Discovery-only/Elasticsearch 属于上游可用的宿主集成方式，不能仅因当前使用全目录和本地搜索就判为协议违规；这里记录的是能力覆盖差异。网络 provider 也需要宿主配置，不能擅自接通外网来满足覆盖数量。

## 五、当前设计上正确、不要误报为缺陷的部分

1. 上游 agent surface 将 workflow/policy/profession/behavior 设为 hidden，将 capability/manifest/receipt/verification/runtime 等设为 host，是正确的权限分层，不要求它们生成模型工具。
2. 上游 coordinator 间接使用 profession/policy 的 permission-scope intersection；当前 native cooperation 通过上游 Coordinator 接入这一部分，但没有接其完整 topology executor/merge/arbiter。
3. `attention.context` 和 hook compiler 已检查 scope、expiry、stale、retention 和 byte budget；缺的是统一 scheduler/budget ledger/真实 Codex current-turn binding，不是“完全忽略 retention budget”。
4. Codex 的项目级显式 thread 选择不自动等于越权：`session.get`/`attention.context` 会返回请求指定的 project-observed thread；当前问题是缺少自动 current thread/turn host binding，不应把显式项目可见查询直接判成安全漏洞。
5. legacy `resourceReads.record` 不能凭名字判定绕过；authority domain 仍会强制审批，`$ampMethod/$call` 探针也没有证明可绕过审批。

## 六、升级后验证和审计限制

- `package.json`/lock 已锁定 AMP 0.7.5、semantic-typescript 2.0.1；安装的 307 个 AMP JS 文件与上游 0.7.5 lib 一致。
- `npm run check` 通过；143 tests、153-tool validation、440 ordinary/package MCP smoke、9 legacy 0.6.3 conformance、3 Edge UI scenes 均通过。
- 上游直载复现没有依赖旧 bundle：`.tmp/amp-audit-scope-loader.mjs` 将当前 adapter `.mts` 映射到上游 `src/*.ts`，复现了 E1–E5；具体日志为 `.tmp/amp075-repro-*.log`。
- `npm run conformance` 仍明确加载 `amp-legacy@0.6.3`，只验证旧 ledger/Goal/Plan wire artifacts；不能证明 0.7.5 新模块、scheduler、kernel、fusion、sediment、profession/capability 等全量 conformance。
- 未验证真实 Codex desktop hook trust、当前运行实例是否加载本次构建、Codex app-server 完整 event stream、远程合作 endpoint 生产配置和真实审批 provider；因此不能把 MCP fixture/stdio 通过当作生产宿主闭环证明。
