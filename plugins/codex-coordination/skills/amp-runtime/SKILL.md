---
name: amp-runtime
description: Use native AMP services, editable registries, domain algorithms, signed artifacts, delegation, governance and durable runtimes in Codex. 在 Codex 中调用 AMP 原生服务、读写注册中心并使用领域算法、签名、委派与治理运行时。
---

# Native AMP integration

Select the user's absolute repository with `coordination_workspace` before calling the native services. It returns a compact binding summary; `verbosity: full` expands diagnostics. `action: refresh` rebuilds the snapshot after external file changes. Settle pending contexts before refreshing or switching repositories.

For everyday reads use `coordination_context` action `search` with a query, choose target IDs, then action `read` with `targets`, optional `startLine`/`maxLines` and `budgetTokens`. The host performs the native allocation/read/release/settlement lifecycle and returns compact pages, source/file line ranges, dependencies and an archive ID. `detail` with `id` expands the immutable original record; with `name` it gives the exact installed tool schema. `metrics` reports static catalog and response projection sizes, not measured Codex tokens. `verbosity: full` is opt-in.

Coordination tools are available directly: profession, profession_lock, selection, mission, goal, plan, collaboration, parse, describe, chain, read, file, outline, importation, exportation, index, control, workspace_adjust, environment, knowledge, workspace, notification, approve and search (all with coordination_ prefixes). `coordination_project` binds native AMP project detection/actions. Copied planning/knowledge state belongs to the workspace's private coordination database and uses a stable plugin session, distinct from Codex's own chat identity. Goal/plan calls containing `workspace` retain the original JSON-ledger interface; omit it for the copied interface. Workspace select/status/refresh retain the AMP binding interface, and structure/build/test/run use the copied implementation. Direct file/graph reads lazily build their native copied index.

Commands require a correlated host approval. Approval rejection or missing elicitation cannot grant permission. Notification and popup UI is disabled by user preference. `coordination_notification` is compatibility-only: it returns displayed:false and never opens a UI or grants approval. Search reuses authorized AMP metadata: index is workspace and offset is zero. DSH-only composer, session compaction and native-subagent ports are not impersonated by Codex.

Use the canonical `amp_tool_workspace_*`, `amp_tool_global_*`, `amp_tool_session_*`, `amp_tool_filesystem_*` and `amp_tool_globalfs_*` tools with their advertised schemas. Their contracts come directly from the installed npm AMP package. Global workspace tools cover the detected projects under the selected authorized root.

Use native discovery before expanding details. Search uses AMP CatalogSearch and Elasticsearch; it never grants read or execution authority. Frame-scoped workspace reads and writes need an allocation from `coordination_context`, followed by canonical materialization. Releasing a handle does not settle a context. Use `pending` and `settle` for host archival; the host does not claim to measure Codex's own model token usage.

## Registries and computations

`coordination_registry` reads and edits the six scoped data registries and ten parser/runtime registries. Read the current entry/version before updating; use `expectedVersion` and `dryRun` when applicable. The canonical adjust tools also expose defaults and links. Native callback implementations bind installed templates, and tool aliases bind installed AMP handlers. Never supply JavaScript source, forge a risk tier or replace a canonical schema through metadata.

`coordination_amp` exposes the published domain API with positional arguments:

1. `{"action":"describe"}` lists modules without loading every signature into context.
2. Add `module` to list its exports; add `name` to obtain the original signatures and available binding.
3. `call` runs a computation, `create` opens a durable native resource, and `invoke` calls an advertised public method by resource ID. `inspect` reads a declared property. `append` adds a validated artifact to a native Ledger array. `service` calls a host-bound database aggregate operation; raw SQL and repository mutations are host-internal.

Arguments are a JSON array. Typed values use `{"$ampRef":"amp-resource.1"}`, `{"$bigint":"42"}`, `{"$bytes":"base64"}`, `{"$date":"ISO timestamp"}`, `{"$map":[["key","value"]]}` and `{"$set":["value"]}`. Installed computation callbacks use `{"$ampFunction":{"module":"structure","name":"compareNumbers"}}`; a bounded property selector uses `{"$property":["priority"]}`. There is no eval or caller-authored callback code. Resource handles are local to the selected repository.

Evidence graphs, warrant revalidation, inquiry, calibration, diagnosis, evaluation, compaction, attention, delegation/lease fencing, cooperation, budgets, legal gates and workflows use AMP's implementations. Domain replay commands are committed to the native object hash chain. Replay reconstructs local state and never repeats external model or network calls.

## Host adapters

- `coordination_hooks`: native read/write/diff/AST/outline/code/project hooks and run history; `context_package` uses AMP ContextBuilder; `file_operation` runs scoped native fingerprints, Office parsing and directory/module content checks.
- `coordination_artifacts`: validate/record/get/list every published JSON Schema root kind, verify the native backing object chain, or export its core ledger kinds as an AMP snapshot. Governance objects use a native GovernanceStore resource.
- `coordination_keys`: host-owned signing keys, public-key import, native rotation/retirement/revocation, manifest/card/federation, governance, envelope and checkpoint signing/verification. Private keys never appear in tool results. Declared signoffs and cryptographic verification are separate AMP layers.
- `coordination_connections`: configured MCP HTTP/stdio, A2A, AMP team and cooperation endpoints; native binding, mirroring, pins, budgets, warrants and receipts. `listen` starts only a host-configured cooperation listener bound to a native CooperationBus resource. Metadata URLs cannot open connections. Host approvals come from a real MCP host elicitation; the governed agent cannot issue them.
- `coordination_runtime`: native CognitiveRuntime, KernelRuntime and GovernedTask with SQLite sessions/turns/outbox, telemetry, the edited behavior registry and registered tool aliases. These are AMP-managed model turns through a configured provider, distinct from Codex's main conversation. Never fabricate provider usage or imply a test fixture is a live provider result.

Open `coordination_dashboard` for the settings-only interface (registry, environment, connections and keys). The former business dashboard, status row and session dialog are removed. Host connection/model configuration lives at `~/.codex/coordination/host.json` or `CODEX_AMP_HOST_CONFIG`; secrets are referenced through host environment variables, never requested in chat.
