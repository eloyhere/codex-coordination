# codex-coordination

A Codex plugin with a **TypeScript MCP server**, a **React 19 dashboard**, and 13 workflow skills. The server imports **attention-manifest-protocol 0.6.3 from npm**; the interface uses **periodicity-react 0.1.15**, including its default ripple effects.

**English** · [简体中文](README.zh-CN.md)

It exposes AMP's 60 original service tools, nine host adapters and the original coordination tools, plus all 24 coordination agent tools and coordination_project (overlapping names are merged): 98 tools total. Native registries, structured scanning, Elasticsearch search, context, governance, signing, delegation, connections and cognitive runtimes use AMP implementations. The **AMP 能力** dashboard tab calls the same tools. See [capability mapping and configuration](docs/AMP-INTEGRATION.md).

Goals, plans, handoffs, attention frames and receipts remain compatible with the existing version 2 `.codex-coordination/ledger.json` and AMP wire version `0.1`. Native AMP control and domain state use host-owned SQLite databases.

## Develop

Requires Node.js **24+** and npm.

```powershell
npm ci
npm run build
npm run dev
```

Open the local Vite URL, enter an absolute repository path, and inspect its real ledger. Browser development preview permits reading, auditing, snapshot export and schema validation. Recording changes uses the Codex MCP connection.

```powershell
npx playwright install chromium
npm run check
```

`check` runs strict TypeScript checks, both builds, plugin validation, unit tests, stdio MCP smoke tests, npm AMP conformance and browser tests at desktop/tablet/mobile widths. `npm run conformance -- --amp <checkout>` can additionally compare an explicit protocol checkout; its default is the installed npm package.

## Install in Codex

Install the published repository marketplace (the bundled marketplace launcher currently targets Windows):

```sh
codex plugin marketplace add eloyhere/codex-coordination --ref v0.5.1
codex plugin add codex-coordination@codex-coordination
```

The npm package also includes the compiled server, UI, skills and marketplace:

```sh
npm install codex-coordination@0.5.1
codex plugin marketplace add ./node_modules/codex-coordination
codex plugin add codex-coordination@codex-coordination
```

For a standalone stdio MCP command, use `npx -y codex-coordination@0.5.1`. This starts the MCP server; it does not register a plugin marketplace automatically.

Build before installing from source:

```powershell
npm ci
npm run build
codex plugin marketplace add R:\project\codex-coordination
codex plugin add codex-coordination@codex-coordination
```

Start a new chat after installing or reloading the plugin. In chat, ask Codex to open `coordination_dashboard` for the repository, or open Coordination from the chat's app entrypoint and enter the repository path. The React view is an MCP App resource, served through the local stdio process. It needs a host that supports MCP Apps; the ordinary tools also work without the interface.

The plugin contains built server modules and one self-contained HTML app. Its runtime dependencies are bundled during development, so the installed plugin does not run `npm install` or access npm. Keep Node.js 24+ available; the included Windows launcher also searches for the Codex-bundled runtime. On macOS/Linux, change `.mcp.json` to invoke `node mcp/server.mjs` from the plugin directory.

## Tools

| Tool | Purpose |
| --- | --- |
| `coordination_status` | Bounded ledger summary and next actions |
| `coordination_goal` | Create, list, read and advance observable goals |
| `coordination_plan` | Create and advance bounded dependency-aware plans |
| `coordination_handoff` | Assign, accept, start, submit and review duties |
| `coordination_check` | Audit consistency or export an AMP snapshot |
| `coordination_protocol` | Discover schemas, validate AMP artifacts, record/list frames and receipts |
| `coordination_dashboard` | Open the React view, inspect data and run audits |

The original ledger forms above take an absolute `workspace`, except that the dashboard entrypoint also accepts `{}`. Goal/plan calls without workspace use the copied workspace-bound interface; [all named tools and compatibility rules](docs/COORDINATION-TOOLS.md) are documented separately. Native AMP tools first bind a repository through `coordination_workspace`; credentials remain in the host.

The nine host adapters are `coordination_workspace`, `coordination_registry`, `coordination_context`, `coordination_amp`, `coordination_artifacts`, `coordination_keys`, `coordination_connections`, `coordination_runtime` and `coordination_hooks`. Start with `coordination_amp` action `describe` for the module catalog and original signatures. The bundled `amp-runtime` skill explains discovery, editable registries and resource handles.

`coordination_protocol` supports `describe`, `validate`, `record`, and `list`. Validation covers all 28 published JSON Schema root kinds. Its legacy ledger recording accepts immutable **frames and receipts only**; goal/plan writes retain their lifecycle tools. `coordination_artifacts` records other schema kinds in the native store. A repeated kind/id conflicts instead of overwriting history. List results are newest first, with a limit of 1–50.

```json
{
  "workspace": "R:\\project\\my-project",
  "action": "record",
  "artifact": {
    "amp": "0.1", "kind": "receipt", "id": "build-result",
    "op": "act", "at": "2026-11-03T00:00:00Z",
    "usage": {}, "outcome": "success", "note": "Build exit code was 0"
  }
}
```

Only record observed outcomes. Frame/receipt fields are caller assertions: schema validation and the hash chain do not authenticate identities, measure usage, or prove evidence. A frame's `digest` retains the protocol's caller-provided meaning; the host computes the enclosing chain hash separately. [Protocol scope](docs/PROTOCOL.md) describes the boundaries.

## Source and build

| Path | Responsibility |
| --- | --- |
| `src/mcp/*.mts`, `src/mcp/lib/*.mts` | TypeScript server and host adapter; edit these files |
| `src/mcp/contracts.mts` | Shared server/UI data contracts |
| `src/app/` | React dashboard, MCP Apps bridge and styling |
| `scripts/build.mjs` | Bundle npm runtime dependencies while retaining shared store identity |
| `vite.config.ts` | Single-file UI build and local read-only preview |
| `plugins/codex-coordination/mcp/` | Generated installable server output |
| `plugins/codex-coordination/app/index.html` | Generated MCP App resource |
| `src/mcp/amp/` | Native AMP host adapters, generated export/signature catalog |
| `plugins/codex-coordination/skills/` | 13 coordination and AMP workflow skills |
| `test/`, `test/browser/` | Ledger, integration and real browser regression checks |

Run `npm run build` after source changes; generated files are retained for marketplace installation. `npm run serve` starts the built stdio service. `npm run snapshot -- --help` documents standalone snapshot export.

## Privacy and limits

Repository operations stay inside the selected authorized root. Host credentials, signing keys and native state stay in the host directory; configured search, model and protocol endpoints may receive requests. Endpoint metadata cannot grant a network connection. The Vite preview binds to loopback and accepts only read/validate operations. Keep one writer per legacy JSON ledger; cross-process locking is not provided there. Declared handoff identities are not authentication. Native sessions and signed operations have their own AMP authorization rules.

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and the bundled dependency notices under the plugin assets.
