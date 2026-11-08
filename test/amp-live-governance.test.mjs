/**
 * WP9: host governance tools on the selected live Codex workflow.
 *
 * The live chain is host-owned: hooks create the native Session/Turn/Intent, the
 * WP6 bootstrap extension accepts the Intent and activates Mission/Goal, the
 * model proposes a draft, and only independent host reviews make the plan
 * executable and a task ready. The governance tools (`workflow_cancel_review`,
 * `workflow_acceptance_review`, `evidence_lifecycle_review`,
 * `workflow_reconciliation_review`) must then resolve the same live scope that
 * write/replace already use: an explicitly selected imported snapshot wins,
 * otherwise the observed Codex thread's native Session is used, with no
 * fallback between origins.
 *
 * Imported-snapshot governance behaviour remains covered by
 * `test/amp-cancellation.test.mjs`, `test/amp-acceptance.test.mjs`,
 * `test/amp-evidence-lifecycle.test.mjs` and `test/amp-reconciliation*.test.mjs`.
 *
 * Residual limitation: a live Goal cannot reach `achieved` through the host
 * tools exposed today. The kernel settles a Goal only after every descendant is
 * graph-terminal, but no host extension completes a live Plan (workflow_review
 * permits only approved/executing/paused), and completing the Task/Plan changes
 * `nativeEnvironment`, so a file-effect receipt/evidence created earlier is
 * stale for acceptance. `execution.run` receipts are anchored to the
 * connection-scoped session instead of the live Session, so they cannot serve as
 * live-scoped acceptance evidence either. This file therefore verifies live task
 * acceptance and live task-dispute propagation; imported goal invalidation stays
 * covered by `test/amp-evidence-lifecycle.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { normalizeToLf } from 'attention-manifest-protocol/file'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { nativeIoBudget } from '../plugins/codex-coordination/mcp/amp/read-budget.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { createPlan } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { makeWorkspace, seedGoal, transact, planPayload } from './helpers.mjs'

const CONTRACT = 'live-governance/1'
const writeKind = 'codex.amp.workspace.write'
const writeTool = 'attention_manifest_protocol_workspace.write'
const sha = value => createHash('sha256').update(value).digest('hex')
const rawDigest = value => 'sha256:' + sha(value)
/** AMP's normalized-LF planned-content digest, as journaled by the write binding. */
const plannedDigest = value => 'sha256:' + createHash('sha256').update(normalizeToLf(value)).digest('hex')

function toolsFor(root) { return withAmpSurface([], () => root) }

function call(tools, name, args = {}) {
  const tool = tools.find(item => item.name === 'attention_manifest_protocol_' + name)
  assert.ok(tool, `missing attention_manifest_protocol_${name}`)
  return tool.handler(args)
}

/** Approve or reject every host elicitation; `decide` may flip per test step. */
function host(t, decide = () => 'approve') {
  const requests = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    requests.push(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: decide(message) } } }))
  })
  return requests
}

function withStore(root, operation) {
  const { store } = openNativeStore(() => root)
  try { return operation(store) } finally { store.close() }
}

function mutate(root, operation) {
  return withStore(root, store => {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    return operation(persistence, store)
  })
}

/** A live plan proposal with a future deadline and one task awaiting one observed file effect. */
function submissionFor(id, taskIds, contractVersion = CONTRACT) {
  return {
    id,
    bounds: { maxAttempts: 1, deadline: new Date(Date.now() + 86_400_000).toISOString(), progressMetric: 'live governance review', deadLetterOwner: 'host' },
    tasks: taskIds.map(taskId => ({ id: taskId, dependsOn: [], required: true, contractVersion, requiredEffects: ['workspace:file.write'] })),
  }
}

/** Capture the live thread and run the host-only Intent → Mission → Goal bootstrap. */
async function bootstrapLive(tools, root, threadId, suffix, contractVersion = CONTRACT) {
  ingestHook({ cwd: root, session_id: threadId, hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: threadId, turn_id: threadId + '-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Live governance ' + suffix })
  const selected = await call(tools, 'session.get', { threadId })
  assert.equal(selected.threadId, threadId)
  const sessionId = selected.entity.id
  const intents = await call(tools, 'intent.list')
  assert.equal(intents.origin, 'codex-live')
  assert.equal(intents.threadId, threadId)
  assert.equal(intents.total, 1)
  const intent = intents.entities[0]
  assert.equal(intent.state, 'captured')
  const accepted = await call(tools, 'workflow_bootstrap', { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: suffix + '-accept' })
  const mission = await call(tools, 'workflow_bootstrap', { action: 'create_mission', intentId: intent.id, expectedVersion: accepted.intent.version, idempotencyKey: suffix + '-mission' })
  const activeMission = await call(tools, 'workflow_bootstrap', { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: mission.mission.version, idempotencyKey: suffix + '-mission-active' })
  const goal = await call(tools, 'workflow_bootstrap', { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion, acceptanceCriteria: ['A reviewed live plan exists', 'A live file effect succeeds'], idempotencyKey: suffix + '-goal' })
  const activeGoal = await call(tools, 'workflow_bootstrap', { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: suffix + '-goal-active' })
  assert.equal(activeGoal.goal.state, 'active')
  assert.equal(activeGoal.goal.sessionId, sessionId)
  return { sessionId, intent, goal: activeGoal.goal }
}

/** Propose a live draft and put the plan and its task through independent host review. */
async function draftAndReady(tools, goalId, submission, suffix) {
  const draft = await call(tools, 'plan.propose_draft', { idempotencyKey: suffix + '-draft', targetId: goalId, submission })
  assert.equal(draft.origin, 'codex-live')
  assert.equal(draft.plan.state, 'draft')
  assert.equal(draft.executionAuthorized, false)
  const approved = await call(tools, 'workflow_review', { kind: 'plan', id: draft.plan.id, to: 'approved', expectedVersion: draft.plan.version, idempotencyKey: suffix + '-plan-approved', reason: 'Approve the reviewed live plan bounds' })
  const executing = await call(tools, 'workflow_review', { kind: 'plan', id: draft.plan.id, to: 'executing', expectedVersion: approved.entity.version, idempotencyKey: suffix + '-plan-executing', reason: 'Start the approved live plan without granting acceptance' })
  const tasks = []
  for (const [index, task] of draft.tasks.entries()) {
    const proposed = await call(tools, 'workflow_review', { kind: 'task', id: task.id, to: 'proposed', expectedVersion: task.version, idempotencyKey: `${suffix}-task-${index}-proposed`, reason: 'Host proposes the live task' })
    const ready = await call(tools, 'workflow_review', { kind: 'task', id: task.id, to: 'ready', expectedVersion: proposed.entity.version, idempotencyKey: `${suffix}-task-${index}-ready`, reason: 'Host admits the reviewed live task' })
    assert.equal(ready.entity.state, 'ready')
    tasks.push(ready.entity)
  }
  return { plan: executing.entity, tasks }
}

/**
 * A complete live chain plus one real file effect and its host-reviewed
 * evidence: Session/Turn/Intent → Mission/Goal → plan/task review → write →
 * evidence_review. The receipt is anchored to the live session and the current
 * environment, which is the exact material governance tools must resolve.
 */
async function liveEvidenceFixture(t, threadId, suffix) {
  const root = makeWorkspace(t)
  const path = 'live.txt'
  const original = 'live governance original\n'
  const planned = 'live governance output\n'
  writeFileSync(join(root, path), original)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLive(tools, root, threadId, suffix)
  const submission = submissionFor(suffix + '-plan', [suffix + '-task'])
  const { plan, tasks } = await draftAndReady(tools, goal.id, submission, suffix)
  const task = tasks[0]
  const written = await call(tools, 'workspace.write', { path, content: planned, expectedHash: sha(original), taskId: task.id, idempotencyKey: suffix + '-write' })
  assert.equal(written.approved, true)
  assert.equal(written.changed, true)
  assert.equal(written.receipt.invocation.context.sessionId, sessionId)
  assert.equal(readFileSync(join(root, path), 'utf8'), planned)
  const reviewed = await call(tools, 'evidence_review', { receiptId: written.receipt.id, claim: 'The live governance file contains the reviewed output', criteriaVersion: CONTRACT, idempotencyKey: suffix + '-evidence' })
  assert.equal(reviewed.approved, true)
  assert.equal(reviewed.verification.status, 'semantic_verified')
  assert.equal(reviewed.acceptanceGranted, false)
  assert.equal(reviewed.evidence.sessionId, sessionId)
  return { root, path, original, planned, tools, sessionId, goal, plan, task, written, reviewed }
}

/** Give one live task a unique running ActionAttempt through the real kernel. */
function seedRunningAttempt(root, sessionId, taskId, prefix) {
  return mutate(root, (persistence, store) => {
    let task = persistence.workflow.get('task', taskId)
    if (task.state === 'ready') task = persistence.transition('task', taskId, 'active', { expectedVersion: task.version, actor: 'test-host', reason: 'Host admits the reviewed live task for one attempt' })
    assert.equal(task.state, 'active')
    const action = persistence.create('action', { id: prefix + '-action', sessionId, taskId, operationId: prefix + '-operation', effect: 'written', required: false, sideEffect: true, recovery: 'query' }, 'test-host')
    const ready = persistence.transition('action', action.id, 'ready', { expectedVersion: action.version, actor: 'test-host' })
    // `create`/`transition` persist their own rows and events; starting the
    // attempt mutates pure kernel state and is persisted explicitly, as the
    // native write/replace effects do.
    const before = persistence.workflow.snapshot()
    const running = persistence.workflow.startAttempt(ready.id, { expectedVersion: ready.version, cancellationEpoch: 0, executionId: prefix + '-execution', attemptId: prefix + '-attempt', actor: 'test-host' })
    const active = persistence.workflow.get('action', ready.id)
    store.transaction(() => {
      store.save('action', active, { expectedVersion: ready.version })
      for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
      persistence.persistAttempt(running, { actor: 'test-host' })
    })
    return { task, action: active, attempt: running }
  })
}

/** Throw once when the post-flush receipt row is persisted (WP3/WP4 uncertainty path). */
function failReceiptOnce() {
  const save = Store.prototype.save
  let fired = false
  Store.prototype.save = function (kind, ...rest) {
    if (kind === 'receipt' && !fired) { fired = true; throw new Error('injected post-flush receipt persistence failure') }
    return save.call(this, kind, ...rest)
  }
  return { restore() { Store.prototype.save = save }, get fired() { return fired } }
}

/** Native action/attempt/journal facts of the single live file effect. */
function nativeFacts(root, kind) {
  return withStore(root, store => {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    const action = JSON.parse(JSON.stringify(persistence.workflow.list('action')[0]))
    const attempt = JSON.parse(JSON.stringify(persistence.workflow.getAttempt(action.attemptIds.at(-1))))
    const events = store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload)))
    return { action, attempt, events, receipts: store.list('receipt').length }
  })
}

function rows(root, kind) {
  return withStore(root, store => store.list(kind).map(row => JSON.parse(JSON.stringify(row))))
}

function events(root, kind) {
  return withStore(root, store => store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload))))
}

test('live acceptance review completes a live task only under independent host approval', async t => {
  let decision = 'approve'
  const prompts = host(t, () => decision)

  // Approved path: the live task moves to completed and the live receipt is sealed.
  const approved = await liveEvidenceFixture(t, 'thread-live-accept', 'live-accept')
  const beforeAccept = await call(approved.tools, 'task.get', { id: approved.task.id })
  assert.equal(beforeAccept.origin, 'codex-live')
  assert.equal(beforeAccept.threadId, 'thread-live-accept')
  assert.equal(beforeAccept.entity.state, 'active')
  const input = { kind: 'task', id: approved.task.id, expectedVersion: beforeAccept.entity.version, criteriaVersion: CONTRACT, evidenceIds: [approved.reviewed.evidence.id], idempotencyKey: 'live-accept-task', reason: 'Independently accept the reviewed live file effect' }
  // Citation is available while the environment still matches, and it never
  // becomes acceptance by itself.
  const cited = await call(approved.tools, 'evidence.cite', { ids: [approved.reviewed.evidence.id] })
  assert.equal(cited.acceptanceGranted, false)
  const beforeApproval = prompts.length
  const accepted = await call(approved.tools, 'workflow_acceptance_review', input)
  assert.equal(prompts.length, beforeApproval + 1, 'the live acceptance asks exactly one host approval')
  assert.equal(accepted.approved, true)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.acceptanceGranted, true)
  assert.equal(accepted.changed, true)
  assert.equal(accepted.entity.state, 'completed')
  assert.equal(accepted.entity.sessionId, approved.sessionId)
  assert.equal(accepted.entity.assessment.valid, true)
  assert.equal(accepted.entity.assessment.evidenceIds[0], approved.reviewed.evidence.id)
  const proofs = events(approved.root, 'codex.amp.workflow.acceptance_proof')
  assert.equal(proofs.length, 1)
  assert.equal(proofs[0].selected, approved.sessionId)
  assert.equal(proofs[0].consumer.kind, 'task')
  assert.equal(proofs[0].consumer.id, approved.task.id)
  assert.equal(proofs[0].consumer.version, input.expectedVersion + 1)
  const after = await call(approved.tools, 'task.get', { id: approved.task.id })
  assert.equal(after.origin, 'codex-live')
  assert.equal(after.threadId, 'thread-live-accept')
  assert.equal(after.entity.state, 'completed')
  // The goal stays active: receipts/evidence alone never achieve a Goal.
  const goalAfter = await call(approved.tools, 'goal.get', { id: approved.goal.id })
  assert.equal(goalAfter.entity.state, 'active')
  // Replay reports the same native acceptance without a second approval.
  const replay = await call(approved.tools, 'workflow_acceptance_review', input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.acceptanceGranted, true)
  assert.equal(prompts.length, beforeApproval + 1)

  // Rejected path: a denied host decision changes nothing.
  decision = 'approve'
  const rejected = await liveEvidenceFixture(t, 'thread-live-reject', 'live-reject')
  const beforeReject = await call(rejected.tools, 'task.get', { id: rejected.task.id })
  decision = 'reject'
  const denied = await call(rejected.tools, 'workflow_acceptance_review', { kind: 'task', id: rejected.task.id, expectedVersion: beforeReject.entity.version, criteriaVersion: CONTRACT, evidenceIds: [rejected.reviewed.evidence.id], idempotencyKey: 'live-reject-task', reason: 'Host declines the live acceptance' })
  decision = 'approve'
  assert.equal(denied.approved, false)
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.acceptanceGranted, false)
  assert.equal(denied.changed, false)
  const afterReject = await call(rejected.tools, 'task.get', { id: rejected.task.id })
  assert.equal(afterReject.entity.state, 'active')
  assert.equal(afterReject.entity.version, beforeReject.entity.version)
  assert.deepEqual(events(rejected.root, 'codex.amp.workflow.acceptance_proof'), [])
  assert.deepEqual(readFileSync(join(rejected.root, rejected.path), 'utf8'), rejected.planned)
})

test('live cancellation review fences the running live attempt without fabricating settlement', async t => {
  const prompts = host(t)
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLive(tools, root, 'thread-live-cancel', 'live-cancel')
  const { tasks } = await draftAndReady(tools, goal.id, submissionFor('live-cancel-plan', ['live-cancel-task']), 'live-cancel')
  const task = tasks[0]
  const seeded = seedRunningAttempt(root, sessionId, task.id, 'live-cancel')
  assert.equal(seeded.attempt.state, 'running')
  const current = await call(tools, 'task.get', { id: task.id })
  assert.equal(current.origin, 'codex-live')
  assert.equal(current.entity.state, 'active')
  const input = { operation: 'request_cancel', kind: 'task', id: task.id, expectedVersion: current.entity.version, idempotencyKey: 'live-cancel-task', reason: 'Host stops the running live task' }
  const beforeApproval = prompts.length
  const result = await call(tools, 'workflow_cancel_review', input)
  assert.equal(prompts.length, beforeApproval + 1, 'the live cancellation asks exactly one host approval')
  assert.equal(result.approved, true)
  assert.equal(result.status, 'cancel_requested')
  assert.equal(result.changed, true)
  assert.equal(result.executionSettled, false)
  assert.equal(result.cancellationEpoch, 1)
  assert.deepEqual(result.updated.map(entity => entity.kind).sort(), ['action', 'task'])
  // Replay is durable and asks nobody again.
  const replay = await call(tools, 'workflow_cancel_review', input)
  assert.equal(replay.replayed, true)
  assert.equal(prompts.length, beforeApproval + 1)
  // Persisted native facts: the task is fenced, the attempt is still running.
  const taskAfter = await call(tools, 'task.get', { id: task.id })
  assert.equal(taskAfter.origin, 'codex-live')
  assert.equal(taskAfter.threadId, 'thread-live-cancel')
  assert.equal(taskAfter.entity.state, 'cancel_requested')
  const attemptAfter = await call(tools, 'action.get', { id: seeded.attempt.attemptId })
  assert.equal(attemptAfter.origin, 'codex-live')
  assert.equal(attemptAfter.threadId, 'thread-live-cancel')
  assert.equal(attemptAfter.attempt.state, 'running')
  const actionRows = rows(root, 'action')
  assert.equal(actionRows.find(row => row.id === seeded.action.id).state, 'cancel_requested')
  assert.equal(actionRows.find(row => row.id === seeded.action.id).cancellationEpoch, 1)
  assert.equal(rows(root, 'action_attempt').find(row => row.attemptId === seeded.attempt.attemptId).state, 'running')
  // Exactly one review is journaled; no settlement event was invented.
  assert.equal(events(root, 'codex.amp.workflow.cancel_review').length, 1)
})

test('live evidence lifecycle revokes live evidence and durably disputes its accepted task', async t => {
  const prompts = host(t)
  const fixture = await liveEvidenceFixture(t, 'thread-live-lifecycle', 'live-lifecycle')
  const beforeAccept = await call(fixture.tools, 'task.get', { id: fixture.task.id })
  const accepted = await call(fixture.tools, 'workflow_acceptance_review', { kind: 'task', id: fixture.task.id, expectedVersion: beforeAccept.entity.version, criteriaVersion: CONTRACT, evidenceIds: [fixture.reviewed.evidence.id], idempotencyKey: 'live-lifecycle-accept', reason: 'Accept the reviewed live file effect before revoking its evidence' })
  assert.equal(accepted.acceptanceGranted, true)
  assert.equal(accepted.entity.state, 'completed')
  const taskBeforeRevoke = await call(fixture.tools, 'task.get', { id: fixture.task.id })
  const goalBeforeRevoke = await call(fixture.tools, 'goal.get', { id: fixture.goal.id })
  assert.deepEqual(events(fixture.root, 'codex.amp.evidence_lifecycle.impact'), [])

  const preview = await call(fixture.tools, 'evidence_lifecycle_review', { action: 'preview', evidenceId: fixture.reviewed.evidence.id })
  assert.equal(preview.changed, false)
  assert.equal(preview.selected, fixture.sessionId)
  assert.deepEqual(preview.affectedEvidence, [fixture.reviewed.evidence.id])
  // A live Goal cannot be achieved before its plan/task drain (see the file
  // header note), so only the completed task's sealed assessment is disputed.
  assert.deepEqual(preview.invalidatedGoals, [])
  assert.equal(preview.disputedTasks.length, 1)
  assert.equal(preview.disputedTasks[0].id, fixture.task.id)
  // Preview leaves every durable fact untouched.
  assert.equal((await call(fixture.tools, 'evidence.get', { id: fixture.reviewed.evidence.id })).evidence.status, 'active')
  assert.equal((await call(fixture.tools, 'task.get', { id: fixture.task.id })).entity.version, taskBeforeRevoke.entity.version)

  const command = { action: 'revoke', evidenceId: fixture.reviewed.evidence.id, expectedEvidenceDigest: preview.expectedEvidenceDigest, expectedProofHead: preview.expectedProofHead, reason: 'Evidence no longer supports the accepted live result', idempotencyKey: 'live-lifecycle-revoke' }
  const beforeApproval = prompts.length
  const revoked = await call(fixture.tools, 'evidence_lifecycle_review', command)
  assert.equal(prompts.length, beforeApproval + 1, 'the live lifecycle revoke asks exactly one host approval')
  assert.equal(revoked.approved, true)
  assert.equal(revoked.status, 'applied')
  assert.equal(revoked.changed, true)
  assert.deepEqual(revoked.affectedEvidence, [fixture.reviewed.evidence.id])
  assert.deepEqual(revoked.invalidatedGoals, [])
  assert.equal(revoked.disputedTasks.length, 1)
  // The revoked evidence is no longer consumable.
  assert.equal((await call(fixture.tools, 'evidence.get', { id: fixture.reviewed.evidence.id })).evidence.status, 'revoked')
  await assert.rejects(call(fixture.tools, 'evidence.cite', { ids: [fixture.reviewed.evidence.id] }), /absent, expired, revoked or stale/)
  // The completed task keeps its historical state/assessment; the dispute is durable.
  const taskAfter = await call(fixture.tools, 'task.get', { id: fixture.task.id })
  assert.equal(taskAfter.entity.state, 'completed')
  assert.equal(taskAfter.entity.version, taskBeforeRevoke.entity.version)
  assert.deepEqual(taskAfter.entity.assessment, taskBeforeRevoke.entity.assessment)
  const goalAfter = await call(fixture.tools, 'goal.get', { id: fixture.goal.id })
  assert.equal(goalAfter.entity.state, 'active')
  assert.equal(goalAfter.entity.version, goalBeforeRevoke.entity.version)
  const disputes = events(fixture.root, 'codex.amp.workflow.task_disputed')
  assert.equal(disputes.length, 1)
  assert.equal(disputes[0].taskId, fixture.task.id)
  assert.equal(disputes[0].status, 'disputed')
  assert.equal(disputes[0].assessmentValid, false)
  assert.deepEqual(disputes[0].historicalAssessment, taskBeforeRevoke.entity.assessment)
  assert.equal(disputes[0].sourceEvidenceId, fixture.reviewed.evidence.id)
  const impacts = events(fixture.root, 'codex.amp.evidence_lifecycle.impact')
  assert.equal(impacts.length, 1)
  assert.equal(impacts[0].selected, fixture.sessionId)
  assert.equal(impacts[0].action, 'revoke')
  // Replay reports the same review; the dispute and impact stay single.
  const replay = await call(fixture.tools, 'evidence_lifecycle_review', command)
  assert.equal(replay.replayed, true)
  assert.equal(events(fixture.root, 'codex.amp.workflow.task_disputed').length, 1)
  assert.equal(events(fixture.root, 'codex.amp.evidence_lifecycle.impact').length, 1)
})

test('live reconciliation review recovers a post-flush live write like the imported path', async t => {
  const prompts = host(t)
  const root = makeWorkspace(t)
  const path = 'reconcile.txt'
  const original = 'live reconcile original\n'
  const planned = 'live reconcile planned\n'
  writeFileSync(join(root, path), original)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLive(tools, root, 'thread-live-reconcile', 'live-reconcile')
  const { tasks } = await draftAndReady(tools, goal.id, submissionFor('live-reconcile-plan', ['live-reconcile-task']), 'live-reconcile')
  const task = tasks[0]

  const fault = failReceiptOnce()
  try {
    await assert.rejects(call(tools, 'workspace.write', { path, content: planned, expectedHash: sha(original), taskId: task.id, idempotencyKey: 'live-reconcile-write' }), /outcome is unresolved/)
  } finally { fault.restore() }
  assert.equal(fault.fired, true)
  assert.equal(readFileSync(join(root, path), 'utf8'), planned, 'the flush reached disk before the receipt failure')
  const facts = nativeFacts(root, writeKind)
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.receipts, 0)
  const started = facts.events.find(event => event.state === 'started')
  assert.equal(started.plannedContentDigest, plannedDigest(planned))
  assert.match(started.budgetReservationId, /^write-budget:/)
  const reservationBefore = withStore(root, store => nativeIoBudget(store, 'native-read:codex').getReservation(started.budgetReservationId))
  assert.equal(reservationBefore.state, 'reserved')

  const input = {
    actionId: facts.action.id,
    expectedAttemptId: facts.attempt.attemptId,
    expectedActionVersion: facts.action.version,
    expectedAttemptVersion: facts.attempt.version,
    outcome: 'succeeded',
    reconciliationRef: 'manual:live-host-inspection',
    observedRawHash: rawDigest(planned),
    idempotencyKey: 'live-reconcile-review',
    reason: 'Host inspected the live file bytes and the journaled planned content',
  }
  const beforeApproval = prompts.length
  const result = await call(tools, 'workflow_reconciliation_review', input)
  assert.equal(prompts.length, beforeApproval + 1, 'the live reconciliation asks exactly one host approval')
  assert.equal(result.approved, true)
  assert.equal(result.reconciled, true)
  assert.equal(result.changed, true)
  assert.equal(result.status, 'reconciled')
  assert.equal(result.state, 'succeeded')
  assert.equal(result.journalKind, writeKind)
  assert.equal(result.attemptId, facts.attempt.attemptId)
  assert.equal(result.operationId, facts.attempt.operationId)
  assert.equal(result.retryAuthorized, false)
  assert.equal(result.acceptanceGranted, false)
  assert.equal(result.businessVerification, 'not_performed')
  // The recovered receipt is a genuine live file_flush_receipt.
  assert.equal(result.receipt.kind, 'file_flush_receipt')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(result.receipt.invocation.toolId, writeTool)
  assert.equal(result.receipt.invocation.id, facts.attempt.executionId)
  assert.equal(result.receipt.invocation.context.sessionId, sessionId)
  assert.equal(result.receipt.observation.value.reconciled, true)
  assert.equal(result.receipt.observation.value.rawHash, rawDigest(planned))
  // The interrupted reservation is charged conservatively, never refunded by inference.
  assert.equal(result.budget.settlementPerformed, true)
  assert.equal(result.budget.conservative, true)
  assert.equal(result.budget.reservationId, started.budgetReservationId)
  const reservationAfter = withStore(root, store => nativeIoBudget(store, 'native-read:codex').getReservation(started.budgetReservationId))
  assert.equal(reservationAfter.state, 'settled')
  assert.equal(reservationAfter.actual.calls, reservationBefore.amount.calls)
  assert.equal(reservationAfter.actual.bytes, reservationBefore.amount.bytes)
  // Persisted native facts match the imported recovery exactly.
  const afterFacts = nativeFacts(root, writeKind)
  assert.equal(afterFacts.action.state, 'succeeded')
  assert.equal(afterFacts.attempt.state, 'succeeded')
  assert.equal(afterFacts.receipts, 1)
  assert.equal(afterFacts.events.at(-1).state, 'succeeded')
  assert.equal(afterFacts.events.at(-1).key, started.key)
  assert.equal(afterFacts.events.at(-1).request, started.request)
  assert.equal(afterFacts.events.at(-1).budgetReservationId, started.budgetReservationId)
  assert.equal(afterFacts.events.at(-1).result.reconciled, true)
  assert.equal(afterFacts.events.at(-1).reconciliationReviewId, result.reviewId)
  const attemptRead = await call(tools, 'action.get', { id: facts.attempt.attemptId })
  assert.equal(attemptRead.origin, 'codex-live')
  assert.equal(attemptRead.threadId, 'thread-live-reconcile')
  assert.equal(attemptRead.attempt.state, 'succeeded')
  assert.equal(readFileSync(join(root, path), 'utf8'), planned, 'reconciliation never rewrites the file')
  // Replay is idempotent and issues no second receipt.
  const replay = await call(tools, 'workflow_reconciliation_review', input)
  assert.equal(replay.replayed, true)
  assert.equal(nativeFacts(root, writeKind).receipts, 1)
})

test('imported selection still wins and live governance facts are never read through it', async t => {
  const prompts = host(t)
  const fixture = await liveEvidenceFixture(t, 'thread-live-imported', 'live-imported')
  const liveBefore = await call(fixture.tools, 'task.get', { id: fixture.task.id })
  assert.equal(liveBefore.entity.state, 'active')
  // The legacy ledger is an explicit, separate import source for this workspace.
  await seedGoal(fixture.root, 'imported-goal')
  await transact(fixture.root, context => createPlan(context, planPayload('imported-plan', 'imported-goal')))

  // Import and explicitly select the legacy snapshot: imported selection wins over
  // the observed live thread recorded by session.get.
  const migration = await call(fixture.tools, 'migration', { action: 'preview' })
  await call(fixture.tools, 'migration', { action: 'import', sourceDigest: migration.sourceDigest })
  await call(fixture.tools, 'workflow_scope', { action: 'select', sourceDigest: migration.sourceDigest })
  const selectedLive = await call(fixture.tools, 'session.get', { threadId: 'thread-live-imported' })
  assert.equal(selectedLive.entity.id, fixture.sessionId)
  const beforeRejections = prompts.length
  await assert.rejects(call(fixture.tools, 'workflow_acceptance_review', { kind: 'task', id: fixture.task.id, expectedVersion: liveBefore.entity.version, criteriaVersion: CONTRACT, evidenceIds: [fixture.reviewed.evidence.id], idempotencyKey: 'imported-scope-accept', reason: 'Imported scope cannot accept a live task' }), /outside the selected workflow scope/)
  await assert.rejects(call(fixture.tools, 'workflow_cancel_review', { operation: 'request_cancel', kind: 'task', id: fixture.task.id, expectedVersion: liveBefore.entity.version, idempotencyKey: 'imported-scope-cancel', reason: 'Imported scope cannot cancel a live task' }), /outside the selected workflow scope/)
  await assert.rejects(call(fixture.tools, 'evidence_lifecycle_review', { action: 'preview', evidenceId: fixture.reviewed.evidence.id }), /outside the selected session scope/)
  assert.equal(prompts.length, beforeRejections, 'imported scope rejects before requesting any approval')

  // A fresh connection with neither selection fails closed instead of guessing live.
  const unscoped = toolsFor(fixture.root)
  await assert.rejects(call(unscoped, 'workflow_acceptance_review', { kind: 'task', id: fixture.task.id, expectedVersion: liveBefore.entity.version, criteriaVersion: CONTRACT, evidenceIds: [fixture.reviewed.evidence.id], idempotencyKey: 'unscoped-accept', reason: 'No scope selected' }), /Select an imported native workflow/)
  assert.equal(prompts.length, beforeRejections)

  // The live chain is untouched, and a live-only connection still reads it.
  const liveTools = toolsFor(fixture.root)
  await call(liveTools, 'session.get', { threadId: 'thread-live-imported' })
  const liveAfter = await call(liveTools, 'task.get', { id: fixture.task.id })
  assert.equal(liveAfter.origin, 'codex-live')
  assert.equal(liveAfter.threadId, 'thread-live-imported')
  assert.equal(liveAfter.entity.state, 'active')
  assert.equal(liveAfter.entity.version, liveBefore.entity.version)
  assert.deepEqual(events(fixture.root, 'codex.amp.workflow.acceptance_proof'), [])
  assert.deepEqual(events(fixture.root, 'codex.amp.workflow.cancel_review'), [])
  assert.deepEqual(events(fixture.root, 'codex.amp.workflow.cancel_requested'), [])
})
