# 0.5.0 重启后实际工具测试（2026-11-03）

通过当前 Codex 聊天实际暴露的 `mcp__coordination__*` 连接，执行 **204 次 MCP 调用，覆盖全部 98 个工具名**。不是子进程 smoke test，也没有用注入式模型或搜索替身。**覆盖入口不等于穷举每个 action、参数组合和外部集成。**

写入操作集中在临时测试仓库：`C:\Users\ADMINI~1\AppData\Local\Temp\coordination-live-00d2b21afe4444bfa43dd3fec74fb04f`。测试结束已绑定回 `R:/project/codex-coordination`，测试仓库 workspace/global 两种作用域均无待结算上下文。插件源码未在本轮修改。测试证据文件保留。

## 已验证效果

- 真实文件创建、workspace/global 全文写入及行差异写入；每次通过独立文件读取验证，表达式依次变为 +43、+44、+45、+46。
- 文件语法树、结构、导入、导出与依赖；知识标记后 Elasticsearch 实际检索命中。
- 使命、目标、计划与任务的生命周期流转；旧 JSON 台账的目标/计划创建与模拟角色交接验收。
- 注册中心、环境设置、业务选择状态的写入与读取。
- 上下文预算分配、物化、源码+依赖读取、释放、结算和归档展开；切换仓库后归档可恢复。
- Ed25519 签名验证通过，篡改内容验证失败，密钥撤销后无法签名；重绑定后撤销状态保留。
- 记录结果另做 **18 条效果断言，18 条通过**。原始调用中保留了首次参数错误、期望拒绝和成功重试，未过滤成“全绿”。

## 发现的问题与未验证范围

1. `amp_tool_filesystem_directory({})` 与 `amp_tool_globalfs_directory({})` 都返回 `invalid_path`，显式传 `{path:"."}` 则正常。可选路径的默认处理需改善。
2. 当前宿主审批测试返回 `rejected`；工作区命令执行返回 `PERMISSION`，未执行。不能据此宣称当前 Codex 的审批通过/命令执行链已打通。
3. `coordination_collaboration agents` 返回 `available:false`，原生子代理名册/分派尚不可用；旧 handoff 测试仅是显式声明的 fixture 角色状态流转。
4. `coordination_runtime create_agent` 成功；真实 `turn` 因没有模型配置返回 `INVALID_STATE`。没有模型输出或 token 用量可供验证。
5. `coordination_connections list` 没有配置的 endpoint；远程 MCP/A2A、监听和委派未进行真实端到端测试。
6. `coordination_chain` 的函数 handle 查询返回零链接。原生文件关系工具可识别 b.ts→a.ts 导入；这不证明函数语义链已经完整建立。
7. dashboard 与 notification 返回了数据/通知结果；本轮未做 Codex 宿主内视觉检查，不声称原生 toast、ripple 或面板交互已验证。
8. 当前项目实际检索命中 `src/mcp/coordination/host.mts` 中的 `HostCoordination`。绑定仍有 4 项 `scan_limit`：AMP-INVENTORY.json、app/index.html 和两个生成的 runtime.mjs 超出扫描预算；这些文件需分页文件工具，不能假定语义索引覆盖所有文件。

首次省略 runtime create_agent input、审批 timeout=1000、mission complete id 的请求属于本轮调用参数错误，补齐后重试；不计为插件业务实现故障。workspace 写入后 global 尚持有旧快照的写入被 revision_mismatch 拒绝，refresh 后重做全局写入成功，说明修订保护生效。

## 逐工具记录

表中的“已验证所测场景”只对第四列列出的操作成立；空列表/正常返回不推导为完整功能可用。

| 工具 | 调用次数 | 结论 | 实际效果 |
| --- | ---: | --- | --- |
| `amp_tool_filesystem_ast` | 1 | 已验证所测场景 | 返回 TypeScript 语法树；设置上限后 truncated=true |
| `amp_tool_filesystem_dependency` | 1 | 已验证所测场景 | 文件依赖识别 b.ts → a.ts；项目级依赖为空 |
| `amp_tool_filesystem_directory` | 2 | 边界/待完善 | path="." 列出根目录；省略 path 返回 invalid_path |
| `amp_tool_filesystem_export` | 1 | 已验证所测场景 | 识别 a.ts 导出的 probeAnswer |
| `amp_tool_filesystem_file` | 1 | 已验证所测场景 | 返回文件指纹、字节数、行数与元数据 |
| `amp_tool_filesystem_import` | 1 | 已验证所测场景 | 识别 b.ts 的 ./a 导入和重导出 |
| `amp_tool_filesystem_outline` | 1 | 已验证所测场景 | 返回项目/文件/函数结构 |
| `amp_tool_filesystem_read` | 9 | 已验证所测场景 | 按页返回源码；写入后复读确认内容变化 |
| `amp_tool_filesystem_session` | 1 | 已验证所测场景 | 返回授权根、可写权限和 TTL，不返回 token |
| `amp_tool_filesystem_write` | 2 | 已验证所测场景 | 文件真实落盘；workspace/global 均复读确认，另验证 dryRun |
| `amp_tool_global_adjust` | 1 | 已验证所测场景 | 返回指定作用域的知识注册列表 |
| `amp_tool_global_capabilities` | 1 | 已验证所测场景 | 返回 revision、项目 ID、限额与工具列表 |
| `amp_tool_global_dependency` | 1 | 已验证所测场景 | 文件依赖识别 b.ts → a.ts；项目级依赖为空 |
| `amp_tool_global_diff_read` | 1 | 已验证所测场景 | 返回可比较的项目/文件树及修订信息 |
| `amp_tool_global_diff_write` | 3 | 已验证所测场景 | 真实行替换落盘并复读确认，另验证 dryRun |
| `amp_tool_global_discover` | 1 | 已验证所测场景 | Elasticsearch 检索 probeAnswer 命中函数符号 |
| `amp_tool_global_interaction` | 1 | 已验证所测场景 | 读取作用域混合配置，初始为 null |
| `amp_tool_global_materialize` | 3 | 已验证所测场景 | 生成预算受限的 Context，文件进入 readableIds |
| `amp_tool_global_outline` | 1 | 已验证所测场景 | 返回项目/文件/函数结构 |
| `amp_tool_global_project` | 1 | 已验证所测场景 | 识别 npm/TypeScript 项目和可用命令 |
| `amp_tool_global_query` | 1 | 已验证所测场景 | 查询接口正常；无条件查询返回空候选 |
| `amp_tool_global_reactive_read` | 1 | 已验证所测场景 | 返回可缓存的反应式树 |
| `amp_tool_global_reactive_write` | 1 | 已验证所测场景 | 写入 summary，cacheVersion 增加并报告失效节点 |
| `amp_tool_global_read` | 1 | 已验证所测场景 | 按页返回源码；写入后复读确认内容变化 |
| `amp_tool_global_relations` | 1 | 已验证所测场景 | 识别 b.ts → a.ts 的 imports 关系 |
| `amp_tool_global_release` | 3 | 已验证所测场景 | 返回 released=true，之后 settle 归档 |
| `amp_tool_global_scenario` | 1 | 已验证所测场景 | 读取作用域场景配置，初始为 null |
| `amp_tool_global_tree` | 1 | 已验证所测场景 | 返回项目节点及分页信息 |
| `amp_tool_global_write` | 3 | 已验证所测场景 | 文件真实落盘；workspace/global 均复读确认，另验证 dryRun |
| `amp_tool_globalfs_ast` | 1 | 已验证所测场景 | 返回 TypeScript 语法树；设置上限后 truncated=true |
| `amp_tool_globalfs_dependency` | 1 | 已验证所测场景 | 文件依赖识别 b.ts → a.ts；项目级依赖为空 |
| `amp_tool_globalfs_directory` | 2 | 边界/待完善 | path="." 列出根目录；省略 path 返回 invalid_path |
| `amp_tool_globalfs_export` | 1 | 已验证所测场景 | 识别 a.ts 导出的 probeAnswer |
| `amp_tool_globalfs_file` | 1 | 已验证所测场景 | 返回文件指纹、字节数、行数与元数据 |
| `amp_tool_globalfs_import` | 1 | 已验证所测场景 | 识别 b.ts 的 ./a 导入和重导出 |
| `amp_tool_globalfs_outline` | 1 | 已验证所测场景 | 返回项目/文件/函数结构 |
| `amp_tool_globalfs_read` | 1 | 已验证所测场景 | 按页返回源码；写入后复读确认内容变化 |
| `amp_tool_globalfs_session` | 1 | 已验证所测场景 | 返回授权根、可写权限和 TTL，不返回 token |
| `amp_tool_globalfs_write` | 1 | 已验证所测场景 | 文件真实落盘；workspace/global 均复读确认，另验证 dryRun |
| `amp_tool_session_interaction` | 1 | 已验证所测场景 | 读取作用域混合配置，初始为 null |
| `amp_tool_session_scenario` | 1 | 已验证所测场景 | 读取作用域场景配置，初始为 null |
| `amp_tool_workspace_adjust` | 1 | 已验证所测场景 | 返回指定作用域的知识注册列表 |
| `amp_tool_workspace_capabilities` | 1 | 已验证所测场景 | 返回 revision、项目 ID、限额与工具列表 |
| `amp_tool_workspace_dependency` | 1 | 已验证所测场景 | 文件依赖识别 b.ts → a.ts；项目级依赖为空 |
| `amp_tool_workspace_diff_read` | 1 | 已验证所测场景 | 返回可比较的项目/文件树及修订信息 |
| `amp_tool_workspace_diff_write` | 2 | 已验证所测场景 | 真实行替换落盘并复读确认，另验证 dryRun |
| `amp_tool_workspace_discover` | 1 | 已验证所测场景 | Elasticsearch 检索 probeAnswer 命中函数符号 |
| `amp_tool_workspace_interaction` | 1 | 已验证所测场景 | 读取作用域混合配置，初始为 null |
| `amp_tool_workspace_materialize` | 2 | 已验证所测场景 | 生成预算受限的 Context，文件进入 readableIds |
| `amp_tool_workspace_outline` | 1 | 已验证所测场景 | 返回项目/文件/函数结构 |
| `amp_tool_workspace_project` | 1 | 已验证所测场景 | 识别 npm/TypeScript 项目和可用命令 |
| `amp_tool_workspace_query` | 1 | 已验证所测场景 | 查询接口正常；无条件查询返回空候选 |
| `amp_tool_workspace_reactive_read` | 1 | 已验证所测场景 | 返回可缓存的反应式树 |
| `amp_tool_workspace_reactive_write` | 1 | 已验证所测场景 | 写入 summary，cacheVersion 增加并报告失效节点 |
| `amp_tool_workspace_read` | 1 | 已验证所测场景 | 按页返回源码；写入后复读确认内容变化 |
| `amp_tool_workspace_relations` | 1 | 已验证所测场景 | 识别 b.ts → a.ts 的 imports 关系 |
| `amp_tool_workspace_release` | 2 | 已验证所测场景 | 返回 released=true，之后 settle 归档 |
| `amp_tool_workspace_scenario` | 1 | 已验证所测场景 | 读取作用域场景配置，初始为 null |
| `amp_tool_workspace_tree` | 1 | 已验证所测场景 | 返回项目节点及分页信息 |
| `amp_tool_workspace_write` | 2 | 已验证所测场景 | 文件真实落盘；workspace/global 均复读确认，另验证 dryRun |
| `coordination_amp` | 2 | 已验证所测场景 | describe 签名后实际调用 compareNumbers(3,7)，返回 -1；未穷举全部领域算法 |
| `coordination_approve` | 2 | 有条件/未全验 | 合法参数返回 rejected/timedOut=false；通过分支未验证，timeout=1000 的首次请求被 schema 拒绝 |
| `coordination_artifacts` | 4 | 已验证所测场景 | 真实记录/读取 receipt，原生对象链 verify 通过 |
| `coordination_chain` | 1 | 边界/待完善 | 函数 handle 的 dependents 查询返回 0 链接和 no_links 诊断；未证明语义链完整性 |
| `coordination_check` | 2 | 已验证所测场景 | 测试台账 7 条链记录校验通过，0 违规 |
| `coordination_collaboration` | 2 | 有条件/未全验 | list 正常；agents 返回 available=false，无法验证原生子代理分派 |
| `coordination_connections` | 1 | 有条件/未全验 | list 返回 endpoints=[]、listeners=[]；远程连接/委派未验证 |
| `coordination_context` | 22 | 已验证所测场景 | 准确工具检索、限量源码+依赖、分配/物化/释放/结算、归档展开、重绑定恢复；两作用域 pending=[] |
| `coordination_control` | 3 | 已验证所测场景 | 工作区 knowledge 条目 register→get，版本为 1 |
| `coordination_dashboard` | 1 | 边界/待完善 | 返回 dashboard 数据和协议状态；本次未进行宿主内视觉/UI交互验证 |
| `coordination_describe` | 1 | 已验证所测场景 | 按 parse 的真实 handle 返回函数引用、路径和范围 |
| `coordination_environment` | 4 | 已验证所测场景 | 环境 set→get 成功；重绑定后值保留（记录中省略变量值） |
| `coordination_exportation` | 1 | 已验证所测场景 | 返回 b.ts 的 ./a 重导出行；直接函数导出在 filesystem_export 中另行验证 |
| `coordination_file` | 1 | 已验证所测场景 | 返回索引中 4 个测试文件的相对路径 |
| `coordination_goal` | 4 | 已验证所测场景 | 使命目标 active→achieved；重绑定后恢复；也验证含 workspace 的旧台账创建 |
| `coordination_handoff` | 6 | 已验证所测场景 | 测试角色 owner/worker 的 assign→accept→start→submit→verify；证据来自真实文件读取，不代表真实子代理执行 |
| `coordination_hooks` | 3 | 已验证所测场景 | 执行 fingerprintFile 和 useCode，run history 留痕 |
| `coordination_importation` | 1 | 已验证所测场景 | 返回 b.ts 的 ./a 导入行 |
| `coordination_index` | 1 | 已验证所测场景 | 真实索引 4 个文件、12 个节点，未截断 |
| `coordination_keys` | 8 | 已验证所测场景 | 生成 Ed25519 key→签名→验签成功→篡改失败→撤销→禁止再签；重绑定后撤销状态保留 |
| `coordination_knowledge` | 2 | 已验证所测场景 | mark a.ts 后真实搜索命中 LiveProbeKnowledge；重绑定后元数据保留 |
| `coordination_mission` | 5 | 已验证所测场景 | create→activate→complete，done 状态重绑定后保留 |
| `coordination_notification` | 1 | 已验证所测场景 | 返回 queued=1、notifications 数组；未证实 Codex 原生 toast 弹窗 |
| `coordination_outline` | 1 | 已验证所测场景 | 返回文章标题、模块、函数 handle 与行号 |
| `coordination_parse` | 1 | 已验证所测场景 | 返回真实函数 cards、tokens 与缺少显式注释的诊断 |
| `coordination_plan` | 9 | 已验证所测场景 | draft→committed→executing，task pending→running→done，plan→done；重绑定恢复；旧台账创建也成功 |
| `coordination_profession` | 1 | 已验证所测场景 | 返回 execution 及插件业务 session 的选择状态 |
| `coordination_profession_lock` | 1 | 已验证所测场景 | 返回 locked=false；本轮未模拟宿主 turn 冻结 |
| `coordination_project` | 2 | 有条件/未全验 | 检测 npm 项目；test dryRun 返回 npm test；实际执行未获宿主审批 |
| `coordination_protocol` | 1 | 已验证所测场景 | 返回 npm AMP 0.6.3 与支持的协议类型 |
| `coordination_read` | 2 | 已验证所测场景 | 真实读取源码；拒绝读取私有台账路径 |
| `coordination_registry` | 3 | 已验证所测场景 | 原生工作区 knowledge register→get；切换后版本与数据保留 |
| `coordination_runtime` | 4 | 有条件/未全验 | 真实 create_agent 成功并持久化 profile；session 初始 null；turn 因无模型配置返回 INVALID_STATE |
| `coordination_search` | 1 | 已验证所测场景 | 对已标记知识运行真实 Elasticsearch 搜索并命中，非模拟返回 |
| `coordination_selection` | 3 | 已验证所测场景 | scene 写为 engineering 并复读一致；仅插件业务状态 |
| `coordination_status` | 3 | 已验证所测场景 | 返回目标/计划/交接计数，7 条台账链 verified=true |
| `coordination_workspace` | 8 | 有条件/未全验 | select/refresh/status、重绑定恢复正常；run 返回 PERMISSION，命令未执行 |
| `coordination_workspace_adjust` | 3 | 已验证所测场景 | 工作区 knowledge 条目 register→get，版本为 1 |

## 证据

本机完整调用参数、返回与断言记录：`.tmp/live-tools-2026-11-03.json`（环境变量值已省略；该目录被 git 忽略，文件保留在本机，不随公开源码或 npm 包发布）。

上下文 quick-read 本次一例：原始归档结果 JSON 5024 个 UTF-16 字符，紧凑投影 966 个字符；这是插件返回数据的差异，不是 Codex 实际上下文长度、模型 token 用量或缓存命中率。
