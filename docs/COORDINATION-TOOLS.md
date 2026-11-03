# Coordination 工具接入与上下文优化（0.5.0）

按用户指定，从 `R:/project/deepseek-coordination` 0.23.2 的当前工作树复制 agent 工具实现。原项目注册的 **24 个工具全部保留正式名称**；另提供原生 AMP `coordination_project`。现有 76 个入口与新增能力合并、去重后共 **98 个工具**，AMP 的 60 个标准定义保持原样。

## 完整调用清单

先通过 `coordination_workspace` 传入绝对 `workspace` 绑定仓库。下面的工具默认使用该仓库内稳定的插件业务会话，不假装它是 Codex 聊天 ID。

| 工具 | 实际实现与主要操作 |
| --- | --- |
| `coordination_goal` | 原 `AmpPlanning`；list/create/transition，创建传完整 `goal` 对象 |
| `coordination_mission` | 原使命队列；list/create/activate/complete/abandon |
| `coordination_plan` | 原 `AmpPlanning`；list/create/transition/task，创建传完整 `plan` 对象 |
| `coordination_knowledge` | 原 `KnowledgeService`；list/mark/update/unmark，标记标题等元数据进入 AMP 搜索，正文仍通过授权读取 |
| `coordination_parse` | 原 `ParseService`；路径或文本解析，默认 compact，可请求 full |
| `coordination_describe` | 原 NodeRegistry；按解析返回的 handle 展开节点 |
| `coordination_chain` | 原 ChainEngine；依赖、依赖者、路径、循环等有界关系投影 |
| `coordination_read` | 原内容读取；按 path 或 handle，按 lines/bytes 分页 |
| `coordination_file` | 原工作区文件树与扁平路径投影 |
| `coordination_outline` | 原文件或工作区大纲 |
| `coordination_importation` | 原导入关系投影 |
| `coordination_exportation` | 原导出/再导出关系投影，保留原项目语义 |
| `coordination_index` | 原索引更新器；index/rebuild，可指定 paths；文件图工具首次使用时自动建立其索引 |
| `coordination_control` | 原作用域控制；注册中心、默认项、设置、CAS、dryRun 与链接 |
| `coordination_workspace_adjust` | 原工作区注册中心便捷入口 |
| `coordination_environment` | 原环境注册中心；list/get/set/refresh/remove/enable/disable |
| `coordination_profession` | 原职业选择状态；属于插件业务状态，不改变 Codex composer |
| `coordination_profession_lock` | 原职业锁查询；不伪造 Codex 主聊天轮次 |
| `coordination_selection` | 原选择状态读写，宿主权限预设缺失时保持原来的失败行为 |
| `coordination_collaboration` | 原职责状态机与子会话校验；list 可用，assign 需要真实原生子代理 roster，Codex MCP 未提供该端口时明确拒绝 |
| `coordination_workspace` | 原 structure/build/test/run；执行绑定真实子进程和 MCP 宿主审批，输出/时间有界 |
| `coordination_notification` | 原 NotificationCenter；返回验证后的通知，在支持 MCP Apps 的界面显示通知卡，不冒充 DSH GUI 事件 |
| `coordination_approve` | 原 ApprovalCenter；由关联的 MCP host elicitation 返回人类决定，超时、拒绝和缺少能力均不能批准 |
| `coordination_search` | 原参数校验及结果接口；后端复用现有 AMP Elasticsearch，搜索当前授权工作区的元数据 |
| `coordination_project`（新增） | 原生 AMP 项目品牌检测与 detect/build/compile/run/test，支持 dryRun，执行需宿主批准 |

可通过 `coordination_context({"action":"detail","name":"coordination_read"})` 获取当前实际参数 schema，无须把全部工具定义一次装入上下文。八个原项目工作流技能也已复制，插件共 13 个技能。

声明层复用原项目 `leanParameters`：默认省略迁入工具参数上的冗长说明，保留类型、枚举、范围及必填约束；执行端仍使用完整校验，detail 返回带说明的完整 schema。设置宿主环境变量 `CODEX_COORDINATION_SCHEMA_DETAIL=full` 可恢复完整声明。AMP 原始 60 个工具不参与此投影。

## 同名兼容与状态位置

`coordination_goal`、`coordination_plan` 不带 `workspace` 时使用上表迁移接口；带 `workspace` 时继续使用原 JSON 台账接口。`coordination_workspace` 的 select/status/refresh 继续绑定 AMP，structure/build/test/run 使用迁移接口。

原 `<workspace>/.codex-coordination/ledger.json` 不迁移、不重新链化。迁移模块状态在 AMP 主数据库旁的 `workspaces/<workspaceId>.coordination.sqlite`；它与原 JSON 台账、AMP 原生控制数据库分别保存。使命、目标、计划和知识元数据可在工作台中调用正式工具查看。注册中心的 global/session 是此插件业务数据库中的作用域，不等于 Codex 全局设置或当前真实聊天身份。

## 源码来源与宿主边界

`vendor/coordination-runtime/SNAPSHOT.json` 记录原项目地址、版本、提交参考及 **152 个原样源文件的 SHA-256**。文件哈希标识实际工作树快照；不假设工作树与提交完全相同。构建先校验快照，再校验注册名称与 24 项清单完全一致。原始 LICENSE/NOTICE 和打包依赖的许可证保留在安装包 assets。

`entry.ts`、`fs-guard.ts`、`fs-sync.ts`、`fs-async.ts` 是独立的 Codex 适配文件。原工具、状态机和解析算法不改写；构建将工作区模块的文件端口接到 AMP 授权根及排除规则，保护宿主数据库、配置和私钥。迁入模块的 AMP 导入绑定已有共享运行时，避免复制出另一套注册中心实例。复制的依赖源码不重复进入默认语义索引，仍可通过授权文件工具读取。

命令只有在真实关联的宿主批准后才执行。子进程隐藏窗口，限时最多 90 秒，stdout/stderr 各最多 256 KiB，仅传递基础环境；不宣称具备 DSH 的 OS sandbox。迁移没有替代 Codex 主循环，也没有伪造 DSH composer、真实聊天轮次、原生子会话树或主聊天压缩端口。缺少这些宿主端口时返回明确结果，不能把元数据状态当成真实宿主动作。

`coordination_search` 使用现有私有 searchNode/searchConnection 配置。逻辑 index 只能是 workspace，from 为 0，最多 20 个命中；fields 筛选顶层元数据键，支持 *，不开放任意 Elasticsearch 索引。需要更多结果时细化查询或使用原始 AMP 发现工具。知识标记只投影标题、备注、路径和标签，不读取或索引文件正文，重启后仍参与搜索。

## 快捷上下文流程

```json
{"action":"search","query":"scanWorkspace","limit":3}
```

从返回的候选中选择 ID，再调用同一个 `coordination_context`：

```json
{"action":"read","targets":["<返回的实体ID>"],"startLine":1,"maxLines":15,"budgetTokens":2000}
```

此操作在宿主内部调用 AMP 的分配、物化、读取、释放和结算；默认仅返回片段、依赖、估算预算与 archive 引用。targetLines 相对目标，fileLines 相对源码文件，避免符号片段行号混淆。错误结果也会结算本次创建的上下文，不操作其他待结算上下文。

`detail` 搭配 archive 的 id 可恢复原始完整记录，校验对象链并检查所属工作区。`verbosity: full` 可直接返回完整流水。`metrics` 返回稳定目录哈希和静态字符量，以及实际经过投影的响应字符计数；`verbosity: full` 再列出工具名。这些都不等于 Codex 实际模型 token、缓存命中或主聊天压缩。

`node scripts/context-benchmark.mjs` 可复现源码阅读对照。本次对 `scanWorkspace` 读取 15 行：5 个原生生命周期响应共 9734 个 JSON 字符，快捷响应 2454 个字符，减少约 74.8%；这是该例的返回量，不是通用 token 节省比例。已进入聊天的历史不会因释放句柄而消失。

验证包括 85 个单元测试、330 项 MCP stdio 检查、独立安装包检查、真实 Elasticsearch 的检索与知识标记增删、生产 MCP Apps 桥接及通知显示。
