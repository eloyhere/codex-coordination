/**
 * Canonical plan/task lifecycle on the selected live Codex workflow.
 *
 * The live chain is host-owned: hooks create the native Session/Turn/Intent,
 * the WP6 bootstrap extension accepts the Intent and activates Mission/Goal, and
 * only then may the model propose a draft, request host review of the bounded
 * plan/task transitions and report a version-anchored progress claim for a
 * unique running ActionAttempt. Imported-snapshot behaviour is covered by
 * `test/amp-draft.test.mjs` and `test/amp-workflow-review.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { workflowBindings } from '../plugins/codex-coordination/mcp/amp/workflow.mjs'
import { bootstrapTool } from '../plugins/codex-coordination/mcp/amp/workflow-bootstrap.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: 'test-connection', policyVersion: 'test', cancellationEpoch: 0 })
const REVIEW = 'workflow_review'
const DRAFT = 'plan.propose_draft'
const PROGRESS = 'task.report_progress'

function toolsFor(root, thread = 'thread-live', selected = new Map()) {
  return [
    ...workflowBindings(binding, () => root, selected, () => thread),
    bootstrapTool(binding, () => root, selected, () => thread),
  ]
}

function call(tools, name, args = {}) {
  const tool = tools.find(item => item.name === 'attention_manifest_protocol_' + name)
  assert.ok(tool, `missing attention_manifest_protocol_${name}`)
  return tool.handler(args)
}

/** Accept every host elicitation in a queued microtask, like the WP6 bootstrap test. */
function approvals(t, decision = 'approve') {
  const requests = []
  configureHostClient({ elicitation: {} }, message => {
    requests.push(message)
    queueMicrotask(() => acceptHostResponse({
      id: message.id,
      result: decision === 'reject' ? { action: 'decline' } : { action: 'accept', content: { decision: 'approve' } },
    }))
  })
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  return requests
}

function threadSession(root, threadId) {
  const store = openCodexStore(root)
  try {
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(event => event.payload).find(item => item.threadId === threadId)
    assert.ok(mapping, `SessionStart must map ${threadId} to a native session`)
    return mapping.sessionId
  } finally { store.close() }
}

function canonicalRoot(root) {
  const { root: canonical, store } = openNativeStore(() => root)
  store.close()
  return canonical
}

function mutate(root, operation) {
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    return operation(persistence, store)
  } finally { store.close() }
}

function submissionFor(id, deadlineOffset = 86_400_000) {
  return {
    id,
    bounds: { maxAttempts: 2, deadline: new Date(Date.now() + deadlineOffset).toISOString(), progressMetric: 'live task succeeds', deadLetterOwner: 'host' },
    tasks: [
      { id: id + '-first', dependsOn: [], required: true, contractVersion: 'test/1', requiredEffects: ['written'] },
      { id: id + '-dependent', dependsOn: [id + '-first'], required: true, contractVersion: 'test/1', requiredEffects: ['verified'] },
    ],
  }
}

/** Capture the live thread and run the host-only Intent → Mission → Goal bootstrap. */
async function bootstrapLiveChain(tools, root, threadId, suffix) {
  ingestHook({ cwd: root, session_id: threadId, hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: threadId, turn_id: threadId + '-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Live plan lifecycle ' + suffix })
  const sessionId = threadSession(root, threadId)
  const intents = await call(tools, 'intent.list')
  assert.equal(intents.origin, 'codex-live')
  assert.equal(intents.threadId, threadId)
  assert.equal(intents.total, 1)
  const intent = intents.entities[0]
  assert.equal(intent.state, 'captured')
  const accepted = await call(tools, 'workflow_bootstrap', { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: suffix + '-accept' })
  const mission = await call(tools, 'workflow_bootstrap', { action: 'create_mission', intentId: intent.id, expectedVersion: accepted.intent.version, idempotencyKey: suffix + '-mission' })
  const activeMission = await call(tools, 'workflow_bootstrap', { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: mission.mission.version, idempotencyKey: suffix + '-mission-active' })
  const goal = await call(tools, 'workflow_bootstrap', { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'live-plan/1', acceptanceCriteria: ['A reviewed live plan exists', 'A live task becomes ready'], idempotencyKey: suffix + '-goal' })
  const activeGoal = await call(tools, 'workflow_bootstrap', { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: suffix + '-goal-active' })
  assert.equal(activeGoal.goal.state, 'active')
  assert.equal(activeGoal.goal.sessionId, sessionId)
  return { sessionId, intent, mission: activeMission.mission, goal: activeGoal.goal }
}

/** Seed a complete chain that belongs to another scope (never selected live). */
function seedForeignChain(root, prefix = 'foreign') {
  return mutate(root, persistence => {
    const sessionId = prefix + '-session'
    const create = (kind, input) => persistence.create(kind, { ...input, sessionId }, 'test-host')
    const transition = (kind, id, to) => persistence.transition(kind, id, to, { expectedVersion: persistence.workflow.get(kind, id).version, actor: 'test-host' })
    create('session', { id: sessionId, sessionId, participants: ['test-host'], sessionType: 'autonomous' })
    transition('session', sessionId, 'active')
    create('turn', { id: prefix + '-turn', classification: 'new_intent' }); transition('turn', prefix + '-turn', 'interpreting')
    let intent = create('intent', { id: prefix + '-intent', originTurnId: prefix + '-turn', text: 'Foreign lifecycle fixture' })
    transition('intent', intent.id, 'confirmed'); transition('intent', intent.id, 'accepted')
    create('mission', { id: prefix + '-mission', intentId: intent.id })
    let goal = create('goal', { id: prefix + '-goal', missionId: prefix + '-mission', contractVersion: 'test/1', acceptanceCriteria: ['foreign'] })
    transition('goal', goal.id, 'active')
    const plan = create('plan', { id: prefix + '-plan', goalId: goal.id, bounds: { maxAttempts: 1, deadline: new Date(Date.now() + 86_400_000).toISOString(), progressMetric: 'foreign', deadLetterOwner: 'test-host' } })
    const task = create('task', { id: prefix + '-task', planId: plan.id, contractVersion: 'test/1', dependsOn: [], required: false, requiredEffects: [] })
    return { sessionId, goalId: goal.id, planId: plan.id, taskId: task.id }
  })
}

/** A live-scope draft plan whose bounds already expired; only host review can reject it. */
function seedExpiredPlan(root, sessionId, goalId, prefix = 'expired-live') {
  return mutate(root, persistence => {
    const plan = persistence.create('plan', { id: prefix + '-plan', sessionId, goalId, bounds: { maxAttempts: 1, deadline: '2000-01-01T00:00:00Z', progressMetric: 'expired', deadLetterOwner: 'test-host' } }, 'test-host')
    persistence.create('task', { id: prefix + '-task', sessionId, planId: plan.id, contractVersion: 'test/1', dependsOn: [], required: false, requiredEffects: [] }, 'test-host')
    return plan.id
  })
}

/** Give one ready live task a unique running ActionAttempt through the real kernel. */
function seedRunningAttempt(root, sessionId, taskId, prefix = 'live') {
  return mutate(root, (persistence, store) => {
    const task = persistence.workflow.get('task', taskId)
    const activeTask = persistence.transition('task', taskId, 'active', { expectedVersion: task.version, actor: 'test-host', reason: 'Host admits the reviewed live task for one attempt' })
    const action = persistence.create('action', { id: prefix + '-action', sessionId, taskId, operationId: prefix + '-operation', effect: 'written', required: false, sideEffect: true, recovery: 'query' }, 'test-host')
    const readyAction = persistence.transition('action', action.id, 'ready', { expectedVersion: action.version, actor: 'test-host' })
    const running = persistence.workflow.startAttempt(readyAction.id, { expectedVersion: readyAction.version, cancellationEpoch: 0, executionId: prefix + '-execution', attemptId: prefix + '-attempt', actor: 'test-host' })
    store.save('action', persistence.workflow.get('action', readyAction.id), { expectedVersion: readyAction.version })
    persistence.persistEvent(persistence.workflow.history().at(-1))
    persistence.persistAttempt(running, { actor: 'test-host' })
    return { task: activeTask, action: persistence.workflow.get('action', readyAction.id), attempt: running }
  })
}

test('a live active Goal supports draft, reviewed plan/task admission and a running-attempt progress claim', async t => {
  const root = makeWorkspace(t)
  const requests = approvals(t)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLiveChain(tools, root, 'thread-live', 'lifecycle')
  assert.equal(requests.length, 5, 'bootstrap asks one host approval per host step')

  // 1. The model proposes a draft against the live active Goal: no approval and
  // no execution happen, and the DAG is materialized as pending tasks.
  const submission = submissionFor('live-plan')
  const request = { idempotencyKey: 'live-draft-1', targetId: goal.id, submission }
  const draft = await call(tools, DRAFT, request)
  assert.equal(draft.plan.state, 'draft')
  assert.equal(draft.plan.sessionId, sessionId)
  assert.equal(draft.plan.goalId, goal.id)
  assert.deepEqual(draft.plan.bounds, submission.bounds)
  assert.equal(draft.tasks.length, 2)
  assert.ok(draft.tasks.every(task => task.state === 'pending'))
  assert.ok(draft.tasks.every(task => task.sessionId === sessionId))
  assert.equal(draft.origin, 'codex-live')
  assert.equal(draft.scope, sessionId)
  assert.equal(draft.approval, 'not_granted')
  assert.equal(draft.executionAuthorized, false)
  assert.equal(requests.length, 5, 'draft creation must never request host approval')
  const replayed = await call(tools, DRAFT, request)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.plan.id, draft.plan.id)
  assert.deepEqual(replayed.tasks.map(task => [task.id, task.state, task.version]), draft.tasks.map(task => [task.id, task.state, task.version]))
  const planRead = await call(tools, 'plan.get', { id: draft.plan.id })
  assert.equal(planRead.origin, 'codex-live')
  assert.equal(planRead.threadId, 'thread-live')
  assert.equal(planRead.entity.state, 'draft')
  assert.equal(planRead.entity.version, draft.plan.version)
  assert.equal((await call(tools, 'task.get', { id: 'live-plan-first' })).entity.state, 'pending')

  // 2. Every live transition still requires its own independent host approval.
  const planApproved = await call(tools, REVIEW, { kind: 'plan', id: draft.plan.id, to: 'approved', expectedVersion: draft.plan.version, idempotencyKey: 'live-plan-approved', reason: 'Approve reviewed live plan bounds' })
  assert.equal(planApproved.approved, true)
  assert.equal(planApproved.entity.state, 'approved')
  assert.equal(planApproved.entity.version, draft.plan.version + 1)
  assert.equal(requests.length, 6)
  const planExecuting = await call(tools, REVIEW, { kind: 'plan', id: draft.plan.id, to: 'executing', expectedVersion: planApproved.entity.version, idempotencyKey: 'live-plan-executing', reason: 'Start the approved live plan without granting task acceptance' })
  assert.equal(planExecuting.entity.state, 'executing')
  assert.equal(planExecuting.entity.version, planApproved.entity.version + 1)
  assert.equal(requests.length, 7)
  const taskProposed = await call(tools, REVIEW, { kind: 'task', id: 'live-plan-first', to: 'proposed', expectedVersion: 0, idempotencyKey: 'live-task-proposed', reason: 'Host proposes the first live task' })
  assert.equal(taskProposed.entity.state, 'proposed')
  assert.equal(taskProposed.entity.version, 1)
  assert.equal(requests.length, 8)
  const taskReady = await call(tools, REVIEW, { kind: 'task', id: 'live-plan-first', to: 'ready', expectedVersion: taskProposed.entity.version, idempotencyKey: 'live-task-ready', reason: 'Admit the reviewed first live task' })
  assert.equal(taskReady.entity.state, 'ready')
  assert.equal(taskReady.entity.version, taskProposed.entity.version + 1)
  assert.equal(requests.length, 9)
  // A dependent live task still cannot become ready before its dependency.
  await assert.rejects(call(tools, REVIEW, { kind: 'task', id: 'live-plan-dependent', to: 'ready', expectedVersion: 0, idempotencyKey: 'live-dependent-ready', reason: 'Dependency is not satisfied' }), /dependencies/)
  assert.equal(requests.length, 9, 'a rejected admission never asks the host for approval')

  // 3. Progress is a claim: it needs exactly one running host attempt and never
  // changes the task state.
  const noAttempt = { id: 'live-plan-first', expectedVersion: taskReady.entity.version, summary: 'No host attempt is running yet', idempotencyKey: 'live-progress-none' }
  await assert.rejects(call(tools, PROGRESS, noAttempt), /no current running attempt/)
  const before = await call(tools, 'task.get', { id: 'live-plan-first' })
  assert.equal(before.entity.state, 'ready')
  assert.equal(before.entity.version, taskReady.entity.version)
  assert.deepEqual(before.progress, [])

  const seeded = seedRunningAttempt(root, sessionId, 'live-plan-first')
  assert.equal(seeded.task.state, 'active')
  const claimRequest = { id: 'live-plan-first', expectedVersion: seeded.task.version, summary: 'Observed the admitted live action', idempotencyKey: 'live-progress-1' }
  const claim = await call(tools, PROGRESS, claimRequest)
  assert.equal(claim.attemptId, seeded.attempt.attemptId)
  assert.equal(claim.executionId, seeded.attempt.executionId)
  assert.equal(claim.operationId, seeded.action.operationId)
  assert.equal(claim.taskVersion, seeded.task.version)
  assert.equal(claim.taskState, 'active')
  assert.equal(claim.verified, false)
  assert.equal(claim.source, 'agent-progress-claim')
  assert.equal(claim.replayed, false)
  assert.equal((await call(tools, PROGRESS, claimRequest)).replayed, true)
  await assert.rejects(call(tools, PROGRESS, { ...claimRequest, expectedVersion: 0, idempotencyKey: 'live-progress-stale' }), /version changed/)
  const after = await call(tools, 'task.get', { id: 'live-plan-first' })
  assert.equal(after.entity.state, 'active', 'a progress claim never transitions the task')
  assert.equal(after.entity.version, seeded.task.version, 'a progress claim never bumps the task version')
  assert.equal(after.progress.length, 1)
  assert.equal(after.progress[0].attemptId, seeded.attempt.attemptId)
  assert.equal(after.progress[0].taskVersion, seeded.task.version)
  assert.equal((await call(tools, 'plan.get', { id: draft.plan.id })).entity.state, 'executing')
  assert.equal(requests.length, 9, 'no progress call requested host approval')
})

test('live draft and review reject foreign scope, cross-origin goals, expired bounds and invalid DAGs', async t => {
  const root = makeWorkspace(t)
  const requests = approvals(t)
  const tools = toolsFor(root)
  const { sessionId, goal } = await bootstrapLiveChain(tools, root, 'thread-live', 'rejections')
  assert.equal(requests.length, 5)
  const foreign = seedForeignChain(root)

  // Expired bounds, duplicate ids, cycles and missing dependencies are rejected
  // before any plan, task or approval exists.
  const expired = submissionFor('expired-plan')
  expired.bounds.deadline = '2000-01-01T00:00:00Z'
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'expired-bounds', targetId: goal.id, submission: expired }), /future/)
  const duplicate = submissionFor('duplicate-plan')
  duplicate.tasks[1].id = duplicate.tasks[0].id
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'duplicate-tasks', targetId: goal.id, submission: duplicate }), /Duplicate task id/)
  const cyclic = submissionFor('cycle-plan')
  cyclic.tasks[0].dependsOn = ['cycle-plan-dependent']
  cyclic.tasks[1].dependsOn = ['cycle-plan-first']
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'cyclic-tasks', targetId: goal.id, submission: cyclic }), /cyclic/)
  const missing = submissionFor('missing-plan')
  missing.tasks[0].dependsOn = ['missing-task']
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'missing-dependency', targetId: goal.id, submission: missing }), /cyclic|missing/)

  // A foreign Goal (another workflow scope) and an imported reference key are
  // both refused while the live scope is selected.
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'foreign-goal', targetId: foreign.goalId, submission: submissionFor('foreign-plan') }), /outside the selected workflow scope/)
  await assert.rejects(call(tools, DRAFT, { idempotencyKey: 'imported-reference', targetId: 'legacy-goal-reference', submission: submissionFor('legacy-plan') }), /does not exist/)
  assert.equal(requests.length, 5, 'rejected proposals never request approval')

  // Review of a plan or task from another scope is rejected before approval.
  await assert.rejects(call(tools, REVIEW, { kind: 'plan', id: foreign.planId, to: 'approved', expectedVersion: 0, idempotencyKey: 'foreign-plan-review', reason: 'Foreign plan must not enter this workflow' }), /outside the selected workflow scope/)
  await assert.rejects(call(tools, REVIEW, { kind: 'task', id: foreign.taskId, to: 'ready', expectedVersion: 0, idempotencyKey: 'foreign-task-review', reason: 'Foreign task must not become ready here' }), /outside the selected workflow scope/)
  // Live plan admission still checks future bounds.
  const expiredLivePlan = seedExpiredPlan(root, sessionId, goal.id)
  await assert.rejects(call(tools, REVIEW, { kind: 'plan', id: expiredLivePlan, to: 'approved', expectedVersion: 0, idempotencyKey: 'expired-live-review', reason: 'Expired bounds must be re-drafted' }), /expired/)
  assert.equal(requests.length, 5, 'scope and bounds rejections never request approval')

  // The opposite direction: an imported selection cannot admit the live Goal.
  const selected = new Map([[canonicalRoot(root), foreign.sessionId]])
  const importedTools = toolsFor(root, 'thread-live', selected)
  await assert.rejects(call(importedTools, DRAFT, { idempotencyKey: 'imported-live-goal', targetId: goal.id, submission: submissionFor('imported-plan') }), /outside the selected workflow scope/)
  assert.equal(requests.length, 5)

  // No plan or task from the rejected proposals was persisted in either scope;
  // the only live plan is the deliberately expired fixture used above.
  const liveTasks = await call(tools, 'task.list_ready')
  assert.deepEqual(liveTasks.tasks, [])
  assert.equal(liveTasks.origin, 'codex-live')
  const livePlans = await call(tools, 'plan.list')
  assert.equal(livePlans.total, 1)
  assert.equal(livePlans.entities[0].id, expiredLivePlan)
  assert.equal(livePlans.entities[0].state, 'draft')
})
