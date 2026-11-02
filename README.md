# codex-coordination

A Codex plugin that keeps a durable **Attention Manifest Protocol** ledger beside
your repository: strict AMP `Goal` and `Plan` artifacts, accountable handoffs
between a declared owner and assignee, and an append-only chain that exports a
verifiable `ledger-snapshot`.

It is an MCP server plus four skills. No dependencies, no build step, no network —
Node.js is the only runtime requirement. **English** · [简体中文](README.zh-CN.md)

```
R:\project\codex-coordination
├─ .agents/plugins/marketplace.json          # local marketplace Codex reads
└─ plugins/codex-coordination/
   ├─ .codex-plugin/plugin.json              # plugin manifest
   ├─ .mcp.json                              # starts the MCP server
   ├─ mcp/server.mjs                         # stdio JSON-RPC, zero dependencies
   ├─ mcp/lib/                               # AMP primitives, chain, goals, plans, duties, audit
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
lose — in the protocol's own object shapes, so another AMP reader can check it.

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
codex mcp list          # shows the coordination server as installed, enabled
```

Codex treats MCP tool calls as approval-gated. In an interactive session it asks
once; a session whose approval policy is `never` (for example a non-interactive
`codex exec`) refuses them with "MCP tool call requires approval, but approval
policy is never". Approve the tools, or run that session with
`--dangerously-bypass-approvals-and-sandbox` when the target directory is
expendable.

On macOS or Linux, replace the Windows launcher in
`plugins/codex-coordination/.mcp.json` with a direct Node command:

```json
{"mcpServers": {"coordination": {"command": "node", "args": ["mcp/server.mjs"], "cwd": "."}}}
```

## Strict AMP v0.1

The artifacts are the published schemas' objects, not lookalikes. Protocol
reference: `attention-manifest-protocol` 0.5.0, wire tag `0.1`.

| What | Emitted as | Chain entry |
| --- | --- | --- |
| Outcome | AMP `Goal` (`docs/schemas/plan.schema.json`, goal branch) | `kind:"goal"` at creation |
| Steps | AMP `Plan` (plan branch), with `goal`, derived `edges`, `commitment_window`, `budget`, `abandon_if`, `status`, `created` | `kind:"plan"` on every mutation |
| Ledger | AMP `ledger-snapshot` — `{amp, kind, agent, tip, count, entries}` | the chain itself |
| Handoff | host projection (no AMP kind), recorded as bounded `event` entries | `kind:"event"` |

Every entry is `{seq, kind, payload, prev, hash}` where
`hash = sha256(canonicalJson({seq, kind, payload, prev}))`, `seq` counts from
zero, and `seq 0` links to `sha256:` plus 64 zeros. Canonical JSON sorts keys,
keeps arrays in order, and rejects `undefined`, non-finite numbers, `-0` and
unpaired surrogates instead of letting `JSON.stringify` rewrite them.

A duty is deliberately **not** an AMP artifact: `responsibility-assignment`
requires an authority list, budget and time window this host cannot honestly
supply, so the plugin records a truthful projection and puts its terms in the
chain as events. `docs/PROTOCOL.md` lists every such decision.

## The five tools

Every call takes `workspace`: the **absolute** path of the repository root. The
server never guesses it, because its own working directory is the installed
plugin.

| Tool | Question it answers | Result |
| --- | --- | --- |
| `coordination_status` | What is agreed, what can start now, who is waiting? | summaries + `ledger.tip` |
| `coordination_goal` | What outcome are we committed to, and is it still true? | `goal` artifact + `lifecycle` |
| `coordination_plan` | What are the bounded steps, and which one is unblocked? | `plan` artifact + `progress` |
| `coordination_handoff` | Who owes what, and has their result been accepted? | `duty` projection |
| `coordination_check` | Is the record consistent? Emit the snapshot. | `audit` or `ledger-snapshot` |

Example — a goal, then a plan, then a handoff:

```json
{"action":"create","workspace":"C:/work/project","goal":{"amp":"0.1","kind":"goal","id":"deterministic-export","statement":"Identical inputs export identical bytes","success":[{"id":"same-bytes","statement":"Two exports match","check":"Export twice and compare sha256"}],"value":0.8,"priority":1}}
```

```json
{"action":"create","workspace":"C:/work/project","plan":{"amp":"0.1","kind":"plan","id":"export-plan","goal":{"kind":"goal","id":"deterministic-export"},"commitment_window":2,"budget":{},"abandon_if":[{"id":"network-clock","statement":"The writer needs a network clock","check":"Read the writer"}],"tasks":[{"id":"pin-clock","intent":"Remove wall-clock timestamps from the writer","actor":"self","expect":{"observation":"no Date.now() on the export path","check":"grep and run the export test"}},{"id":"compare","intent":"Compare two exports","actor":"tool","pre":["pin-clock"],"expect":{"observation":"digests match","check":"sha256sum both files"}}]}}
```

```json
{"action":"assign","workspace":"C:/work/project","duty":{"id":"review-digests","role":"qualification","owner":"codex-main","assignee":"codex-sub-1","responsibilities":["Re-run the comparison on a clean checkout"],"acceptance":["The reported digests match the local run"],"plan":"export-plan","task":"compare"}}
```

`goal`, `abandon_if` and `commitment_window` use the AMP spellings; the camelCase
forms are rejected with the field to use instead, and `edges`/`status`/`created`
are computed by the server.

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

One host document per workspace, created on first write:

```
<workspace>/.codex-coordination/ledger.json
```

It holds the materialised projection plus the chain. The chain entry carries a
host-only `at` timestamp that is **not** covered by the hash; the exported
snapshot strips it, so its entries are exactly AMP `ChainEntry` values. Commit the
directory if you want the coordination trail in version control; add it to
`.gitignore` if you do not.

`docs/PROTOCOL.md` documents the object model, the state machines, the digest
construction, and the deliberate omissions from AMP v0.1.

## Verify it

```powershell
node scripts/validate.mjs        # manifests, skills, tool references, version agreement
node --test "test/*.test.mjs"    # 47 unit tests, including pinned reference digests
node scripts/mcp-smoke.mjs       # real stdio handshake, snapshot export, tamper refusal
node scripts/amp-conformance.mjs --amp R:\project\attention-manifest-protocol
node scripts/amp-snapshot.mjs C:\work\project
```

`npm run check` runs the first three. The conformance script needs a checkout of
the reference implementation and proves, by importing it, that:

- `canonicalJson` and `digestOf` are byte-identical;
- every emitted Goal and Plan artifact validates against `plan.schema.json`;
- the emitted `ledger-snapshot` validates against `ledger-snapshot.schema.json`;
- the reference's own `verifySnapshot` accepts the snapshot.

## What it does not do

This matters more than what it does:

- **It does not run your checks.** `achieved`, `done` and `verified` record that
  you said you ran them. The audit checks structure, never truth.
- **It does not authenticate identity.** `owner`, `assignee` and `actor` are
  declared strings; the split is enforced for consistency, not for security.
- **It does not repair a tampered ledger.** A hash mismatch is reported as
  `LEDGER_CHAIN` and left alone, because silently rewriting the chain would
  destroy the only thing the chain is for.
- **It never truncates the chain.** A truncated chain cannot verify from genesis;
  AMP's answer is a signed checkpoint, which this host has no key for.
- **It does not migrate 0.1 ledgers.** Re-chaining old entries would recompute
  hashes over old evidence. A 0.1 file is refused with its version named.

## Development

```powershell
node scripts/validate.mjs       # manifests, skill frontmatter, tool references
node --test "test/*.test.mjs"   # 47 unit tests
node scripts/mcp-smoke.mjs      # real stdio handshake + tool calls + tamper check
node plugins/codex-coordination/mcp/server.mjs   # run the server by hand
```

`npm run check` runs the first three. The `node` on `PATH` must be 20 or newer;
the Windows launcher also accepts `NODE_EXE` and falls back to the Node runtime
bundled with the Codex desktop app.

Layout:

| Path | Role |
| --- | --- |
| `plugins/codex-coordination/mcp/lib/amp.mjs` | ids, canonical JSON, digests, chain hash, shared validators |
| `plugins/codex-coordination/mcp/lib/store.mjs` | atomic ledger transactions, AMP chain, `ledger-snapshot` export |
| `plugins/codex-coordination/mcp/lib/goals.mjs` | Goal artifact and lifecycle |
| `plugins/codex-coordination/mcp/lib/plans.mjs` | Plan artifact, task graph, dependency gates |
| `plugins/codex-coordination/mcp/lib/collaboration.mjs` | duties and handoffs (host projection) |
| `plugins/codex-coordination/mcp/lib/check.mjs` | structural audit |
| `plugins/codex-coordination/mcp/lib/tools.mjs` | the five tool definitions |
| `scripts/validate.mjs` | package consistency |
| `scripts/mcp-smoke.mjs` | wire-level smoke test |
| `scripts/amp-snapshot.mjs` | write the verified `ledger-snapshot` |
| `scripts/amp-conformance.mjs` | reference-implementation and schema conformance |
| `test/` | unit tests for the chain, the artifacts and their gates |

## Compatibility

- Codex CLI 0.166+ (plugin manifest, local marketplaces, MCP over stdio).
- AMP wire tag `0.1`; reference implementation `attention-manifest-protocol` 0.5.0.
- MCP protocol revisions `2025-06-18`, `2025-03-26`, `2024-11-05`.
- Node.js 20+; Windows launcher included, macOS/Linux uses `node` directly.

Verified on Windows 11 with Codex CLI `0.166.0-alpha.5.1`: the marketplace is
accepted by `codex plugin marketplace add`, the plugin installs by name, and
`codex mcp list` shows the `coordination` server enabled with the launcher
command, working directory and forwarded environment. The AMP artifacts are
verified against `attention-manifest-protocol` 0.5.0 by
`scripts/amp-conformance.mjs`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
