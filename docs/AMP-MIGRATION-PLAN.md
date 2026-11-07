# Long-running AMP migration

Status: active. Standard blueprint: `R:/project/attention-manifest-protocol`.
Preserve existing data and snackbar/dialog notification behavior throughout.

## Completion criteria

- Every upstream agent verb has a tested executable binding or a documented,
  concrete missing host capability; no placeholder execution tools.
- Existing records remain readable, with explicit, transactional, repeatable
  conversion where semantics can be preserved. No inferred verification or
  automatic acceptance of old goals/tasks.
- Primary execution and persistence use the current protocol. Any remaining
  legacy dependency has a documented consumer and compatibility justification.
- Discovery lists actual bindings and reports unavailable providers accurately.
- Authorization, scope, CAS, idempotency and audit survive restart and failure.
- Build, typecheck, behavioral regressions, MCP and package smoke pass.
- Notification source and behavior are preserved.

## Work sequence

1. Inventory all upstream modules/verbs against real host bindings and map every
   `amp-legacy` consumer. Record source version and supported contracts.
2. Consolidate native Store opening, workspace scope, stable request digests,
   durable audit and idempotency across project and submissions.
3. Migrate workflow domain: session/intent/mission/goal/plan/task/action facts,
   draft proposal consumption and ready-task queries. Define old-to-new mappings
   before writing any migrated facts; retain original records and references.
4. Migrate filesystem/outline/discovery ports to current native implementations;
   retain path boundaries, file CAS and byte/line fidelity.
5. Migrate evidence/receipts/verification, budgets, cooperation, attention and
   execution ports. Keep host decisions independent from model submissions.
6. Connect supported Codex host ports; document specifically unavailable private
   lifecycle APIs. Do not emulate Codex session/turn state as if it were native.
7. Replace compatibility imports by domain, update catalogs and skills, verify
   existing data, packaging and notification behavior; remove unused legacy code.

## Starting checkpoint

- AMP 0.7.2 primary dependency, 0.6.3 explicit legacy alias.
- 35 canonical verbs bound; 140 total plugin tools.
- Project: six native verbs, transactional command replay, CAS, restart tests.
- Four submission verbs: durable pending-host-review records, not approvals.
- Remaining read aliases still use existing host ports and old aggregate shapes.
- Latest verified: 103 tests, 414 MCP checks, package smoke, typecheck.
- Shared native storage boundary and stable request format implemented, with
  backward-compatible old submission retries. Machine-readable coverage is in
  `AMP-MIGRATION-INVENTORY.json`: 14 standard verbs remain unbound.
- Project now uses native entity persistence and one-time, verified transactional
  conversion of older command-only journals; routine reads do not replay commands.
- Verified legacy ledger preview/import/status now persists isolated native
  workflow snapshots with original ledger preservation. Imported work is suspended
  and unverified. Native scoped workflow reads and independently approved limited
  nonterminal transitions now work. Native drafts, old plan submission consumption,
  independent plan admission and task readiness now work. Action execution,
  verification and old-writer cutover remain outstanding.

Each checkpoint must update `AMP-07-MIGRATION.md` with implemented behavior,
validation and remaining limits. Keep the long-running goal active until the
completion criteria are met; report material progress and real blockers.

## Project persistence clarification

Codex synchronization records and AMP native state share each actual project's
`.codex-coordination/amp-07/store.sqlite`; no global shared synchronization store
is used. Same thread and turn IDs in two projects remain isolated. Existing
ignore rules are preserved. See `CODEX-SYNC.md` for the synchronization contract
and outstanding host integration limits.
