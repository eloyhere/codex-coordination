/**
 * Fault injection around the two native file effects: the real CAS flush reaches
 * disk, then receipt persistence throws and the surrounding SQLite transaction
 * rolls back. These tests pin the journal evidence the next reconciliation WP
 * needs (`plannedContentDigest`, an open `budgetReservationId`) without calling
 * `reconciliationReview` yet.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { normalizeToLf } from 'attention-manifest-protocol/file'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { makeWorkspace } from './helpers.mjs'
import { writeBinding } from '../plugins/codex-coordination/mcp/amp/write.mjs'
import { replaceBinding } from '../plugins/codex-coordination/mcp/amp/replace.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { nativeIoBudget } from '../plugins/codex-coordination/mcp/amp/read-budget.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test/1', cancellationEpoch: 0 }
const sessionId = 'file-effect-session'
const sha = value => createHash('sha256').update(value).digest('hex')
/** AMP's normalized-LF digest convention, as used by reconciliation. */
const digest = value => 'sha256:' + sha(normalizeToLf(value))

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

/** Approve every elicitation and restore the host client afterwards. */
function approve(t) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
}

/**
 * Throw once when the post-flush receipt row is persisted. `Store.prototype.save`
 * is shared by every handler, so the patch must be restored in a `finally`.
 */
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
    const action = p.workflow.list('action', sessionId)[0]
    const attempt = p.workflow.getAttempt(action.attemptIds.at(-1))
    const events = store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload)))
    return { action, attempt, receipts: store.list('receipt'), events }
  })
}

function reservationOf(root, id) {
  return withStore(root, store => nativeIoBudget(store, 'native-read:codex').getReservation(id))
}

test('a line-targeted write whose receipt fails after flush leaves the planned content digest and an open budget reservation', async t => {
  const root = makeWorkspace(t)
  const original = 'line one\nline two\nline three\n'
  const replacement = 'line two updated\n'
  const planned = 'line one\nline two updated\nline three\n'
  writeFileSync(join(root, 'notes.md'), original)
  seed(root)
  approve(t)
  const tool = writeBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const fault = failReceiptOnce()
  try {
    await assert.rejects(tool.handler({
      path: 'notes.md', content: replacement, expectedHash: sha(original), target: { mode: 'line', start: 1, end: 2 },
      taskId: 'task', idempotencyKey: 'uncertain-line-write',
    }), /outcome is unresolved/)
  } finally { fault.restore() }
  assert.equal(fault.fired, true)
  // The native CAS committed before receipt persistence failed.
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), planned)

  const facts = nativeFacts(root, 'codex.amp.workspace.write')
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.receipts.length, 0)
  const started = facts.events.filter(event => event.state === 'started')
  assert.equal(started.length, 1)
  assert.equal(started[0].plannedContentDigest, digest(planned))
  assert.match(started[0].budgetReservationId, /^write-budget:/)
  assert.equal(facts.events.at(-1).state, 'unknown_outcome')
  assert.equal(facts.events.at(-1).plannedContentDigest, digest(planned))

  const reservation = reservationOf(root, started[0].budgetReservationId)
  assert.equal(reservation.state, 'reserved')
  assert.ok(reservation.amount.bytes >= Buffer.byteLength(planned) + Buffer.byteLength(replacement),
    `reservation ${reservation.amount.bytes} does not cover the planned write`)
})

test('a string replace whose receipt fails after flush leaves the planned content digest and an open budget reservation', async t => {
  const root = makeWorkspace(t)
  const original = 'alpha beta\nsecond line\n'
  const replacement = 'BETA'
  const planned = 'alpha BETA\nsecond line\n'
  writeFileSync(join(root, 'a.txt'), original)
  seed(root)
  approve(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)
  const fault = failReceiptOnce()
  try {
    await assert.rejects(tool.handler({
      path: 'a.txt', mode: 'string', text: 'beta', replacement,
      taskId: 'task', idempotencyKey: 'uncertain-string-replace',
    }), /outcome is unresolved/)
  } finally { fault.restore() }
  assert.equal(fault.fired, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), planned)

  const facts = nativeFacts(root, 'codex.amp.workspace.replace')
  assert.equal(facts.action.state, 'unknown_outcome')
  assert.equal(facts.attempt.state, 'unknown_outcome')
  assert.equal(facts.receipts.length, 0)
  const started = facts.events.filter(event => event.state === 'started')
  assert.equal(started.length, 1)
  assert.equal(started[0].plannedContentDigest, digest(planned))
  assert.match(started[0].budgetReservationId, /^replace-budget:/)
  assert.equal(facts.events.at(-1).state, 'unknown_outcome')
  assert.equal(facts.events.at(-1).plannedContentDigest, digest(planned))

  const reservation = reservationOf(root, started[0].budgetReservationId)
  assert.equal(reservation.state, 'reserved')
  assert.ok(reservation.amount.bytes >= Buffer.byteLength(planned) + Buffer.byteLength(replacement),
    `reservation ${reservation.amount.bytes} does not cover the planned replace`)
})

test('a whitespace-only literal target is accepted and replaces exactly the addressed space', async t => {
  const root = makeWorkspace(t)
  const original = 'a b\n'
  writeFileSync(join(root, 'a.txt'), original)
  seed(root)
  approve(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => sessionId)

  // The new expectedBufferVersion guard is checked before approval or any claim.
  await assert.rejects(tool.handler({
    path: 'a.txt', mode: 'string', text: ' ', replacement: '-', expectedBufferVersion: -1,
    taskId: 'task', idempotencyKey: 'bad-buffer-version',
  }), /expectedBufferVersion must be a nonnegative safe integer/)

  const result = await tool.handler({ path: 'a.txt', mode: 'string', text: ' ', replacement: '-', taskId: 'task', idempotencyKey: 'whitespace-text' })
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.mode, 'string')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a-b\n')
  const facts = nativeFacts(root, 'codex.amp.workspace.replace')
  assert.equal(facts.action.state, 'succeeded')
  assert.equal(facts.attempt.state, 'succeeded')
  assert.equal(facts.receipts.length, 1)
  assert.equal(facts.events.at(-1).state, 'succeeded')
  assert.equal(facts.events.find(event => event.state === 'started').plannedContentDigest, digest('a-b\n'))
})
