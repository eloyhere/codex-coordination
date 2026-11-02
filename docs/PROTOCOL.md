# Protocol conformance

What this plugin implements of the Attention Manifest Protocol (AMP v0.1), what
it deliberately reduces, and how to verify the parts that are enforced.

The reference implementation for the DSH harness lives in the
`deepseek-coordination` plugin and the `attention-manifest-protocol` package.
This project borrows the object model, not the code: it is a dependency-free
Node program that Codex starts as an MCP server.

## 1. Objects implemented

| AMP concept | Here | Notes |
| --- | --- | --- |
| Goal | `goals.mjs` | `statement`, `success[]` with mandatory `check`, `value ∈ [0,1]`, `priority`, optional `horizon`/`deadline` |
| Plan | `plans.mjs` | ≤ 12 tasks, dependencies on the task (`pre`), derived edges, acyclic by construction |
| Task | `plans.mjs` | `intent`, `actor`, `expect{observation,check}`, `irreversibility 0-3`, optional `budget` |
| Duty / assignment | `collaboration.mjs` | owner + assignee, responsibilities, acceptance criteria, optional goal/plan/task reference |
| Handoff | `collaboration.mjs` | submit (summary + evidence) → verify/reject (owner review) |
| Ledger | `store.mjs` | projection + append-only SHA-256 chained journal |
| Checkpoint | — | not implemented; the head digest is published on every status/check call |
| Manifest, Frame, Envelope, Warrant, Receipt | — | not implemented; a Codex session has no signing key and no turn bus to observe |

## 2. State machines

Every transition is table-driven, and the tables are exported so a test can
assert them rather than duplicate them.

```
goal:   proposed -> committed | abandoned
        committed -> active | abandoned
        active -> achieved | abandoned
        achieved, abandoned -> (terminal)

plan:   draft -> committed | abandoned
        committed -> executing | abandoned
        executing -> done | abandoned
        done, abandoned -> (terminal)

task:   pending -> running | done | skipped
        running -> done | failed | skipped
        failed -> running | skipped
        done, skipped -> (terminal)

duty:   assigned -> accepted | cancelled
        accepted -> started | cancelled
        started -> submitted | cancelled
        submitted -> verified | rejected | cancelled
        rejected -> accepted | cancelled
        verified, cancelled -> (terminal)
```

Additional gates, each enforced at the mutation site:

- `goal.achieved` requires every linked plan to be `done` or `abandoned`.
- A task may enter `running` or `done` only when every predecessor is `done`.
- A task cannot move while its plan is a `draft`; starting the first task of a
  `committed` plan promotes the plan to `executing` in the same transaction.
- `plan.done` requires every task to be `done`, `failed` or `skipped`.
- `duty.submit` requires a non-empty `summary` and 1–32 `evidence` entries.
- `duty.verify` requires the submitted evidence and a non-empty owner `review`.
- `duty` moves are split by side: `accept`/`start`/`submit` belong to the
  assignee, `verify`/`reject`/`cancel` to the owner. A declared `actor` that
  does not match is `PERMISSION`.

## 3. Ledger file

```jsonc
{
  "amp": "0.1",
  "kind": "coordination-ledger",
  "version": 1,
  "workspace": "C:/work/project",
  "createdAt": "...",
  "updatedAt": "...",
  "seq": 17,              // absolute count of journal entries ever appended
  "head": "<sha256>",     // digest of the newest retained entry
  "journalBase": null,    // digest of the newest dropped entry, when truncated
  "journalDropped": 0,
  "goals": { "<id>": { ... } },
  "plans": { "<id>": { ... } },
  "duties": { "<id>": { ... } },
  "journal": [
    { "seq": 1, "at": "...", "type": "goal/created", "id": "ship-v1",
      "data": { ... }, "prev": null, "digest": "<sha256>" }
  ]
}
```

Each entry's digest is `sha256(prev ?? "" + "\u0000" + canonicalJson(body))`,
where `body` is the entry without its own `prev`/`digest` fields and canonical
JSON sorts object keys and drops `undefined`. Because `prev` is stored on the
entry itself, the retained window verifies even after truncation: the first
retained entry is checked against `journalBase`.

The journal retains at most 2000 entries; older ones are dropped first and
counted in `journalDropped`. Nothing else is ever dropped, so the projection is
complete even when the journal window is not.

## 4. Identity model

`owner`, `assignee` and `actor` are **declared** strings. The server compares
them to keep a caller from casually advancing someone else's duty, but it cannot
authenticate the caller: it runs as the user, inside one Codex session, and MCP
carries no identity. Recorded identity is evidence of intent, not proof of
authorship. Do not build a security boundary on it.

## 5. What the tools cannot do

- They cannot run a success criterion, an acceptance check, or a task's
  `expect.check`. `achieved`, `done` and `verified` record that the caller says
  it ran them.
- They cannot validate evidence. An evidence string is a locator plus an
  observation; nothing dereferences it.
- They cannot repair a broken chain. A digest mismatch means the file was
  edited outside the tools; the audit reports it and leaves it alone.

## 6. Verifying

```bash
node scripts/validate.mjs      # manifests, skill frontmatter, tool references
node --test "test/*.test.mjs"  # 30 unit tests over the ledger and its gates
node scripts/mcp-smoke.mjs     # real stdio handshake, tool calls, tamper check
```

The smoke script starts the server exactly as Codex does, negotiates
`2025-06-18`, lists the five tools, calls `status`, `goal` and `check`, edits one
journal digest on disk, and asserts the next `check` reports `LEDGER_CHAIN`.

## 7. Compatibility

- Protocol revisions accepted: `2025-06-18`, `2025-03-26`, `2024-11-05`; the
  client's requested revision is echoed when supported.
- Transport: stdio, one JSON object per line, JSON-RPC 2.0. Batching is accepted.
- Runtime: Node.js 20+; no package installation, no network access.
