# AMP 0.7 integration status

The primary dependency is AMP 0.7.2. Existing executable host adapters use the
explicit `amp-legacy` npm alias pinned to 0.6.3. The 0.7 API removed the database,
control and other entrypoints these adapters consume; replacing their imports
without migrating behavior would break existing durable workspaces.

The new `attention_manifest_protocol_discover` uses the native 0.7 AgentGateway,
host-owned connection identity, parameter-smuggling checks and native ranking.
Its default provider indexes the executable plugin tool contracts. The new
`attention_manifest_protocol_surface` exposes the upstream module tier table as
read-only migration metadata. Neither tool grants authority to execute canonical
verbs. The plugin currently exposes 140 tools.

Thirty-five canonical verbs now have bindings: 32 native domain verbs,
3 durable review submissions and no canonical compatibility aliases. Native domains include
project, scoped workflow queries and plan draft creation. Remaining ports and
unbound verbs are recorded in `AMP-MIGRATION-INVENTORY.json`.
Discovery's AMP source includes only bound canonical contracts.

Submissions use the native 0.7 Store at
`.codex-coordination/amp-07/store.sqlite`, with transactions, durable idempotency
keys scoped to the local principal/workspace, and successful/failed gateway-call
audit events. The `attention_manifest_protocol_submissions` tool reads the
pending review queue. Submitting a proposal does not imply host approval,
verified evidence, goal achievement or an attention residency change.

## Step 1: native project domain

Project rules and environment writes use the 0.7 `Project` and upstream
`createProjectToolHandlers`, rather than compatibility aliases or pending
submissions. Native CAS rules are preserved. Commands, idempotency responses and
gateway audit outcomes are durable in the workspace's 0.7 Store. Each call
reconstructs native state in journal order inside a writer transaction; original
timestamps are preserved, so rule hashes/versions remain stable after restart.
Failed writes roll back without adding a project command. Metadata is the native
project metadata collection, not a substitute for the filesystem scan.

The native project configuration is distinct from legacy host runtime settings:
environment declarations do not change process variables, install dependencies,
or automatically import old runtime configuration.

Validation covers restart replay, version conflicts, retry deduplication, reused
key conflicts, rule updates, spoofed binding fields and workspace isolation.

Still using compatibility ports: existing ledger and runtime aggregate storage.
These are not silently converted to incompatible 0.7 workflow entities. Session,
turn and lease lifecycle verbs require real Codex host lifecycle ports, which
this stdio plugin does not have. Session file/outline, conversation and network
discovery providers remain unavailable. The old tools continue to expose their
existing concrete capabilities. All notification source files remain unchanged.

The copied vendor sources retain their upstream hashes. The coordination bundle
resolves their original AMP imports to the legacy namespace at build time,
sharing the same legacy module instances as the host.

## Step 2: shared storage boundary and auditable coverage

Native project and submission adapters now share one workspace Store opener.
Existing directory/database links must resolve inside the selected workspace.
Requests use stable key ordering; older submission request strings remain
retryable by comparing parsed meaning without modifying historical events.

`npm run inventory:migration` regenerates `AMP-MIGRATION-INVENTORY.json` from
the built executable tool registry and the installed protocol's surface. The
current 49 standard verbs comprise 6 native, 4 durable submissions, 9 compatibility
ports and 30 unbound verbs. It also identifies 24 source/script/test files with
explicit legacy imports. This is coverage evidence, not a completion claim.

Verified against 0.7.2: typecheck, server build, 92 behavioral tests, plugin
validation and packaged MCP smoke (374 checks). Notification source is unchanged.

## Step 3: native project entity persistence

The project adapter now uses upstream `bindProject` to restore and flush native
`project_rule`, `project_environment`, metadata and view rows. Routine reads no
longer replay commands. Native writes and the existing idempotency journal are
committed in the same Store transaction.

An older command-only project is upgraded once on first access: replay original
timestamps, verify every recorded result against native output, flush native
entities and append a migration marker atomically. Historical commands remain
unchanged. Invalid replay results or ambiguous mixed native/journal state fail
without committing converted facts. Invalid native rehydration reports are
surfaced instead of silently dropping records. Repeated migration is a no-op.

Verified: 94 behavioral tests, typecheck, server build, plugin validation and
package smoke (374 checks). Tests specifically prove old hash/version/timestamp
and retry preservation, single migration, and rollback of inconsistent journals.
Workflow goal/plan/task conversion remains outstanding: old success assertions
must not be treated as independently verified native acceptance.

## Step 4: verified legacy workflow import

`attention_manifest_protocol_migration` provides preview/import/status. Preview
audits the complete old ledger and validates the proposed native workflow
snapshot. Import requires that preview's SHA-256 source digest; changed or damaged
sources are refused. A single native Store transaction writes workflow entities,
their native persistence audit facts and the full original ledger text. The
source file is never modified, and retrying a source digest does not duplicate it.

Goals, plans, task dependencies and acceptance checks are mapped to namespaced
native references. Original duties, statuses, artifacts, history and chain remain
in the archived source. These are import snapshots, not a live replacement for
the old writable ledger: changed sources import as distinct isolated snapshots.

Each snapshot has an explicitly administrative, suspended AMP session, not a
Codex session. Imported goals are proposed/verification_pending, plans draft and
tasks pending even when old assertions claimed completion. Parent intent/mission
records identify imported context; native audit events explicitly identify import
normalization rather than historical execution. Bounds are expired review
placeholders, not permission to retry old work. No attempts or verification are
invented. Independent host review is still required before activation/cutover.

Tests prove repeated import, changed-source rejection, multiple snapshot isolation,
native restore, source-byte preservation, DAG links, refusal of damaged chains
and refusal to promote old goal achievement into native verification. Current
full regression passed 95 tests; two additional focused migration cases passed.
Typecheck, plugin validation and package smoke (376 checks) passed.

## Step 5: scoped native workflow reads

Canonical goal/plan get/list now read native persisted workflow facts instead of
forwarding to the old coordination ledger. Native mission get, intent get/list,
task get/list_ready, action get/list and plan ready_tasks are also registered.
The old `coordination_*` tools remain available for legacy ledger operations.

`attention_manifest_protocol_workflow_scope` lists/selects verified import
snapshots by source digest. Selection belongs to one MCP connection and workspace;
it is not persisted as a global default and must be repeated after restart.
Gateway session identity comes from that selection, never model-supplied identity.
Reads reject cross-snapshot entity IDs and invalid native restoration reports.
Selected imported sessions remain suspended. Ready queries additionally check
session state, task readiness, plan state and dependency completion, and always
report that execution authority was not granted. Workflow calls and scope changes
are durably audited.

Coverage: 18 native verbs, 4 durable submissions, 5 compatibility ports and 22
unbound verbs. Verified: typecheck, server build, 98 behavioral tests, plugin
validation and package smoke (394 checks), including scope isolation, spoofed
identity rejection, connection restart and no ready work from suspended imports.

## Step 6: independently approved native transitions

`attention_manifest_protocol_workflow_review` requests one exact nonterminal
transition through the existing correlated MCP host elicitation port. It is a
host-mediated control, not a canonical model-owned lifecycle verb. It supports
session resume/idle/suspend and limited intent/mission/goal review states, always
inside the selected plugin workflow. It does not control Codex chat lifecycle,
approve plans, start actions, accept evidence or declare business success.

Commands are validated before asking the host. The Store transaction is opened
after the independent response, never held while waiting for it. Workspace,
scope, complete workflow head and native expectedVersion must still match before
commit. Denial/unavailable approval does not change the workflow. Decisions and
idempotency results are durable; a committed retry never asks for approval again.
Model-supplied approval flags and identity fields are rejected.

Plan review still requires fresh bounds and an independent plan approval port;
old expired import bounds are not silently replaced. The legacy writer remains
available until the full native proposal/verification/execution path is ready.

Verified: 99 behavioral tests, typecheck, server build, plugin validation and
package smoke (396 checks). Focused tests cover unavailable approval, correlated
response enforcement, idempotent approval replay, stale version rejection,
unavailable success transitions, concurrent state changes during approval and
workspace switching during approval. Notification source is unchanged.

## Step 7: native plan proposals and independent admission

`plan.propose_draft` now creates a native draft and pending task DAG under an
active goal in the selected active workflow. Typed proposals carry future bounds,
task acceptance contracts and required effects. Dependencies are topologically
ordered. Cycles, duplicates, missing dependencies, invalid bounds and native
admission failures roll back the complete draft. Retry keys are durable.

Old pending plan submissions can be consumed once by submissionId, with principal
checks and target resolution through the selected import's reference mapping.
Original records remain unchanged; submission listings derive their
materialized_native_draft status and plan ID from the consumption journal.
Incomplete old proposals are rejected, not silently repaired.

Host review now supports plan approval/executing/paused and task
proposed/ready/blocked transitions. Operational admission checks active goal,
nonempty DAG and future bounds before and after independent host approval;
native guards enforce dependency readiness and version checks. Pausing/blocking
does not require unexpired bounds. No action starts or success assertions follow
from these commands.

Verified: 100 behavioral tests, typecheck, server build, plugin validation and
package smoke (396 checks). Action execution, verification and legacy writer
cutover remain outstanding. Notification source is unchanged.

## Step 8: native read execution and issued receipts

Execution find/inspect now use native LcpService and ManifestStore instead of the
old context lookup. Contracts are pinned by tool/schema/description digest.
`execution.run` builds full handles and identity on the host from those pins;
callers submit typed JSON, not code or identity envelopes. The current catalog
contains concrete native/project/workflow and bounded workspace read contracts.
Write contracts are explicitly withheld until workflow Action/attempt fencing is
connected; this is not full side-effect execution coverage.

Native Executor applies policy and persistent workspace/principal budgets through
the upstream BudgetLedger binding. Reservation changes rehydrate current facts
inside writer transactions. Host-fixed quota is 1000 calls, 64 MiB, one hour of
measured duration and 8 concurrent children; this does not meter Codex tokens.
Reservation/settlement enforces accounting limits, not operating-system process
cancellation. Native measured failures/unknown outcomes remain explicit.

Runs claim a durable retry key before dispatch and journal invocations. Completed
retries return stored results after restart. Unfinished starts block automatic
retry until independent reconciliation. Actual observations produce immutable
issued native ReceiptCore records, explicitly without business verification.
No task/goal success transition is performed.

`execution.read_handle` pages connection/workspace-owned result handles with a
five-minute TTL. Handles are intentionally ephemeral; stored execution replay
still includes inline results after restart. `budget.remaining` reports durable
native read quota without resetting it on reconnection.

Verified: 101 behavioral tests, typecheck, server build, plugin validation and
package smoke (402 checks). Coverage: 24 native, 3 durable submissions,
3 compatibility ports and 19 unbound standard verbs. Source notification code
is unchanged. Remaining work includes side-effect Action/attempt execution,
independent business evidence verification and legacy writer cutover.

## Step 9: native evidence and independent host verification

Evidence get/list/cite now restore the upstream EvidenceLedger binding. Citation
rejects non-consumable or environment-stale evidence. Native read execution can
also find and invoke these query contracts.

evidence_review verifies the execution-fact digest of a stored successful native
receipt, then requests independent MCP host confirmation of one explicit
versioned claim against the complete receipt. No approval means no verification
or evidence fact. Approved confirmation is attributed to
independent-mcp-host-confirmation, not an automated test or model-provided truth.
Native verification and evidence rows commit with durable retry results. Review
requests and host decisions are journaled. Tasks/goals are not completed.

New receipts anchor the host-computed native project/workflow fact snapshot.
The anchor and refreshed receipt facts must still match at verification commit;
citations also reject stale anchors. Older receipts without anchors are not
promoted. File tool freshness anchors remain unimplemented, so business review
currently refuses their receipts. Local digest checking is not a signature claim.

Verified: 102 tests, typecheck, server build, validation and package smoke (410
checks). Tests cover unavailable approval, explicit confirmation, replay, restart,
workspace isolation, state drift during approval and corrupted receipts. Coverage
is 27 native, 3 submissions, 3 compatibility ports and 16 unbound standard verbs.
Side-effect Action execution, acceptance consumption, file freshness and legacy
writer cutover remain open. Notification source is unchanged.

## Step 10: native scoped filesystem reads and previews

Workspace list/read/outline no longer forward to old coordination handlers.
Native document_outline and diff are now registered as well. The host supplies
its existing selected root and exact exclusions to a bounded Node storage port;
the native Workspace/WorkspaceFile and built-in language/document parsers perform
the protocol operations. The old standard-alias module has been removed. Legacy
coordination/runtime tools still exist and still consume amp-legacy: zero
canonical aliases does not mean the legacy dependency has been removed.

The port refuses absolute/UNC/ADS/traversal paths, ambiguous Windows aliases,
symlinks/junctions and excluded subtrees. It checks real paths, opened file
identity, byte bounds and before/after raw hashes. Files are capped at 16 MiB;
text replies at 256 KiB, outlines at 500 nodes, and directory walks at depth 4 /
500 entries. Text reads expose normalized UTF-8 byte or 1-based line windows;
native charset facts preserve source encoding/BOM/EOL without modifying disk.
Binary documents stay bytes. diff applies a hypothetical buffer in native memory
and verifies expectedHash, without flushing any disk changes.

Tests prove BOM/CRLF and UTF-16 reads, UTF-8 codepoint-boundary rejection, large
file/line bounds, traversal/ADS/symlink/exclusion refusal, outline and diff behavior,
and binary ZIP document parsing with unchanged source bytes. Full regression:
103 tests, typecheck/server build, validation and package smoke (414 checks).
Coverage: 32 native, 3 submissions, 0 aliases and 14 unbound standard verbs.
File-write/CAS/lease fencing and file receipt freshness remain outstanding.

## Checkpoint 11: file evidence freshness and project-local Codex bridge

File read/outline/document-outline receipts now pin raw bytes and the native
environment. Evidence review and citation reject changed files, policy changes
and environment drift, including changes during approval. File writes remain
unbound pending real action/attempt fencing.

The packaged Codex bridge observes eleven host hook event types using real
session/turn identifiers. An on-demand `attention_manifest_protocol_codex_sync`
tool exposes observations and goal pull/push. Goal pushes use automatic origin
and a Codex-wins digest preflight; the host lacks atomic goal CAS. Read-only goal
database fallback never writes Codex's source database. Intermediate assistant
messages and complete event streaming still require a working host connection;
native AMP workflow entity mapping is not yet complete.

Each actual project owns `.codex-coordination/amp-07/store.sqlite`, shared by its
AMP native data and Codex observations. No cross-project synchronization pool is
used. Tests reopen two distinct project databases with identical thread/turn IDs
and verify message/goal isolation and preservation of existing ignore rules.
Packaged hook subprocess tests verify lifecycle ingestion and neutral failure
responses. Tool IDs are stored without object prototype collisions.

Server build, six bridge tests, plugin validation (141 tools) and packaged smoke
(416 checks) passed. Snackbar/dialog code is unchanged. Installation and actual
host hook trust/streaming remain separate deployment verification requirements.

## Checkpoint 12: native Codex session lifecycle

SessionStart/SessionEnd now transactionally maintain native AMP session entities
alongside the observed hook event. Native WorkflowPersistence supplies the
creation, version checks, transitions and durable audit. A stable namespaced ID
links the Codex thread to its AMP session. End suspends rather than permanently
closes the session; resume preserves identity and uses resumed -> active.
An end without an observed start creates no session. Sync status exposes the
mapped entity. Tests rehydrate the database between each lifecycle event and
verify that repeated starts add no transition and no turn classification is
invented. Native turn/goal mapping and full message streaming remain incomplete.

## Checkpoint 13: standard native session queries

Registered canonical session.get and session.list through AgentGateway with
native WorkflowPersistence reads. Only real hook-created mappings in the
selected project are visible; imported workflows and connection IDs are not
presented as Codex sessions. get selects an observed threadId, and list is
bounded to 100 results. Calls are audited; gateway identity overrides are
rejected. Tests cover actual persisted lifecycle entities, unknown threads,
cross-project visibility and spoofed principals.

Typecheck, server build and all 112 regression tests passed. Plugin validation
reports 143 tools. The regenerated inventory reports 34 native standard verbs,
3 durable submissions, no compatibility aliases, 12 unbound verbs and 24 legacy
source consumers. Native session status reporting and turn response delivery
remain unbound pending their actual host contracts.

Packaged smoke passed 420 checks after updating its explicit tool-name contract
for the two newly registered session queries.

## Checkpoint 14: installed local plugin verification

Registered the repository as the local codex-coordination marketplace through
the installed Codex CLI and installed codex-coordination@codex-coordination
version 0.6.0. CLI plugin listing confirms installed=true and enabled=true.
The MCP smoke suite ran against the actual installed cache server path, outside
the repository payload, and passed 420 checks. Source/cache hashes match for the
manifest, hooks registry, hook entry, session mapping, session tools and surface.

This proves installation and stdio tool startup/discovery, not that the current
desktop chat has reloaded its plugin snapshot or trusted/executed command hooks.
Desktop hook execution, existing control-socket access and complete event
streaming still need host verification. No installed cache file was edited.

## Checkpoint 15: scoped task progress and session status UI

Canonical task.report_progress now persists an agent-authored, explicitly
unverified claim anchored to the native task version and selected workflow.
It enforces scope, active session, bounded text, idempotency and stale-version
checks without changing task state. task.get returns the latest 20 claims.
Restart tests prove exact retries and readback survive reopening the store.

User selected a minimal status row, read-only detail dialog, automatic refresh,
hide-without-data, and panel-top fallback if the native composer slot is absent.
The documented extension surface does not provide an arbitrary persistent
composer status slot, so the implementation uses the existing plugin panel.
The dialog exposes all module metadata and native raw entity groups. Unlinked
legacy modules, including profession, are explicitly reported as unavailable
for the selected native session rather than borrowing another runtime session.
Without a supplied actual threadId, the user selects the chat explicitly.

Snapshot access opens the project database read-only, does not create storage,
filters out other sessions and marks project-shared data. Tests prove source
bytes remain unchanged. Native data is loaded lazily to preserve legacy schema
initialization order. Existing notification components are unchanged.

Build, 113 regression tests, validation (144 tools) and packaged smoke (422
checks) passed. Inventory: 35 native, 3 durable submissions, 11 unbound verbs.
Browser UI validation is pending installation of the matching Playwright browser.

UI follow-up: all three browser scenarios passed using the installed Edge
channel, including the read-only dialog, hidden-empty state, automatic session
state refresh, desktop/mobile layouts and existing dialog/snackbar delivery.
Windows sandbox process cleanup required running the browser suite with process
management permissions; that run exited successfully (3 passed). The optional
COORDINATION_TEST_BROWSER_CHANNEL setting permits testing installed browsers.
The dialog also includes the selected chat's latest 100 original hook/goal
observations, with complete totals. Version 0.6.1 carries this UI update.

## Checkpoint 16: project cache VCS exclusion

Both legacy ledger creation and native store creation maintain root-level cache
ignore rules. Git and Git-backed Jujutsu use gitignore; detected Mercurial,
Bazaar and Fossil checkouts use their own file formats. Existing rules and line
endings survive, repeated calls are idempotent, and linked configuration outside
the selected project is rejected. Unsupported detected systems (SVN, Pijul,
Darcs, Perforce) emit an explicit adapter-needed diagnostic; no universal VCS
ignore mechanism is claimed. Non-Git adapters currently require checkout-root
selection. Already tracked files are never removed from repository indexes.

Tests use real Git init/check-ignore to verify complete directory exclusion for
both writers, plus format/preservation and escape-refusal cases. Full regression:
116 passed. Typecheck/validation and package smoke (422 checks) passed. Version
0.6.1 was installed through the Codex CLI, without editing cache files directly.

## Checkpoint 17: workspace-owned legacy databases

The host now locates legacy domain and copied coordination databases under each
project's `.codex-coordination/amp-legacy/`, rather than its home-directory
workspaces pool. Selecting a project can import only its old hash-addressed
database pair using SQLite's consistent backup API. Sources remain intact;
existing destination databases always win and are never replaced by old copies.
Backups use a per-target migration lock, temporary file, quick_check and atomic
rename. Escaping storage links are rejected. Memory-only host fixtures remain
memory-only. Cache exclusions cover these new files.

Tests prove WAL-backed data is included, original database/WAL bytes stay
unchanged, concurrent first imports create only one copy, local edits survive
reselection, and project switching cannot expose another project's artifacts.
Domain execution handles and journal tamper detection still survive restart.
The 21 focused host/domain/storage tests passed with typecheck and server build.

The old primary control database remains in its configured location and still
needs a separately filtered project migration. This checkpoint does not claim
all legacy persistence is project-local, nor removal of amp-legacy. Installed
0.6.1 predates this source checkpoint; deployment will follow the next validated
storage stage rather than editing the installed cache.

## Checkpoint 18: filtered project control-store cutover

The legacy host now opens `.codex-coordination/amp-legacy/control.sqlite` in the
selected project. The old configured/home database is read-only migration input,
not the active writer. Switching projects closes the prior binding and opens
the correct project database. Native and legacy future writes are project-local.

One-time transactional import preserves project/global control configuration,
registry versions/tombstones/links, project-specialized registry journals,
historical session context/roots/write/hook history, and owned retrieval objects.
Old sessions are revoked in the destination with no valid token hash. Imported
retrievals retain original object-chain rows as provenance in a new local chain.
The complete source chain is verified first; corrupted sources fail closed.
Existing local state wins retries, and source bytes remain unchanged.

Old unscoped caches, annotations, frames and scheduler data cannot be reliably
attributed to a project, so they remain intact at source rather than being
blindly copied. Host full status exposes a migration report with these limits.
The configured CODEX_AMP_DATABASE path now names the legacy import source;
`:memory:` retains explicit nonpersistent behavior. This migration does not
remove the remaining amp-legacy runtime dependency.

Validation: 121 regression tests, typecheck, server/app build, 144-tool
validation, 422 packaged checks and all 3 browser scenarios passed. The read-only
dialog snapshot reader now depends only on Node APIs; its native module/entity
catalog is injected from the initialized tool surface. This removes dynamic
native loading from the UI snapshot path and avoids prototype-hardening conflicts
with test transforms while preserving full module discovery.

Deployed version 0.6.2 through the native Codex plugin installer. The smoke
suite also passed 422 checks against the actual installed cache server.

## Checkpoint 19: native attention queries and context compilation

Registered standard attention.get/context over native stored AttentionObject
records. The bridge resolves the native session through actual Codex host
observations and uses the latest observed active turn for compilation. Missing
or completed turn observations fail rather than inventing a current turn.
Tenant/principal/session checks apply to attention records and their referenced
version lookups; project-root IDs and nested source scopes are also checked.

Context uses AMP's real compileContext implementation with its mount, expiry,
staleness, pointer-version and byte-budget exclusions. The host caps previews at
32 KiB/1,000 attention records. Output is a tool-result preview, not an assertion
of hidden Codex context injection or provider token usage. No model-accessible
attention creation/mount port was added; request_focus remains a pending host
submission. Old attention objects are not silently converted into new ones.

Build/typecheck, all 123 regression tests, 146-tool validation and packaged smoke
(426 checks) passed. The rebuilt inventory now reports 37 native standard verbs,
3 durable submissions and 9 unbound verbs. These source changes are newer than
the installed 0.6.2 checkpoint and will ship with the next validated stage.

## Checkpoint 20: audited connection repairs and regression fixes

The workspace now registers 162 MCP tools. The canonical 0.7.8 surface contains
42 native verbs, three durable submissions with a host-review consumer, and four
unbound Turn verbs. No observed hook event is presented as a native Turn control
contract; response/clarification delivery still needs a real Codex host port.

Session status claims are version-anchored and unverified. The narrow workspace
write port performs existing UTF-8 whole-file replacement under an independently
reviewed native workflow task, an actual ActionAttempt, native lease/CAS and an
issued file receipt. It never accepts Task/Goal success. File effects and SQLite
cannot commit atomically; unresolved starts/outcomes block automatic repetition
and require host reconciliation. This is not a general Action scheduler.

Canonical cooperation uses native Coordinator snapshots and local durable queues
inside a host-approved delegation. Identity, fencing and provenance are host-bound;
results remain unverified and there is no remote agent startup or remote delivery.
The submission review extension consumes focus, clarification and goal-evidence
proposals after an independent decision and fresh scope/version/evidence checks.
Legacy authority management routes receive an MCP-facing exact-argument approval
gate, without replacing the underlying legacy adapters.

Discovery now includes scoped files/outlines and an explicitly selected observed
conversation. Attention may be delivered through UserPromptSubmit additionalContext
with bounded summaries and retention reset, not by replacing Codex's model loop.
The discovery outline projection uses the normalized text digest required by AMP;
raw-byte hashes remain source-navigation anchors. Network discovery remains
unavailable. Full MCP catalog exposure remains in use.

Regression fixes preserve the tests' substantive checks: write fixtures follow
Turn/Intent/Mission and draft DAG lifecycle guards; file write admission checks
Mission state; Store handles close even on idempotent replay. Count and exact-name
contracts explicitly recognize all 162 tools rather than suppressing assertions.

Verification: source/app typechecks, server/app builds, 143/143 unit tests,
162-tool validation, 458 ordinary MCP smoke checks, 458 isolated-package smoke
checks, 9 legacy 0.6.3 conformance checks, and all three Edge browser scenarios
passed. The primary dependency is AMP 0.7.8 with semantic-typescript 2.0.1;
legacy 0.6.3 remains only as a documented compatibility runtime. The source payload was rebuilt; no installed plugin cache was edited.

