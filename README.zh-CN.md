# codex-coordination

Agent 可调用 `coordination_notification`，在插件界面显示 snackbar、popover、dialog 或 alert，支持严重程度、位置、自动关闭和关闭按钮。参见 [通知用法](docs/NOTIFICATIONS.md)。

一个包含 **TypeScript MCP 服务、React 19 界面与十三个工作流 skill** 的 Codex 插件。服务直接从 npm 导入 **attention-manifest-protocol 0.6.3**，界面使用 **periodicity-react 0.1.15** 并保留默认 ripple 特效。

**简体中文** · [English](README.md)

插件提供 AMP 原有的 60 个服务工具、9 个宿主适配工具和原有 7 个协调工具，合并 24 个 coordination agent 工具及 coordination_project，并处理同名兼容后，共 **98 个工具**。注册中心、结构扫描、Elasticsearch 搜索、上下文、治理、签名、委派、连接与认知运行时直接使用 AMP 实现。界面的 **AMP 能力** 标签页调用同一组工具。完整入口与配置见 [AMP 接入说明](docs/AMP-INTEGRATION.md)。

原有目标、计划、交接、注意帧与回执仍保存在 `.codex-coordination/ledger.json`，兼容 version 2 台账和 AMP wire tag `0.1`。AMP 原生控制和领域状态使用宿主侧 SQLite。

## 开发

需要 **Node.js 24+** 与 npm。

```powershell
npm ci
npm run build
npm run dev
```

打开 Vite 输出的本地地址，输入仓库绝对路径，即可查看真实台账。浏览器开发预览支持读取、审计、导出快照与校验协议对象；追加记录通过 Codex 中的 MCP 连接完成。

```powershell
npx playwright install chromium
npm run check
```

`check` 依次执行严格 TypeScript 检查、前后端构建、插件结构检查、单元测试、stdio MCP 冒烟测试、npm AMP 一致性检查，以及桌面、平板和手机宽度的浏览器测试。

`npm run conformance` 默认对照已安装的 npm 协议包；也可以用 `npm run conformance -- --amp <协议仓库路径>` 对照指定源码仓库。

## 安装到 Codex

从已发布的仓库自定义市场安装（当前随包市场启动器面向 Windows）：

```sh
codex plugin marketplace add eloyhere/codex-coordination --ref v0.5.1
codex plugin add codex-coordination@codex-coordination
```

npm 包也包含编译后的服务、界面、skills 和市场目录：

```sh
npm install codex-coordination@0.5.1
codex plugin marketplace add ./node_modules/codex-coordination
codex plugin add codex-coordination@codex-coordination
```

仅需 stdio MCP 服务时可运行 `npx -y codex-coordination@0.5.1`；它不会自动注册插件市场。仓库自定义市场与 OpenAI 官方公共目录是不同的分发渠道。

从源码安装前先构建：

```powershell
npm ci
npm run build
codex plugin marketplace add R:\project\codex-coordination
codex plugin add codex-coordination@codex-coordination
```

安装或重新加载后新开一个聊天。可以请 Codex 调用 `coordination_dashboard` 打开当前仓库的界面，也可以从聊天的应用入口打开 Coordination，再输入仓库路径。

React 界面作为 MCP App 资源由本地 stdio 服务提供，需要宿主支持 MCP Apps；普通工具可以独立使用。构建产物包含服务模块和一个内联脚本、样式的 HTML 文件，npm 依赖在开发时打包，安装后的插件无需执行 `npm install` 或访问 npm。

Windows 启动器会寻找 PATH、`NODE_EXE` 或 Codex 自带的 Node 运行时。macOS/Linux 可将 `.mcp.json` 改为在插件目录运行 `node mcp/server.mjs`。运行时需要 Node.js 24+。

## 工具

| 工具 | 用途 |
| --- | --- |
| `coordination_status` | 有界台账概览与下一步动作 |
| `coordination_goal` | 创建、读取、列出和推进可观察目标 |
| `coordination_plan` | 创建和推进带依赖约束的有界计划 |
| `coordination_handoff` | 指派、接受、开始、提交及验收交接 |
| `coordination_check` | 审计台账或导出 AMP 快照 |
| `coordination_protocol` | 发现 schema、校验对象、追加及列出注意帧与回执 |
| `coordination_dashboard` | 打开 React 界面、查看记录及执行审计 |

上表的旧台账模式要求传入绝对 `workspace`，界面入口也接受 `{}`。goal/plan 不带 workspace 时使用迁入的工作区绑定接口；[完整工具清单与兼容规则](docs/COORDINATION-TOOLS.md) 单独说明。AMP 原生工具先通过 `coordination_workspace` 绑定仓库，认证凭证由宿主持有。

9 个宿主工具分别是 `coordination_workspace`、`coordination_registry`、`coordination_context`、`coordination_amp`、`coordination_artifacts`、`coordination_keys`、`coordination_connections`、`coordination_runtime` 和 `coordination_hooks`。从 `coordination_amp` 的 `describe` 查询模块、原始签名与绑定方式；新增的 `amp-runtime` skill 说明实际调用流程。

`coordination_protocol` 的 action：

- `describe`：查询 npm 协议版本、支持的类型；传 `kind` 时返回对应 schema。
- `validate`：覆盖协议包发布的全部 28 种 JSON Schema 根对象；快照还通过协议包自己的摘要链校验。其他类型的持久化通过 `coordination_artifacts` 进入原生对象存储。
- `record`：仅追加不可变的注意帧和回执，同 kind/id 重复会冲突。目标和计划仍通过原有生命周期工具写入。
- `list`：倒序读取注意帧和回执，可按 kind 筛选，limit 为 1–50。

追加回执示例：

```json
{
  "workspace": "R:\\project\\my-project",
  "action": "record",
  "artifact": {
    "amp": "0.1", "kind": "receipt", "id": "build-result",
    "op": "act", "at": "2026-11-03T00:00:00Z",
    "usage": {}, "outcome": "success", "note": "构建退出码为 0"
  }
}
```

只记录实际观察到的结果。注意帧和回执中的字段属于调用者声明；schema 和摘要链不证明证据真实，不认证身份，也不会自动计量 token 或时间。注意帧的 `digest` 保留协议中调用者提供的含义，宿主另外计算外层台账链摘要。完整范围见 [协议说明](docs/PROTOCOL.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `src/mcp/*.mts`、`src/mcp/lib/*.mts` | TypeScript 服务和 Codex 适配层，修改这里的源码 |
| `src/mcp/contracts.mts` | 前后端共享数据契约 |
| `src/app/` | React 界面、MCP Apps 桥接与样式 |
| `scripts/build.mjs` | 打包 npm 运行时依赖，保留台账事务队列的模块共享关系 |
| `vite.config.ts` | 单文件界面构建、本机只读预览接口 |
| `plugins/codex-coordination/mcp/` | 生成的可安装服务产物 |
| `plugins/codex-coordination/app/index.html` | 生成的 MCP App 资源 |
| `src/mcp/amp/` | AMP 宿主适配、生成的导出与签名目录 |
| `plugins/codex-coordination/skills/` | 十三个协调与 AMP 工作流技能 |
| `test/`、`test/browser/` | 台账、协议、工具和浏览器回归检查 |

修改源码后运行 `npm run build`。保留生成产物，便于 Codex marketplace 安装。`npm run serve` 启动构建后的 stdio 服务；`npm run snapshot -- --help` 查看独立导出命令。

## 数据与边界

仓库操作限制在选定的授权根目录，宿主凭证、签名私钥与原生状态保存在宿主目录。配置的搜索、模型和协议服务可以接收请求，单独编辑 endpoint 元数据不会授予网络连接。本地 Vite 预览只监听 loopback，仅开放读取和校验操作。旧 JSON 台账没有跨进程锁，同一工作区应只运行一个写入服务。交接身份属于声明；原生会话及签名操作使用 AMP 各自的授权机制。

Apache-2.0。参见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和插件 assets 中的依赖许可证。
