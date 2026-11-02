# codex-coordination (plugin)

The installable half of the project. Codex reads `.codex-plugin/plugin.json`,
loads the four skills from `skills/`, and starts `mcp/server.mjs` through
`.mcp.json` → `scripts/launch-mcp.cmd`.

## Run it by hand

```powershell
node mcp/server.mjs
```

It speaks newline-delimited JSON-RPC on stdin/stdout. Set
`CODEX_COORDINATION_DEBUG=1` to see diagnostics on stderr (stdout must stay
clean — it is the wire).

## Configuration

| Variable | Meaning |
| --- | --- |
| `CODEX_COORDINATION_WORKSPACE` | Default workspace when a tool call omits `workspace` |
| `CODEX_COORDINATION_DEBUG` | Emit diagnostics on stderr |
| `NODE_EXE` | Node binary the Windows launcher should use |

`workspace` is otherwise **required** on every tool call. The server's own
working directory is this plugin directory, so it never guesses.

## Ledger

Each workspace it is pointed at gets one host document:
`<workspace>/.codex-coordination/ledger.json` — the materialised goals, plans and
duties plus an append-only AMP chain (`{seq, kind, payload, prev, hash}`). The
strict AMP artifact is derived: `coordination_check` with `action:"snapshot"`
returns the `ledger-snapshot`, and `node scripts/amp-snapshot.mjs <workspace>`
writes it to disk.

## Docs

The project README covers installation, the five tools, the four skills, the AMP
conformance table and the honesty limits; `docs/PROTOCOL.md` covers the object
model, the chain construction, the state machines and the deliberate omissions.
