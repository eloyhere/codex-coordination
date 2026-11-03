# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog; the project adheres to Semantic Versioning.

## [0.5.1] — 2026-11-03

- Render coordination_notification with Periodicity Snackbar, Popover, Dialog and Alert, including anchors, severity, multiline messages, durations and dismiss-only actions.
- Share agent-delivered and workbench notifications through a deduplicated display queue; support notification-only MCP App views.
- Add production bridge checks for all four surfaces, dismissal, timed closure, queue order, replay deduplication and initial notification delivery.

## [0.5.0] — 2026-11-03

- Copy all 24 agent tool implementations and eight workflow skills from deepseek-coordination 0.23.2, keeping formal coordination_* names. Verify a 152-file source snapshot before every build; retain licenses and notices.
- Add coordination_project over native AMP. Merge colliding goal/plan/workspace interfaces with their existing parameter forms; preserve the original JSON ledger and all 60 canonical AMP definitions. The combined surface has 98 tools and 13 skills.
- Bind copied file operations to AMP authorization, commands and approvals to correlated MCP host decisions, notifications to MCP results/UI, and search plus knowledge-file metadata to the existing AMP Elasticsearch backend.
- Add coordination_context search/read/detail/metrics: exact tool discovery, one-call native reading/settlement, compact default pages, durable full-result references, explicit file/target line ranges and static catalog/projection accounting.
- Shorten server guidance, compact JSON transport text and workspace diagnostics, and expose every named tool in the React workbench.
- Preserve explicit boundaries for DSH-only composer, native-child and conversation-compaction ports. Measure output characters separately from unknown Codex token/cache usage.

## [0.4.1] — 2026-11-03

- Upgrade to AMP 0.6.3, which caches immutable input digests during compiler scanning and preserves the exact original revision/source bytes.
- Exclude this plugin's explicitly marked generated server bundles from semantic scans, retaining paged filesystem access and TypeScript source indexing.
- Add optional scan phase timings under CODEX_COORDINATION_DEBUG and a generated-bundle regression check. Fix first binding of this repository exceeding the MCP timeout.
- Advertise positional JSON argument types explicitly so MCP hosts can pass numbers, objects and nested arrays without stringifying them.

## [0.4.0] — 2026-11-03

- Import published AMP 0.6.2, including its compiler, Markdown, Office and TeX scanners; reuse native search and domain algorithms.
- Expose all 60 canonical AMP agent service definitions unchanged, nine host adapters and the existing seven coordination tools.
- Make all 16 registry families editable and connect their native consumers, including parser dispatch, SQL dialects, cognitive behaviors and tool aliases. Persist versions and replayable edits.
- Add native context settlement, schema artifacts, evidence, warrants, calibration, attention, delegation, governance, workflows, signed envelopes, key lifecycle and durable domain resource access.
- Bind configured MCP HTTP/stdio, A2A, AMP team and cooperation transports with native catalog pins, budgets, receipts and correlated host approval.
- Integrate native CognitiveRuntime, KernelRuntime and GovernedTask with SQLite sessions, turns, outbox and measured provider usage.
- Add the React / Periodicity AMP workbench, private host configuration, search process lifecycle and capability/configuration documentation.

## [0.3.1] — 2026-11-03

### Fixed

- Restore Periodicity React's default button and card ripple effects by removing
  the wrapper overrides that disabled them.
- Publish a new plugin cache version so the repaired UI can be installed without
  replacing the active 0.3.0 cache directory.

## [0.3.0] — 2026-11-03

### Changed

- Migrate server source to strict TypeScript under `src/mcp`, retaining generated
  installable `.mjs` output and compatibility with version 2 ledgers.
- Import `attention-manifest-protocol@0.6.0` directly from npm for canonical JSON,
  digests, cloning, goal lifecycle, plan preconditions, schemas and snapshot
  verification. Bundle runtime dependencies; require Node.js 24+.
- Run AMP conformance against the installed npm package by default, retaining
  optional `--amp` checkout comparisons.

### Added

- React 19 / `periodicity-react@0.1.15` dashboard with goals, plans, handoffs,
  attention records, audits, filtering, snapshot export and JSON validation.
- MCP Apps HTML resource, thread entrypoint, structured tool results, host theme
  and safe-area integration, plus a loopback read-only development preview.
- `coordination_protocol` for schema discovery, validation, and immutable
  frame/receipt recording; `coordination_dashboard` for opening the interface.
- Lockfile, separate server/UI builds, third-party license output and browser
  checks of responsive layouts and the production MCP Apps bridge.

## [0.2.0] — 2026-11-03

The ledger now emits strict AMP v0.1 artifacts instead of AMP-shaped
approximations.

### Added

- **AMP chain** (`mcp/lib/store.mjs`): entries are `{seq, kind, payload, prev, hash}`
  with `hash = digestOf({seq, kind, payload, prev})`, `seq` from zero and
  `seq 0` linked to `sha256:` + 64 zeros. The advisory `at` timestamp is host
  metadata and is excluded from the hash.
- **`ledger-snapshot` export** (`snapshotOf`, `verifySnapshot`): `coordination_check`
  with `action:"snapshot"` returns the artifact and refuses a chain that does not
  verify; `scripts/amp-snapshot.mjs` writes the same value to
  `<workspace>/.codex-coordination/ledger-snapshot.json`.
- **Reference conformance** (`scripts/amp-conformance.mjs`): imports
  `attention-manifest-protocol` 0.5.0, compares `canonicalJson`/`digestOf` byte for
  byte, validates every emitted Goal and Plan against `plan.schema.json`, validates
  the snapshot against `ledger-snapshot.schema.json`, and verifies the chain with
  the reference's own `verifySnapshot`.
- **Strict canonical JSON**: RFC 8785-style ordering plus rejection of
  `undefined`, non-finite numbers, `-0`, unpaired surrogates, sparse arrays and
  class instances.
- **Strict input validation**: `requireExactKeys` rejects unknown and missing
  fields; AMP spellings (`commitment_window`, `abandon_if`) are required and
  camelCase is rejected with the field to use instead.

### Changed

- **Goals** are stored as a strict AMP `Goal` artifact plus AMP's `GoalLifecycle`;
  tool results return `goal` (the artifact) beside `lifecycle`, `createdAt`,
  `updatedAt` and `history`.
- **Plans** are strict AMP `Plan` artifacts: `goal` and `abandon_if` are required,
  `edges` are derived, `commitment_window` is 1–5, `budget` defaults to `{}`, and
  `status`/`created` are stamped by the server. Every mutation appends the updated
  artifact.
- **Duties** are explicitly host projections: no `amp`/`kind` fields, recorded in
  the chain as bounded `duty.assigned` / `duty.transitioned` events.
- **Goal transitions** are chained as `event` entries (the artifact does not
  change), **plan mutations** as updated `plan` entries.
- Ledger document version is **2**; chain truncation was removed, because a
  truncated chain cannot verify from genesis.

### Removed

- The 0.1 journal shape (`{seq, at, type, id, data, prev, digest}`) and its
  unprefixed hex digests. A 0.1 ledger is refused with `INVALID_STATE` rather than
  re-chained.

## [0.1.0] — 2026-11-03

First release: a working Codex plugin, not a scaffold.

### Added

- **Local marketplace** (`.agents/plugins/marketplace.json`) listing the plugin,
  so `codex plugin marketplace add <path>` is the whole installation.
- **Plugin manifest** with interface metadata, four skills and one MCP server.
- **MCP server** (`mcp/server.mjs`): stdio, one JSON object per line, JSON-RPC
  2.0, sequential dispatch, protocol negotiation across `2025-06-18`,
  `2025-03-26` and `2024-11-05`, and no third-party dependencies.
- **Ledger store** (`mcp/lib/store.mjs`): one `<workspace>/.codex-coordination/
  ledger.json`, atomic temp-file rename, per-ledger serialisation, and an
  append-only SHA-256 journal that verifies after truncation.
- **Goals** (`mcp/lib/goals.mjs`): AMP Goal objects with mandatory observable
  checks, the five-state lifecycle, and an `achieved` gate over linked plans.
- **Plans** (`mcp/lib/plans.mjs`): up to 12 tasks, dependencies declared on the
  task and edges derived, Kahn cycle detection, predecessor gates, automatic
  draft → committed → executing promotion.
- **Handoffs** (`mcp/lib/collaboration.mjs`): owner/assignee duties, the
  assignee-only and owner-only moves, evidence required on submit and review
  required on verify.
- **Audit** (`mcp/lib/check.mjs`): chain verification plus structural
  violations and warnings, with stable violation codes.
- **Five MCP tools**: `coordination_status`, `coordination_goal`,
  `coordination_plan`, `coordination_handoff`, `coordination_check`.
- **Four skills**: `coordination-goals`, `coordination-planning`,
  `coordination-handoffs`, `coordination-audit` (bilingual body notes).
- **Windows launcher** that resolves Node from `NODE_EXE`, `PATH`, the Codex
  bundled runtime, or the standard install directory.
- **Tooling**: `scripts/validate.mjs` (manifests, skill frontmatter, tool
  references), `scripts/mcp-smoke.mjs` (real stdio handshake, tool calls, a
  tampered-digest check), and 30 `node:test` unit tests.

### Notes

- Identity is declared, not authenticated; the README and `docs/PROTOCOL.md`
  say so where a reader might otherwise assume a security boundary.
- No `achieved`/`done`/`verified` transition runs the corresponding check. The
  tools record assertions and enforce structure only.
