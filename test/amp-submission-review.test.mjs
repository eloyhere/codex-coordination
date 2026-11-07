import test from 'node:test'
import assert from 'node:assert/strict'
import { createAttention } from 'attention-manifest-protocol/attention'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { makeWorkspace, seedGoal } from './helpers.mjs'
import { migrationTool } from '../plugins/codex-coordination/mcp/amp/migration.mjs'
import { projectBindings } from '../plugins/codex-coordination/mcp/amp/project.mjs'
import { executionBindings } from '../plugins/codex-coordination/mcp/amp/execution.mjs'
import { evidenceBindings } from '../plugins/codex-coordination/mcp/amp/evidence.mjs'
import { openNativeStore, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { submissionReview } from '../plugins/codex-coordination/mcp/amp/submission-review.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test', cancellationEpoch: 0 }
function fixture(root, id = 'focus-one') {
  const { store } = openNativeStore(() => root)
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  const session = persistence.create('session', { id: 'codex-session', sessionId: 'codex-session', participants: ['codex'] }, 'test')
  persistence.transition('session', session.id, 'active', { expectedVersion: session.version, actor: 'test' })
  const current = persistence.workflow.get('session', session.id)
  const now = new Date().toISOString()
  const object = createAttention({ id, summary: 'Session context', pointer: { kind: 'session', id: current.id, version: String(current.version) }, scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: current.id, turnId: 'turn-1' }, budget: { bytes: 1000 }, expiresAt: new Date(Date.now() + 3600000).toISOString(), reason: 'test' }, now)
  store.save('attention', object)
  store.appendEvent('codex.sync.session_mapping', { threadId: 'thread-one', sessionId: current.id })
  const parameters = { targetId: id, submission: { reason: 'Prioritize current context', amount: 0.4, mount: true } }
  const submission = { id: 'submission-' + id, tool: 'attention_manifest_protocol_attention.request_focus', parameters, binding, status: 'pending_host_review', request: nativeRequest({ tool: 'attention_manifest_protocol_attention.request_focus', parameters }) }
  store.appendEvent('codex.amp.submission', submission)
  store.close()
  return { sessionId: current.id, object }
}

test('focus submissions require host approval and durably focus/mount exactly once', async t => {
  const root = makeWorkspace(t), { object } = fixture(root)
  const tool = submissionReview(binding, () => root, () => undefined)
  const input = { submissionId: 'submission-focus-one', expectedVersion: object.version, idempotencyKey: 'review-focus' }
  let requests = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => { requests++; queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })) })
  const approved = await tool.handler(input)
  assert.equal(approved.status, 'consumed')
  assert.equal(approved.attention.mounted, true)
  assert.equal(approved.attention.intensity, 0.9)
  assert.equal(approved.mountRequested, true)
  assert.equal((await tool.handler(input)).replayed, true)
  assert.equal(requests, 1)
  const { store } = openNativeStore(() => root)
  try { assert.equal(store.list('attention')[0].version, 3) } finally { store.close() }
})

test('rejected focus is durable and stale targets are not changed after host approval', async t => {
  const rejectedRoot = makeWorkspace(t), rejectedFixture = fixture(rejectedRoot, 'reject-focus')
  const rejectedTool = submissionReview(binding, () => rejectedRoot, () => undefined)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  let requests = 0
  configureHostClient({ elicitation: {} }, message => { requests++; queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'reject' } } })) })
  const input = { submissionId: 'submission-reject-focus', expectedVersion: rejectedFixture.object.version, idempotencyKey: 'reject-once' }
  assert.equal((await rejectedTool.handler(input)).status, 'rejected')
  assert.equal((await rejectedTool.handler(input)).replayed, true)
  assert.equal(requests, 1)

  const staleRoot = makeWorkspace(t), staleFixture = fixture(staleRoot, 'stale-focus')
  const staleTool = submissionReview(binding, () => staleRoot, () => undefined)
  configureHostClient({ elicitation: {} }, message => {
    const opened = openNativeStore(() => staleRoot)
    try { const current = JSON.parse(JSON.stringify(opened.store.list('attention')[0])); opened.store.save('attention', { ...current, version: current.version + 1 }) } finally { opened.store.close() }
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  const result = await staleTool.handler({ submissionId: 'submission-stale-focus', expectedVersion: staleFixture.object.version, idempotencyKey: 'stale-once' })
  assert.equal(result.status, 'stale_after_approval')
  const opened = openNativeStore(() => staleRoot)
  try { assert.equal(opened.store.list('attention')[0].intensity, 0.5) } finally { opened.store.close() }
})

async function workflowFixture(root) {
  await seedGoal(root, 'submission-goal')
  const migration = migrationTool(() => root)
  const preview = await migration.handler({ action: 'preview' })
  await migration.handler({ action: 'import', sourceDigest: preview.sourceDigest })
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); persistence.restoreAll()
    let session = persistence.workflow.get('session', preview.sessionId)
    session = persistence.transition('session', session.id, 'resumed', { expectedVersion: session.version, actor: 'test' })
    persistence.transition('session', session.id, 'active', { expectedVersion: session.version, actor: 'test' })
    return { sessionId: session.id, intent: JSON.parse(JSON.stringify(persistence.workflow.list('intent')[0])), goal: JSON.parse(JSON.stringify(persistence.workflow.list('goal')[0])) }
  } finally { store.close() }
}
function submit(root, kind, targetId, payload, id) {
  const tool = 'attention_manifest_protocol_' + kind, parameters = { targetId, submission: payload }
  const { store } = openNativeStore(() => root)
  try { store.appendEvent('codex.amp.submission', { id, tool, parameters, binding, status: 'pending_host_review', request: nativeRequest({ tool, parameters }) }) } finally { store.close() }
}
function approve(t) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
}

test('clarification attaches the reviewed proposal without rewriting or accepting the intent', async t => {
  const root = makeWorkspace(t), { sessionId, intent } = await workflowFixture(root)
  approve(t)
  submit(root, 'intent.submit_clarification', intent.id, { text: 'Clarify expected output as JSON' }, 'clarify-one')
  const review = submissionReview(binding, () => root, () => sessionId)
  const input = { submissionId: 'clarify-one', expectedVersion: intent.version, idempotencyKey: 'clarification-review' }
  const result = await review.handler(input)
  assert.equal(result.consumed, true)
  assert.equal(result.attachment.intentAccepted, false)
  assert.equal(result.attachment.clarification, 'Clarify expected output as JSON')
  assert.equal((await review.handler(input)).replayed, true)
  const { store } = openNativeStore(() => root)
  try { assert.deepEqual(JSON.parse(JSON.stringify(store.list('intent')[0])), intent); assert.equal(store.events({ kind: 'codex.amp.intent.clarification' }).length, 1) } finally { store.close() }
  await assert.rejects(submissionReview({ ...binding, principalId: 'other' }, () => root, () => sessionId).handler({ ...input, idempotencyKey: 'foreign' }), /another principal/)
})

test('goal evidence consumes only verified current citations matching the goal contract', async t => {
  const root = makeWorkspace(t), { sessionId, goal } = await workflowFixture(root)
  approve(t)
  const project = projectBindings(binding, () => root)
  const execution = executionBindings(project, binding, () => root)
  const callExecution = (suffix, args) => execution.find(tool => tool.name === 'attention_manifest_protocol_' + suffix).handler(args)
  const found = await callExecution('execution.find_tools', { query: 'project rules', limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_project.rules').pinned
  const run = await callExecution('execution.run', { idempotencyKey: 'goal-read', calls: [{ id: 'read', ...pinned, arguments: {} }] })
  const evidence = evidenceBindings(binding, () => root)
  const verified = await evidence.find(tool => tool.name === 'attention_manifest_protocol_evidence_review').handler({ receiptId: run.receipts[0].id, claim: 'Project rules inspected', criteriaVersion: goal.contractVersion, idempotencyKey: 'goal-verify' })
  submit(root, 'goal.submit_evidence', goal.id, { evidenceIds: [verified.evidence.id], criteriaVersion: goal.contractVersion }, 'goal-evidence-one')
  const result = await submissionReview(binding, () => root, () => sessionId).handler({ submissionId: 'goal-evidence-one', expectedVersion: goal.version, idempotencyKey: 'goal-attach' })
  assert.equal(result.consumed, true)
  assert.equal(result.acceptanceGranted, false)
  const { store } = openNativeStore(() => root)
  try { assert.equal(store.list('goal')[0].state, goal.state); assert.equal(store.events({ kind: 'codex.amp.goal.evidence_attachment' }).length, 1) } finally { store.close() }
  submit(root, 'goal.submit_evidence', goal.id, { evidenceIds: ['nonexistent'], criteriaVersion: goal.contractVersion }, 'goal-fake')
  await assert.rejects(submissionReview(binding, () => root, () => sessionId).handler({ submissionId: 'goal-fake', expectedVersion: goal.version, idempotencyKey: 'fake' }), /absent/)
})
