import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { reconciliationReview } from '../plugins/codex-coordination/mcp/amp/reconciliation.mjs'
import { writeBinding } from '../plugins/codex-coordination/mcp/amp/write.mjs'
import { openNativeStore, nativeEnvironment, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { nativeIoBudget } from '../plugins/codex-coordination/mcp/amp/read-budget.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { makeWorkspace } from './helpers.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => 'sha256:' + sha(value)
const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test/1', cancellationEpoch: 0 }
const sessionId = 'reconcile-session'
const source = '\uFEFForiginal\r\n', content = 'recovered\r\noutput\r\n'
const decide = (decision = 'approve', hook = () => {}) => configureHostClient({ elicitation: {} }, message => {
  hook(message)
  queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision } } }))
})
const clone = value => JSON.parse(JSON.stringify(value))

function withStore(root, operation) {
  const { store } = openNativeStore(() => root)
  try { return operation(store) } finally { store.close() }
}
function seed(root) {
  withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const create = (kind, input) => p.create(kind, { ...input, sessionId }, 'host')
    const transition = (kind, id, to) => p.transition(kind, id, to, { expectedVersion: p.workflow.get(kind, id).version, actor: 'host' })
    create('session', { id: sessionId, participants: ['host'] }); transition('session', sessionId, 'active')
    create('turn', { id: 'turn', classification: 'new_intent' }); transition('turn', 'turn', 'interpreting')
    create('intent', { id: 'intent', originTurnId: 'turn', text: 'Recover uncertain write' }); transition('intent', 'intent', 'confirmed'); transition('intent', 'intent', 'accepted')
    create('mission', { id: 'mission', intentId: 'intent' }); transition('mission', 'mission', 'active')
    create('goal', { id: 'goal', missionId: 'mission', contractVersion: '1', acceptanceCriteria: ['Requested file exists'] }); transition('goal', 'goal', 'active')
    create('plan', { id: 'plan', goalId: 'goal', bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 3600000).toISOString(), progressMetric: 'Recover safely', deadLetterOwner: 'host' } })
    create('task', { id: 'task', planId: 'plan', contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] })
    transition('plan', 'plan', 'approved'); transition('plan', 'plan', 'executing'); transition('task', 'task', 'ready')
  })
}
async function fixture(t) {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), source)
  seed(root); decide()
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  const writer = writeBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const originalWrite = { path: 'public.md', content, expectedHash: sha('original\n'), taskId: 'task', idempotencyKey: 'uncertain-write' }
  // Real CAS reaches disk, then receipt persistence fails and the DB transaction
  // rolls back. This is the genuine adapter uncertainty we need to reconcile.
  const save = Store.prototype.save
  let injected = false
  Store.prototype.save = function (kind, ...rest) {
    if (kind === 'receipt' && !injected) { injected = true; throw new Error('injected post-flush persistence failure') }
    return save.call(this, kind, ...rest)
  }
  try { await assert.rejects(writer.handler(originalWrite), /outcome is unresolved/) } finally { Store.prototype.save = save }
  assert.equal(injected, true)
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), '\uFEFFrecovered\r\noutput\r\n')
  const facts = withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
    const action = p.workflow.list('action', sessionId)[0], attempt = p.workflow.getAttempt(action.attemptIds[0])
    assert.equal(action.state, 'unknown_outcome'); assert.equal(attempt.state, 'unknown_outcome')
    assert.equal(store.list('receipt').length, 0)
    const writes = store.events({ kind: 'codex.amp.workspace.write' }).map(item => clone(item.payload))
    return {
      actionId: action.id,
      expectedAttemptId: attempt.attemptId,
      expectedActionVersion: action.version,
      expectedAttemptVersion: attempt.version,
      outcome: 'succeeded',
      reconciliationRef: 'manual:host-inspection-1',
      observedRawHash: digest(readFileSync(join(root, 'public.md'))),
      expectedContentDigest: digest('recovered\noutput\n'),
      idempotencyKey: 'reconcile-1',
      reason: 'Host inspected exact current bytes and original requested content',
      started: writes.find(item => item.state === 'started'),
    }
  })
  const { started, ...input } = facts
  let currentRoot = root, currentScope = sessionId
  const policy = { root, exclude: [] }
  const tool = reconciliationReview(binding, () => currentRoot, () => policy, () => currentScope)
  return { root, input, started, tool, writer, originalWrite, policy, scope(value) { currentScope = value }, workspace(value) { currentRoot = value } }
}
const state = root => withStore(root, store => {
  const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
  const payloads = kind => store.events({ kind }).map(item => clone(item.payload))
  return {
    workflow: p.workflow.snapshot(),
    action: p.workflow.list('action', sessionId)[0],
    attempt: p.workflow.snapshot().attempts[0],
    receipts: store.list('receipt').map(item => clone(item)),
    writes: payloads('codex.amp.workspace.write'),
    decisions: payloads('codex.amp.workflow.reconciliation.host_decision'),
    requests: payloads('codex.amp.workflow.reconciliation.requested'),
    reconciliations: payloads('codex.amp.workflow.reconciliation'),
    transitions: payloads('action.transitioned'),
  }
})
const reservationOf = (root, id) => withStore(root, store => nativeIoBudget(store, 'native-read:codex').getReservation(id))
const file = root => join(root, 'public.md')

function injectFailureOnce(method, predicate) {
  const original = Store.prototype[method]
  let fired = false
  Store.prototype[method] = function (...args) {
    if (!fired && predicate(...args)) { fired = true; throw new Error('injected ' + method + ' failure') }
    return original.apply(this, args)
  }
  return { restore() { Store.prototype[method] = original }, get fired() { return fired } }
}

function trackStores() {
  const open = Store.open, close = Store.prototype.close
  let opens = 0, closes = 0
  Store.open = function (...args) { opens += 1; return open.apply(this, args) }
  Store.prototype.close = function (...args) { closes += 1; return close.apply(this, args) }
  return {
    restore() { Store.open = open; Store.prototype.close = close },
    snapshot() { return { opens, closes } },
  }
}

// Simulate a different host settling the same attempt during the approval window.
function externalReconcile(root, outcome = 'failed') {
  withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
    const action = p.workflow.list('action', sessionId)[0], attempt = p.workflow.getAttempt(action.attemptIds.at(-1))
    let current = action
    if (current.state === 'unknown_outcome') {
      const before = p.workflow.snapshot()
      current = p.workflow.transition('action', current.id, 'reconciling', { expectedVersion: current.version, actor: 'host' })
      store.save('action', current, { expectedVersion: action.version })
      for (const event of p.workflow.history().slice(before.events.length)) p.persistEvent(event)
    }
    const before = p.workflow.snapshot()
    const reconciled = p.workflow.reconcileAction(current.id, { expectedVersion: current.version, expectedAttemptVersion: attempt.version, outcome, actor: 'host', reconciliationRef: 'manual:external-host' })
    store.save('action', reconciled, { expectedVersion: current.version })
    for (const event of p.workflow.history().slice(before.events.length)) p.persistEvent(event)
    p.persistAttempt(p.workflow.getAttempt(attempt.attemptId), { actor: 'host', from: 'unknown_outcome', reason: 'external host reconciliation' })
  })
}

test('uncertain write recovers native attempt and genuine anchored receipt without writing again', async t => {
  const f = await fixture(t), before = readFileSync(file(f.root)), beforeStat = statSync(file(f.root))
  let prompts = 0, message
  decide('approve', value => { prompts++; message = value; assert.match(value.params.message, /host must independently check/); assert.match(value.params.message, /manual:host-inspection-1/) })
  const result = await f.tool.handler(f.input)
  assert.equal(prompts, 1)
  assert.equal(message.params.message.includes('does not assert absence'), true)
  assert.equal(result.approved, true); assert.equal(result.reconciled, true); assert.equal(result.changed, true); assert.equal(result.status, 'reconciled')
  assert.equal(result.state, 'succeeded'); assert.equal(result.acceptanceGranted, false); assert.equal(result.retryAuthorized, false)
  assert.equal(result.receipt.kind, 'file_flush_receipt'); assert.equal(result.receipt.invocation.context.attemptId, f.input.expectedAttemptId)
  assert.equal(result.receipt.invocation.context.executionId, f.started.executionId); assert.equal(result.receipt.observation.value.reconciled, true)
  assert.equal(result.receipt.workspaceAnchor.snapshotId, digest(before))
  withStore(f.root, store => assert.equal(result.receipt.workspaceAnchor.changeHash, nativeEnvironment(store, f.root)))
  assert.equal((await verifyReceiptIntegrity(result.receipt, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'test', verifiedAt: new Date().toISOString() })).status, 'integrity_verified')
  assert.deepEqual(readFileSync(file(f.root)), before)
  assert.equal(statSync(file(f.root)).ino, beforeStat.ino); assert.equal(statSync(file(f.root)).mtimeMs, beforeStat.mtimeMs)
  const replay = await f.tool.handler(f.input)
  assert.equal(replay.replayed, true); assert.equal(prompts, 1); assert.equal(replay.receipt.id, result.receipt.id)
  assert.equal((await f.writer.handler(f.originalWrite)).reconciled, true)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'succeeded'); assert.equal(persisted.attempt.state, 'succeeded')
  assert.equal(persisted.receipts.length, 1); assert.equal(persisted.receipts[0].id, result.receipt.id)
  assert.equal(persisted.requests.length, 1); assert.equal(persisted.decisions.length, 1); assert.equal(persisted.reconciliations.length, 1)
  assert.equal(persisted.decisions[0].approved, true); assert.equal(persisted.decisions[0].reconciliationRef, 'manual:host-inspection-1')
  assert.equal(persisted.writes.at(-1).state, 'succeeded')
  assert.equal(persisted.writes.at(-1).key, f.started.key); assert.equal(persisted.writes.at(-1).request, f.started.request)
  assert.equal(persisted.writes.at(-1).budgetReservationId, f.started.budgetReservationId)
  assert.equal(persisted.writes.at(-1).result.reconciled, true); assert.equal(persisted.writes.at(-1).reconciliationReviewId, result.reviewId)
  assert.equal(persisted.writes.filter(item => item.state === 'succeeded').length, 1)
  assert.equal(persisted.writes.filter(item => item.state === 'unknown_outcome').length, 1)
  const transition = persisted.transitions.find(item => item.to === 'succeeded')
  assert.ok(transition); assert.match(transition.reason, new RegExp(result.reviewId + ':manual:host-inspection-1'))
  assert.equal(typeof f.started.budgetReservationId, 'string')
  const reservation = reservationOf(f.root, f.started.budgetReservationId)
  assert.equal(reservation.state, 'settled'); assert.equal(reservation.actual.calls, reservation.amount.calls); assert.equal(reservation.actual.bytes, reservation.amount.bytes)
  assert.equal(result.budget.conservative, true); assert.equal(result.budget.reservationId, f.started.budgetReservationId)
  assert.equal(reservationOf(f.root, f.started.budgetReservationId).actual.bytes, result.budget.actual.bytes)
})

test('host denial is durable, replayable and cannot settle or issue a receipt', async t => {
  const f = await fixture(t)
  let prompts = 0
  decide('reject', () => { prompts++ })
  const denied = await f.tool.handler(f.input)
  assert.equal(denied.approved, false); assert.equal(denied.reconciled, false); assert.equal(denied.changed, false); assert.equal(denied.status, 'rejected')
  assert.equal((await f.tool.handler(f.input)).replayed, true); assert.equal(prompts, 1)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.attempt.state, 'unknown_outcome'); assert.equal(persisted.receipts.length, 0)
  assert.equal(persisted.decisions[0].approved, false); assert.equal(persisted.requests.length, 1); assert.equal(persisted.reconciliations.length, 1)
  assert.equal(persisted.writes.at(-1).state, 'unknown_outcome'); assert.equal(persisted.writes.some(item => item.state === 'succeeded'), false)
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
})

test('missing host approval, host errors and a closed host all keep the write unresolved', async t => {
  for (const mode of ['unavailable', 'error', 'closed']) {
    const f = await fixture(t)
    let sent = 0
    if (mode === 'unavailable') configureHostClient({}, () => { sent++ })
    if (mode === 'error') configureHostClient({ elicitation: {} }, message => { sent++; queueMicrotask(() => acceptHostResponse({ id: message.id, error: { code: -32000, message: 'host unavailable' } })) })
    if (mode === 'closed') configureHostClient({ elicitation: {} }, message => { sent++; queueMicrotask(() => closeHostClient()) })
    const denied = await f.tool.handler(f.input)
    assert.equal(denied.approved, false); assert.equal(denied.reconciled, false); assert.equal(denied.status, 'rejected')
    assert.equal(sent, mode === 'unavailable' ? 0 : 1)
    const persisted = state(f.root)
    assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.receipts.length, 0)
    assert.equal(persisted.writes.at(-1).state, 'unknown_outcome'); assert.equal(persisted.decisions[0].approved, false)
    if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
  }
})

test('caller mutation during approval cannot change outcome, attempt or manual reference', async t => {
  const f = await fixture(t), original = structuredClone(f.input)
  let prompts = 0
  decide('approve', () => { prompts++; f.input.outcome = 'failed'; f.input.expectedAttemptId = 'forged'; f.input.reconciliationRef = 'manual:unapproved'; f.input.expectedContentDigest = digest('other') })
  const result = await f.tool.handler(f.input)
  assert.equal(prompts, 1); assert.equal(result.state, 'succeeded'); assert.equal(result.attemptId, original.expectedAttemptId); assert.equal(result.reconciliationRef, original.reconciliationRef)
  await assert.rejects(f.tool.handler(f.input), /Idempotency key/)
})

for (const race of ['file', 'metadata', 'deleted', 'journal', 'workflow', 'attempt', 'policy']) test('stale_after_approval on ' + race + ' change leaves the write unresolved and the decision durable', async t => {
  const f = await fixture(t)
  const beforeWrites = state(f.root).writes.length
  let prompts = 0
  decide('approve', () => {
    prompts++
    if (race === 'file') writeFileSync(file(f.root), 'concurrent change\n')
    if (race === 'metadata') { const later = new Date(Date.now() + 5000); utimesSync(file(f.root), later, later) }
    if (race === 'deleted') rmSync(file(f.root))
    if (race === 'journal') withStore(f.root, store => {
      const last = store.events({ kind: 'codex.amp.workspace.write' }).at(-1).payload
      store.appendEvent('codex.amp.workspace.write', { ...last, error: 'concurrent host update' })
    })
    if (race === 'workflow') withStore(f.root, store => {
      const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
      const task = p.workflow.get('task', 'task'); p.transition('task', task.id, 'blocked', { expectedVersion: task.version, actor: 'host' })
    })
    if (race === 'attempt') externalReconcile(f.root)
    if (race === 'policy') f.policy.exclude.push('public.md')
  })
  const result = await f.tool.handler(f.input)
  assert.equal(prompts, 1)
  assert.equal(result.approved, true); assert.equal(result.reconciled, false); assert.equal(result.changed, false); assert.equal(result.status, 'stale_after_approval')
  assert.match(result.staleReason, /changed|differs|unknown-outcome|ENOENT|no such file/i)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, race === 'attempt' ? 'failed' : 'unknown_outcome')
  assert.equal(persisted.attempt.state, race === 'attempt' ? 'failed' : 'unknown_outcome')
  assert.equal(persisted.receipts.length, 0)
  assert.equal(persisted.writes.some(item => item.result !== undefined || ['succeeded', 'failed', 'cancelled'].includes(item.state)), false)
  assert.equal(persisted.writes.length, race === 'journal' ? beforeWrites + 1 : beforeWrites)
  assert.equal(persisted.writes.at(-1).state, 'unknown_outcome')
  assert.equal(persisted.decisions.length, 1); assert.equal(persisted.decisions[0].approved, true)
  assert.equal(persisted.requests.length, 1); assert.equal(persisted.reconciliations.length, 1); assert.equal(persisted.reconciliations[0].result.status, 'stale_after_approval')
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
  const replay = await f.tool.handler(f.input)
  assert.equal(replay.replayed, true); assert.equal(replay.status, 'stale_after_approval'); assert.equal(prompts, 1)
})

for (const race of ['scope', 'workspace']) test(race + ' change after the host decision is rejected without touching the write', async t => {
  const f = await fixture(t)
  let prompts = 0
  decide('approve', () => { prompts++; if (race === 'scope') f.scope('foreign'); else f.workspace(makeWorkspace(t)) })
  await assert.rejects(f.tool.handler(f.input), /scope|Workspace/)
  assert.equal(prompts, 1)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.attempt.state, 'unknown_outcome')
  assert.equal(persisted.receipts.length, 0); assert.equal(persisted.writes.at(-1).state, 'unknown_outcome')
  assert.equal(persisted.decisions.length, 1); assert.equal(persisted.decisions[0].approved, true)
  assert.equal(persisted.reconciliations.length, 0)
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
})

test('model approval, wrong versions, forged hashes and invalid references cannot prove success', async t => {
  const f = await fixture(t)
  const invalid = [
    { approved: true }, { verified: true }, { valid: true }, { state: 'succeeded' }, { reconciled: true },
    { receipt: {} }, { budget: {} }, { businessVerification: 'verified' }, { acceptanceGranted: true },
    { principalId: 'other' }, { scope: 'foreign' }, { workspace: 'elsewhere' },
    { expectedActionVersion: 900 }, { expectedAttemptVersion: 900 }, { expectedAttemptId: 'forged' }, { actionId: 'forged' },
    { observedRawHash: digest('other') }, { expectedContentDigest: digest('other') },
    { reconciliationRef: 'inspected' }, { reconciliationRef: 'manual: ' }, { idempotencyKey: '' }, { reason: '' }, { outcome: 'unknown' },
  ]
  for (const patch of invalid) await assert.rejects(f.tool.handler({ ...f.input, ...patch }), /Invalid|Unknown|parameter|version|differs|manual|required|not found|does not exist/i)
  await assert.rejects(f.tool.handler({ ...f.input, expectedContentDigest: undefined }), /expected content digest/)
  writeFileSync(file(f.root), 'other output\n')
  await assert.rejects(f.tool.handler({ ...f.input, observedRawHash: digest('other output\n') }), /original requested content/)
  assert.equal(state(f.root).requests.length, 0)
  assert.equal(state(f.root).receipts.length, 0)
  assert.equal(state(f.root).action.state, 'unknown_outcome')
})

test('normalized requested content is sufficient proof while the host-supplied raw hash is still required', async t => {
  const f = await fixture(t)
  const lf = 'recovered\noutput\n'
  writeFileSync(file(f.root), lf)
  const result = await f.tool.handler({ ...f.input, observedRawHash: digest(lf) })
  assert.equal(result.state, 'succeeded'); assert.equal(result.receipt.workspaceAnchor.snapshotId, digest(lf))
  assert.equal(readFileSync(file(f.root), 'utf8'), lf)
  assert.equal(state(f.root).receipts.length, 1)
})

test('a journal claim with a terminal result is never reconciled', async t => {
  const f = await fixture(t)
  const last = state(f.root).writes.at(-1)
  withStore(f.root, store => store.appendEvent('codex.amp.workspace.write', { key: last.key, request: last.request, state: 'succeeded', result: { approved: true, changed: true } }))
  await assert.rejects(f.tool.handler(f.input), /terminal result|not permitted/)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.requests.length, 0); assert.equal(persisted.receipts.length, 0)
})

test('a journal claim without its exact started event is rejected', async t => {
  const f = await fixture(t)
  const last = state(f.root).writes.at(-1)
  withStore(f.root, store => store.appendEvent('codex.amp.workspace.write', { ...last, key: 'codex:no-started-event' }))
  await assert.rejects(f.tool.handler(f.input), /single started claim/)
  assert.equal(state(f.root).requests.length, 0)
})

test('a journal claim whose execution identity drifted from the native attempt is rejected', async t => {
  const f = await fixture(t)
  const last = state(f.root).writes.at(-1)
  withStore(f.root, store => store.appendEvent('codex.amp.workspace.write', { ...last, executionId: 'forged-execution' }))
  await assert.rejects(f.tool.handler(f.input), /exact native attempt identity/)
  assert.equal(state(f.root).requests.length, 0)
})

test('a journal claim whose budget reservation identity drifted is rejected without charging twice', async t => {
  const f = await fixture(t)
  const last = state(f.root).writes.at(-1)
  withStore(f.root, store => store.appendEvent('codex.amp.workspace.write', { ...last, budgetReservationId: 'write-budget:forged' }))
  await assert.rejects(f.tool.handler(f.input), /budget reservation identity changed/)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.requests.length, 0)
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
})

for (const point of ['action', 'receipt', 'write-journal', 'final-event']) test('a rolled-back ' + point + ' write resumes the durable host decision without re-approval', async t => {
  const f = await fixture(t)
  const beforeWrites = state(f.root).writes.length
  let prompts = 0
  decide('approve', () => { prompts++ })
  const failure = point === 'receipt'
    ? injectFailureOnce('save', kind => kind === 'receipt')
    : point === 'action'
      ? injectFailureOnce('save', (kind, entity) => kind === 'action' && entity.state === 'reconciling')
      : point === 'write-journal'
        ? injectFailureOnce('appendEvent', (kind, payload) => kind === 'codex.amp.workspace.write' && payload.state === 'succeeded')
        : injectFailureOnce('appendEvent', (kind, payload) => kind === 'codex.amp.workflow.reconciliation' && payload.result?.reconciled === true)
  try { await assert.rejects(f.tool.handler(f.input), /injected/) } finally { failure.restore() }
  assert.equal(failure.fired, true); assert.equal(prompts, 1)
  const rolled = state(f.root)
  assert.equal(rolled.action.state, 'unknown_outcome'); assert.equal(rolled.attempt.state, 'unknown_outcome')
  assert.equal(rolled.receipts.length, 0); assert.equal(rolled.writes.length, beforeWrites); assert.equal(rolled.reconciliations.length, 0)
  assert.equal(rolled.requests.length, 1); assert.equal(rolled.decisions.length, 1); assert.equal(rolled.decisions[0].approved, true)
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'reserved')
  const retried = await f.tool.handler(f.input)
  assert.equal(retried.reconciled, true); assert.equal(retried.state, 'succeeded'); assert.equal(prompts, 1)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'succeeded'); assert.equal(persisted.receipts.length, 1); assert.equal(persisted.decisions.length, 1)
  assert.equal(persisted.writes.at(-1).state, 'succeeded')
  if (f.started.budgetReservationId) assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'settled')
})

test('a failed requested-event write prompts nobody and can be retried cleanly', async t => {
  const f = await fixture(t)
  let prompts = 0
  decide('approve', () => { prompts++ })
  const failure = injectFailureOnce('appendEvent', kind => kind === 'codex.amp.workflow.reconciliation.requested')
  try { await assert.rejects(f.tool.handler(f.input), /injected/) } finally { failure.restore() }
  assert.equal(failure.fired, true); assert.equal(prompts, 0)
  const rolled = state(f.root)
  assert.equal(rolled.requests.length, 0); assert.equal(rolled.decisions.length, 0); assert.equal(rolled.receipts.length, 0); assert.equal(rolled.action.state, 'unknown_outcome')
  const retried = await f.tool.handler(f.input)
  assert.equal(retried.reconciled, true); assert.equal(prompts, 1)
})

test('a failed decision write fails closed without asking the host a second time', async t => {
  const f = await fixture(t)
  let prompts = 0
  decide('approve', () => { prompts++ })
  const failure = injectFailureOnce('appendEvent', kind => kind === 'codex.amp.workflow.reconciliation.host_decision')
  try { await assert.rejects(f.tool.handler(f.input), /injected/) } finally { failure.restore() }
  assert.equal(failure.fired, true); assert.equal(prompts, 1)
  const persisted = state(f.root)
  assert.equal(persisted.requests.length, 1); assert.equal(persisted.decisions.length, 0); assert.equal(persisted.action.state, 'unknown_outcome'); assert.equal(persisted.receipts.length, 0)
  await assert.rejects(f.tool.handler(f.input), /unresolved|no repeated approval/i)
  assert.equal(prompts, 1)
})

test('every native store opened by reconciliation is closed on failure', async t => {
  const f = await fixture(t)
  decide('approve')
  const tracker = trackStores()
  const failure = injectFailureOnce('appendEvent', (kind, payload) => kind === 'codex.amp.workspace.write' && payload.state === 'succeeded')
  try { await assert.rejects(f.tool.handler(f.input), /injected/) } finally { failure.restore(); tracker.restore() }
  const { opens, closes } = tracker.snapshot()
  assert.ok(opens >= 3); assert.equal(closes, opens)
})

test('cancelled native identity cannot become success but manual cancellation preserves uncertainty semantics', async t => {
  const f = await fixture(t)
  withStore(f.root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); p.restoreAll()
    const task = p.workflow.get('task', 'task'), before = p.workflow.snapshot()
    p.workflow.requestCancel('task', task.id, { expectedVersion: task.version, actor: 'host' })
    for (const item of p.workflow.snapshot().entities) {
      const previous = before.entities.find(old => old.kind === item.kind && old.id === item.id)
      if (previous.version !== item.version) store.save(item.kind, item, { expectedVersion: previous.version })
    }
    for (const event of p.workflow.history().slice(before.events.length)) p.persistEvent(event)
  })
  const versions = state(f.root).action.version
  await assert.rejects(f.tool.handler({ ...f.input, expectedActionVersion: versions }), /uncancelled/)
  let message
  decide('approve', value => { message = value })
  const cancelled = await f.tool.handler({ ...f.input, expectedActionVersion: versions, outcome: 'cancelled' })
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.receipt, undefined); assert.equal(cancelled.reconciled, true)
  assert.equal(cancelled.observedEffect, 'manual-host-decision-no-absence-claim'); assert.equal(cancelled.retryAuthorized, false)
  assert.match(message.params.message, /does not assert absence/)
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'cancelled'); assert.equal(persisted.attempt.state, 'cancelled'); assert.equal(persisted.receipts.length, 0)
  assert.equal(persisted.writes.at(-1).state, 'cancelled'); assert.equal(persisted.writes.at(-1).result.observedEffect, 'manual-host-decision-no-absence-claim')
  assert.equal(reservationOf(f.root, f.started.budgetReservationId).state, 'settled')
})

test('manual failure does not claim that the filesystem effect never happened', async t => {
  const f = await fixture(t)
  let message
  decide('approve', value => { message = value })
  const result = await f.tool.handler({ ...f.input, outcome: 'failed', expectedContentDigest: undefined })
  assert.equal(result.state, 'failed'); assert.equal(result.receipt, undefined); assert.equal(result.reconciled, true)
  assert.equal(result.observedEffect, 'manual-host-decision-no-absence-claim'); assert.equal(result.retryAuthorized, false); assert.equal(result.acceptanceGranted, false)
  assert.match(message.params.message, /does not assert absence/)
  assert.equal(readFileSync(file(f.root), 'utf8'), '\uFEFFrecovered\r\noutput\r\n')
  const persisted = state(f.root)
  assert.equal(persisted.action.state, 'failed'); assert.equal(persisted.attempt.state, 'failed'); assert.equal(persisted.receipts.length, 0)
  assert.equal(persisted.writes.at(-1).state, 'failed'); assert.equal(persisted.writes.at(-1).result.receipt, undefined)
  assert.equal(persisted.transitions.find(item => item.to === 'failed').reason.includes(':manual:host-inspection-1'), true)
})
