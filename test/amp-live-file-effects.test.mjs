/**
 * Canonical file effects on the selected live Codex workflow.
 *
 * The live chain is host-owned: hooks create the native Session/Turn/Intent, the
 * WP6 bootstrap extension accepts the Intent and activates Mission/Goal, the
 * model proposes a draft, and only an independent host review makes the plan
 * executable and a task ready. `workspace.write` and `replace` must then follow
 * that exact live scope, create their native ActionAttempt/receipt and remain
 * isolated from imported snapshots and other live threads.
 *
 * Imported-snapshot and synthetic active-session behaviour is covered by
 * `test/amp-write.test.mjs`, `test/amp-write-targets.test.mjs`,
 * `test/amp-replace.test.mjs`, `test/amp-replace-attempt.test.mjs` and
 * `test/amp-file-effect-recovery.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { createPlan } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { makeWorkspace, seedGoal, transact, planPayload } from './helpers.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

function toolsFor(root) {
  return withAmpSurface([], () => root)
}

function call(tools, name, args = {}) {
  const tool = tools.find(item => item.name === 'attention_manifest_protocol_' + name)
  assert.ok(tool, `missing attention_manifest_protocol_${name}`)
  return tool.handler(args)
}

/** Approve every host elicitation and keep the exact prompts for assertions. */
function approvals(t) {
  const requests = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    requests.push(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  return requests
}

function withStore(root, operation) {
  const { store } = openNativeStore(() => root)
  try { return operation(store) } finally { store.close() }
}

function nativeRows(root, kind) {
  return withStore(root, store => store.list(kind).map(value => JSON.parse(JSON.stringify(value))))
}

function mutate(root, operation) {
  return withStore(root, store => {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    return operation(persistence, store)
  })
}

function threadSession(root, threadId) {
  const store = openCodexStore(root)
  try {
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(event => event.payload).find(item => item.threadId === threadId)
    assert.ok(mapping, `SessionStart must map ${threadId} to a native session`)
    return mapping.sessionId
  } finally { store.close() }
}

/** A live plan proposal must carry a future deadline and at least one task. */
function submissionFor(id, taskIds) {
  return {
    id,
    bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 86_400_000).toISOString(), progressMetric: 'live file effect succeeds', deadLetterOwner: 'host' },
    tasks: taskIds.map(taskId => ({ id: taskId, dependsOn: [], required: true, contractVersion: 'test/1', requiredEffects: ['written'] })),
  }
}

/** Capture the live thread and run the host-only Intent → Mission → Goal bootstrap. */
async function bootstrapLive(tools, root, threadId, suffix) {
  ingestHook({ cwd: root, session_id: threadId, hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: threadId, turn_id: threadId + '-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Live file effects ' + suffix })
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
  const goal = await call(tools, 'workflow_bootstrap', { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'live-file/1', acceptanceCriteria: ['A reviewed live plan exists', 'A live file effect succeeds'], idempotencyKey: suffix + '-goal' })
  const activeGoal = await call(tools, 'workflow_bootstrap', { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: suffix + '-goal-active' })
  assert.equal(activeGoal.goal.state, 'active')
  assert.equal(activeGoal.goal.sessionId, sessionId)
  assert.equal(threadSession(root, threadId), sessionId)
  return { sessionId, intent, goal: activeGoal.goal }
}

/** Propose a live draft and put every task through independent host review. */
async function draftAndReady(tools, goalId, submission, suffix) {
  const draft = await call(tools, 'plan.propose_draft', { idempotencyKey: suffix + '-draft', targetId: goalId, submission })
  assert.equal(draft.plan.state, 'draft')
  assert.equal(draft.origin, 'codex-live')
  assert.equal(draft.executionAuthorized, false)
  assert.ok(draft.tasks.length > 0)
  assert.ok(draft.tasks.every(task => task.state === 'pending'))
  const approved = await call(tools, 'workflow_review', { kind: 'plan', id: draft.plan.id, to: 'approved', expectedVersion: draft.plan.version, idempotencyKey: suffix + '-plan-approved', reason: 'Approve the reviewed live plan bounds' })
  const executing = await call(tools, 'workflow_review', { kind: 'plan', id: draft.plan.id, to: 'executing', expectedVersion: approved.entity.version, idempotencyKey: suffix + '-plan-executing', reason: 'Start the approved live plan without granting acceptance' })
  assert.equal(executing.entity.state, 'executing')
  const tasks = []
  for (const [index, task] of draft.tasks.entries()) {
    const proposed = await call(tools, 'workflow_review', { kind: 'task', id: task.id, to: 'proposed', expectedVersion: task.version, idempotencyKey: `${suffix}-task-${index}-proposed`, reason: 'Host proposes the live task' })
    const ready = await call(tools, 'workflow_review', { kind: 'task', id: task.id, to: 'ready', expectedVersion: proposed.entity.version, idempotencyKey: `${suffix}-task-${index}-ready`, reason: 'Host admits the reviewed live task for file effects' })
    assert.equal(ready.entity.state, 'ready')
    tasks.push(ready.entity)
  }
  return { plan: executing.entity, tasks }
}

/** Give one live task a unique running ActionAttempt through the real kernel. */
function seedRunningAttempt(root, sessionId, taskId, prefix) {
  return mutate(root, (persistence, store) => {
    let task = persistence.workflow.get('task', taskId)
    if (task.state === 'ready') task = persistence.transition('task', taskId, 'active', { expectedVersion: task.version, actor: 'test-host', reason: 'Host admits the reviewed live task for one attempt' })
    assert.equal(task.state, 'active')
    const action = persistence.create('action', { id: prefix + '-action', sessionId, taskId, operationId: prefix + '-operation', effect: 'written', required: false, sideEffect: true, recovery: 'query' }, 'test-host')
    const readyAction = persistence.transition('action', action.id, 'ready', { expectedVersion: action.version, actor: 'test-host' })
    const running = persistence.workflow.startAttempt(readyAction.id, { expectedVersion: readyAction.version, cancellationEpoch: 0, executionId: prefix + '-execution', attemptId: prefix + '-attempt', actor: 'test-host' })
    store.save('action', persistence.workflow.get('action', readyAction.id), { expectedVersion: readyAction.version })
    persistence.persistEvent(persistence.workflow.history().at(-1))
    persistence.persistAttempt(running, { actor: 'test-host' })
    return { task, action: persistence.workflow.get('action', readyAction.id), attempt: running }
  })
}

/** Seed a complete, executable-looking chain that belongs to another scope. */
function seedForeignChain(root, prefix = 'foreign-live') {
  return mutate(root, (persistence, store) => {
    const sessionId = prefix + '-session'
    const create = (kind, input) => persistence.create(kind, { ...input, sessionId }, 'test-host')
    const transition = (kind, id, to) => persistence.transition(kind, id, to, { expectedVersion: persistence.workflow.get(kind, id).version, actor: 'test-host' })
    create('session', { id: sessionId, sessionId, participants: ['test-host'], sessionType: 'autonomous' })
    transition('session', sessionId, 'active')
    create('turn', { id: prefix + '-turn', classification: 'new_intent' }); transition('turn', prefix + '-turn', 'interpreting')
    const intent = create('intent', { id: prefix + '-intent', originTurnId: prefix + '-turn', text: 'Foreign file-effect fixture' })
    transition('intent', intent.id, 'confirmed'); transition('intent', intent.id, 'accepted')
    create('mission', { id: prefix + '-mission', intentId: intent.id })
    const goal = create('goal', { id: prefix + '-goal', missionId: prefix + '-mission', contractVersion: 'test/1', acceptanceCriteria: ['foreign'] })
    transition('goal', goal.id, 'active')
    const plan = create('plan', { id: prefix + '-plan', goalId: goal.id, bounds: { maxAttempts: 1, deadline: new Date(Date.now() + 86_400_000).toISOString(), progressMetric: 'foreign', deadLetterOwner: 'test-host' } })
    // The DAG is fixed while the plan is a draft; transitions follow.
    const task = create('task', { id: prefix + '-task', planId: plan.id, contractVersion: 'test/1', dependsOn: [], required: false, requiredEffects: [] })
    transition('plan', plan.id, 'approved'); transition('plan', plan.id, 'executing')
    transition('task', task.id, 'proposed'); transition('task', task.id, 'ready')
    return { sessionId, goalId: goal.id, planId: plan.id, taskId: task.id }
  })
}

test('a live reviewed task admits workspace.write, exposes its attempt and consumes the receipt as evidence', async t => {
  const root = makeWorkspace(t)
  const original = 'live original\n'
  writeFileSync(join(root, 'live.md'), original)
  const prompts = approvals(t)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLive(tools, root, 'thread-live-write', 'write')
  const { plan, tasks } = await draftAndReady(tools, goal.id, submissionFor('live-write-plan', ['live-write-task']), 'write')
  assert.equal(plan.state, 'executing')
  const task = tasks[0]
  assert.equal(task.state, 'ready')
  assert.equal(prompts.length, 9, 'bootstrap and review ask one host approval each')

  const result = await call(tools, 'workspace.write', { path: 'live.md', content: 'live output\n', expectedHash: sha(original), taskId: task.id, idempotencyKey: 'live-write-1' })
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.businessVerification, 'not_performed')
  assert.match(result.actionId, /^workspace-write:/)
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/)
  assert.match(result.executionId, /^[0-9a-f-]{36}$/)
  assert.match(result.budgetReservationId, /^write-budget:/)
  assert.equal(result.receipt.kind, 'file_flush_receipt')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(result.receipt.id, 'receipt:' + result.executionId)
  assert.equal(result.receipt.invocation.context.sessionId, sessionId)
  assert.equal(readFileSync(join(root, 'live.md'), 'utf8'), 'live output\n')
  assert.equal(prompts.length, 10)

  const activated = await call(tools, 'task.get', { id: task.id })
  assert.equal(activated.origin, 'codex-live')
  assert.equal(activated.threadId, 'thread-live-write')
  assert.equal(activated.sessionId, sessionId)
  assert.equal(activated.entity.state, 'active')

  // action.get/list are the canonical live reads of the native execution facts.
  const attemptRead = await call(tools, 'action.get', { id: result.attemptId })
  assert.equal(attemptRead.origin, 'codex-live')
  assert.equal(attemptRead.threadId, 'thread-live-write')
  assert.equal(attemptRead.scope, sessionId)
  assert.equal(attemptRead.attempt.attemptId, result.attemptId)
  assert.equal(attemptRead.attempt.actionId, result.actionId)
  assert.equal(attemptRead.attempt.state, 'succeeded')
  assert.equal(attemptRead.attempt.operationId, result.operationId)
  const attemptList = await call(tools, 'action.list', { taskId: task.id })
  assert.equal(attemptList.origin, 'codex-live')
  assert.equal(attemptList.total, 1)
  assert.equal(attemptList.attempts[0].attemptId, result.attemptId)
  assert.equal(attemptList.attempts[0].actionId, result.actionId)

  // The issued file receipt is consumable only while the exact bytes remain.
  const review = await call(tools, 'evidence_review', { receiptId: result.receipt.id, claim: 'The live file contains live output', criteriaVersion: 'live-file/1', idempotencyKey: 'live-write-evidence' })
  assert.equal(review.approved, true)
  assert.equal(review.verification.status, 'semantic_verified')
  assert.equal(review.acceptanceGranted, false)
  const cited = await call(tools, 'evidence.cite', { ids: [review.evidence.id] })
  assert.equal(cited.citations.length, 1)
  assert.equal(cited.citations[0].receiptId, result.receipt.id)
  assert.equal(cited.acceptanceGranted, false)

  // Progress stays a claim: it needs exactly one running host attempt and never
  // transitions the task or grants acceptance.
  const current = await call(tools, 'task.get', { id: task.id })
  const progressInput = { id: task.id, expectedVersion: current.entity.version, summary: 'Observed the approved live write', idempotencyKey: 'live-write-progress' }
  await assert.rejects(call(tools, 'task.report_progress', progressInput), /no current running attempt/)
  const seeded = seedRunningAttempt(root, sessionId, task.id, 'live-write')
  const claim = await call(tools, 'task.report_progress', progressInput)
  assert.equal(claim.attemptId, seeded.attempt.attemptId)
  assert.equal(claim.executionId, seeded.attempt.executionId)
  assert.equal(claim.taskVersion, current.entity.version)
  assert.equal(claim.taskState, 'active')
  assert.equal(claim.verified, false)
  const after = await call(tools, 'task.get', { id: task.id })
  assert.equal(after.entity.state, 'active', 'a progress claim never transitions the task')
  assert.equal(after.entity.version, current.entity.version)
  assert.equal(after.progress.at(-1).attemptId, seeded.attempt.attemptId)
})

test('the same live chain admits replace and consumes its ActionAttempt and receipt as evidence', async t => {
  const root = makeWorkspace(t)
  const original = 'alpha beta\nsecond line\n'
  const expected = 'alpha BETA\nsecond line\n'
  writeFileSync(join(root, 'live.txt'), original)
  const prompts = approvals(t)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLive(tools, root, 'thread-live-replace', 'replace')
  const { plan, tasks } = await draftAndReady(tools, goal.id, submissionFor('live-replace-plan', ['live-replace-task']), 'replace')
  assert.equal(plan.state, 'executing')
  const task = tasks[0]
  assert.equal(task.state, 'ready')
  const input = { path: 'live.txt', mode: 'string', text: 'beta', replacement: 'BETA', taskId: task.id, idempotencyKey: 'live-replace-1' }

  const result = await call(tools, 'replace', input)
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.businessVerification, 'not_performed')
  assert.equal(result.mode, 'string')
  assert.equal(result.taskId, task.id)
  assert.equal(result.workspace, root)
  assert.match(result.actionId, /^workspace-replace:/)
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/)
  assert.match(result.executionId, /^[0-9a-f-]{36}$/)
  assert.match(result.budgetReservationId, /^replace-budget:/)
  assert.equal(result.receipt.kind, 'file_flush_receipt')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(result.receipt.id, 'receipt:' + result.executionId)
  assert.equal(result.receipt.invocation.toolId, 'attention_manifest_protocol_replace')
  assert.equal(result.receipt.invocation.context.sessionId, sessionId)
  assert.equal(readFileSync(join(root, 'live.txt'), 'utf8'), expected)
  assert.equal(prompts.length, 10)

  const attemptRead = await call(tools, 'action.get', { id: result.attemptId })
  assert.equal(attemptRead.origin, 'codex-live')
  assert.equal(attemptRead.attempt.state, 'succeeded')
  assert.equal(attemptRead.attempt.actionId, result.actionId)
  const attemptList = await call(tools, 'action.list', { taskId: task.id })
  assert.equal(attemptList.origin, 'codex-live')
  assert.equal(attemptList.total, 1)
  assert.equal(attemptList.attempts[0].attemptId, result.attemptId)
  const activated = await call(tools, 'task.get', { id: task.id })
  assert.equal(activated.entity.state, 'active')

  // Replay returns the same native facts without a second action or receipt.
  const replay = await call(tools, 'replace', input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.id, result.receipt.id)
  assert.equal(prompts.length, 10)
  assert.equal(nativeRows(root, 'action_attempt').length, 1)
  assert.equal(nativeRows(root, 'receipt').length, 1)

  const review = await call(tools, 'evidence_review', { receiptId: result.receipt.id, claim: 'The live file contains BETA', criteriaVersion: 'live-file/1', idempotencyKey: 'live-replace-evidence' })
  assert.equal(review.approved, true)
  assert.equal(review.verification.status, 'semantic_verified')
  assert.equal(review.acceptanceGranted, false)
  const cited = await call(tools, 'evidence.cite', { ids: [review.evidence.id] })
  assert.equal(cited.citations.length, 1)
  assert.equal(cited.citations[0].receiptId, result.receipt.id)
  assert.equal(cited.acceptanceGranted, false)
})

test('live and imported scopes cannot admit each other\'s tasks and foreign goals are rejected', async t => {
  const root = makeWorkspace(t)
  const original = 'untouched\n'
  writeFileSync(join(root, 'live.md'), original)
  const prompts = approvals(t)
  await seedGoal(root, 'imported-goal')
  await transact(root, context => createPlan(context, planPayload('imported-plan', 'imported-goal')))
  const tools = toolsFor(root)
  const preview = await call(tools, 'migration', { action: 'preview' })
  const imported = await call(tools, 'migration', { action: 'import', sourceDigest: preview.sourceDigest })
  const importedTaskId = imported.references['task:imported-plan:write-server']
  assert.ok(importedTaskId, 'the imported snapshot exposes its native task id')
  const foreign = seedForeignChain(root)
  const { goal } = await bootstrapLive(tools, root, 'thread-live-scope', 'scope')
  const { tasks } = await draftAndReady(tools, goal.id, submissionFor('live-scope-plan', ['live-scope-task']), 'scope')
  const liveTask = tasks[0]
  const afterSetup = prompts.length

  // A complete, executable foreign task is still outside the selected live thread.
  const base = { path: 'live.md', content: 'foreign write\n', expectedHash: sha(original) }
  await assert.rejects(call(tools, 'workspace.write', { ...base, taskId: foreign.taskId, idempotencyKey: 'foreign-task-write' }), /Task must belong to selected workflow and be ready\/active/)
  await assert.rejects(call(tools, 'replace', { path: 'live.md', mode: 'string', text: 'untouched', replacement: 'foreign edit', taskId: foreign.taskId, idempotencyKey: 'foreign-task-replace' }), /Task must belong to selected workflow and be ready\/active/)
  // A foreign Goal cannot become the target of a live draft.
  await assert.rejects(call(tools, 'plan.propose_draft', { idempotencyKey: 'foreign-goal-draft', targetId: foreign.goalId, submission: submissionFor('foreign-plan', ['foreign-task']) }), /outside the selected workflow scope/)
  assert.equal(prompts.length, afterSetup, 'scope rejections never request host approval')

  // An imported selection cannot admit the live task.
  await call(tools, 'workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  await assert.rejects(call(tools, 'workspace.write', { ...base, taskId: liveTask.id, idempotencyKey: 'imported-selected-live-write' }), /Selected workflow is not active|Task must belong to selected workflow and be ready\/active/)
  await assert.rejects(call(tools, 'replace', { path: 'live.md', mode: 'string', text: 'untouched', replacement: 'imported edit', taskId: liveTask.id, idempotencyKey: 'imported-selected-live-replace' }), /Selected workflow is not active|Task must belong to selected workflow and be ready\/active/)
  assert.equal(prompts.length, afterSetup)

  // A live selection cannot admit the imported task either.
  const liveTools = toolsFor(root)
  await call(liveTools, 'session.get', { threadId: 'thread-live-scope' })
  await assert.rejects(call(liveTools, 'workspace.write', { ...base, taskId: importedTaskId, idempotencyKey: 'live-selected-imported-write' }), /Task must belong to selected workflow and be ready\/active/)
  await assert.rejects(call(liveTools, 'replace', { path: 'live.md', mode: 'string', text: 'untouched', replacement: 'live edit', taskId: importedTaskId, idempotencyKey: 'live-selected-imported-replace' }), /Task must belong to selected workflow and be ready\/active/)
  assert.equal(prompts.length, afterSetup)

  // Nothing was approved, journaled or changed by the cross-scope attempts.
  assert.equal(readFileSync(join(root, 'live.md'), 'utf8'), original)
  assert.deepEqual(nativeRows(root, 'receipt'), [])
  assert.equal(nativeRows(root, 'action').length, 0)
  assert.deepEqual(withStore(root, store => store.events({ kind: 'codex.amp.workspace.write' })), [])
  assert.deepEqual(withStore(root, store => store.events({ kind: 'codex.amp.workspace.replace' })), [])
  // The live task remained ready: no admitted file effect transitioned it.
  const current = await call(liveTools, 'task.get', { id: liveTask.id })
  assert.equal(current.entity.state, 'ready')
})
