import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { makeWorkspace, seedGoal } from './helpers.mjs'
const { cooperationBindings } = await import(process.env.AMP_COOPERATION_MODULE ? pathToFileURL(process.env.AMP_COOPERATION_MODULE).href : '../plugins/codex-coordination/mcp/amp/cooperation.mjs')
const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test/1', cancellationEpoch: 0 }

async function setup(t) {
  const root = makeWorkspace(t)
  await seedGoal(root, 'cooperation-goal')
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const preview = await call('migration', { action: 'preview' })
  const imported = await call('migration', { action: 'import', sourceDigest: preview.sourceDigest })
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); persistence.restoreAll()
    const transition = (kind, id, to) => persistence.transition(kind, id, to, { expectedVersion: persistence.workflow.get(kind, id).version, actor: 'test-host' })
    transition('session', imported.sessionId, 'resumed'); transition('session', imported.sessionId, 'active')
    const goalId = imported.references['goal:cooperation-goal']
    const mission = persistence.workflow.get('mission', persistence.workflow.get('goal', goalId).missionId)
    transition('intent', mission.intentId, 'confirmed'); transition('intent', mission.intentId, 'accepted'); transition('mission', mission.id, 'active'); transition('goal', goalId, 'active')
    persistence.create('plan', { id: 'cooperation-plan', sessionId: imported.sessionId, goalId, bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 86400000).toISOString(), progressMetric: 'Host reviews local result', deadLetterOwner: 'host' } }, 'test-host')
    for (const id of ['task-1', 'task-2']) persistence.create('task', { id, sessionId: imported.sessionId, planId: 'cooperation-plan', dependsOn: [], required: true, contractVersion: 'test/1', requiredEffects: [] }, 'test-host')
    transition('plan', 'cooperation-plan', 'approved')
    for (const id of ['task-1', 'task-2']) transition('task', id, 'ready')
  } finally { store.close() }
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  return { root, sessionId: imported.sessionId }
}
const makeCall = (workspace, selected) => {
  const tools = cooperationBindings(binding, workspace, selected)
  return (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
}
const review = { cooperationId: 'coop-1', taskId: 'task-1', expectedVersion: 0, idempotencyKey: 'create', reason: 'Review local queue delegation', participants: ['reviewer'], objective: 'Review the native task' }
const approve = (hook = () => {}) => configureHostClient({ elicitation: {} }, message => {
  hook(message)
  queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
})

test('native cooperation requires reviewed delegation and preserves local untrusted messages/results across restart', async t => {
  const { root, sessionId } = await setup(t)
  const call = makeCall(() => root, () => sessionId)
  const send = { taskId: 'task-1', recipientAgentId: 'codex', payload: { note: 'Self-directed local data' }, idempotencyKey: 'send-1' }
  await assert.rejects(call('cooperation.send', send), /host-approved delegation/)
  configureHostClient({}, () => {})
  assert.equal((await call('cooperation_review', review)).approved, false)
  assert.equal((await call('cooperation_review', review)).replayed, true)
  let approvals = 0
  approve(() => approvals++)
  const created = await call('cooperation_review', { ...review, idempotencyKey: 'approved' })
  assert.equal(created.approved, true); assert.equal(created.remoteAgentStarted, false)
  assert.equal((await call('cooperation_review', { ...review, idempotencyKey: 'approved' })).replayed, true)
  assert.equal(approvals, 1)
  const message = await call('cooperation.send', send)
  assert.equal(message.remoteDelivery, false)
  assert.equal(message.message.kind, 'untrustedData')
  assert.equal(message.message.senderAgentId, 'codex')
  assert.deepEqual(message.message.provenance[0].taint, ['untrusted-agent-claim', 'not-business-verified'])
  await assert.rejects(call('cooperation.send', { ...send, payload: 'changed' }), /Idempotency key/)
  const restarted = makeCall(() => root, () => sessionId)
  assert.equal((await restarted('cooperation.send', send)).replayed, true)
  assert.equal((await restarted('cooperation.inbox')).messages.length, 1)
  assert.equal((await restarted('cooperation.inbox')).messages[0].messageId, message.message.messageId)
  const result = { taskId: 'task-1', outcome: 'success', value: { claim: 'Done' }, idempotencyKey: 'result-1' }
  const submitted = await restarted('cooperation.report_result', result)
  assert.equal(submitted.accepted, true); assert.equal(submitted.verified, false); assert.equal(submitted.businessAcceptance, false)
  assert.equal(submitted.provenance[0].sourceId, 'codex')
  assert.equal((await makeCall(() => root, () => sessionId)('cooperation.report_result', result)).replayed, true)
  await assert.rejects(restarted('cooperation.report_result', { ...result, idempotencyKey: 'again' }), /settled/)
  await assert.rejects(restarted('cooperation.send', { ...send, idempotencyKey: 'after-completion' }), /settled/)
})

test('cooperation rejects model identities, nonparticipants, foreign scopes and forged provenance', async t => {
  const { root, sessionId } = await setup(t)
  let selected = sessionId
  const call = makeCall(() => root, () => selected)
  approve()
  await call('cooperation_review', review)
  const send = { taskId: 'task-1', recipientAgentId: 'reviewer', payload: 'data', idempotencyKey: 'safe' }
  for (const extra of [{ senderAgentId: 'reviewer' }, { ownerAgentId: 'reviewer' }, { ownerEpoch: 99 }, { fence: 'forged' }, { kind: 'trustedInstruction' }, { provenance: [] }, { verified: true }, { payload: { owner: 'other' } }]) await assert.rejects(call('cooperation.send', { ...send, ...extra }), /Invalid cooperation parameters|bound by the host/)
  await assert.rejects(call('cooperation.send', { ...send, recipientAgentId: 'outsider' }), /participant/)
  await assert.rejects(call('cooperation.report_result', { taskId: 'task-1', outcome: 'success', value: {}, provenance: [], idempotencyKey: 'forged' }), /Invalid cooperation parameters/)
  assert.equal((await call('cooperation.send', send)).message.recipientAgentId, 'reviewer')
  assert.equal((await call('cooperation.inbox')).messages.length, 0)
  await assert.rejects(call('cooperation.inbox', { cooperationId: 'other' }), /not visible/)
  selected = 'foreign-workflow'
  await assert.rejects(call('cooperation.inbox'))
  selected = undefined
  await assert.rejects(call('cooperation.send', { ...send, idempotencyKey: 'no-scope' }), /scope first/)
  assert.throws(() => cooperationBindings({ ...binding, principalId: 'reviewer' }, () => root, () => sessionId), /codex principal/)
})

test('exact cooperation review rejects stale heads, scope switches and approval forgery', async t => {
  const { root, sessionId } = await setup(t), other = makeWorkspace(t)
  let workspace = root, selected = sessionId
  const call = makeCall(() => workspace, () => selected)
  await assert.rejects(call('cooperation_review', { ...review, approved: true }), /Invalid cooperation review/)
  await assert.rejects(call('cooperation_review', { ...review, expectedVersion: 1 }), /version changed/)
  approve(() => {
    const { store } = openNativeStore(() => root)
    try {
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); persistence.restoreAll()
      const task = persistence.workflow.get('task', 'task-2')
      persistence.transition('task', task.id, 'blocked', { expectedVersion: task.version, actor: 'concurrent-host' })
    } finally { store.close() }
  })
  await assert.rejects(call('cooperation_review', review), /changed during host review/)
  approve(() => { selected = 'different' })
  await assert.rejects(call('cooperation_review', { ...review, idempotencyKey: 'scope-race' }), /scope changed/)
  selected = sessionId
  approve(() => { workspace = other })
  await assert.rejects(call('cooperation_review', { ...review, idempotencyKey: 'workspace-race' }), /scope changed/)
  workspace = root
  assert.equal((await call('cooperation.inbox')).messages.length, 0)
})

const changeNative = (root, operation) => {
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); persistence.restoreAll()
    operation(persistence)
  } finally { store.close() }
}

test('canonical active native task is delegated and review arguments are detached before approval', async t => {
  const { root, sessionId } = await setup(t)
  changeNative(root, persistence => persistence.transition('task', 'task-1', 'active', { expectedVersion: persistence.workflow.get('task', 'task-1').version, actor: 'host' }))
  const call = makeCall(() => root, () => sessionId), input = structuredClone(review)
  approve(message => {
    assert.match(message.params.message, /Review the native task/)
    input.taskId = 'task-2'; input.objective = 'unapproved objective'; input.participants.push('unapproved-agent')
  })
  assert.equal((await call('cooperation_review', input)).taskId, 'task-1')
  assert.equal((await call('cooperation.send', { taskId: 'task-1', recipientAgentId: 'reviewer', payload: 'approved task', idempotencyKey: 'active-send' })).message.taskId, 'task-1')
  await assert.rejects(call('cooperation.send', { taskId: 'task-2', recipientAgentId: 'reviewer', payload: 'other', idempotencyKey: 'other-send' }), /host-approved delegation/)
  await assert.rejects(call('cooperation.send', { taskId: 'task-1', recipientAgentId: 'unapproved-agent', payload: 'other', idempotencyKey: 'other-recipient' }), /participant/)
})

for (const invalidation of ['blocked', 'cancelled', 'settled', 'parent', 'epoch']) test('native ' + invalidation + ' fences old delegation and persists coordinator cancellation', async t => {
  const { root, sessionId } = await setup(t)
  const call = makeCall(() => root, () => sessionId)
  approve(); await call('cooperation_review', structuredClone(review))
  changeNative(root, persistence => {
    const task = persistence.workflow.get('task', 'task-1')
    if (invalidation === 'blocked') persistence.transition('task', task.id, 'blocked', { expectedVersion: task.version, actor: 'host' })
    if (invalidation === 'cancelled') {
      const before = persistence.workflow.snapshot()
      const updated = persistence.workflow.requestCancel('task', task.id, { expectedVersion: task.version, actor: 'host' })
      persistence.store.save('task', updated, { expectedVersion: task.version })
      for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
    }
    if (invalidation === 'settled') {
      persistence.transition('task', task.id, 'active', { expectedVersion: task.version, actor: 'host' })
      persistence.transition('task', task.id, 'completed', { expectedVersion: persistence.workflow.get('task', task.id).version, actor: 'host', cancellationEpoch: 0, acceptance: { contractVersion: task.contractVersion, valid: true, verificationId: 'host-verification', evidenceIds: ['host-evidence'] } })
    }
    if (invalidation === 'parent') persistence.transition('plan', task.planId, 'superseded', { expectedVersion: persistence.workflow.get('plan', task.planId).version, actor: 'host' })
    if (invalidation === 'epoch') {
      // A recovered host snapshot can keep dispatchable state at a new epoch.
      const snapshot = persistence.workflow.snapshot()
      snapshot.cancellationEpoch = 1
      const updated = snapshot.entities.find(item => item.kind === 'task' && item.id === task.id)
      updated.cancellationEpoch = 1; updated.version++
      const event = { sequence: snapshot.sequence + 1, entityKind: 'task', entityId: task.id, eventType: 'cancel.fenced', from: task.state, to: task.state, expectedVersion: task.version, version: updated.version, actor: 'host', cancellationEpoch: 1, timestamp: updated.updatedAt }
      snapshot.events.push(event); snapshot.sequence++
      WorkflowStore.restore(snapshot)
      persistence.store.save('task', updated, { expectedVersion: task.version })
      persistence.persistEvent(event)
    }
  })
  await assert.rejects(call('cooperation.send', { taskId: 'task-1', recipientAgentId: 'codex', payload: 'stale', idempotencyKey: 'stale-send' }), /dispatchable|active|settled|cancelled/)
  await assert.rejects(call('cooperation.report_result', { taskId: 'task-1', outcome: 'success', value: 'stale', idempotencyKey: 'stale-result' }), /dispatchable|active|settled|cancelled/)
  const { store } = openNativeStore(() => root)
  try {
    const snapshot = store.events({ kind: 'codex.amp.cooperation.commit' }).at(-1).payload.snapshot
    assert.equal(snapshot.tasks.find(task => task.taskId === 'task-1').state, 'cancel_requested')
    assert.equal(snapshot.messages.length, 0)
  } finally { store.close() }
})

test('scope callback failure closes the opened native store', async t => {
  const { root } = await setup(t)
  const original = Store.prototype.close
  let closed = 0
  Store.prototype.close = function (...args) { closed++; return original.apply(this, args) }
  try {
    const call = makeCall(() => root, () => { throw new Error('scope callback failed') })
    await assert.rejects(call('cooperation_review', structuredClone(review)), /scope callback failed/)
    assert.equal(closed, 1)
  } finally { Store.prototype.close = original }
})
