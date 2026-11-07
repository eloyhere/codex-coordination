import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, symlinkSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const moduleRoot = process.env.AMP_WRITE_TEST_MODULE_ROOT ? pathToFileURL(resolve(process.env.AMP_WRITE_TEST_MODULE_ROOT) + '/').href : new URL('../plugins/codex-coordination/mcp/amp/', import.meta.url).href
const { writeBinding } = await import(moduleRoot + 'write.mjs')
const { configureHostClient, acceptHostResponse, closeHostClient } = await import(moduleRoot + 'host-client.mjs')
const { openNativeStore } = await import(moduleRoot + 'native-store.mjs')
import { makeWorkspace } from './helpers.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
function seed(root) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    let session = p.create('session', { id: 'session-write', sessionId: 'session-write', rootId: sha(root), participants: ['test'] }, 'test')
    session = p.transition('session', session.id, 'active', { expectedVersion: session.version, actor: 'test' })
    const turn = p.create('turn', { id: 'turn-write', sessionId: session.id, classification: 'steering' }, 'test')
    p.transition('turn', turn.id, 'interpreting', { expectedVersion: turn.version, actor: 'test' })
    const intent = p.create('intent', { id: 'intent-write', sessionId: session.id, originTurnId: turn.id, text: 'write test file' }, 'test')
    p.transition('intent', intent.id, 'confirmed', { expectedVersion: intent.version, actor: 'test' })
    p.transition('intent', intent.id, 'accepted', { expectedVersion: intent.version + 1, actor: 'test' })
    const mission = p.create('mission', { id: 'mission-write', sessionId: session.id, intentId: intent.id, title: 'test', statement: 'test' }, 'test')
    p.transition('mission', mission.id, 'active', { expectedVersion: mission.version, actor: 'test' })
    const goal = p.create('goal', { id: 'goal-write', sessionId: session.id, missionId: mission.id, contractVersion: '1', acceptanceCriteria: ['The expected file content exists'], statement: 'test' }, 'test')
    p.transition('goal', goal.id, 'active', { expectedVersion: goal.version, actor: 'test' })
    const plan = p.create('plan', { id: 'plan-write', sessionId: session.id, goalId: goal.id, bounds: { maxAttempts: 2, deadline: new Date(Date.now() + 60000).toISOString(), progressMetric: 'test', deadLetterOwner: 'test' } }, 'test')
    const task = p.create('task', { id: 'task-write', sessionId: session.id, planId: plan.id, contractVersion: '1', dependsOn: [], required: false, requiredEffects: [] }, 'test')
    p.transition('task', task.id, 'proposed', { expectedVersion: task.version, actor: 'test' })
    p.transition('plan', plan.id, 'approved', { expectedVersion: plan.version, actor: 'test' })
    p.transition('plan', plan.id, 'executing', { expectedVersion: plan.version + 1, actor: 'test' })
    p.transition('task', task.id, 'ready', { expectedVersion: task.version + 1, actor: 'test' })
  } finally { store.close() }
}

test('native write binding requires active selected workflow and host approval, uses CAS and durable replay', async t => {
  const root = makeWorkspace(t)
  const bytes = Buffer.from('\uFEFF# Original\r\n', 'utf8')
  writeFileSync(join(root, 'public.md'), bytes)
  const taskId = 'task-write'
  let selected = 'session-write'
  const scope = () => selected
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }
  const tool = writeBinding(binding, () => root, () => ({ root, exclude: [] }), scope)
  const input = { path: 'public.md', content: '# Changed\n', expectedHash: sha('# Original\n'), taskId, idempotencyKey: 'write-1' }
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  seed(root)

  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
  const result = await tool.handler(input)
  assert.equal(result.approved, true)
  assert.equal(result.businessVerification, 'not_performed')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(result.receipt.kind, 'file_flush_receipt')
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), '\uFEFF# Changed\r\n')
  assert.equal((await tool.handler(input)).replayed, true)

  const { store } = openNativeStore(() => root)
  try {
    assert.equal(store.list('action_attempt').length, 1)
    assert.equal(store.list('receipt').length, 1)
    assert.equal(store.events({ kind: 'codex.amp.workspace.write' }).at(-1).payload.state, 'succeeded')
  } finally { store.close() }
})

test('write approval is bound to a detached request when the caller mutates input', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), 'original\n')
  seed(root)
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }
  const input = { path: 'public.md', content: 'approved-A\n', expectedHash: sha('original\n'), taskId: 'task-write', idempotencyKey: 'immutable' }
  const snapshot = { ...input }
  const policy = { root, exclude: [] }
  let prompts = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    prompts++
    assert.match(message.params.message, /approved-A/)
    assert.doesNotMatch(message.params.message, /unapproved-B/)
    input.content = 'unapproved-B\n'; input.path = 'other.md'; input.taskId = 'foreign-task'; input.idempotencyKey = 'changed-key'
    policy.exclude.push('public.md')
    // A retained policy reference cannot rewrite the snapshot used for preflight.
    policy.exclude.pop()
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  const tool = writeBinding(binding, () => root, () => policy, () => 'session-write')
  const result = await tool.handler(input)
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), 'approved-A\n')
  assert.equal(result.file.path, snapshot.path)
  assert.equal(result.receipt.invocation.arguments.contentDigest, 'sha256:' + sha(snapshot.content))
  assert.equal((await tool.handler(snapshot)).replayed, true)
  assert.equal(prompts, 1)
})

test('file write receipts enter independent evidence review and reject changed output', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), 'original\n')
  seed(root)
  const { evidenceBindings } = await import(moduleRoot + 'evidence.mjs')
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }
  const scope = () => 'session-write', policy = () => ({ root, exclude: [] })
  const write = writeBinding(binding, () => root, policy, scope)
  const evidence = evidenceBindings(binding, () => root, policy)
  const review = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence_review')
  const cite = evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence.cite')
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
  const result = await write.handler({ path: 'public.md', content: 'approved output\n', expectedHash: sha('original\n'), taskId: 'task-write', idempotencyKey: 'write-evidence' })
  const input = { receiptId: result.receipt.id, claim: 'The public file contains approved output', criteriaVersion: '1', idempotencyKey: 'verify-output' }
  const approved = await review.handler(input)
  assert.equal(approved.verification.status, 'semantic_verified')
  assert.equal(approved.acceptanceGranted, false)
  assert.equal((await cite.handler({ ids: [approved.evidence.id] })).citations.length, 1)
  writeFileSync(join(root, 'public.md'), 'changed output\n')
  await assert.rejects(cite.handler({ ids: [approved.evidence.id] }), /file.*changed/)
  await assert.rejects(review.handler({ ...input, idempotencyKey: 'changed-output' }), /file.*changed/)
  writeFileSync(join(root, 'public.md'), 'approved output\n')
  configureHostClient({ elicitation: {} }, message => {
    writeFileSync(join(root, 'public.md'), 'changed during review\n')
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(review.handler({ ...input, idempotencyKey: 'output-race' }), /file.*changed/)
})

test('host approval cannot bypass an exhausted native I/O quota for file writes', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), 'original\n')
  seed(root)
  const { BudgetLedger } = await import('attention-manifest-protocol/budget')
  const { bindBudget } = await import('attention-manifest-protocol/persistence')
  const { store } = openNativeStore(() => root)
  try { bindBudget(store, new BudgetLedger()).configure('native-read:codex', { calls: 0, bytes: 0, milliseconds: 0, tokens: 0, retries: 0, concurrency: 0 }) } finally { store.close() }
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
  const tool = writeBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session-write')
  await assert.rejects(tool.handler({ path: 'public.md', content: 'must not write\n', expectedHash: sha('original\n'), taskId: 'task-write', idempotencyKey: 'zero-quota' }), /Reservation would exceed/)
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), 'original\n')
  const reopened = openNativeStore(() => root)
  try { assert.equal(reopened.store.list('action_attempt').length, 0); assert.equal(reopened.store.list('receipt').length, 0) } finally { reopened.store.close() }
})

test('early policy and scope failures close the native Store without creating write claims', async t => {
  // On Windows the makeWorkspace cleanup also proves no SQLite handle is retained.
  const root = makeWorkspace(t), other = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), 'original\n')
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }
  const input = { path: 'public.md', content: 'next\n', expectedHash: sha('original\n'), taskId: 'task-write', idempotencyKey: 'preflight' }
  const wrongPolicy = writeBinding(binding, () => root, () => ({ root: other, exclude: [] }), () => 'session-write')
  await assert.rejects(wrongPolicy.handler(input), /policy belongs to another workspace/)
  const badScope = writeBinding(binding, () => root, undefined, () => { throw new Error('scope unavailable') })
  await assert.rejects(badScope.handler(input), /scope unavailable/)
  const { store } = openNativeStore(() => root)
  try { assert.equal(store.events({ kind: 'codex.amp.workspace.write' }).length, 0) } finally { store.close() }
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), 'original\n')
})

test('native write binding refuses stale hash, excluded and linked paths without modifying them', async t => {
  const root = makeWorkspace(t), outside = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), 'content\n')
  writeFileSync(join(outside, 'secret.md'), 'secret')
  symlinkSync(join(outside, 'secret.md'), join(root, 'linked.md'), 'file')
  seed(root)
  const tool = writeBinding({ tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }, () => root, () => ({ root, exclude: ['public.md'] }), () => 'session-write')
  const base = { content: 'changed\n', expectedHash: sha('content\n'), taskId: 'task-write', idempotencyKey: 'no-write' }
  await assert.rejects(tool.handler({ ...base, path: 'public.md' }))
  await assert.rejects(tool.handler({ ...base, path: 'linked.md', idempotencyKey: 'linked' }))
  await assert.rejects(tool.handler({ ...base, path: '../secret.md', idempotencyKey: 'traversal' }))
  assert.equal(readFileSync(join(root, 'public.md'), 'utf8'), 'content\n')
  assert.equal(lstatSync(join(root, 'linked.md')).isSymbolicLink(), true)
})
