import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeWorkspace } from './helpers.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'

const moduleRoot = process.env.AMP_REPLACE_TEST_MODULE_ROOT ? pathToFileURL(resolve(process.env.AMP_REPLACE_TEST_MODULE_ROOT) + '/').href : new URL('../plugins/codex-coordination/mcp/amp/', import.meta.url).href
const { replaceBinding } = await import(moduleRoot + 'replace.mjs')
const { openNativeStore } = await import(moduleRoot + 'native-store.mjs')
const { configureHostClient, acceptHostResponse, closeHostClient } = await import(moduleRoot + 'host-client.mjs')

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test', cancellationEpoch: 0 }
const sha = value => createHash('sha256').update(value).digest('hex')
const rawHash = value => 'sha256:' + sha(value)

function seed(root) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    let session = p.create('session', { id: 'session', sessionId: 'session', rootId: sha(root), participants: ['test'] }, 'test')
    session = p.transition('session', session.id, 'active', { expectedVersion: session.version, actor: 'test' })
    const turn = p.create('turn', { id: 'turn', sessionId: session.id, classification: 'steering' }, 'test')
    p.transition('turn', turn.id, 'interpreting', { expectedVersion: turn.version, actor: 'test' })
    const intent = p.create('intent', { id: 'intent', sessionId: session.id, originTurnId: turn.id, text: 'replace' }, 'test')
    p.transition('intent', intent.id, 'confirmed', { expectedVersion: intent.version, actor: 'test' })
    p.transition('intent', intent.id, 'accepted', { expectedVersion: intent.version + 1, actor: 'test' })
    const mission = p.create('mission', { id: 'mission', sessionId: session.id, intentId: intent.id, title: 't', statement: 't' }, 'test')
    p.transition('mission', mission.id, 'active', { expectedVersion: mission.version, actor: 'test' })
    const goal = p.create('goal', { id: 'goal', sessionId: session.id, missionId: mission.id, contractVersion: '1', acceptanceCriteria: ['edited'], statement: 't' }, 'test')
    p.transition('goal', goal.id, 'active', { expectedVersion: goal.version, actor: 'test' })
    const plan = p.create('plan', { id: 'plan', sessionId: session.id, goalId: goal.id, bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 60000).toISOString(), progressMetric: 'p', deadLetterOwner: 'test' } }, 'test')
    const task = p.create('task', { id: 'task', sessionId: session.id, planId: plan.id, contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] }, 'test')
    p.transition('task', task.id, 'proposed', { expectedVersion: task.version, actor: 'test' })
    p.transition('plan', plan.id, 'approved', { expectedVersion: plan.version, actor: 'test' })
    p.transition('plan', plan.id, 'executing', { expectedVersion: plan.version + 1, actor: 'test' })
    p.transition('task', task.id, 'ready', { expectedVersion: task.version + 1, actor: 'test' })
  } finally { store.close() }
}

/** Approve (or reject) every elicitation and keep the exact host prompts. */
function approvals(t, approve = true) {
  const messages = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    messages.push(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: approve ? 'approve' : 'reject' } } }))
  })
  return messages
}

function replaceEvents(root) {
  const { store } = openNativeStore(() => root)
  try { return store.events({ kind: 'codex.amp.workspace.replace' }).map(event => ({ ...event, payload: JSON.parse(JSON.stringify(event.payload)) })) } finally { store.close() }
}

function nativeFacts(root) {
  const { store } = openNativeStore(() => root)
  try {
    return JSON.parse(JSON.stringify({ actions: store.list('action'), attempts: store.list('action_attempt'), receipts: store.list('receipt'), tasks: store.list('task') }))
  } finally { store.close() }
}

const base = { taskId: 'task', idempotencyKey: 'replace-attempt-1', path: 'a.txt' }

test('replace creates one native action attempt and a file_flush_receipt; replay returns the same receipt', async t => {
  const root = makeWorkspace(t)
  const original = 'alpha beta\nsecond line\n'
  const expected = 'alpha BETA\nsecond line\n'
  writeFileSync(join(root, 'a.txt'), original)
  seed(root)
  const prompts = approvals(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session')
  const input = { ...base, mode: 'string', text: 'beta', replacement: 'BETA' }

  const result = await tool.handler(input)
  assert.equal(prompts.length, 1)
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.businessVerification, 'not_performed')
  assert.equal(result.mode, 'string')
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), expected)
  assert.match(result.actionId, /^workspace-replace:/)
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/)
  assert.match(result.executionId, /^[0-9a-f-]{36}$/)
  assert.equal(result.operationId.length > 0, true)
  assert.match(result.budgetReservationId, /^replace-budget:/)

  const receipt = result.receipt
  assert.equal(receipt.kind, 'file_flush_receipt')
  assert.equal(receipt.lifecycle, 'issued')
  assert.equal(receipt.id, 'receipt:' + result.executionId)
  assert.equal(receipt.invocation.toolId, 'attention_manifest_protocol_replace')
  assert.equal(receipt.invocation.id, result.executionId)
  assert.equal(receipt.invocation.context.tenantId, binding.tenantId)
  assert.equal(receipt.invocation.context.principalId, binding.principalId)
  assert.equal(receipt.invocation.context.sessionId, 'session')
  assert.equal(receipt.invocation.context.attemptId, result.attemptId)
  assert.deepEqual(receipt.invocation.arguments, { path: 'a.txt', mode: 'string', text: 'beta', replacement: 'BETA' })
  assert.equal(receipt.observation.status, 'success')
  assert.equal(receipt.observation.value.path, 'a.txt')
  assert.equal(receipt.observation.value.mode, 'string')
  assert.equal(receipt.observation.value.beforeRawHash, rawHash(original))
  assert.equal(receipt.observation.value.rawHash, rawHash(expected))
  assert.equal(receipt.observation.value.hash, sha(expected))
  assert.equal(receipt.observation.value.baseHash, rawHash(original))
  assert.equal(receipt.observation.value.bufferVersion, 1)
  assert.equal(receipt.observation.value.bytes, Buffer.byteLength(expected))
  assert.deepEqual(receipt.workspaceAnchor.affectedFiles, ['a.txt'])
  assert.equal(receipt.workspaceAnchor.snapshotId, rawHash(expected))
  assert.match(receipt.workspaceAnchor.workspaceId, /^sha256:[a-f0-9]{64}$/)
  assert.match(receipt.workspaceAnchor.changeHash, /^sha256:[a-f0-9]{64}$/)

  const facts = nativeFacts(root)
  assert.equal(facts.attempts.length, 1)
  assert.equal(facts.attempts[0].attemptId, result.attemptId)
  assert.equal(facts.attempts[0].actionId, result.actionId)
  assert.equal(facts.attempts[0].state, 'succeeded')
  assert.equal(facts.actions.length, 1)
  assert.equal(facts.actions[0].id, result.actionId)
  assert.equal(facts.actions[0].effect, 'workspace:file.write')
  assert.equal(facts.actions[0].recovery, 'reconcile')
  assert.equal(facts.actions[0].sideEffect, true)
  assert.equal(facts.actions[0].state, 'succeeded')
  assert.equal(facts.receipts.length, 1)
  assert.equal(facts.receipts[0].id, receipt.id)
  assert.equal(facts.tasks[0].state, 'active')
  const journal = replaceEvents(root)
  assert.equal(journal.at(-1).payload.state, 'succeeded')
  assert.equal(journal.at(-1).payload.result.attemptId, result.attemptId)
  assert.equal(journal.filter(event => event.payload.state === 'approval_pending').length, 1)
  assert.equal(journal.filter(event => event.payload.state === 'started').length, 1)

  const replay = await tool.handler(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.id, receipt.id)
  assert.deepEqual(replay.receipt, receipt)
  assert.equal(prompts.length, 1)
  await assert.rejects(tool.handler({ ...input, replacement: 'OTHER' }), /already used for a different replace/)
  assert.equal(prompts.length, 1)
  const afterReplay = nativeFacts(root)
  assert.equal(afterReplay.attempts.length, 1)
  assert.equal(afterReplay.receipts.length, 1)

  // A correct guard (plain hex spelling) is normalized and accepted by the native handler.
  const guarded = await tool.handler({ ...base, idempotencyKey: 'replace-attempt-2', mode: 'string', text: 'BETA', replacement: 'beta', expectedBaseHash: sha(expected), expectedBufferVersion: 0 })
  assert.equal(guarded.approved, true)
  assert.equal(guarded.changed, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), original)
  assert.equal(guarded.receipt.invocation.arguments.expectedBaseHash, sha(expected))
  assert.equal(guarded.receipt.invocation.arguments.expectedBufferVersion, 0)
  assert.equal(guarded.receipt.observation.value.baseHash, rawHash(expected))
})

test('replace receipts enter independent evidence review and reject changed output', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'a.txt'), 'original line\n')
  seed(root)
  const { evidenceBindings } = await import(moduleRoot + 'evidence.mjs')
  const policy = () => ({ root, exclude: [] })
  const scope = () => 'session'
  const replace = replaceBinding(binding, () => root, policy, scope)
  const evidence = evidenceBindings(binding, () => root, policy)
  const review = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence_review')
  const cite = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence.cite')
  approvals(t)

  const replaced = await replace.handler({ ...base, idempotencyKey: 'replace-evidence', mode: 'string', text: 'original', replacement: 'approved output' })
  assert.equal(replaced.changed, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'approved output line\n')
  const input = { receiptId: replaced.receipt.id, claim: 'The file contains approved output', criteriaVersion: '1', idempotencyKey: 'verify-replace' }
  const approved = await review.handler(input)
  assert.equal(approved.verification.status, 'semantic_verified')
  assert.equal(approved.acceptanceGranted, false)
  assert.equal((await cite.handler({ ids: [approved.evidence.id] })).citations.length, 1)

  writeFileSync(join(root, 'a.txt'), 'changed output\n')
  await assert.rejects(cite.handler({ ids: [approved.evidence.id] }), /file.*changed/)
  await assert.rejects(review.handler({ ...input, idempotencyKey: 'changed-output' }), /file.*changed/)
})

test('denied replace approval creates no action, attempt or receipt and leaves the file unchanged', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'a.txt'), 'original\n')
  seed(root)
  const prompts = approvals(t, false)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session')

  const denied = await tool.handler({ ...base, mode: 'string', text: 'original', replacement: 'next' })
  assert.equal(prompts.length, 1)
  assert.equal(denied.approved, false)
  assert.equal(denied.changed, false)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n')
  const facts = nativeFacts(root)
  assert.equal(facts.actions.length, 0)
  assert.equal(facts.attempts.length, 0)
  assert.equal(facts.receipts.length, 0)
  const journal = replaceEvents(root)
  assert.equal(journal.length, 2)
  assert.equal(journal[0].payload.state, 'approval_pending')
  assert.equal(journal[1].payload.result.approved, false)
  assert.equal(journal[1].payload.state, undefined)
})

test('stale replace guards are rejected before approval without actions, attempts or receipts', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'a.txt'), 'original\n')
  seed(root)
  const prompts = approvals(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session')

  await assert.rejects(tool.handler({ ...base, idempotencyKey: 'stale-base-hash', mode: 'string', text: 'original', replacement: 'next', expectedBaseHash: sha('different') }), /expectedBaseHash/)
  await assert.rejects(tool.handler({ ...base, idempotencyKey: 'stale-buffer', mode: 'string', text: 'original', replacement: 'next', expectedBufferVersion: 1 }), /buffer is at version 0/)
  assert.equal(prompts.length, 0)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n')
  assert.equal(replaceEvents(root).length, 0)
  const facts = nativeFacts(root)
  assert.equal(facts.actions.length, 0)
  assert.equal(facts.attempts.length, 0)
  assert.equal(facts.receipts.length, 0)
})
