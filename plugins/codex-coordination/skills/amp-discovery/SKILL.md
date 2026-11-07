---
name: amp-discovery
description: Find executable AMP coordination capabilities in Codex and inspect the AMP 0.7 module surface before choosing a tool.
---

Use `attention_manifest_protocol_discover` with a short task query. Its default
source, `host_modules`, searches the tools installed in this plugin. Read the
selected tool's contract and execute through that tool's existing authorization
and workspace checks. Discovery never grants execution authority.

Use `attention_manifest_protocol_surface` to inspect the AMP 0.7 tier table.
The `registered` field lists canonical verbs bound to actual host handlers.
Use discovery's `amp` source to find only those executable canonical contracts.
Other verbs remain metadata; do not claim they can execute from inventory alone.
Host and hidden modules must not be exposed as model execution tools.

Session files, outlines, conversation and network providers are not installed in
this discovery adapter. Unavailable sources are reported explicitly. Existing
workspace, context, filesystem and search tools remain available through host
discovery. Preserve the existing snackbar and dialog notification flows.

Clarification proposals, goal evidence and focus requests remain pending review.
Plan proposals create native drafts with pending task DAGs. Supply a stable
idempotencyKey for retries. Read `attention_manifest_protocol_submissions` for
old submissions and materialization status. Draft creation is not approval.

For project configuration use the native `attention_manifest_protocol_project.*`
tools. Read environment/rules first, then pass expectedVersion when editing.
configure_environment and put_rule are actual durable writes with idempotency
keys, not review proposals. Configuration is declarative: it does not execute
installation commands or change the running process environment.

For legacy ledger migration use `attention_manifest_protocol_migration` preview,
then import with its exact sourceDigest. Import preserves the source and produces
suspended native workflow facts for review; it does not activate work or verify
old success claims. status lists imported snapshots and source-to-native IDs.

Select a native import using `attention_manifest_protocol_workflow_scope` and its
sourceDigest before canonical goal/plan/task/intent/mission/action queries. Use the
native IDs returned by migration/status. Selection is local to this connection
and workspace; it is not a Codex session switch. Native workflow reads do not
fall back to old ledger records. Use coordination tools for the old ledger.

Native nonterminal state review uses `attention_manifest_protocol_workflow_review`.
It obtains independent approval through the connected MCP host and fails closed
when the host cannot approve. Pass the current expectedVersion, stable retry key
and concrete reason. It cannot declare achievement, verify evidence or start
actions. Plan approval and task readiness require fresh bounds, active goal and
dependency checks. The explicit approval requirement comes from the AMP
surface's host-owned lifecycle boundary, implemented through the existing
correlated host approval port; model arguments cannot substitute for approval.

For native execution, find_tools returns `pinned: {toolId, digest}`. Pass those
fields to inspect_tool and typed execution.run child calls, with one stable run
idempotencyKey. The current native execution catalog admits read contracts only.
Writes are withheld until Action/attempt fencing is connected. Issued receipts
are execution facts, not proof of business success. budget.remaining reports
plugin costs, not Codex token usage. Do not automatically retry unresolved runs.
Result handles belong to their issuing connection/workspace and expire in five
minutes; completed run replay retains inline results after restart.

Native evidence_review requires a stored successful native project/workflow
receipt, unchanged host-computed state anchor and independent host confirmation
of the exact claim/criteria version. Unavailable approval creates no evidence.
Evidence get/list/cite read native persisted facts; cite rejects stale state.
These operations do not achieve goals or complete tasks. File-tool receipt
freshness and goal/task acceptance consumption remain unimplemented.

Workspace read/list/outline/document_outline/diff now use native AMP file ports.
Read paths are relative POSIX paths; symlinks and host exclusions are refused.
Line windows are 1-based; mode byte addresses normalized UTF-8 and must align to
codepoint boundaries. Use baseHash from a read for diff.expectedHash. diff accepts
proposed content and is a preview only. Binary documents use document_outline.
Native workspace.write is not yet exposed; no disk write follows from a preview.
