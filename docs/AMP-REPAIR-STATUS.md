# AMP 0.7.8 修复台账

目标：逐项处理 [差异审计](AMP-075-GAP-REPORT.md)，复用上游实现，不将工具注册当语义完成。用户要求原样移植 deepseek-coordination 使用的 entity→cache→service→repository→sql；五层及必要支持闭包保持原始字节，业务适配留在外层。

## 当前已验证基线

- 主依赖已升级并锁定 **attention-manifest-protocol@0.7.8**（`semantic-typescript@2.0.1`）；`amp-legacy@0.6.3` 仅作兼容运行时。
- `discover` 在 0.7.8 支持字符串、字符串数组与 `regex: true` 三种查询；本项目的 MCP schema 同步暴露 `query` 的 string/array 两种形态、`regex` 布尔与 `weights`，并有字符串、数组、正则匹配及非法正则拒绝的回归。
- 工具目录现为 **162 项**，标准动词覆盖 **42 native + 3 durable-submission + 4 unbound**（仍为 `turn.current/respond/clarify/report`）。
- 完整 `npm run check`（typecheck + server/app 构建 + validate + test + smoke + package smoke + conformance + UI）通过：**266/266 单测**、**162 工具验证**、普通与独立打包各 **458** 项 MCP 检查、conformance 9 项、UI **2** 个场景。日志：[amp-repair-final-check.log](../.tmp/amp-repair-final-check.log)。
- 四个宿主扩展模块的专属回归：证据生命周期 **12/12**、Project 视图/锚点 **18/18**、未知写入协调 **28/28**、原生治理 **16/16**。
- 0.7.6 起 `safeStringify` 会把非整数有限小数四舍五入到两位；本项目沿用上游序列化语义（与 AMP 自身持久化一致），已在此记录为上游行为，不再自行改写 native 摘要函数。

原样存储来源与边界见 [AMP-SQLITE-SOURCE.md](AMP-SQLITE-SOURCE.md)：参考项目 AMP0.7.1 的五层及支持闭包 67 文件，224654 bytes，SHA-256 与原文逐字节一致；上层 AMP 保持 0.7.8。构建采用统一模块身份，原样实现不作修改，路径/身份/快照适配在外层。旧数据库无删除、无重建、无 payload 重写。

## 第一阶段：确定性问题与SQLite五层

| 项目 | 当前状态 | 验证 |
|---|---|---|
| E1 write参数审批后可变 | 已修改；入口稳定复制参数，后续全程用同一请求 | 原复现由实际写B变为只写获准A；构建产物回归通过 |
| E2 write early scope/policy异常不close | 已修改；open后立即finally覆盖前置构造 | 原复现opened=1/closed=0变为1/1；构建产物回归通过 |
| E3 discovery snapshot版本错配 | 单有界raw snapshot+AMP decode实现 | 已在完整整合回归通过 |
| E4 discovery decoded byte超预算 | raw/UTF8分别限制，large name-only、遍历有界 | 已在完整整合回归通过 |
| E5 hook attention全库limit | 先按真实嵌套scope过滤，再scope cap | 3个源码测试通过，包括1001 foreign rows |
| E6 legacy签名发送审批 | deliver/delegate/listen/stop/disconnect进入exact approval | 源码与产物回归通过 |
| current attempt progress / action.get,list | 真实attempt绑定、唯一性/epoch与scope检查 | 4项独立attempt及draft重启回归通过 |
| cooperation active准入、native取消fence同步 | 已修，访问时按原生祖先状态/epoch同步cancel | 10项cooperation回归通过；仍本地队列 |
| 原样SQLite五层 | 67原文文件与哈希已复制并真实接入统一构建 | 6项存储架构回归、原文校验、独立包检查通过 |
| write receipt→evidence | freshness source加入write；独立审阅参数复制 | 真实写入→验证→引用→文件变化拒绝测试通过 |
| host审批取消级联 | 完整原生requestCancel/cancelCascade，审批journal与事务fence | 8项回归通过，不伪造settlement |
| direct/read Executor/write统一I/O预算 | 共用原有native-read主账户；审批不豁免额度 | 零预算读/执行/写拒绝通过，执行不双计费 |
| task/goal业务Acceptance | 独立审批与真实evidence/integrity/verification检查，原生guard，pre/post proof | 8项回归通过；撤销传播继续实现 |
| 证据撤销/失效传播 | 新增 `evidence_lifecycle_review`：preview 出 CAS 摘要，审批后原生 revoke/stale 传播，achieved goal 原生 invalidate，completed task 记 disputed；重复失效 fail closed，stale→revoke 仍可升级；文件 freshness 纳入前后检查 | **12/12 通过** |
| 未知写入结果协调 | 新增 `workflow_reconciliation_review`：只处理 started 无 result 的写入；成功要求当前内容/raw hash/attempt identity/取消链全部一致，成功后原生 reconcile + 真 file_flush_receipt + journal 终态；失败/取消必须有显式 manual/query 引用，不声称"无副作用"；预算按原 reservation 全额 settle | **28/28 通过** |
| 原生治理状态机 | 新增 `governance`/`governance_review`：profession 强制 uncertified 起点、capability 仅原生合法转移、tool→skill 传播真实持久化；cognition 权重降低标 `applied:false`；默认无受信评估器时认证 fail closed；journal 重放/伪造/审批期篡改均拒绝 | **16/16 通过** |
| 回执聚合评价 | 新增只读 `receipt_evaluation`：按连接/租户/principal/自有会话过滤，逐条重验 execution digest 与 integrity，篡改回执被报出并排除；不声称业务验收或 Codex token 用量 | **3/3 通过** |
| Project 视图/锚点 | 新增 `project_views`/`project_review`：只读不建库；metadata/view 经 bindProject 持久化并与 canonical adapter 共享版本；锚点只从已观测原生回执（read/outline/document_outline/write）派生；旧 journal 仅迁移一次 | **18/18 通过** |

## 后续阶段（仍未完成）

- 深化层级预算、调度与统一执行入口覆盖（当前原生 read/Executor/write 已共用 I/O 额度，但不是 Codex 内建工具全局预算）。
- 纠正计划/重验闭环：当前证据失效能原生 invalidate goal 并记录 task dispute，尚未自动生成并审批 corrective plan。
- 原生 Turn 真实宿主桥；缺可验证 API 时维持未绑定，不能用 observed events 代替。
- 0.7.8 其余模块接线：behavior 发布/冷却、cognition 策略选择、learn/feedback 生命周期、fusion、sediment、L3 attention scheduler、project mindmap/kinds、file 结构化编辑。
- 逐项补充适用 conformance，完整回归与独立安装包验证。

## 验证边界

- 上述 162 工具中，`turn.*` 仍保持未绑定；host/hidden 模块不会注册为模型工具。
- 治理认证默认返回 `unsupported_without_host_evaluator`，需要宿主注入受信评估器；测试只验证注入后的行为，不把默认状态说成已认证。
- cooperation 仍是本地 durable 队列，没有远程投递、五拓扑执行或 merge receipt。
- `npm run conformance` 依旧以 `amp-legacy@0.6.3` 为基线，不能证明 0.7.8 全模块符合性。

此台账不代表整个长期目标已经完成。原143项/440项全绿属于修复前升级基线；新的整合结果另记，不重复用旧结果证明新代码。
