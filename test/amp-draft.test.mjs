import test from 'node:test'
import assert from 'node:assert/strict'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { makeWorkspace, seedGoal } from './helpers.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'

test('native draft creation is scoped, transactional, restartable and consumes old pending proposals once', async t => {
  const root = makeWorkspace(t)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  await seedGoal(root, 'old-goal')
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const preview = await call('migration', { action: 'preview' })
  const imported = await call('migration', { action: 'import', sourceDigest: preview.sourceDigest })
  await call('workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  const goalId = imported.references['goal:old-goal']
  const submission = { id: 'native-draft', bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 86400000).toISOString(), progressMetric: 'Test succeeds', deadLetterOwner: 'host' }, tasks: [
    { id: 'dependent', dependsOn: ['first'], required: true, contractVersion: 'test/1', requiredEffects: ['verified'] },
    { id: 'first', dependsOn: [], required: true, contractVersion: 'test/1', requiredEffects: ['written'] },
  ] }
  const request = { idempotencyKey: 'draft-1', targetId: goalId, submission }
  await assert.rejects(call('plan.propose_draft', request), /active\/idle/)
  let { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    persistence.restoreAll()
    const transition = (kind, id, to) => persistence.transition(kind, id, to, { expectedVersion: persistence.workflow.get(kind, id).version, actor: 'test-host' })
    transition('session', imported.sessionId, 'resumed'); transition('session', imported.sessionId, 'active');
    const missionId = persistence.workflow.get('goal', goalId).missionId
    transition('mission', missionId, 'active'); transition('goal', goalId, 'active')
  } finally { store.close() }
  const draft = await call('plan.propose_draft', request)
  assert.equal(draft.plan.state, 'draft')
  assert.equal(draft.tasks.length, 2)
  assert.ok(draft.tasks.every(task => task.state === 'pending'))
  assert.equal(draft.executionAuthorized, false)
  let progressRequest = { id: draft.tasks[0].id, expectedVersion: draft.tasks[0].version, summary: 'Running the admitted action', idempotencyKey: 'progress-1' }
  await assert.rejects(call('task.report_progress', progressRequest), /no current running attempt/)
  const reportedTask = await call('task.get', { id: progressRequest.id })
  assert.equal(reportedTask.entity.state, 'pending')
  assert.deepEqual(reportedTask.progress, [])
  assert.equal((await call('plan.propose_draft', request)).replayed, true)
  const review = { kind: 'plan', id: draft.plan.id, to: 'approved', expectedVersion: draft.plan.version, idempotencyKey: 'approve-plan', reason: 'Approve reviewed bounded native plan' }
  configureHostClient({}, () => {})
  assert.equal((await call('workflow_review', review)).approved, false)
  let approvals = 0
  configureHostClient({ elicitation: {} }, message => {
    approvals++
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  assert.equal((await call('workflow_review', { ...review, idempotencyKey: 'approve-plan-2' })).entity.state, 'approved')
  const first = draft.tasks.find(task => task.id === 'first'), dependent = draft.tasks.find(task => task.id === 'dependent')
  await assert.rejects(call('workflow_review', { kind: 'task', id: dependent.id, to: 'ready', expectedVersion: dependent.version, idempotencyKey: 'blocked-dependent', reason: 'Not ready yet' }), /dependencies/)
  assert.equal(approvals, 1)
  await call('workflow_review', { kind: 'task', id: first.id, to: 'ready', expectedVersion: first.version, idempotencyKey: 'first-ready', reason: 'Admit reviewed first task' })
  const ready = await call('plan.ready_tasks', { id: draft.plan.id })
  assert.deepEqual(ready.tasks.map(task => task.id), ['first'])
  assert.equal(ready.executionAuthorized, false)
  let runningAttempt
  ;({ store } = openNativeStore(() => root))
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const restored = persistence.restoreAll()
    assert.deepEqual(restored.skipped, [])
    const plan = persistence.workflow.get('plan', draft.plan.id)
    persistence.transition('plan', plan.id, 'executing', { expectedVersion: plan.version, actor: 'test-host' })
    const task = persistence.workflow.get('task', first.id)
    const activeTask = persistence.transition('task', task.id, 'active', { expectedVersion: task.version, actor: 'test-host' })
    progressRequest = { id: activeTask.id, expectedVersion: activeTask.version, summary: 'Observed the admitted running action', idempotencyKey: 'progress-running' }
    const action = persistence.create('action', { id: 'first-action', sessionId: imported.sessionId, taskId: activeTask.id, operationId: 'first-operation', effect: 'written', required: false, sideEffect: true, recovery: 'query' }, 'test-host')
    const readyAction = persistence.transition('action', action.id, 'ready', { expectedVersion: action.version, actor: 'test-host' })
    runningAttempt = persistence.workflow.startAttempt(readyAction.id, { expectedVersion: readyAction.version, cancellationEpoch: 0, executionId: 'first-execution', attemptId: 'first-attempt', actor: 'test-host' })
    store.save('action', persistence.workflow.get('action', readyAction.id), { expectedVersion: readyAction.version })
    persistence.persistEvent(persistence.workflow.history().at(-1))
    persistence.persistAttempt(runningAttempt, { actor: 'test-host' })
  } finally { store.close() }
  const runningProgress = await call('task.report_progress', progressRequest)
  assert.equal(runningProgress.attemptId, runningAttempt.attemptId)
  assert.equal(runningProgress.executionId, runningAttempt.executionId)
  assert.equal((await call('task.report_progress', progressRequest)).replayed, true)
  const cyclic = structuredClone(submission); cyclic.id = 'cycle-plan'; cyclic.tasks[1].dependsOn = ['dependent']
  await assert.rejects(call('plan.propose_draft', { ...request, idempotencyKey: 'cycle', submission: cyclic }), /cyclic/)
  assert.equal((await call('plan.list')).total, 1)
  await assert.rejects(call('plan.propose_draft', { ...request, idempotencyKey: 'bad-date', submission: { ...submission, bounds: { ...submission.bounds, deadline: '2000-01-01T00:00:00Z' } } }), /future/)
  ;({ store } = openNativeStore(() => root))
  try {
    const old = { ...submission, id: 'old-submitted-plan', tasks: [{ ...submission.tasks[1], id: 'old-task' }] }
    store.appendEvent('codex.amp.submission', { id: 'old-submission', tool: 'attention_manifest_protocol_plan.propose_draft', binding: { tenantId: 'local', principalId: 'codex' }, parameters: { targetId: 'old-goal', submission: old } })
  } finally { store.close() }
  const consumed = await call('plan.propose_draft', { idempotencyKey: 'consume', submissionId: 'old-submission' })
  assert.equal(consumed.plan.goalId, goalId)
  assert.equal((await call('plan.propose_draft', { idempotencyKey: 'consume-again', submissionId: 'old-submission' })).replayed, true)
  assert.equal((await call('submissions')).submissions.find(item => item.id === 'old-submission').status, 'materialized_native_draft')
  const restarted = withAmpSurface([], () => root)
  await restarted.find(tool => tool.name === 'attention_manifest_protocol_workflow_scope').handler({ action: 'select', sourceDigest: preview.sourceDigest })
  assert.equal((await restarted.find(tool => tool.name === 'attention_manifest_protocol_plan.list').handler({})).total, 2)
  const persistedTask = await restarted.find(tool => tool.name === 'attention_manifest_protocol_task.get').handler({ id: progressRequest.id })
  assert.equal(persistedTask.progress[0].summary, progressRequest.summary)
  assert.equal(persistedTask.progress[0].attemptId, runningAttempt.attemptId)
  assert.equal(persistedTask.progress.length, 1)
  assert.equal((await restarted.find(tool => tool.name === 'attention_manifest_protocol_task.report_progress').handler(progressRequest)).replayed, true)
})
