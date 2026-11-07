import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkflowPersistence, bindEvidence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { createReceiptCore, verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { verifyBusinessSemantics } from 'attention-manifest-protocol/verification'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { workflowAcceptanceReview } from '../plugins/codex-coordination/mcp/amp/acceptance.mjs'
import { NativeReadStorage } from '../plugins/codex-coordination/mcp/amp/filesystem.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { openNativeStore, nativeEnvironment } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection' }
function fixture(root, kind = 'task', effect = 'succeeded') {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const create = (kind, input) => p.create(kind, { ...input, sessionId: 'session' }, 'fixture')
    const move = (kind, id, to) => p.transition(kind, id, to, { expectedVersion: p.workflow.get(kind, id).version, actor: 'fixture' })
    create('session', { id: 'session', participants: ['codex'] }); move('session', 'session', 'active')
    create('turn', { id: 'turn', classification: 'new_intent' }); move('turn', 'turn', 'interpreting')
    create('intent', { id: 'intent', originTurnId: 'turn', text: 'Verify output' }); move('intent', 'intent', 'confirmed'); move('intent', 'intent', 'accepted')
    create('mission', { id: 'mission', intentId: 'intent' }); move('mission', 'mission', 'active')
    create('goal', { id: 'goal', missionId: 'mission', contractVersion: 'criteria/1', acceptanceCriteria: ['Output is correct'] }); move('goal', 'goal', 'active')
    if (kind === 'goal') return
    create('plan', { id: 'plan', goalId: 'goal', bounds: { maxAttempts: 3, deadline: '2099-01-01T00:00:00Z', progressMetric: 'accepted', deadLetterOwner: 'codex' } })
    create('task', { id: 'task', planId: 'plan', dependsOn: [], contractVersion: 'criteria/1', required: true, requiredEffects: ['write'] })
    move('plan', 'plan', 'approved'); move('plan', 'plan', 'executing'); move('task', 'task', 'ready'); move('task', 'task', 'active')
    if (effect === 'missing') return
    create('action', { id: 'action', taskId: 'task', operationId: 'operation', effect: 'write', recovery: 'query', required: true, sideEffect: true }); move('action', 'action', 'ready')
    const saveCommand = command => {
      const before = p.workflow.get('action', 'action'), sequence = p.workflow.snapshot().sequence
      const attempt = command(before)
      store.transaction(() => {
        store.save('action', p.workflow.get('action', 'action'), { expectedVersion: before.version })
        p.persistAttempt(attempt, { actor: 'fixture' })
        for (const event of p.workflow.history().filter(event => event.sequence > sequence)) p.persistEvent(event)
      })
    }
    saveCommand(action => p.workflow.startAttempt('action', { expectedVersion: action.version, cancellationEpoch: 0, executionId: 'execution', attemptId: 'attempt', actor: 'fixture' }))
    if (effect !== 'running') saveCommand(action => p.workflow.settleAttempt('attempt', { expectedVersion: 0, expectedActionVersion: action.version, outcome: effect, actor: 'fixture' }))
  } finally { store.close() }
}
function read(root, operation) {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(p.restoreAll().skipped, [])
    return operation(p, store)
  } finally { store.close() }
}
async function evidence(root, options = {}) {
  const { store } = openNativeStore(() => root)
  try {
    const now = new Date().toISOString(), env = nativeEnvironment(store, root)
    const invocation = { id: 'invocation', toolId: options.file ? 'attention_manifest_protocol_workspace.read' : 'attention_manifest_protocol_project.rules', arguments: options.file ? { path: 'output.txt' } : {}, createdAt: now, context: { ...binding, sessionId: options.sessionId ?? 'session', principalId: options.principalId ?? 'codex', agentId: 'codex', operationId: 'read-op', attemptId: 'read-attempt', executionId: 'read-execution' } }
    const observation = { id: 'observation', invocationId: invocation.id, status: 'success', value: 'correct output', observedAt: now }
    const anchor = { workspaceId: root, changeHash: env, ...(options.file ? { snapshotId: new NativeReadStorage({ root, exclude: [] }, binding.tenantId).raw('output.txt').hash, affectedFiles: ['output.txt'] } : {}) }
    const receipt = createReceiptCore({ id: 'receipt', invocation, observation, issuedAt: now, payloadDigest: executionFactDigest(invocation, observation), hashAlgorithm: 'sha256-json-execution-facts/2', workspaceAnchor: anchor })
    const integrity = await verifyReceiptIntegrity(receipt, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'native-execution-facts/2', verifiedAt: now })
    const verification = await verifyBusinessSemantics(receipt, integrity, { id: 'verification', criteriaVersion: options.criteriaVersion ?? 'criteria/1', verifier: 'independent-mcp-host-confirmation', verifiedAt: now }, () => true, ['Output is correct'])
    store.save('receipt', receipt); store.save('receipt_integrity', integrity); store.save('verification', verification)
    const bound = bindEvidence(store, new EvidenceLedger()); bound.rehydrate()
    return bound.add({ id: 'evidence', tenantId: 'local', claim: 'Output is correct', polarity: 'supports', receipt, integrity, verification, criteriaVersion: verification.criteriaVersion, environmentVersion: env, createdAt: now, sessionId: invocation.context.sessionId, ...(options.expired ? { createdAt: '2000-01-01T00:00:00Z', expiresAt: '2001-01-01T00:00:00Z' } : {}) })
  } finally { store.close() }
}
function input(root, kind = 'task', extra = {}) { return read(root, p => ({ kind, id: kind, expectedVersion: p.workflow.get(kind, kind).version, criteriaVersion: 'criteria/1', evidenceIds: ['evidence'], idempotencyKey: 'accept-' + kind, reason: 'Independently accept verified output', ...extra })) }
function host(t, callback) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    callback?.(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
}

test('task/goal acceptance uses actual verification IDs and seals exact pre-transition applicability', async t => {
  let requests = 0; host(t, () => requests++)
  for (const kind of ['task', 'goal']) {
    const root = makeWorkspace(t); fixture(root, kind); const item = await evidence(root)
    const tool = workflowAcceptanceReview(binding, () => root, () => 'session'), args = input(root, kind)
    const result = await tool.handler(args)
    assert.equal(result.status, 'accepted'); assert.equal(result.acceptanceGranted, true)
    assert.equal(result.entity.state, kind === 'task' ? 'completed' : 'achieved')
    assert.equal(result.entity.assessment.verificationId, item.verificationId)
    assert.equal((await tool.handler(args)).replayed, true)
    read(root, (p, store) => {
      const proof = store.events({ kind: 'codex.amp.workflow.acceptance_proof' })[0].payload
      assert.equal(proof.targetBefore.version, args.expectedVersion)
      assert.equal(proof.consumer.version, args.expectedVersion + 1)
      assert.equal(proof.preAcceptanceEnvironment, item.environmentVersion)
      assert.equal(proof.postAcceptanceEnvironment, nativeEnvironment(store, root))
      assert.notEqual(proof.preAcceptanceEnvironment, proof.postAcceptanceEnvironment)
      assert.equal(proof.evidence[0].verification.id, item.verificationId)
      assert.equal(store.list('evidence')[0].environmentVersion, item.environmentVersion)
      assert.equal(p.workflow.get(kind, kind).assessment.valid, true)
    })
  }
  assert.equal(requests, 2)
})

test('successful receipts alone, mismatched criteria/principal/session and expired or revoked evidence cannot accept', async t => {
  let requests = 0; host(t, () => requests++)
  for (const mode of ['absent', 'criteria', 'principal', 'session', 'expired', 'revoked', 'verification']) {
    const root = makeWorkspace(t); fixture(root)
    await evidence(root, mode === 'criteria' ? { criteriaVersion: 'other' } : mode === 'principal' ? { principalId: 'foreign' } : mode === 'session' ? { sessionId: 'foreign' } : mode === 'expired' ? { expired: true } : {})
    if (mode === 'revoked') read(root, (p, store) => { const bound = bindEvidence(store, new EvidenceLedger()); bound.rehydrate(); bound.revoke('evidence', 'local', 'invalidated', new Date().toISOString()) })
    if (mode === 'verification') read(root, (p, store) => { const row = JSON.parse(JSON.stringify(store.list('verification')[0])); store.save('verification', { ...row, status: 'semantic_rejected' }) })
    await assert.rejects(workflowAcceptanceReview(binding, () => root, () => 'session').handler(input(root, 'task', mode === 'absent' ? { evidenceIds: ['receipt'] } : {})))
    assert.equal(read(root, p => p.workflow.get('task', 'task').state), 'active')
  }
  assert.equal(requests, 0)
})

test('upstream completion guards reject missing required effects, failed actions and unresolved attempts', async t => {
  let requests = 0; host(t, () => requests++)
  for (const effect of ['missing', 'failed', 'running', 'unknown_outcome']) {
    const root = makeWorkspace(t); fixture(root, 'task', effect); await evidence(root)
    await assert.rejects(workflowAcceptanceReview(binding, () => root, () => 'session').handler(input(root)), /effects|actions|unsettled|drained/i)
  }
  // A goal with active child work cannot bypass the native child-settlement guard.
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  await assert.rejects(workflowAcceptanceReview(binding, () => root, () => 'session').handler(input(root, 'goal')), /drained/)
  assert.equal(requests, 0)
})

test('file freshness, revocation and unrelated workflow head changes are rechecked after approval', async t => {
  for (const mode of ['file', 'revoke', 'head']) {
    const root = makeWorkspace(t); fixture(root); writeFileSync(join(root, 'output.txt'), 'correct'); await evidence(root, { file: true })
    host(t, () => {
      if (mode === 'file') writeFileSync(join(root, 'output.txt'), 'changed')
      else read(root, (p, store) => {
        if (mode === 'revoke') { const bound = bindEvidence(store, new EvidenceLedger()); bound.rehydrate(); bound.revoke('evidence', 'local', 'host revoked', new Date().toISOString()) }
        else p.transition('session', 'session', 'idle', { expectedVersion: p.workflow.get('session', 'session').version, actor: 'other' })
      })
    })
    const result = await workflowAcceptanceReview(binding, () => root, () => 'session').handler(input(root))
    assert.equal(result.status, 'stale_after_approval')
    assert.equal(read(root, p => p.workflow.get('task', 'task').state), 'active')
  }
})

test('workspace and selected workflow changes cannot apply an approved acceptance', async t => {
  for (const mode of ['workspace', 'scope']) {
    const root = makeWorkspace(t), other = makeWorkspace(t); fixture(root); await evidence(root)
    let workspace = root, selected = 'session'
    host(t, () => { if (mode === 'workspace') workspace = other; else selected = 'foreign' })
    const result = await workflowAcceptanceReview(binding, () => workspace, () => selected).handler(input(root))
    assert.equal(result.status, 'stale_after_approval')
    assert.equal(result.acceptanceGranted, false)
    assert.equal(read(root, p => p.workflow.get('task', 'task').state), 'active')
  }
})

test('approval uses detached nested evidence IDs and rejection is durable', async t => {
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  const args = input(root)
  host(t, () => { args.evidenceIds[0] = 'forged'; args.reason = 'unapproved' })
  const tool = workflowAcceptanceReview(binding, () => root, () => 'session')
  assert.equal((await tool.handler(args)).acceptanceGranted, true)
  assert.deepEqual(read(root, p => p.workflow.get('task', 'task').assessment.evidenceIds), ['evidence'])
  const deniedRoot = makeWorkspace(t); fixture(deniedRoot); await evidence(deniedRoot)
  configureHostClient({}, () => {})
  const deniedTool = workflowAcceptanceReview(binding, () => deniedRoot, () => 'session'), denied = input(deniedRoot)
  assert.equal((await deniedTool.handler(denied)).status, 'rejected')
  assert.equal((await deniedTool.handler(denied)).replayed, true)
  await assert.rejects(deniedTool.handler({ ...denied, valid: true }), /Invalid|parameter/)
})

test('unresolved review fails closed and transaction rollback resumes the same durable approval', async t => {
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  const tool = workflowAcceptanceReview(binding, () => root, () => 'session'), args = input(root)
  let requests = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, () => { requests++; throw new Error('Interrupted') })
  await assert.rejects(tool.handler(args), /Interrupted/)
  await assert.rejects(tool.handler(args), /unresolved/)
  await assert.rejects(tool.handler({ ...args, idempotencyKey: 'replacement' }), /unresolved/)
  read(root, (p, store) => {
    const pending = store.events({ kind: 'codex.amp.workflow.acceptance_requested' })[0].payload
    store.appendEvent('codex.amp.workflow.acceptance_host_decision', { key: pending.key, request: pending.request, reviewId: pending.reviewId, approved: true })
  })
  const append = Store.prototype.appendEvent
  t.after(() => { Store.prototype.appendEvent = append })
  Store.prototype.appendEvent = function (kind, ...rest) { if (kind === 'codex.amp.workflow.acceptance_proof') throw new Error('Proof write failed'); return append.call(this, kind, ...rest) }
  await assert.rejects(tool.handler(args), /Proof write failed/)
  assert.equal(read(root, p => p.workflow.get('task', 'task').state), 'active')
  Store.prototype.appendEvent = append
  assert.equal((await tool.handler(args)).acceptanceGranted, true)
  assert.equal(requests, 1)
})

test('scope callback exceptions close the store and foreign scope never reaches approval', async t => {
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  const args = input(root), close = Store.prototype.close
  let closes = 0
  t.after(() => { Store.prototype.close = close })
  Store.prototype.close = function (...rest) { closes++; return close.apply(this, rest) }
  await assert.rejects(workflowAcceptanceReview(binding, () => root, () => { throw new Error('Scope unavailable') }).handler(args), /Scope unavailable/)
  assert.equal(closes, 1)
  await assert.rejects(workflowAcceptanceReview(binding, () => root, () => 'foreign').handler(args), /scope/)
})
