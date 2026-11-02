# Changelog

All notable changes to this project are documented here. The format follows
Keep a Changelog; the project adheres to Semantic Versioning.

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
