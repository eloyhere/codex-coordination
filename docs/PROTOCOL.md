# Protocol integration

This plugin is a Codex host adapter for `attention-manifest-protocol@0.6.3`, installed from npm. AMP artifacts retain wire version `0.1`. [AMP integration and configuration](AMP-INTEGRATION.md) maps the native services, domain API, adapters, registries and host boundaries. This document also specifies compatibility with the original JSON coordination ledger.

## Native host integration

The source now exposes AMP's 60 canonical workspace, global, session, filesystem and global-filesystem tool definitions unchanged. Select an absolute repository using `coordination_workspace` before calling them. The host retains session credentials and stores scoped control state in `~/.codex/coordination/amp.sqlite` (override with `CODEX_AMP_DATABASE`). Specialized registries are exposed by `coordination_registry`; their native operations are replayed from a versioned SQLite journal. Executable callbacks bind installed templates, and parser registry edits activate the shared AMP parser instances.

Search delegates to AMP `CatalogSearch`, `projectSearchRecords` and `applyControlRegistry`. Configure Elasticsearch with `CODEX_AMP_SEARCH_NODE` or `searchNode` in `~/.codex/coordination/host.json`; the default is `http://127.0.0.1:9200`. A host-configured local searchProcess can start an existing installation. Published AMP scanners provide symbols, import/call relations, nested projects, Markdown, Office and TeX projections within bounded authorized inputs.

`coordination_context` allocates explicitly requested frames, exposes pending contexts and archives settlements without claiming measured model token usage. This host lifecycle is distinct from the caller-supplied records accepted by `coordination_protocol` below.

Protocol implementation binding, MCP/A2A/team/cooperation connections, cognitive/kernel/governed runtimes, telemetry, governance, signing/trust, delegation and domain services have dedicated adapters. There are 98 tools total. The generated inventory supports discovery; behavior tests and adapter bindings establish operational coverage. Host-only approvals, private keys, SQL and network authority remain behind the relevant adapters.

## Runtime ownership

| Responsibility | Implementation |
| --- | --- |
| Canonical JSON and digests | Imports from `attention-manifest-protocol/semantic` |
| Safe JSON cloning | Imports from `attention-manifest-protocol/semantic/jsonValue.js` |
| Goal lifecycle | Imports from `attention-manifest-protocol/goal`, with extra host gates for unfinished plans |
| Plan preconditions | `validatePlanInput` from `attention-manifest-protocol/goal/plan.js`, plus bounded host validation |
| Protocol types | `Goal`, `Plan`, `PlanTask`, `Ref`, `Budget`, `Criterion` from the published type surface |
| Artifact schemas | All 16 published schema files / 28 root kinds, validated with Ajv 2020 and RFC 3339 formats |
| Snapshot protocol verification | `verifySnapshot` from `attention-manifest-protocol/ledger` |
| Host storage and diagnostics | TypeScript files in `src/mcp/lib/`; compiled and bundled into the plugin |

The lockfile pins npm integrity and dependency versions. There is no source checkout path or vendored protocol tree in the runtime. esbuild includes the imported npm implementations and schemas in the distributable; deployment needs Node 24+, not an installed node_modules directory. Retained `.mjs` files are generated output; edit `.mts` source and rebuild.

## Supported objects

| Object | Creation and persistence |
| --- | --- |
| Goal | `coordination_goal`; strict AMP artifact, one `goal` entry at creation. Lifecycle/history live beside it; later transitions append host `event` payloads. |
| Plan | `coordination_plan`; strict AMP artifact, a new `plan` entry on every mutation. Edges, initial status and creation time are host-derived. |
| Frame | `coordination_protocol` action `record`; complete schema-valid caller-provided AMP artifact, immutable kind/id, appended as `frame`. Maximum nine attention slots; exclusions and revisit conditions remain explicit. |
| Receipt | Same recording path, appended as `receipt`; operation, outcome, timestamp and usage shape follow the npm schema. |
| Ledger snapshot | `coordination_check` action `snapshot`; derived from the append-only journal. `coordination_protocol` can validate a supplied snapshot with both schema and upstream hash verification. |
| Handoff duty | Host projection, recorded as bounded `event` payloads. It is not an AMP artifact kind. |

Frames and receipts supplied to the legacy recording tool are caller assertions. That recording path does not measure usage, authenticate declared identities or execute checks. Its outer chain hash binds the exact recorded data. The separate native context service allocates frames and binds session credentials; AMP-managed provider turns record measured usage through CognitiveRuntime. Codex's own internal model loop is outside those provider ports. Identities used in the original handoff workflow remain declared names.

Goal/Plan writes must use their dedicated lifecycle tools. The generic protocol tool cannot bypass state transitions by appending replacement goals/plans. A second frame or receipt of the same kind/id conflicts; history is never overwritten.

## Host rules

- Goals carry at least one observable success criterion and an explicit check. States are `proposed → committed → active → achieved`, with abandonment edges; terminal states cannot reopen. Achievement additionally requires every linked plan to be settled.
- Plans have at most twelve tasks. Dependencies must exist and be acyclic. `goal`, `abandon_if`, expected observations and checks are required. New plans are `draft`, then `committed`, `executing`, and `done` or `abandoned`.
- Tasks may enter `running` or `done` only after all predecessors are `done`. Starting a task promotes a committed plan to executing. A plan can close only when every task is terminal.
- Duties move through `assigned`, `accepted`, `started`, `submitted` and owner `verified`/`rejected`, with cancellation edges. Submission requires evidence; review requires the owner's recorded explanation. Only the declared side can advance each action.
- The host rejects unknown fields and invalid canonical values rather than silently rewriting the caller's record. Protocol errors are translated into stable `CoordinationError` codes returned as MCP `isError` results.

## Ledger and compatibility

The host document remains version **2**, at `<workspace>/.codex-coordination/ledger.json`. Existing version 2 ledgers remain readable and are not migrated or re-chained. Version 1 ledgers are refused because inventing a replacement chain would erase their original provenance.

Each exported chain entry is exactly `{seq, kind, payload, prev, hash}`. The hash is AMP's digest of `{seq, kind, payload, prev}`. Sequence starts at zero; the first predecessor is `sha256:` plus 64 zeros. Host advisory timestamps are excluded from exported entries and hash input. Count and tip are checked against actual entries.

The legacy ledger emits `goal`, `plan`, `event`, `frame` and `receipt`. Native domain resources and `coordination_artifacts` separately support claims, hypotheses and the other published root kinds in the SQLite object store. Legacy host event payloads are coordination events; they are not claimed to satisfy the strict AMP Event branch of receipt.schema.json.

Writes are serialized per ledger inside one process and materialized with a temporary file and atomic rename. There is no cross-process lock. Use one writer per workspace. An audit reports tampering and structural errors; it never repairs a broken chain by rewriting it.

## React and Codex

`coordination_dashboard` is a read-only tool with an MCP Apps resource at `ui://codex-coordination/dashboard`. It accepts `{}` for the thread entrypoint and returns a workspace selector. With an absolute workspace, it returns the current status, audit, and up to fifty recent frame/receipt records.

The server implements `resources/list` and `resources/read` with `text/html;profile=mcp-app`. The single-file React 19 interface uses `periodicity-react`, the official MCP Apps client bridge, host theme updates and safe-area insets. Refresh, export and validation invoke the same MCP handlers as chat. Explicit record actions append frames/receipts through their normal checks.

The development-only Vite API listens on loopback, checks a custom request header and origin, and restricts calls to read/validate tools. Production HTML communicates with its parent MCP host and contains no local HTTP API endpoint. Browser preview permits no writes.

## Host authority

Native authorization is bound to the selected root and host-retained session credentials. Signing and key lifecycle use host-owned keys; executable registry callbacks bind installed implementations. Remote endpoints, model credentials and listener ports require private host configuration. Governing-agent calls cannot manufacture host approvals or private key material. Native replay restores local resources without repeating external model/network effects. Pending materialization contexts remain process-local until explicitly settled; persisted frames and settlements retain their native records.

## Verification

`npm run check` builds and verifies the complete package: 85 unit tests, 330 stdio checks, isolated package checks, 9 conformance checks and 2 browser scenarios. It covers native registries, domain replay integrity, delegation fencing, governance budgets, signing/revocation, runtime metering, filesystem authorization and actual local protocol transports as well as the legacy lifecycle/ledger behavior. Stdio checks discover 98 tools. Conformance defaults to the installed npm package and can compare an explicit checkout with `--amp`.

Playwright checks real ledger data, filtering, validation, snapshot export, invalid inputs and layout at 1440, 768 and 375 pixels. A second test loads the **production HTML in an iframe**, performs the MCP Apps handshake with a test host, routes calls to real handlers, records a receipt, selects a workspace, edits a native registry and discovers domain modules. This is a host simulation, not a claim that an already-running Codex process has reloaded its tool set. Real Elasticsearch checks run separately via `node scripts/amp-search-smoke.mjs`.
