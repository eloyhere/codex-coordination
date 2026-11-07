import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeWorkspace } from './helpers.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'

const moduleRoot = process.env.AMP_ATTEMPT_TEST_MODULE_ROOT
  ? pathToFileURL(resolve(process.env.AMP_ATTEMPT_TEST_MODULE_ROOT) + '/').href
  : new URL('../plugins/codex-coordination/mcp/amp/', import.meta.url).href
const { workflowBindings } = await import(moduleRoot + 'workflow.mjs')
const { openNativeStore } = await import(moduleRoot + 'native-store.mjs')
const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'mcp-connection', policyVersion: 'test', cancellationEpoch: 0 }

function mutate(root, operation) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(p.restoreAll().skipped, [])
    return operation(p, store)
  } finally { store.close() }
}
function kernelCommand(p, store, operation) {
  const before = p.workflow.snapshot()
  const result = operation(p.workflow)
  const after = p.workflow.snapshot()
  store.transaction(() => {
    for (const entity of after.entities) {
      const previous = before.entities.find(value => value.kind === entity.kind && value.id === entity.id)
      if (previous && previous.version !== entity.version) store.save(entity.kind, entity, { expectedVersion: previous.version })
    }
    for (const event of after.events.slice(before.events.length)) p.persistEvent(event)
    for (const attempt of after.attempts) {
      const previous = before.attempts.find(value => value.attemptId === attempt.attemptId)
      if (!previous || previous.version !== attempt.version) p.persistAttempt(attempt, { actor: 'test-host' })
    }
  })
  return result
}
function seed(root, prefix = 'one', start = true) {
  return mutate(root, (p, store) => {
    const sessionId = prefix + '-session', taskId = prefix + '-task', actionId = prefix + '-action', attemptId = prefix + '-attempt'
    const create = (kind, input) => p.create(kind, { ...input, sessionId }, 'test-host')
    const transition = (kind, id, to) => p.transition(kind, id, to, { expectedVersion: p.workflow.get(kind, id).version, actor: 'test-host' })
    create('session', { id: sessionId, rootId: createHash('sha256').update(root).digest('hex'), participants: ['test-host'] })
    transition('session', sessionId, 'active')
    create('turn', { id: prefix + '-turn', classification: 'steering' }); transition('turn', prefix + '-turn', 'interpreting')
    create('intent', { id: prefix + '-intent', originTurnId: prefix + '-turn', text: 'exercise real attempts' })
    transition('intent', prefix + '-intent', 'confirmed'); transition('intent', prefix + '-intent', 'accepted')
    create('mission', { id: prefix + '-mission', intentId: prefix + '-intent', title: 'test', statement: 'test' }); transition('mission', prefix + '-mission', 'active')
    create('goal', { id: prefix + '-goal', missionId: prefix + '-mission', contractVersion: '1', acceptanceCriteria: ['real attempt recorded'], statement: 'test' }); transition('goal', prefix + '-goal', 'active')
    create('plan', { id: prefix + '-plan', goalId: prefix + '-goal', bounds: { maxAttempts: 3, deadline: new Date(Date.now() + 600000).toISOString(), progressMetric: 'test', deadLetterOwner: 'test-host' } })
    create('task', { id: taskId, planId: prefix + '-plan', contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] })
    create('task', { id: prefix + '-pending', planId: prefix + '-plan', contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] })
    transition('plan', prefix + '-plan', 'approved'); transition('plan', prefix + '-plan', 'executing')
    transition('task', taskId, 'ready'); transition('task', taskId, 'active')
    create('action', { id: actionId, taskId, operationId: prefix + '-operation', effect: 'test', required: false, sideEffect: true, recovery: 'query' }); transition('action', actionId, 'ready')
    if (start) kernelCommand(p, store, workflow => workflow.startAttempt(actionId, { expectedVersion: workflow.get('action', actionId).version, cancellationEpoch: 0, executionId: prefix + '-execution', attemptId, actor: 'test-host' }))
    return { sessionId, taskId, actionId, attemptId, taskVersion: p.workflow.get('task', taskId).version }
  })
}
function toolsFor(root, sessionId, bound = binding) {
  const { root: canonicalRoot, store } = openNativeStore(() => root); store.close()
  const tools = workflowBindings(bound, () => root, new Map([[canonicalRoot, sessionId]]))
  return (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
}

test('action.get reads attempt identity and action.list filters real attempts by task in selected session', async t => {
  const root = makeWorkspace(t), one = seed(root), foreign = seed(root, 'foreign')
  const call = toolsFor(root, one.sessionId)
  const result = await call('action.get', { id: one.attemptId })
  assert.equal(result.attempt.attemptId, one.attemptId)
  assert.equal(result.attempt.executionId, 'one-execution')
  assert.equal(result.attempt.operationId, 'one-operation')
  assert.equal(result.attempt.state, 'running')
  const listed = await call('action.list', { taskId: one.taskId })
  assert.deepEqual(listed.attempts, [result.attempt])
  assert.equal(listed.total, 1)
  assert.deepEqual((await call('action.list', { taskId: 'one-pending' })).attempts, [])
  await assert.rejects(call('action.get', { id: one.actionId }), /does not exist/)
  await assert.rejects(call('action.get', { id: foreign.attemptId }), /outside the selected workflow scope/)
  await assert.rejects(call('action.list', { taskId: foreign.taskId }), /outside the selected workflow scope/)
  await assert.rejects(call('action.list'), /taskId is required/)
})

test('progress binds unique real running attempt, persists identity, rejects stale version, and replays settled keys only', async t => {
  const root = makeWorkspace(t), one = seed(root)
  seed(root, 'foreign') // Foreign running attempts do not make the selected scope ambiguous.
  const call = toolsFor(root, one.sessionId)
  const request = { id: one.taskId, expectedVersion: one.taskVersion, summary: 'Observed host execution', idempotencyKey: 'progress' }
  const result = await call('task.report_progress', request)
  assert.equal(result.attemptId, one.attemptId)
  assert.equal(result.executionId, 'one-execution')
  assert.equal(result.operationId, 'one-operation')
  assert.equal(result.cancellationEpoch, 0)
  assert.equal(result.verified, false)
  assert.equal((await call('task.report_progress', request)).replayed, true)
  await assert.rejects(call('task.report_progress', { ...request, summary: 'changed' }), /different progress report/)
  await assert.rejects(call('task.report_progress', { ...request, expectedVersion: 99, idempotencyKey: 'stale' }), /version changed/)
  await assert.rejects(call('task.report_progress', { ...request, attemptId: 'foreign-attempt', idempotencyKey: 'spoof' }), /bound by the host|Unknown progress parameter/)
  assert.equal((await call('task.get', { id: one.taskId })).progress[0].attemptId, one.attemptId)
  mutate(root, (p, store) => kernelCommand(p, store, workflow => workflow.settleAttempt(one.attemptId, { expectedVersion: 0, expectedActionVersion: workflow.get('action', one.actionId).version, outcome: 'succeeded', actor: 'test-host' })))
  const restarted = toolsFor(root, one.sessionId)
  assert.equal((await restarted('task.report_progress', request)).replayed, true)
  await assert.rejects(restarted('task.report_progress', { ...request, idempotencyKey: 'new-after-settlement' }), /no current running attempt/)
  assert.equal((await restarted('task.get', { id: one.taskId })).progress.length, 1)
})

test('progress fails closed for pending/no attempt, mismatched task and ambiguous concurrent executions', async t => {
  const root = makeWorkspace(t), one = seed(root, 'one', false)
  const call = toolsFor(root, one.sessionId)
  await assert.rejects(call('task.report_progress', { id: 'one-pending', expectedVersion: 0, summary: 'not started', idempotencyKey: 'pending' }), /no current running attempt/)
  await assert.rejects(call('task.report_progress', { id: one.taskId, expectedVersion: one.taskVersion, summary: 'not started', idempotencyKey: 'no-attempt' }), /no current running attempt/)
  mutate(root, (p, store) => kernelCommand(p, store, workflow => workflow.startAttempt(one.actionId, { expectedVersion: workflow.get('action', one.actionId).version, cancellationEpoch: 0, executionId: 'one-execution', attemptId: one.attemptId, actor: 'test-host' })))
  await assert.rejects(call('task.report_progress', { id: 'one-pending', expectedVersion: 0, summary: 'wrong task', idempotencyKey: 'mismatch' }), /does not match the current host attempt/)
  mutate(root, (p, store) => {
    const action = p.create('action', { id: 'second-action', sessionId: one.sessionId, taskId: one.taskId, operationId: 'second-operation', effect: 'test', required: false, sideEffect: false, recovery: 'idempotent' }, 'test-host')
    p.transition('action', action.id, 'ready', { expectedVersion: action.version, actor: 'test-host' })
    kernelCommand(p, store, workflow => workflow.startAttempt(action.id, { expectedVersion: workflow.get('action', action.id).version, cancellationEpoch: 0, executionId: 'second-execution', attemptId: 'second-attempt', actor: 'test-host' }))
  })
  await assert.rejects(call('task.report_progress', { id: one.taskId, expectedVersion: one.taskVersion, summary: 'ambiguous', idempotencyKey: 'ambiguous' }), /ambiguous running attempts/)
  mutate(root, (_p, store) => assert.equal(store.events({ kind: 'codex.amp.task.progress' }).length, 0))
})

test('explicit host attempt scope rejects foreign and stale bindings; cancellation epochs fence new reports', async t => {
  const root = makeWorkspace(t), one = seed(root), foreign = seed(root, 'foreign')
  const request = { id: one.taskId, expectedVersion: one.taskVersion, summary: 'host scoped', idempotencyKey: 'host' }
  await assert.rejects(toolsFor(root, one.sessionId, { ...binding, attemptId: foreign.attemptId })('task.report_progress', request), /outside the selected workflow scope/)
  await assert.rejects(toolsFor(root, one.sessionId, { ...binding, attemptId: one.attemptId, cancellationEpoch: 1 })('task.report_progress', request), /stale cancellation epoch/)
  const call = toolsFor(root, one.sessionId, { ...binding, attemptId: one.attemptId })
  assert.equal((await call('task.report_progress', request)).attemptId, one.attemptId)
  mutate(root, (p, store) => kernelCommand(p, store, workflow => workflow.requestCancel('task', one.taskId, { expectedVersion: one.taskVersion, actor: 'test-host' })))
  assert.equal((await call('task.report_progress', request)).replayed, true)
  await assert.rejects(call('task.report_progress', { ...request, idempotencyKey: 'cancelled' }), /epoch changed|Cancellation prevents/)
})
