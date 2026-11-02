# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog; the project adheres to Semantic Versioning.

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
