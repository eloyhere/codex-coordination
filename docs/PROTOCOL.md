# Protocol conformance

What this plugin implements of the Attention Manifest Protocol (AMP v0.1, reference
implementation `attention-manifest-protocol` 0.5.0), which invariants are
enforced and where, and what it deliberately does not claim.

This document is written to be checkable. Every claim names a file and, where a
rule is enforced at runtime, a test. A claim that cannot be traced to one is a
bug in this document, not a feature.

## 1. What "conformant" means here

Conformance is claimed at the boundary, in three levels. Every artifact is in
exactly one level, and the level is part of the contract.

| Level | Meaning |
| --- | --- |
| **Wired** | Emitted on a real path (tool call) and returned or chained in the shape the published schema defines. |
| **Host projection** | Derived from plugin state with a stated derivation; it is *not* an AMP artifact kind and never pretends to be one. |
| **Not implemented** | The protocol defines it; this plugin does not claim it, with the reason in §7. |

The plugin does **not** claim to be a complete AMP implementation. It claims that
every AMP object it *does* emit is byte-compatible with the reference and passes
the same checks, and that everything it does not emit is listed in §7.
`scripts/amp-conformance.mjs` measures the first half against the reference; it
is not part of `npm run check`, because the plugin must run from a bare checkout.

## 2. Objects

### 2.1 Goal — wired

| Aspect | Implementation |
| --- | --- |
| Type | `mcp/lib/goals.mjs` `normaliseGoalArtifact` |
| Shape | `{amp, kind:"goal", id, statement, success:[Criterion], value, priority, horizon?, deadline?}` |
| Schema | `docs/schemas/plan.schema.json` (goal branch) of the reference |
| Chain entry | `kind: "goal"`, payload = the artifact, appended once at creation |
| Lifecycle | `goalView()` returns AMP's `GoalLifecycle` (`state`, `startedAt`, `achievedAt`) beside `createdAt`, `updatedAt`, `history` |
| Test | `test/goals.test.mjs`, `test/amp.test.mjs` |

`success` requires at least one criterion and each criterion requires a non-empty
`check`: a goal without one is a wish. Unknown fields are rejected rather than
dropped, so a misspelled field cannot become durable protocol data.

A transition changes no artifact field (AMP keeps lifecycle outside the goal), so
it is recorded as an `event` entry (`{"type":"goal.transitioned","goal","from","to"}`)
instead of rewriting the artifact.

### 2.2 Plan — wired

| Aspect | Implementation |
| --- | --- |
| Type | `mcp/lib/plans.mjs` `normalisePlanArtifact` |
| Shape | `{amp, kind:"plan", id, goal:Ref, process?:Ref, tasks:[PlanTask], edges:[[from,to]], commitment_window, budget, abandon_if:[Criterion], monitor?, rollback?, warrant?:Ref, status, created}` |
| Schema | `docs/schemas/plan.schema.json` (plan branch) |
| Chain entry | `kind: "plan"`, payload = the artifact, appended on every mutation |
| Test | `test/plans.test.mjs` |

`goal` and `abandon_if` are required because AMP requires them. `edges` are
derived from each task's `pre`, so a plan cannot describe two contradictory
graphs; `status` starts at `draft` and `created` is stamped by the server. Those
three fields are rejected as *input* — supplying them would invite a caller to
declare a history it did not go through.

A task carries `{id, intent, actor, ref?, pre, expect:{observation,check},
irreversibility, budget?, status}`. `expect.check` is mandatory: a task whose
result cannot be checked is not a task.

Every plan mutation (status or task) appends the **updated** artifact, because the
artifact itself is what changed. Free-form notes are host metadata in the
returned `history`; the artifact has no field for commentary.

### 2.3 Ledger — wired

| Aspect | Implementation |
| --- | --- |
| Chain | `hash = digestOf({seq, kind, payload, prev})`, genesis `sha256:` + 64 zeros |
| Storage | `<workspace>/.codex-coordination/ledger.json`: a host document (`kind: "coordination-ledger"`) holding the projection and the chain |
| Artifact | `snapshotOf()` returns `{amp, kind:"ledger-snapshot", agent, tip, count, entries}` |
| Verification | `verifySnapshot()` recomputes every hash from its four covered fields, then compares `tip` and `count`; `verifyChain()` adds the document's own `tip`/`count` |
| Emission | `coordination_check` with `action:"snapshot"`; `scripts/amp-snapshot.mjs` writes the same value to disk |
| Test | `test/store.test.mjs`, `test/amp.test.mjs` |

Entry kinds written: `goal`, `plan` and `event`. The other five AMP kinds
(`frame`, `receipt`, `claim`, `hypothesis`, `unknown`) are never written, because
nothing in this host produces them.

`seq` counts from zero and is contiguous. `at` is stored on each entry but is
**not** covered by the hash — it is advisory host metadata, like AMP's
`LogEntry.at` — and is stripped from the emitted snapshot, whose entry objects are
exactly `{seq, kind, payload, prev, hash}`.

The host document is not an AMP artifact and does not claim to be. That is the
same split the DSH plugin makes between its SQLite tables and the artifacts it
emits.

## 3. State machines

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
  assignee, `verify`/`reject`/`cancel` to the owner. A declared `actor` that does
  not match is `PERMISSION`.

## 4. Duty and handoff — host projection

A duty is stored as `{id, role, owner, assignee, responsibilities, acceptance,
reference?, status, summary, evidence, review, createdAt, updatedAt, history}`.
It carries no `amp` and no `kind`: AMP has no `duty` object, and emitting one
would be an invented kind rather than a conformance.

Why not `responsibility-assignment`: that object requires `authority`, `budget`,
`window` (`from`/`to`) and `version`, and a Codex session has no org directory, no
lease and no wall-clock window to declare. A half-filled assignment would be a
more confident lie than a truthful projection.

Duty mutations append `event` entries: `duty.assigned` carries the recorded terms
(role, owner, assignee, responsibilities, acceptance, reference) and
`duty.transitioned` carries the move, the actor, and — on submit/verify/reject —
the recorded summary, evidence and review. The trail therefore survives a
hand-edited projection.

Test: `test/collaboration.test.mjs`.

## 5. Input validation

The tool inputs are not the artifacts, so they are validated before an artifact
exists:

- `requireExactKeys` rejects both missing required fields and unknown fields,
  naming the field. `additionalProperties: false` is a rule here, not a note.
- AMP spellings are the only spellings. `commitmentWindow` / `abandonIf` are
  rejected with the field to use instead; guessing which one won would make the
  record depend on the caller's habit.
- `edges`, `status` and `created` on a plan are computed by the server and
  rejected as input.
- Strings containing an unpaired UTF-16 surrogate are rejected, and `-0` is
  rejected as a number: RFC 8785 cannot encode the first and rewrites the second,
  so a digest over them would not bind the value the caller passed.
- Ids, digests, timestamps, budgets and references each have one validator in
  `mcp/lib/amp.mjs`, shared by every object.

## 6. Identity model

`owner`, `assignee` and `actor` are **declared** strings. The server compares
them to keep a caller from casually advancing someone else's duty, but it cannot
authenticate the caller: it runs as the user, inside one Codex session, and MCP
carries no identity. Recorded identity is evidence of intent, not proof of
authorship. Do not build a security boundary on it.

## 7. Deliberately not implemented

Each row is a gap with a reason, not an accident.

| Protocol surface | Why not |
| --- | --- |
| `manifest` and `signature` | no host/org countersigner, and no key material this plugin should mint on the user's behalf; a self-signed manifest would imply an identity claim nothing verifies |
| `frame` / `attention-request` / `interrupt` | a Codex MCP server sees one tool call at a time and no turn boundary; there is no attention allocation it could observe, so a frame would be invented |
| `receipt` / `usage` | the host owns token and time accounting; the plugin measures nothing, so it records nothing |
| `claim` / `hypothesis` / `unknown` / warrant tiers | no comprehension or evidence pipeline exists in this host; emitting a claim at a chosen tier would be a position dressed as a warrant |
| `responsibility-assignment` / `interaction-binding` / `delegation` / `lease` / `result-contract` | see §4: the required authority, budget, window and signature fields cannot be supplied honestly here |
| `checkpoint` and chain truncation | truncating the chain would make it unverifiable from genesis, and AMP's answer — a signed checkpoint — needs the key material this host does not have. The chain is therefore kept whole. |
| `process` objects | no process authoring surface exists. `plan.process` is accepted as a `Ref` but nothing here creates the process. |
| `attention` budgets beyond the declared `plan.budget` | nothing in this host enforces a token, call, interrupt or money budget; the field records the caller's declaration, not a measurement |
| MCP tool execution, sandbox policy | Codex owns tools and permissions; the server registers read-only tool definitions and never executes a check |
| automatic goal ranking | `plan`/`goal` `priority` is the caller's integer; no inference-based ranking exists |
| process/Elasticsearch/federation/discover | no peer, no index, no network in this plugin |

## 8. Verifying

```bash
node scripts/validate.mjs        # manifests, skill frontmatter, tool references, version agreement
node --test "test/*.test.mjs"    # 47 unit tests, including pinned reference digests
node scripts/mcp-smoke.mjs       # real stdio handshake, five tools, snapshot export, tamper refusal
node scripts/amp-conformance.mjs --amp <attention-manifest-protocol checkout>
node scripts/amp-snapshot.mjs <workspace>
```

`npm run check` runs the first three. `npm run conformance` runs the fourth when
the reference checkout is available.

The conformance script drives a goal, a plan and a full handoff through the real
write path, then checks:

1. `canonicalJson` and `digestOf` are byte-identical to the reference's own
   functions for a set of vectors;
2. every emitted Goal and Plan artifact validates against
   `docs/schemas/plan.schema.json`;
3. the emitted `ledger-snapshot` validates against
   `docs/schemas/ledger-snapshot.schema.json`;
4. the reference's `verifySnapshot` accepts the snapshot, and so does this
   plugin's;
5. every entry is exactly `{seq, kind, payload, prev, hash}` with a contiguous
   `seq` from zero and an AMP digest.

## 9. Upgrading from 0.1

The 0.1 ledger format stored `{seq, at, type, id, data, prev, digest}` entries
and unprefixed hex digests. It is **not** migrated: re-chaining those entries
would compute new hashes over old evidence and destroy the only property the chain
has. A 0.1 file is refused with `INVALID_STATE` naming the version; delete it to
start a new ledger, or keep it as an archive.

## 10. Compatibility

- AMP wire tag `0.1`; reference implementation `attention-manifest-protocol`
  0.5.0 (Apache-2.0).
- MCP protocol revisions accepted: `2025-06-18`, `2025-03-26`, `2024-11-05`; the
  client's requested revision is echoed when supported.
- Transport: stdio, one JSON object per line, JSON-RPC 2.0. Batching is accepted.
- Runtime: Node.js 20+; no package installation, no network access.
