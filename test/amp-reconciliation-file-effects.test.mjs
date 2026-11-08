/**
 * WP4: host reconciliation of the two native file effects.
 *
 * Each fixture reaches the real post-flush uncertainty path from WP3: the CAS
 * flush reaches disk, then receipt persistence throws once and the SQLite
 * transaction rolls back. Reconciliation is then asked to prove the resulting
 * file bytes against the journal's planned content digest.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { normalizeToLf } from 'attention-manifest-protocol/file'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { makeWorkspace } from './helpers.mjs'
import { writeBinding } from '../plugins/codex-coordination/mcp/amp/write.mjs'
import { replaceBinding } from '../plugins/codex-coordination/mcp/amp/replace.mjs'
import { reconciliationReview } from '../plugins/codex-coordination/mcp/amp/reconciliation.mjs'
import { evidenceBindings } from '../plugins/codex-coordination/mcp/amp/evidence.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openNativeStore, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { nativeIoBudget } from '../plugins/codex-coordination/mcp/amp/read-budget.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test/1', cancellationEpoch: 0 }
const sessionId = 'file-effect-reconcile-session'
const writeKind = 'codex.amp.workspace.write'
const replaceKind = 'codex.amp.workspace.replace'
const reconciliationKind = 'codex.amp.workflow.reconciliation'
const writeTool = 'attention_manifest_protocol_workspace.write'
const replaceTool = 'attention_manifest_protocol_replace'
const sha = value => createHash('sha256').update(value).digest('hex')
/** AMP's normalized-LF planned-content digest. */
const digest = value => 'sha256:' + sha(normalizeToLf(value))
/** Raw on-disk hash, as the host observes and anchors it. */
const rawDigest = value => 'sha256:' + createHash('sha256').update(value).digest('hex')

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
    create('intent', { id: 'intent', originTurnId: 'turn', text: 'Recover an uncertain file effect' }); transition('intent', 'intent', 'confirmed'); transition('intent', 'intent', 'accepted')
    create('mission', { id: 'mission', intentId: 'intent' }); transition('mission', 'mission', 'active')
    create('goal', { id: 'goal', missionId: 'mission', contractVersion: '1', acceptanceCriteria: ['Requested file content exists'] }); transition('goal', 'goal', 'active')
    create('plan', { id: 'plan', goalId: 'goal', bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 3600000).toISOString(), progressMetric: 'Recover safely', deadLetterOwner: 'host' } })
    create('task', { id: 'task', planId: 'plan', contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] })
    transition('plan', 'plan', 'approved'); transition('plan', 'plan', 'executing'); transition('task', 'task', 'ready')
  })
}

/** Approve (or reject) every elicitation and expose the exact host prompts. */
function approvals(t, decision = 'approve') {
  const messages = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    messages.push(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision } } }))
  })
  return messages
}

/** Throw once when the post-flush receipt row is persisted. */
function failReceiptOnce() {
  const save = Store.prototype.save
  let fired = false
  Store.prototype.save = function (kind, ...rest) {
    if (kind === 'receipt' && !fired) { fired = true; throw new Error('injected post-flush receipt persistence failure') }
    return save.call(this, kind, ...rest)
  }
  return { restore() { Store.prototype.save = save }, get fired() { return fired } }
}

function nativeFacts(root, kind) {
  return withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    p.restoreAll()
    const action = JSON.parse(JSON.stringify(p.workflow.list('action', sessionId)[0]))
    const attempt = JSON.parse(JSON.stringify(p.workflow.getAttempt(action.attemptIds.at(-1))))
    const events = store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload)))
    return { action, attempt, events, started: events.find(event => event.state === 'started'), receipts: store.list('receipt').length }
  })
}

function persisted(root) {
  return withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    p.restoreAll()
    const action = JSON.parse(JSON.stringify(p.workflow.list('action', sessionId)[0]))
    const attempt = JSON.parse(JSON.stringify(p.workflow.getAttempt(action.attemptIds.at(-1))))
    const payloads = kind => store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload)))
    return {
      action,
      attempt,
      receipts: store.list('receipt').map(item => JSON.parse(JSON.stringify(item))),
      writes: payloads(writeKind),
      replaces: payloads(replaceKind),
      requests: payloads(reconciliationKind + '.requested'),
      decisions: payloads(reconciliationKind + '.host_decision'),
      reconciliations: payloads(reconciliationKind),
    }
  })
}

function reservationOf(root, id) {
  return withStore(root, store => nativeIoBudget(store, 'native-read:codex').getReservation(id))
}

function reviewInput(facts, path, root, { idempotencyKey, expectedContentDigest } = {}) {
  const input = {
    actionId: facts.action.id,
    expectedAttemptId: facts.attempt.attemptId,
    expectedActionVersion: facts.action.version,
    expectedAttemptVersion: facts.attempt.version,
    outcome: 'succeeded',
    reconciliationRef: 'manual:wp4-host-inspection',
    observedRawHash: rawDigest(readFileSync(join(root, path))),
    idempotencyKey,
    reason: 'Host inspected the exact current bytes and the journaled planned content',
  }
  // A true omission is intentional: the journal already pins the planned result.
  if (expectedContentDigest !== undefined) input.expectedContentDigest = expectedContentDigest
  return input
}

/** Drive a line-targeted write into the real unknown_outcome state. */
async function unknownLineWrite(t) {
  const root = makeWorkspace(t)
  const original = 'line one\nline two\nline three\n'
  const replacement = 'line two updated\n'
  const planned = 'line one\nline two updated\nline three\n'
  writeFileSync(join(root, 'notes.md'), original)
  seed(root)
  const prompts = approvals(t, 'approve')
  const writer = writeBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const writeInput = { path: 'notes.md', content: replacement, expectedHash: sha(original), target: { mode: 'line', start: 1, end: 2 }, expectedBufferVersion: 0, taskId: 'task', idempotencyKey: 'wp4-line-write' }
  const fault = failReceiptOnce()
  try { await assert.rejects(writer.handler(writeInput), /outcome is unresolved/) } finally { fault.restore() }
  assert.equal(fault.fired, true)
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), planned)
  const facts = nativeFacts(root, writeKind)
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.receipts, 0)
  assert.equal(facts.events.filter(event => event.state === 'started').length, 1)
  assert.equal(facts.started.plannedContentDigest, digest(planned))
  assert.match(facts.started.budgetReservationId, /^write-budget:/)
  return { root, original, replacement, planned, writer, writeInput, facts, prompts }
}

/** Drive a string replace into the real unknown_outcome state. */
async function unknownStringReplace(t) {
  const root = makeWorkspace(t)
  const original = 'alpha beta\nsecond line\n'
  const planned = 'alpha BETA\nsecond line\n'
  writeFileSync(join(root, 'a.txt'), original)
  seed(root)
  const prompts = approvals(t, 'approve')
  const replacer = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const replaceInput = { path: 'a.txt', mode: 'string', text: 'beta', replacement: 'BETA', taskId: 'task', idempotencyKey: 'wp4-string-replace' }
  const fault = failReceiptOnce()
  try { await assert.rejects(replacer.handler(replaceInput), /outcome is unresolved/) } finally { fault.restore() }
  assert.equal(fault.fired, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), planned)
  const facts = nativeFacts(root, replaceKind)
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.receipts, 0)
  assert.equal(facts.events.filter(event => event.state === 'started').length, 1)
  assert.equal(facts.started.plannedContentDigest, digest(planned))
  assert.match(facts.started.budgetReservationId, /^replace-budget:/)
  assert.equal(facts.events.at(-1).state, 'unknown_outcome')
  return { root, original, planned, replacer, replaceInput, facts, prompts }
}

/** Recreate a pre-WP3 full-file write journal: real native attempt, no plannedContentDigest. */
function legacyUnknownWrite(root, { path, before, after }) {
  writeFileSync(join(root, path), after)
  seed(root)
  return withStore(root, store => {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    if (p.restoreAll().skipped.length) throw new Error('legacy fixture workflow is invalid')
    const task = p.workflow.get('task', 'task')
    if (task.state === 'ready') p.transition('task', task.id, 'active', { expectedVersion: task.version, actor: 'host', cancellationEpoch: task.cancellationEpoch })
    const created = p.create('action', { id: 'workspace-write:' + randomUUID(), sessionId, taskId: 'task', operationId: randomUUID(), effect: 'workspace:file.write', required: false, sideEffect: true, recovery: 'reconcile' }, 'host')
    const pending = p.transition('action', created.id, 'pending', { expectedVersion: created.version, actor: 'host', cancellationEpoch: created.cancellationEpoch })
    const ready = p.transition('action', pending.id, 'ready', { expectedVersion: pending.version, actor: 'host', cancellationEpoch: pending.cancellationEpoch })
    const executionId = randomUUID(), attemptId = randomUUID()
    const startedSnapshot = p.workflow.snapshot()
    const attempt = p.workflow.startAttempt(ready.id, { expectedVersion: ready.version, cancellationEpoch: ready.cancellationEpoch, executionId, attemptId, actor: 'host' })
    const liveAction = p.workflow.get('action', ready.id)
    store.save('action', liveAction, { expectedVersion: ready.version })
    for (const event of p.workflow.history().slice(startedSnapshot.events.length)) p.persistEvent(event)
    p.persistAttempt(attempt, { actor: 'host', reason: 'Legacy host-approved file write' })
    const request = nativeRequest({ path, content: after, expectedHash: sha(before), taskId: 'task', scope: sessionId })
    const identity = { actionId: liveAction.id, attemptId, executionId, operationId: liveAction.operationId, cancellationEpoch: attempt.cancellationEpoch }
    const started = { key: 'codex:legacy-write', request, state: 'started', ...identity, beforeRawHash: rawDigest(before) }
    const uncertainEvent = { ...started, state: 'unknown_outcome', error: 'legacy uncertain write' }
    store.appendEvent(writeKind, started)
    store.appendEvent(writeKind, uncertainEvent)
    const settledSnapshot = p.workflow.snapshot()
    const uncertain = p.workflow.settleAttempt(attemptId, { expectedVersion: attempt.version, expectedActionVersion: liveAction.version, outcome: 'unknown_outcome', actor: 'host' })
    const settledAction = p.workflow.get('action', liveAction.id)
    store.save('action', settledAction, { expectedVersion: liveAction.version })
    for (const event of p.workflow.history().slice(settledSnapshot.events.length)) p.persistEvent(event)
    p.persistAttempt(uncertain, { actor: 'host', from: 'running', reason: 'Legacy write outcome uncertain' })
    return { action: JSON.parse(JSON.stringify(settledAction)), attempt: JSON.parse(JSON.stringify(uncertain)), events: [JSON.parse(JSON.stringify(started)), JSON.parse(JSON.stringify(uncertainEvent))], started }
  })
}

test('an uncertain line-targeted write reconciles from the journaled planned digest without rewriting the file', async t => {
  const f = await unknownLineWrite(t)
  const before = readFileSync(join(f.root, 'notes.md')), beforeStat = statSync(join(f.root, 'notes.md'))
  const input = reviewInput(f.facts, 'notes.md', f.root, { idempotencyKey: 'wp4-reconcile-line' })
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'expectedContentDigest'), false)

  const reconciler = reconciliationReview(binding, () => f.root, () => ({ root: f.root, exclude: [] }), () => sessionId)
  assert.equal(f.prompts.length, 1)
  const result = await reconciler.handler(input)
  assert.equal(f.prompts.length, 2)

  assert.equal(result.approved, true); assert.equal(result.reconciled, true); assert.equal(result.changed, true)
  assert.equal(result.status, 'reconciled'); assert.equal(result.state, 'succeeded')
  assert.equal(result.journalKind, writeKind); assert.equal(result.retryAuthorized, false); assert.equal(result.acceptanceGranted, false)
  assert.equal(result.attemptId, f.facts.attempt.attemptId)
  assert.equal(result.receipt.id, 'receipt:' + f.facts.attempt.executionId)

  const receipt = result.receipt
  assert.equal(receipt.kind, 'file_flush_receipt'); assert.equal(receipt.lifecycle, 'issued')
  assert.equal(receipt.invocation.toolId, writeTool)
  assert.equal(receipt.invocation.id, f.facts.attempt.executionId)
  assert.equal(receipt.invocation.context.attemptId, f.facts.attempt.attemptId)
  assert.equal(receipt.invocation.createdAt, f.facts.attempt.startedAt)
  assert.deepEqual(receipt.invocation.arguments, { path: 'notes.md', expectedHash: sha(f.original), contentDigest: rawDigest(f.replacement), target: { mode: 'line', start: 1, end: 2 }, expectedBufferVersion: 0 })
  assert.equal(receipt.observation.status, 'success')
  assert.equal(receipt.observation.value.path, 'notes.md')
  assert.deepEqual(receipt.observation.value.target, { mode: 'line', start: 1, end: 2 })
  assert.equal(receipt.observation.value.beforeRawHash, rawDigest(f.original))
  assert.equal(receipt.observation.value.rawHash, rawDigest(f.planned))
  assert.equal(receipt.observation.value.hash, sha(f.planned))
  assert.equal(receipt.observation.value.bytes, Buffer.byteLength(f.planned))
  assert.equal(receipt.observation.value.reconciled, true)
  assert.equal(receipt.observation.value.reviewId, result.reviewId)
  assert.equal(receipt.observation.value.reconciliationRef, 'manual:wp4-host-inspection')
  assert.equal(receipt.observation.value.proof, 'host-confirmed-current-file-and-journaled-planned-content')
  assert.deepEqual(receipt.workspaceAnchor.affectedFiles, ['notes.md'])
  assert.equal(receipt.workspaceAnchor.snapshotId, rawDigest(f.planned))
  assert.match(receipt.workspaceAnchor.workspaceId, /^sha256:[a-f0-9]{64}$/)
  assert.match(receipt.workspaceAnchor.changeHash, /^sha256:[a-f0-9]{64}$/)
  const integrity = await verifyReceiptIntegrity(receipt, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'test', verifierVersion: 'test', verifiedAt: new Date().toISOString() })
  assert.equal(integrity.status, 'integrity_verified')

  // Reconciliation never rewrites: same bytes, inode and mtime.
  assert.deepEqual(readFileSync(join(f.root, 'notes.md')), before)
  assert.equal(statSync(join(f.root, 'notes.md')).ino, beforeStat.ino)
  assert.equal(statSync(join(f.root, 'notes.md')).mtimeMs, beforeStat.mtimeMs)

  const after = persisted(f.root)
  assert.equal(after.action.state, 'succeeded')
  assert.equal(after.attempt.state, 'succeeded')
  assert.equal(after.receipts.length, 1)
  assert.equal(after.receipts[0].id, receipt.id)
  assert.equal(after.writes.at(-1).state, 'succeeded')
  assert.equal(after.writes.at(-1).key, f.facts.started.key)
  assert.equal(after.writes.at(-1).request, f.facts.started.request)
  assert.equal(after.writes.at(-1).plannedContentDigest, digest(f.planned))
  assert.equal(after.writes.at(-1).budgetReservationId, f.facts.started.budgetReservationId)
  assert.equal(after.writes.at(-1).result.reconciled, true)
  assert.equal(after.writes.at(-1).reconciliationReviewId, result.reviewId)
  assert.equal(after.replaces.length, 0)
  assert.equal(after.requests.length, 1); assert.equal(after.decisions.length, 1); assert.equal(after.reconciliations.length, 1)
  assert.equal(after.decisions[0].approved, true)

  const reservation = reservationOf(f.root, f.facts.started.budgetReservationId)
  assert.equal(reservation.state, 'settled')
  assert.equal(reservation.actual.calls, reservation.amount.calls)
  assert.equal(reservation.actual.bytes, reservation.amount.bytes)
  assert.equal(result.budget.conservative, true)
  assert.equal(result.budget.reservationId, f.facts.started.budgetReservationId)

  // The recovered terminal claim makes both the original effect and the review replayable.
  assert.equal((await reconciler.handler(input)).replayed, true)
  assert.equal((await f.writer.handler(f.writeInput)).reconciled, true)

  // The receipt is a consumable native execution fact for evidence.
  const evidence = evidenceBindings(binding, () => f.root, () => ({ root: f.root, exclude: [] }))
  const review = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence_review')
  const cite = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence.cite')
  const approved = await review.handler({ receiptId: receipt.id, claim: 'The line-targeted write produced the journaled planned content', criteriaVersion: '1', idempotencyKey: 'wp4-evidence-line' })
  assert.equal(approved.verification.status, 'semantic_verified')
  assert.equal(approved.acceptanceGranted, false)
  const citation = await cite.handler({ ids: [approved.evidence.id] })
  assert.equal(citation.citations.length, 1)
  assert.equal(citation.citations[0].receiptId, receipt.id)
  assert.equal(citation.acceptanceGranted, false)
})

test('an uncertain string replace reconciles from its planned digest and appends the terminal replace journal', async t => {
  const f = await unknownStringReplace(t)
  const before = readFileSync(join(f.root, 'a.txt')), beforeStat = statSync(join(f.root, 'a.txt'))
  const input = reviewInput(f.facts, 'a.txt', f.root, { idempotencyKey: 'wp4-reconcile-replace' })
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'expectedContentDigest'), false)

  const reconciler = reconciliationReview(binding, () => f.root, () => ({ root: f.root, exclude: [] }), () => sessionId)
  const result = await reconciler.handler(input)
  assert.equal(result.status, 'reconciled'); assert.equal(result.state, 'succeeded')
  assert.equal(result.journalKind, replaceKind)

  const receipt = result.receipt
  assert.equal(receipt.invocation.toolId, replaceTool)
  assert.deepEqual(receipt.invocation.arguments, { path: 'a.txt', mode: 'string', text: 'beta', replacement: 'BETA' })
  assert.equal(receipt.observation.value.mode, 'string')
  assert.equal(receipt.observation.value.rawHash, rawDigest(f.planned))
  assert.equal(receipt.observation.value.hash, sha(f.planned))
  assert.equal(receipt.observation.value.bytes, Buffer.byteLength(f.planned))
  assert.equal(receipt.observation.value.reconciled, true)
  assert.equal(receipt.observation.value.proof, 'host-confirmed-current-file-and-journaled-planned-content')
  assert.deepEqual(receipt.workspaceAnchor.affectedFiles, ['a.txt'])
  assert.equal(receipt.workspaceAnchor.snapshotId, rawDigest(f.planned))

  assert.deepEqual(readFileSync(join(f.root, 'a.txt')), before)
  assert.equal(statSync(join(f.root, 'a.txt')).ino, beforeStat.ino)
  assert.equal(statSync(join(f.root, 'a.txt')).mtimeMs, beforeStat.mtimeMs)

  const after = persisted(f.root)
  assert.equal(after.action.state, 'succeeded')
  assert.equal(after.attempt.state, 'succeeded')
  assert.equal(after.receipts.length, 1)
  assert.equal(after.replaces.at(-1).state, 'succeeded')
  assert.equal(after.replaces.at(-1).key, f.facts.started.key)
  assert.equal(after.replaces.at(-1).request, f.facts.started.request)
  assert.equal(after.replaces.at(-1).plannedContentDigest, digest(f.planned))
  assert.equal(after.replaces.at(-1).budgetReservationId, f.facts.started.budgetReservationId)
  assert.equal(after.replaces.at(-1).result.reconciled, true)
  assert.equal(after.replaces.at(-1).reconciliationReviewId, result.reviewId)
  // The terminal event belongs to the replace journal, never to the write journal.
  assert.equal(after.writes.length, 0)
  assert.equal(after.replaces.filter(event => event.state === 'succeeded').length, 1)
  assert.equal(after.replaces.filter(event => event.state === 'unknown_outcome').length, 1)

  const reservation = reservationOf(f.root, f.facts.started.budgetReservationId)
  assert.equal(reservation.state, 'settled')
  assert.equal(reservation.actual.calls, reservation.amount.calls)
  assert.equal(reservation.actual.bytes, reservation.amount.bytes)
  assert.equal(result.budget.conservative, true)
  assert.equal((await reconciler.handler(input)).replayed, true)
})

test('a rejected replace reconciliation leaves the attempt unknown and the budget reservation reserved', async t => {
  const f = await unknownStringReplace(t)
  const before = readFileSync(join(f.root, 'a.txt')), beforeStat = statSync(join(f.root, 'a.txt'))
  approvals(t, 'reject')
  const input = reviewInput(f.facts, 'a.txt', f.root, { idempotencyKey: 'wp4-reconcile-rejected' })
  const reconciler = reconciliationReview(binding, () => f.root, () => ({ root: f.root, exclude: [] }), () => sessionId)
  const denied = await reconciler.handler(input)

  assert.equal(denied.approved, false); assert.equal(denied.reconciled, false); assert.equal(denied.changed, false)
  assert.equal(denied.status, 'rejected'); assert.equal(denied.receipt, undefined)
  assert.deepEqual(readFileSync(join(f.root, 'a.txt')), before)
  assert.equal(statSync(join(f.root, 'a.txt')).mtimeMs, beforeStat.mtimeMs)

  const after = persisted(f.root)
  assert.equal(after.action.state, 'unknown_outcome')
  assert.equal(after.attempt.state, 'unknown_outcome')
  assert.equal(after.receipts.length, 0)
  assert.equal(after.replaces.at(-1).state, 'unknown_outcome')
  assert.equal(after.replaces.some(event => ['succeeded', 'failed', 'cancelled'].includes(event.state)), false)
  assert.equal(after.requests.length, 1); assert.equal(after.decisions.length, 1)
  assert.equal(after.decisions[0].approved, false)
  assert.equal(after.reconciliations.length, 1)
  assert.equal(after.reconciliations[0].result.status, 'rejected')
  const reservation = reservationOf(f.root, f.facts.started.budgetReservationId)
  assert.equal(reservation.state, 'reserved')
})

test('a model-supplied expected digest that differs from the journaled plan fails before approval', async t => {
  const f = await unknownLineWrite(t)
  const before = readFileSync(join(f.root, 'notes.md')), beforeStat = statSync(join(f.root, 'notes.md'))
  const input = reviewInput(f.facts, 'notes.md', f.root, { idempotencyKey: 'wp4-reconcile-wrong-digest', expectedContentDigest: digest('some other planned output\n') })
  const promptsBefore = f.prompts.length
  const reconciler = reconciliationReview(binding, () => f.root, () => ({ root: f.root, exclude: [] }), () => sessionId)
  await assert.rejects(reconciler.handler(input), /expected content digest differs/i)

  assert.equal(f.prompts.length, promptsBefore)
  assert.deepEqual(readFileSync(join(f.root, 'notes.md')), before)
  assert.equal(statSync(join(f.root, 'notes.md')).mtimeMs, beforeStat.mtimeMs)
  const after = persisted(f.root)
  assert.equal(after.action.state, 'unknown_outcome')
  assert.equal(after.attempt.state, 'unknown_outcome')
  assert.equal(after.receipts.length, 0)
  assert.equal(after.requests.length, 0)
  assert.equal(after.reconciliations.length, 0)
  assert.equal(after.writes.at(-1).state, 'unknown_outcome')
})

test('a legacy whole-file write journal without a planned digest falls back to its requested full content', async t => {
  const root = makeWorkspace(t)
  const before = 'legacy original\n', after = 'legacy recovered\n'
  const prompts = approvals(t, 'approve')
  const facts = legacyUnknownWrite(root, { path: 'legacy.md', before, after })
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.started.plannedContentDigest, undefined)
  assert.equal(facts.events.filter(event => event.state === 'started').length, 1)
  assert.equal(facts.events.at(-1).state, 'unknown_outcome')

  const input = reviewInput(facts, 'legacy.md', root, { idempotencyKey: 'wp4-reconcile-legacy' })
  const reconciler = reconciliationReview(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const result = await reconciler.handler(input)
  assert.equal(prompts.length, 1)
  assert.equal(result.state, 'succeeded'); assert.equal(result.status, 'reconciled')
  assert.equal(result.receipt.invocation.toolId, writeTool)
  assert.deepEqual(result.receipt.invocation.arguments, { path: 'legacy.md', expectedHash: sha(before), contentDigest: rawDigest(after) })
  assert.equal(result.receipt.observation.value.rawHash, rawDigest(after))
  assert.equal(result.receipt.observation.value.proof, 'host-confirmed-current-file-and-original-request')
  assert.equal(result.budget.legacyWithoutReservation, true)
  assert.equal(result.budget.settlementPerformed, false)

  const afterState = persisted(root)
  assert.equal(afterState.action.state, 'succeeded')
  assert.equal(afterState.attempt.state, 'succeeded')
  assert.equal(afterState.receipts.length, 1)
  assert.equal(afterState.writes.at(-1).state, 'succeeded')
  assert.equal('plannedContentDigest' in afterState.writes.at(-1), false)
  assert.equal(afterState.reconciliations[0].proof.plannedContentDigest, undefined)
  assert.equal(afterState.reconciliations[0].proof.expectedDigest, digest(after))
})
