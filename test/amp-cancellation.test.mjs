import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { workflowCancelReview } from '../plugins/codex-coordination/mcp/amp/cancellation.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection' }
function fixture(root) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const create = (kind, input) => p.create(kind, { ...input, sessionId: 'session' }, 'fixture')
    const move = (kind, id, to) => p.transition(kind, id, to, { expectedVersion: p.workflow.get(kind, id).version, actor: 'fixture' })
    create('session', { id: 'session', participants: ['codex'] }); move('session', 'session', 'active')
    create('turn', { id: 'turn', classification: 'new_intent' }); move('turn', 'turn', 'interpreting')
    create('intent', { id: 'intent', originTurnId: 'turn', text: 'Cancel fixture' }); move('intent', 'intent', 'confirmed'); move('intent', 'intent', 'accepted')
    create('mission', { id: 'mission', intentId: 'intent' }); move('mission', 'mission', 'active')
    create('goal', { id: 'goal', missionId: 'mission', contractVersion: 'v1', acceptanceCriteria: ['accepted'] }); move('goal', 'goal', 'active')
    create('plan', { id: 'plan', goalId: 'goal', bounds: { maxAttempts: 3, deadline: '2099-01-01T00:00:00Z', progressMetric: 'accepted', deadLetterOwner: 'codex' } })
    create('task', { id: 'task', planId: 'plan', dependsOn: [], contractVersion: 'v1', required: true, requiredEffects: ['write'] })
    move('plan', 'plan', 'approved'); move('plan', 'plan', 'executing'); move('task', 'task', 'ready'); move('task', 'task', 'active')
    create('action', { id: 'action', taskId: 'task', operationId: 'operation', effect: 'write', recovery: 'query', required: true, sideEffect: true }); move('action', 'action', 'ready')
    const before = p.workflow.get('action', 'action')
    const sequence = p.workflow.snapshot().sequence
    const attempt = p.workflow.startAttempt('action', { expectedVersion: before.version, cancellationEpoch: 0, executionId: 'execution', attemptId: 'attempt', actor: 'fixture' })
    store.transaction(() => {
      store.save('action', p.workflow.get('action', 'action'), { expectedVersion: before.version })
      for (const event of p.workflow.history().filter(event => event.sequence > sequence)) p.persistEvent(event)
      p.persistAttempt(attempt, { actor: 'fixture' })
    })
    return p.workflow.snapshot()
  } finally { store.close() }
}
function state(root) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const report = p.restoreAll()
    assert.deepEqual(report.skipped, [])
    return p.workflow
  } finally { store.close() }
}
const command = (kind = 'task', overrides = {}) => ({ operation: kind === 'intent' ? 'cascade' : 'request_cancel', kind, id: kind, expectedVersion: 0, idempotencyKey: 'cancel-' + kind, reason: 'Stop this work', ...overrides })
function input(root, kind = 'task', overrides = {}) { return command(kind, { expectedVersion: state(root).get(kind, kind).version, ...overrides }) }
function host(t, callback) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    callback?.(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
}

test('host cancellation persists native descendant epochs and running attempts without fabricating settlement', async t => {
  const root = makeWorkspace(t); fixture(root)
  let requests = 0
  host(t, () => requests++)
  const tool = workflowCancelReview(binding, () => root, () => 'session'), args = input(root)
  const result = await tool.handler(args)
  assert.equal(result.status, 'cancel_requested')
  assert.equal(result.executionSettled, false)
  assert.equal(result.cancellationEpoch, 1)
  assert.deepEqual(result.updated.map(entity => entity.kind).sort(), ['action', 'task'])
  assert.equal((await tool.handler(args)).replayed, true)
  assert.equal(requests, 1)
  const workflow = state(root)
  assert.equal(workflow.get('task', 'task').state, 'cancel_requested')
  assert.equal(workflow.get('action', 'action').cancellationEpoch, 1)
  assert.equal(workflow.getAttempt('attempt').state, 'running')
  assert.throws(() => workflow.assertExecutionAllowed('action', 0), /epoch|Cancellation/)
  assert.equal(workflow.get('plan', 'plan').cancellationEpoch, 0)
})

test('each work root and intent cascade uses the native kernel propagation', async t => {
  host(t)
  for (const kind of ['mission', 'goal', 'plan', 'action', 'intent']) {
    const root = makeWorkspace(t); fixture(root)
    const args = input(root, kind)
    const result = await workflowCancelReview(binding, () => root, () => 'session').handler(args)
    assert.equal(result.cancellationEpoch, 1)
    const workflow = state(root)
    assert.equal(workflow.get('action', 'action').cancellationEpoch, 1)
    assert.equal(workflow.get(kind, kind).state, kind === 'intent' ? 'superseded' : 'cancel_requested')
    assert.ok(workflow.history().filter(event => event.cancellationEpoch === 1).every(event => event.reason === args.reason && event.actor === 'mcp-host-review'))
  }
})

test('cancellation detaches arguments and fails full-head CAS when another entity changes', async t => {
  const root = makeWorkspace(t); fixture(root)
  const args = input(root)
  host(t, () => { args.reason = 'mutated'; args.id = 'other' })
  const tool = workflowCancelReview(binding, () => root, () => 'session')
  assert.equal((await tool.handler(args)).changed, true)
  assert.equal(state(root).history().at(-1).reason, 'Stop this work')
  const staleRoot = makeWorkspace(t); fixture(staleRoot)
  host(t, () => {
    const { store } = openNativeStore(() => staleRoot)
    try {
      const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
      const session = p.workflow.get('session', 'session')
      p.transition('session', session.id, 'idle', { expectedVersion: session.version, actor: 'other' })
    } finally { store.close() }
  })
  const stale = await workflowCancelReview(binding, () => staleRoot, () => 'session').handler(input(staleRoot))
  assert.equal(stale.status, 'stale_after_approval')
  assert.equal(state(staleRoot).get('task', 'task').state, 'active')
})

test('workspace and selected scope changes cannot apply an approved cancellation', async t => {
  for (const mode of ['workspace', 'scope']) {
    const root = makeWorkspace(t), other = makeWorkspace(t); fixture(root)
    let selected = 'session', workspace = root
    host(t, () => { if (mode === 'workspace') workspace = other; else selected = 'other' })
    const result = await workflowCancelReview(binding, () => workspace, () => selected).handler(input(root))
    assert.equal(result.status, 'stale_after_approval')
    assert.equal(state(root).get('task', 'task').state, 'active')
  }
})

test('rejection and missing host approval are durable; invalid input never requests approval', async t => {
  const root = makeWorkspace(t); fixture(root)
  const tool = workflowCancelReview(binding, () => root, () => 'session'), args = input(root)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({}, () => { throw new Error('No request expected') })
  assert.equal((await tool.handler(args)).status, 'rejected')
  assert.equal((await tool.handler(args)).replayed, true)
  await assert.rejects(tool.handler({ ...args, reason: 'another' }), /Idempotency/)
  await assert.rejects(tool.handler({ ...args, approved: true }), /parameter|Invalid/i)
  await assert.rejects(tool.handler({ ...args, idempotencyKey: 'stale', expectedVersion: 999 }), /version changed/)
  await assert.rejects(tool.handler({ ...args, operation: 'cascade' }), /Invalid cancellation/)
  assert.equal(state(root).get('task', 'task').state, 'active')
})

test('unresolved host requests never ask again and a journaled decision can resume safely', async t => {
  const root = makeWorkspace(t); fixture(root)
  const tool = workflowCancelReview(binding, () => root, () => 'session'), args = input(root)
  let requests = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, () => { requests++; throw new Error('Transport interrupted') })
  await assert.rejects(tool.handler(args), /Transport interrupted/)
  await assert.rejects(tool.handler(args), /unresolved/)
  await assert.rejects(tool.handler({ ...args, idempotencyKey: 'replacement-key' }), /unresolved/)
  assert.equal(requests, 1)
  const { store } = openNativeStore(() => root)
  try {
    const pending = store.events({ kind: 'codex.amp.workflow.cancel_requested' })[0].payload
    store.appendEvent('codex.amp.workflow.cancel_host_decision', { key: pending.key, request: pending.request, reviewId: pending.reviewId, approved: true })
  } finally { store.close() }
  assert.equal((await tool.handler(args)).status, 'cancel_requested')
  assert.equal(requests, 1)
})

test('CAS failure rolls back every descendant and event, then resumes the durable approval', async t => {
  const root = makeWorkspace(t); fixture(root)
  let requests = 0
  host(t, () => requests++)
  const tool = workflowCancelReview(binding, () => root, () => 'session'), args = input(root)
  const nativeSave = Store.prototype.save
  t.after(() => { Store.prototype.save = nativeSave })
  Store.prototype.save = function (kind, entity, options) {
    if (kind === 'action' && entity.cancellationEpoch === 1) throw new Error('Injected descendant CAS failure')
    return nativeSave.call(this, kind, entity, options)
  }
  await assert.rejects(tool.handler(args), /descendant CAS failure/)
  const unchanged = state(root)
  assert.equal(unchanged.get('task', 'task').state, 'active')
  assert.equal(unchanged.get('action', 'action').cancellationEpoch, 0)
  assert.ok(unchanged.history().every(event => event.cancellationEpoch === 0))
  Store.prototype.save = nativeSave
  assert.equal((await tool.handler(args)).status, 'cancel_requested')
  assert.equal(state(root).get('task', 'task').cancellationEpoch, 1)
  assert.equal(requests, 1)
})

test('scope callback failures close storage before propagating', async t => {
  const root = makeWorkspace(t); fixture(root)
  const nativeClose = Store.prototype.close
  let closes = 0
  t.after(() => { Store.prototype.close = nativeClose })
  Store.prototype.close = function (...args) { closes++; return nativeClose.apply(this, args) }
  const args = input(root)
  closes = 0
  await assert.rejects(workflowCancelReview(binding, () => root, () => { throw new Error('scope failed') }).handler(args), /scope failed/)
  assert.equal(closes, 1)
})
