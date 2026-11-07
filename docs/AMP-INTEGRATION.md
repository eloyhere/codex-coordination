# AMP 接入与配置（0.5.0）

运行时依赖固定为 npm `attention-manifest-protocol@0.6.3`。算法、解析、检索、治理及协议校验直接调用包内实现；适配层承担授权、端口、JSON 编码、生命周期和持久化。AMP 的扫描实现已从上游工具目录移入公开 `scan` 模块并发布为 0.6.2，插件没有复制一套扫描算法。

## Codex 入口

先调用 `coordination_workspace`：`{"action":"select","workspace":"R:\\project\\my-project"}`。外部修改文件后调用 `refresh`；有待结算上下文时先结算再切换或刷新。

共 98 个工具：AMP 原始 workspace 19、global 19、filesystem 10、globalfs 10、session 2；宿主适配 9；原有协调工具 7；协调 agent 工具 24（3 个同名入口合并）；另加 coordination_project。60 个原始定义的名称、字段、风险和 schema 不改写，认证 token 不进入 agent 参数。global 聚合授权根目录内扫描出的多个项目，不扩大文件权限。[全部迁入工具、兼容与上下文优化](COORDINATION-TOOLS.md) 单独说明。

| 宿主入口 | 实际绑定 |
| --- | --- |
| `coordination_workspace` | SessionRegistry、原生扫描器、FilesystemService、WorkspaceAgentService / GlobalAgentService、快照刷新 |
| `coordination_registry` | 16 类原生注册中心的发现、读写、删除、版本与实际消费者 |
| `coordination_context` | 原生 selectFocus、Frame 分配、pending、settle、revoke |
| `coordination_amp` | 发布模块的类型签名、纯计算、原生类资源、公开方法/属性、宿主数据库聚合服务 |
| `coordination_artifacts` | 全部 28 种 schema 根对象的校验及不可变存储、摘要链验证、核心台账快照 |
| `coordination_keys` | Ed25519、KeyRegistry / Keyring、轮换/退役/撤销、manifest、federation、governance、envelope 与 checkpoint 签验 |
| `coordination_connections` | MCP HTTP/stdio、A2A、AMP team、cooperation；绑定、目录同步、pin、预算、回执与宿主审批 |
| `coordination_runtime` | AgentService、CognitiveRuntime、KernelRuntime、GovernedTask、会话、回合、重放、反馈及 telemetry |
| `coordination_hooks` | 原生 hooks、AST/outline、ContextBuilder、文件指纹、Office 解析、目录及模块完整性 |

`coordination_dashboard` 的 **AMP 能力** 页提供仓库绑定、工具选择、参数编辑与执行结果。生产界面走 MCP Apps；Vite 浏览器预览仅允许读取与校验。

## 注册中心

六类作用域数据：`skills`、`knowledge`、`protocols`、`modules`、`environments`、`concepts`，使用原生 control 服务，可选择 workspace/global。十类工作区注册中心：`tools`、`outlines`、`outlineKeywords`、`languages`、`tokenKinds`、`nodeKinds`、`sqlDialects`、`calibrations`、`behaviors`、`entities`。

先 `list/get` 读取当前版本，再 `register/update/remove/clear`；支持相应的 `expectedVersion` 与 `dryRun`。专用注册中心的操作持久化并进入原生对象摘要链，重启后重放；切换仓库时恢复该仓库的真实解析器实例。默认项只在首次缺失时写入，用户删除的项不会自动复活。

语言、token/node 种类、关键字、SQL 方言和 outline 修改作用于原生解析分派；行为修改作用于 CognitiveRuntime，工具别名进入实际工具循环。可执行 outline/behavior 绑定已安装模板，工具别名绑定已安装 AMP 工具，保持目标风险及 schema。元数据不解释 JavaScript，也不产生新宿主权限。

## 模块与领域资源

`coordination_amp` 的 `describe` 先给出模块索引；加入 `module` 列出导出，再加入 `name` 查看 npm 原始声明及可用绑定。`call` 使用位置参数数组执行函数；`create` 创建原生资源；`invoke/inspect` 调用公开方法/读取公开属性；`resources` 列出当前资源。下面按领域列出运行时导入的 58 个模块；完整导出及签名由 [AMP-INVENTORY.json](AMP-INVENTORY.json) 和源码 catalog 生成。

| 模块组 | 接入方式 |
| --- | --- |
| attention、frame、context、window、boundary、progress | 原生注意力/窗口计算、ContextWindow、ContextBuilder、帧与上下文宿主生命周期 |
| bayes、diagnosis、evaluation、evidence、warrant、knowledge、concept、naming | 原生计算、CalibrationRegistry、EvidenceGraph、WarrantRevalidation、InquiryLog、作用域数据注册中心 |
| assignment、delegate、cooperation、interaction、ipc、thread | Assignment/BindingLedger、TeamRuntime、CooperationBus、EnvelopeRuntime、线程和宿主传输端口 |
| governance、policy、authz、manifest、execution | 原生预算/法律/工作流/策略/授权、审计、签名及执行 profile；私钥与审批由专用宿主管理 |
| runtime、kernel、process、mission、session | Cognitive/Kernel/GovernedTask、AgentService、MissionQueue、会话、turn/outbox 与宿主凭证 |
| scan、file、fingerprint、syntax、outline、hook | 原生 TS/JS 编译器关系图、Markdown/Office/TeX、原生解析注册中心、授权文件端口及 hooks |
| search、discover、global、control、protocol、registry、skill、environment、module | 原生 Elasticsearch 投影/同步/发现、60 个标准工具、控制注册中心、ProtocolRegistry 绑定与模型客户端 |
| database、storage、store、ledger、goal、receipt、error | 原生 SQLite 聚合、存储资源、AppendLog、Ledger、生命周期、schema 与错误映射 |
| semantic、structure、concurrency、lock、scenario、types | 原生规范化/摘要、数据结构、互斥锁、场景工具与运行时常量 |

JSON 承载 BigInt、bytes、Map、Set、Date 与资源句柄，分别使用 `$bigint`、`$bytes`、`$map`、`$set`、`$date`、`$ampRef`。示例：`{"action":"call","module":"syntax","name":"countLines","arguments":["a\nb\n"]}`。回调使用安装过的 `$ampFunction` 或公开资源 `$ampMethod`；不执行调用者代码。公开签名不代表每个内部 TypeScript helper 都适合直接 RPC：原始 SQL、文件系统根、网络端口、私钥与审批保持宿主持有，通过表中专用适配调用。

领域资源按命令和原生时钟重建；重放日志同时校验原生对象链与命令承诺，拒绝删改。原生持久存储使用自身数据库，不重复执行其写入；模型及网络请求不在重放时再次发送。资源 ID 绑定选定仓库；不能跨仓库借用。

## 数据位置与生命周期

- 原有协调台账：`<workspace>/.codex-coordination/ledger.json`，version 2 不迁移、不重新链化。
- 当前项目的旧版控制/搜索/对象状态：`.codex-coordination/amp-legacy/control.sqlite`。原 `~/.codex/coordination/amp.sqlite`（或 `CODEX_AMP_DATABASE` 指定路径）仅作为只读迁移源；`:memory:` 仍表示不持久化。领域库和协调库也在项目内。
- 每仓库领域状态和私钥：主数据库旁 `workspaces/<workspaceId>.sqlite`；不能选为 agent 文件根。
- 私有配置：`~/.codex/coordination/host.json` 或 `CODEX_AMP_HOST_CONFIG`。宿主目录、数据库、TLS 私钥、配置文件从授权文件读取及扫描中排除。

扫描有界：最多 5000 文件，普通文本单文件 1 MiB，Office 16 MiB，总读取 32 MiB；跳过符号链接、`.git`、`node_modules` 和协调台账目录。明确标注由本插件 `build:server` 生成的 bundle 不再重复进入语义扫描，其 TypeScript 源码正常索引，bundle 仍可通过分页文件工具读取。原生 scanner 负责语义，宿主负责采集边界。AMP 0.6.3 对不可变输入的摘要每文件只计算一次，避免按 AST 节点反复哈希整文件；开启 CODEX_COORDINATION_DEBUG 可查看扫描阶段耗时。授权写入遵循原生帧、CAS 和作用域检查，执行仅绑定安装环境的命令。

原生 materialization handle 和待结算上下文属于当前连接进程；frame 与显式结算快照进入持久对象存储。释放 handle 不等于结算。宿主结算回执只证明上下文已归档，`usage: {}` 不冒充模型计量。Codex 主聊天模型的内部循环和 token 计量不是插件公开端口；`coordination_runtime` 的真实 provider 回合有 AMP 原生计量。

## 私有宿主配置

以下是配置格式示例，按实际服务填写。不要把密钥值放入仓库或聊天。

```json
{
  "searchNode": "http://127.0.0.1:9200",
  "searchConnection": {
    "auth": { "apiKeyEnv": "AMP_SEARCH_API_KEY" },
    "tls": { "caFile": "C:/private/elastic-ca.pem" }
  },
  "llm": {
    "apiKeyEnv": "AMP_LLM_API_KEY",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash"
  },
  "endpoints": [
    { "id": "remote-mcp", "family": "mcp", "url": "http://127.0.0.1:9000/mcp", "headerEnv": { "Authorization": "AMP_REMOTE_AUTH" }, "budget": { "calls": 100, "tokens": 100000 }, "catalogVersion": 1 },
    { "id": "stdio-mcp", "family": "mcp", "command": "node", "args": ["C:/services/server.mjs"], "envVars": ["AMP_SERVICE_KEY"] },
    { "id": "remote-agent", "family": "a2a", "url": "http://127.0.0.1:9001" },
    { "id": "team", "family": "amp-team", "url": "http://127.0.0.1:9002" },
    { "id": "cooperation", "family": "cooperation", "url": "http://127.0.0.1:9003", "signingKid": "local-signing-key", "signer": "local-host" }
  ],
  "listeners": [{ "id": "local-cooperation", "host": "127.0.0.1", "port": 9003 }]
}
```

搜索直接调用 AMP `CatalogSearch`、`projectSearchRecords`、`applyControlRegistry`。`CODEX_AMP_SEARCH_NODE` 可覆盖地址；无配置时默认 loopback 9200。`searchConnection` 支持 Elasticsearch 原生连接选项，并将 `auth.apiKeyEnv/bearerEnv/passwordEnv` 转成环境值；password 配置同时给出 username。TLS 的 caFile/certFile/keyFile 从宿主读取。

已有本地 Elasticsearch 时直接复用。也可以设置 `searchProcess`：`command`、`args`、`cwd`、`env`、`envVars`、`keepAlive`，在第一次发现前启动显式配置的本机进程，等待就绪。仅用于 loopback 地址，隐藏进程窗口；默认退出时关闭自有进程，`keepAlive: true` 可保留。插件不捆绑 Elasticsearch 二进制。当前开发机器复用 AMP 项目已有 Elasticsearch 9.2.0，地址为 `http://127.0.0.1:19200`，配置只在本机私有 host.json。

模型调用使用 AMP `DeepSeekLlm`；可配置 baseUrl/model、timeoutMs/retries 和输入/缓存/输出价格。无 llm 配置时使用 `DEEPSEEK_API_KEY` 的原生 fromEnv；未配置凭证会明确失败。不会降级成伪造回答或 usage。

远程连接只使用 host.json 中声明的 id。修改 protocols 注册中心可停用/移除现有绑定；仅写 URL 无法创建连接。MCP 目录 pin 与预算跨重连保存，经过宿主确认的目录更新用配置 `catalogVersion` 递增。高风险审批走真实关联的 MCP host elicitation；agent 参数不能签发审批。监听端口也须先由宿主配置，`listen` 再绑定原生 CooperationBus 资源及实时 keyring。

`.mcp.json` 转发常用 `AMP_LLM_API_KEY`、`AMP_SEARCH_API_KEY/PASSWORD/BEARER`、`DEEPSEEK_*`、`OPENAI_API_KEY` 及 `CODEX_AMP_*` 配置变量。示例中的自定义 `AMP_REMOTE_AUTH/AMP_SERVICE_KEY` 须在 Codex 环境转发白名单中添加；stdio 子进程再经 endpoint.envVars 显式转发。子进程不默认继承所有模型密钥。

## 验证

`npm run check`：严格 TS、服务和 React 构建、98 工具结构验证、85 个单元测试、330 项 stdio 检查、独立目录安装包检查、9 项 AMP 一致性检查、2 个 Playwright 场景（包含 1440/768/375 宽度与生产 MCP Apps 桥接）。

`node scripts/amp-search-smoke.mjs`：使用本机真实 Elasticsearch 验证符号、工具、知识注册/更新/删除、重复发现及内容隔离。`node scripts/inventory-amp.mjs`：从已安装 npm 包重新生成导出、公开签名和 schema 目录。

连接测试使用真实本地 HTTP/stdio MCP、A2A 和合作监听服务；认知/治理测试使用 AMP ScriptedLlm 注入，核对真实测试 provider 的 usage、持久化及不重复模型调用。未把付费模型账户或第三方生产服务的可用性计为已验证。模块目录用于发现能力，不能把导出数量等同于每个导出都做过独立行为测试。
