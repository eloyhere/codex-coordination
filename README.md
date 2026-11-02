# codex-coordination

A Codex plugin that keeps a durable coordination ledger beside your repository:
goals with observable success criteria, plans of at most twelve
dependency-checked tasks, handoffs between a declared owner and assignee, and a
SHA-256 chained journal of every change.

It is an MCP server plus four skills. No dependencies, no build step, no
network — Node.js is the only runtime requirement.

```
R:\project\codex-coordination
├─ .agents/plugins/marketplace.json          # local marketplace Codex reads
└─ plugins/codex-coordination/
   ├─ .codex-plugin/plugin.json              # plugin manifest
   ├─ .mcp.json                              # starts the MCP server
   ├─ mcp/server.mjs                         # stdio JSON-RPC, zero dependencies
   ├─ mcp/lib/                               # ledger, goals, plans, handoffs, audit
   ├─ skills/                                # four Codex skills
   └─ scripts/launch-mcp.cmd                 # Windows launcher (finds Node)
```

## Why

Codex sessions are short-lived and parallel. The reasoning that made a task
"done enough" lives in a transcript that the next session does not read, so the
same work is redone, half-finished branches are declared complete, and nothing
records who was supposed to check what.

This plugin writes that reasoning beside the repository in a form both a human
and a model can read: what was promised, which steps were planned, what was
submitted as evidence, and whether the record is still consistent. The ledger is
not a task tracker; it is the *accountable* part of the trail that transcripts
lose.

## Install

Requires Codex CLI 0.166+ and Node.js 20+.

```powershell
codex plugin marketplace add R:\project\codex-coordination
codex plugin add codex-coordination@codex-coordination
```

Then start a new session; the `coordination` MCP server starts on demand. To
check what Codex sees:

```powershell
codex plugin list
```

On macOS or Linux, replace the Windows launcher in
`plugins/codex-coordination/.mcp.json` with a direct Node command:

```json
{"mcpServers": {"coordination": {"command": "node", "args": ["mcp/server.mjs"], "cwd": "."}}}
```

## The five tools

Every call takes `workspace`: the **absolute** path of the repository root. The
server never guesses it, because its own working directory is the installed
plugin.

| Tool | Question it answers |
| --- | --- |
| `coordination_status` | What is agreed, what can start now, who is waiting? |
| `coordination_goal` | What outcome are we committed to, and is it still true? |
| `coordination_plan` | What are the bounded steps, and which one is unblocked? |
| `coordination_handoff` | Who owes what, and has their result been accepted? |
| `coordination_check` | Is the record internally consistent? |

Example — a goal, then a plan, then a handoff:

```json
{"action":"create","workspace":"C:/work/project","goal":{"amp":"0.1","kind":"goal","id":"deterministic-export","statement":"Identical inputs export identical bytes","success":[{"id":"same-bytes","statement":"Two exports match","check":"Export twice and compare sha256"}],"value":0.8,"priority":1}}
```

```json
{"action":"create","workspace":"C:/work/project","plan":{"id":"export-plan","goal":{"kind":"goal","id":"deterministic-export"},"tasks":[{"id":"pin-clock","intent":"Remove wall-clock timestamps from the writer","actor":"self","expect":{"observation":"no Date.now() on the export path","check":"grep and run the export test"}},{"id":"compare","intent":"Compare two exports","actor":"tool","pre":["pin-clock"],"expect":{"observation":"digests match","check":"sha256sum both files"}}]}}
```

```json
{"action":"assign","workspace":"C:/work/project","duty":{"id":"review-digests","role":"qualification","owner":"codex-main","assignee":"codex-sub-1","responsibilities":["Re-run the comparison on a clean checkout"],"acceptance":["The reported digests match the local run"],"plan":"export-plan","task":"compare"}}
```

## The four skills

Codex loads them on demand; each one names the rules the server enforces and the
honesty rules it cannot enforce.

| Skill | Use it when |
| --- | --- |
| `coordination-goals` | An outcome must outlive one reply |
| `coordination-planning` | A goal needs ordered steps |
| `coordination-handoffs` | Work moves between two identities |
| `coordination-audit` | Before claiming completion, or when resuming |

## The ledger

One file per workspace, created on first write:

```
<workspace>/.codex-coordination/ledger.json
```

It holds the materialised records plus an append-only journal where each entry
carries the digest of its predecessor. Commit the directory if you want the
coordination trail in version control; add it to `.gitignore` if you do not.

`docs/PROTOCOL.md` documents the object model, the state machines, the digest
construction, and the deliberate reductions from AMP v0.1.

## What it does not do

This matters more than what it does:

- **It does not run your checks.** `achieved`, `done` and `verified` record that
  you said you ran them. The audit checks structure, never truth.
- **It does not authenticate identity.** `owner`, `assignee` and `actor` are
  declared strings; the split is enforced for consistency, not for security.
- **It does not repair a tampered ledger.** A digest mismatch is reported as
  `LEDGER_CHAIN` and left alone, because silently rewriting the chain would
  destroy the only thing the chain is for.

## Development

```powershell
node scripts/validate.mjs       # manifests, skill frontmatter, tool references
node --test "test/*.test.mjs"   # 30 unit tests
node scripts/mcp-smoke.mjs      # real stdio handshake + tool calls + tamper check
node plugins/codex-coordination/mcp/server.mjs   # run the server by hand
```

`npm run check` runs all three. The `node` on `PATH` must be 20 or newer; the
Windows launcher also accepts `NODE_EXE` and falls back to the Node runtime
bundled with the Codex desktop app.

Layout:

| Path | Role |
| --- | --- |
| `plugins/codex-coordination/mcp/lib/amp.mjs` | ids, canonical JSON, digests, typed errors |
| `plugins/codex-coordination/mcp/lib/store.mjs` | atomic ledger transactions, journal chain |
| `plugins/codex-coordination/mcp/lib/goals.mjs` | goal validation and lifecycle |
| `plugins/codex-coordination/mcp/lib/plans.mjs` | task graph, dependency gates |
| `plugins/codex-coordination/mcp/lib/collaboration.mjs` | duties and handoffs |
| `plugins/codex-coordination/mcp/lib/check.mjs` | structural audit |
| `plugins/codex-coordination/mcp/lib/tools.mjs` | the five tool definitions |
| `scripts/validate.mjs` | package consistency |
| `scripts/mcp-smoke.mjs` | wire-level smoke test |
| `test/` | unit tests for the ledger and its gates |

## Compatibility

- Codex CLI 0.166+ (plugin manifest, local marketplaces, MCP over stdio).
- MCP protocol revisions `2025-06-18`, `2025-03-26`, `2024-11-05`.
- Node.js 20+; Windows launcher included, macOS/Linux uses `node` directly.

Verified on Windows 11 with Codex CLI `0.166.0-alpha.5.1`: the marketplace is
accepted by `codex plugin marketplace add`, the plugin installs by name, and
`codex mcp list` shows the `coordination` server enabled with the launcher
command, working directory and forwarded environment.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
