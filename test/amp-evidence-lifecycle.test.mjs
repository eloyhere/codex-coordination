import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkflowPersistence, bindEvidence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { createReceiptCore, verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { verifyBusinessSemantics } from 'attention-manifest-protocol/verification'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { evidenceLifecycleReview } from '../plugins/codex-coordination/mcp/amp/evidence-lifecycle.mjs'
import { workflowAcceptanceReview } from '../plugins/codex-coordination/mcp/amp/acceptance.mjs'
import { NativeReadStorage } from '../plugins/codex-coordination/mcp/amp/filesystem.mjs'
import { openNativeStore, nativeEnvironment } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection' }
const digestPattern = /^sha256:[a-f0-9]{64}$/
const REQUEST = 'codex.amp.evidence_lifecycle.requested'
const DECISION = 'codex.amp.evidence_lifecycle.host_decision'
const REVIEW = 'codex.amp.evidence_lifecycle.review'
const IMPACT = 'codex.amp.evidence_lifecycle.impact'
const SEALED = 'codex.amp.workflow.acceptance_proof'

function fixture(root, kind = 'task') {
  const { store } = openNativeStore(() => root)
  try {
    const p = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const create = (entityKind, input) => p.create(entityKind, { ...input, sessionId: 'session' }, 'fixture')
    const move = (entityKind, id, to) => p.transition(entityKind, id, to, { expectedVersion: p.workflow.get(entityKind, id).version, actor: 'fixture' })
    create('session', { id: 'session', participants: ['codex'] }); move('session', 'session', 'active')
    create('turn', { id: 'turn', classification: 'new_intent' }); move('turn', 'turn', 'interpreting')
    create('intent', { id: 'intent', originTurnId: 'turn', text: 'Verify output' }); move('intent', 'intent', 'confirmed'); move('intent', 'intent', 'accepted')
    create('mission', { id: 'mission', intentId: 'intent' }); move('mission', 'mission', 'active')
    create('goal', { id: 'goal', missionId: 'mission', contractVersion: 'v1', acceptanceCriteria: ['Output is correct'] }); move('goal', 'goal', 'active')
    if (kind === 'goal') return
    create('plan', { id: 'plan', goalId: 'goal', bounds: { maxAttempts: 3, deadline: '2099-01-01T00:00:00Z', progressMetric: 'accepted', deadLetterOwner: 'codex' } })
    create('task', { id: 'task', planId: 'plan', dependsOn: [], contractVersion: 'v1', required: true, requiredEffects: ['write'] })
    move('plan', 'plan', 'approved'); move('plan', 'plan', 'executing'); move('task', 'task', 'ready'); move('task', 'task', 'active')
    create('action', { id: 'action', taskId: 'task', operationId: 'operation', effect: 'write', recovery: 'query', required: true, sideEffect: true }); move('action', 'action', 'ready')
    const saveCommand = command => {
      const before = p.workflow.get('action', 'action'), sequence = p.workflow.snapshot().sequence
      const attempt = command(before)
      store.transaction(() => {
        store.save('action', p.workflow.get('action', 'action'), { expectedVersion: before.version })
        p.persistAttempt(attempt, { actor: 'fixture' })
        for (const event of p.workflow.history().filter(item => item.sequence > sequence)) p.persistEvent(event)
      })
    }
    saveCommand(action => p.workflow.startAttempt('action', { expectedVersion: action.version, cancellationEpoch: 0, executionId: 'execution', attemptId: 'attempt', actor: 'fixture' }))
    saveCommand(action => p.workflow.settleAttempt('attempt', { expectedVersion: 0, expectedActionVersion: action.version, outcome: 'succeeded', actor: 'fixture' }))
  } finally { store.close() }
}

async function evidence(root, options = {}) {
  const tenantId = options.tenantId ?? 'local'
  const id = options.id ?? 'evidence'
  const sessionId = options.sessionId ?? 'session'
  const principalId = options.principalId ?? 'codex'
  const claim = options.claim ?? 'Output is correct'
  const dependsOn = options.dependsOn ?? []
  const { store } = openNativeStore(() => root)
  try {
    const now = new Date().toISOString(), env = nativeEnvironment(store, root)
    const invocation = { id: 'invocation-' + id, toolId: options.file ? 'attention_manifest_protocol_workspace.read' : 'attention_manifest_protocol_project.rules', arguments: options.file ? { path: 'output.txt' } : {}, createdAt: now, context: { tenantId, principalId, sessionId, agentId: 'codex', operationId: 'operation-' + id, attemptId: 'attempt-' + id, executionId: 'execution-' + id } }
    const observation = { id: 'observation-' + id, invocationId: invocation.id, status: 'success', value: 'correct output', observedAt: now }
    const anchor = { workspaceId: root, changeHash: env, ...(options.file ? { snapshotId: new NativeReadStorage({ root, exclude: [] }, tenantId).raw('output.txt').hash, affectedFiles: ['output.txt'] } : {}) }
    const receipt = createReceiptCore({ id: 'receipt-' + id, invocation, observation, issuedAt: now, payloadDigest: executionFactDigest(invocation, observation), hashAlgorithm: 'sha256-json-execution-facts/2', workspaceAnchor: anchor })
    const integrity = await verifyReceiptIntegrity(receipt, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'native-execution-facts/2', verifiedAt: now })
    const verification = await verifyBusinessSemantics(receipt, integrity, { id: 'verification-' + id, criteriaVersion: options.criteriaVersion ?? 'v1', verifier: 'independent-mcp-host-confirmation', verifiedAt: now }, () => true, [claim])
    store.save('receipt', receipt); store.save('receipt_integrity', integrity); store.save('verification', verification)
    const bound = bindEvidence(store, new EvidenceLedger()); bound.rehydrate()
    return bound.add({ id, tenantId, claim, polarity: 'supports', receipt, integrity, verification, criteriaVersion: verification.criteriaVersion, environmentVersion: env, createdAt: now, sessionId, dependsOn })
  } finally { store.close() }
}

function read(root, operation) {
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    return operation(persistence, store)
  } finally { store.close() }
}

function workflow(root) {
  return read(root, persistence => persistence.workflow)
}

function rows(root, kind) {
  return read(root, (_persistence, store) => store.list(kind).map(row => JSON.parse(JSON.stringify(row))))
}

function events(root, kind) {
  return read(root, (_persistence, store) => store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload))))
}

function stateSnapshot(root) {
  return read(root, (persistence, store) => ({
    evidence: store.list('evidence').map(row => JSON.parse(JSON.stringify(row))).sort((left, right) => left.id.localeCompare(right.id)),
    workflow: persistence.workflow.snapshot(),
    events: store.events().map(event => ({ kind: event.kind, entityId: event.entityId, payload: JSON.parse(JSON.stringify(event.payload)) })),
  }))
}

function workflowVersion(root, kind, id = kind) {
  return workflow(root).get(kind, id).version
}

async function accept(root, kind) {
  return await workflowAcceptanceReview(binding, () => root, () => 'session').handler({
    kind, id: kind, expectedVersion: workflowVersion(root, kind), criteriaVersion: 'v1',
    evidenceIds: ['evidence'], idempotencyKey: 'accept-' + kind, reason: 'Independently accept verified output',
  })
}

function host(t, callback) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    callback?.(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
}

function preview(tool, evidenceId = 'evidence') {
  return tool.handler({ action: 'preview', evidenceId })
}

function command(previewed, action = 'revoke', overrides = {}) {
  return {
    action,
    evidenceId: previewed.evidenceId,
    expectedEvidenceDigest: previewed.expectedEvidenceDigest,
    expectedProofHead: previewed.expectedProofHead,
    reason: 'Evidence no longer supports the accepted result',
    idempotencyKey: 'lifecycle-' + action,
    ...overrides,
  }
}

test('preview returns exact CAS digests and leaves evidence, proofs, workflow and journal untouched', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  let duringApproval = () => {}
  host(t, () => duringApproval())
  await accept(root, 'goal')
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const before = stateSnapshot(root)
  const first = await preview(tool)
  assert.equal(first.changed, false)
  assert.equal(first.selected, 'session')
  assert.equal(first.evidenceId, 'evidence')
  assert.match(first.expectedEvidenceDigest, digestPattern)
  assert.match(first.expectedProofHead, digestPattern)
  assert.deepEqual(first.affectedEvidence, ['evidence'])
  assert.equal(first.invalidatedGoals.length, 1)
  assert.equal(first.invalidatedGoals[0].id, 'goal')
  assert.equal(first.invalidatedGoals[0].version, workflow(root).get('goal', 'goal').version)
  assert.deepEqual(first.disputedTasks, [])
  const second = await preview(tool)
  assert.equal(second.expectedEvidenceDigest, first.expectedEvidenceDigest)
  assert.equal(second.expectedProofHead, first.expectedProofHead)
  const after = stateSnapshot(root)
  assert.deepEqual(after, before)
  assert.deepEqual(events(root, REQUEST), [])
  assert.deepEqual(events(root, REVIEW), [])
  assert.deepEqual(events(root, IMPACT), [])
})

test('host-approved revoke and stale apply native dependency propagation exactly as previewed and invalidate an accepted goal', async t => {
  for (const action of ['revoke', 'stale']) {
    const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
    await evidence(root, { id: 'dependent', dependsOn: ['evidence'] })
    let duringApproval = () => {}
    host(t, () => duringApproval())
    const accepted = await accept(root, 'goal')
    const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
    const previewed = await preview(tool)
    assert.deepEqual(previewed.affectedEvidence, ['evidence', 'dependent'])
    assert.equal(previewed.invalidatedGoals.length, 1)
    let requests = 0
    duringApproval = () => { requests++ }
    const result = await tool.handler(command(previewed, action))
    assert.equal(result.approved, true)
    assert.equal(result.changed, true)
    assert.equal(result.status, 'applied')
    assert.deepEqual(result.affectedEvidence, previewed.affectedEvidence)
    assert.equal(requests, 1)
    const evidenceRows = rows(root, 'evidence')
    const base = evidenceRows.find(row => row.id === 'evidence')
    const dependent = evidenceRows.find(row => row.id === 'dependent')
    assert.equal(base.status, action === 'revoke' ? 'revoked' : 'stale')
    assert.equal(dependent.status, action === 'revoke' ? 'pending_revalidation' : 'stale')
    const provenance = rows(root, 'provenance_event').map(row => row.type)
    assert.ok(provenance.includes(action === 'revoke' ? 'evidence_revoked' : 'evidence_staled'))
    const goal = workflow(root).get('goal', 'goal')
    assert.equal(goal.state, 'achieved')
    assert.equal(goal.validity, 'invalidated')
    assert.equal(goal.version, previewed.invalidatedGoals[0].version + 1)
    assert.deepEqual(goal.assessment, accepted.entity.assessment)
    assert.equal(result.invalidatedGoals.length, 1)
    assert.equal(result.invalidatedGoals[0].id, 'goal')
    assert.equal(result.invalidatedGoals[0].version, goal.version)
    const impacts = events(root, IMPACT)
    assert.equal(impacts.length, 1)
    assert.equal(impacts[0].action, action)
    assert.deepEqual(impacts[0].affectedEvidence, previewed.affectedEvidence)
    assert.equal(impacts[0].sourceEvidenceId, 'evidence')
    assert.equal(impacts[0].reason, 'Evidence no longer supports the accepted result')
    assert.match(impacts[0].digest, digestPattern)
    const replay = await tool.handler(command(previewed, action))
    assert.equal(replay.replayed, true)
    assert.equal(replay.changed, true)
    assert.equal(requests, 1)
    assert.equal(events(root, IMPACT).length, 1)
    assert.equal(events(root, REVIEW).length, 1)
  }
})

test('a completed task acceptance records only a dispute and preserves task state and assessment', async t => {
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  let duringApproval = () => {}
  host(t, () => duringApproval())
  const accepted = await accept(root, 'task')
  assert.equal(accepted.entity.state, 'completed')
  const taskBefore = workflow(root).get('task', 'task')
  const goalBefore = workflow(root).get('goal', 'goal')
  const proof = events(root, SEALED)[0]
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const previewed = await preview(tool)
  assert.deepEqual(previewed.affectedEvidence, ['evidence'])
  assert.deepEqual(previewed.invalidatedGoals, [])
  assert.equal(previewed.disputedTasks.length, 1)
  assert.equal(previewed.disputedTasks[0].id, 'task')
  const result = await tool.handler(command(previewed))
  assert.equal(result.status, 'applied')
  assert.equal(result.changed, true)
  const taskAfter = workflow(root).get('task', 'task')
  assert.equal(taskAfter.state, 'completed')
  assert.equal(taskAfter.version, taskBefore.version)
  assert.deepEqual(taskAfter.assessment, taskBefore.assessment)
  const goalAfter = workflow(root).get('goal', 'goal')
  assert.equal(goalAfter.state, 'active')
  assert.equal(goalAfter.validity, goalBefore.validity)
  assert.equal(goalAfter.version, goalBefore.version)
  assert.equal(events(root, 'codex.amp.workflow.goal.invalidated').length, 0)
  const disputes = events(root, 'codex.amp.workflow.task_disputed')
  assert.equal(disputes.length, 1)
  assert.equal(disputes[0].taskId, 'task')
  assert.equal(disputes[0].taskVersion, taskBefore.version)
  assert.equal(disputes[0].status, 'disputed')
  assert.equal(disputes[0].assessmentValid, false)
  assert.deepEqual(disputes[0].historicalAssessment, taskBefore.assessment)
  assert.deepEqual(disputes[0].evidenceIds, ['evidence'])
  assert.equal(disputes[0].proofId, proof.id)
  assert.equal(disputes[0].reviewId, result.reviewId)
  assert.equal(disputes[0].action, 'revoke')
  assert.equal(result.disputedTasks.length, 1)
  assert.deepEqual(result.invalidatedGoals, [])
  assert.equal(events(root, IMPACT).length, 1)
})

test('evidence, proof, workflow and file changes during approval are stale without review effects', async t => {
  for (const mode of ['evidence', 'proof', 'workflow', 'file']) {
    const root = makeWorkspace(t); fixture(root, 'goal')
    if (mode === 'file') writeFileSync(join(root, 'output.txt'), 'correct')
    await evidence(root, mode === 'file' ? { file: true } : {})
    let duringApproval = () => {}
    host(t, () => duringApproval())
    await accept(root, 'goal')
    const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
    const previewed = await preview(tool)
    duringApproval = mode === 'evidence' ? () => {
      read(root, (_persistence, store) => {
        const row = store.list('evidence').find(item => item.id === 'evidence')
        store.save('evidence', { ...JSON.parse(JSON.stringify(row)), freshnessScore: 0.5 })
      })
    }
      : mode === 'proof' ? () => {
          read(root, (_persistence, store) => {
            const sealed = store.events({ kind: SEALED })[0]
            store.appendEvent(SEALED, JSON.parse(JSON.stringify(sealed.payload)), sealed.entityId)
          })
        }
      : mode === 'workflow' ? () => {
          read(root, persistence => {
            const session = persistence.workflow.get('session', 'session')
            persistence.transition('session', session.id, 'idle', { expectedVersion: session.version, actor: 'other' })
          })
        }
      : () => writeFileSync(join(root, 'output.txt'), 'changed')
    const result = await tool.handler(command(previewed))
    assert.equal(result.approved, true)
    assert.equal(result.changed, false)
    assert.equal(result.status, 'stale_after_approval')
    const goal = workflow(root).get('goal', 'goal')
    assert.equal(goal.state, 'achieved')
    assert.equal(goal.validity, 'valid')
    assert.equal(rows(root, 'evidence').find(row => row.id === 'evidence').status, 'active')
    assert.equal(events(root, IMPACT).length, 0)
    if (mode === 'proof') assert.equal(events(root, SEALED).length, 2)
    if (mode === 'workflow') assert.equal(workflow(root).get('session', 'session').state, 'idle')
    if (mode === 'file') assert.equal(readFileSync(join(root, 'output.txt'), 'utf8'), 'changed')
  }
})

test('workspace and selected scope changes reject an approved lifecycle review', async t => {
  for (const mode of ['workspace', 'scope']) {
    const root = makeWorkspace(t), other = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
    let duringApproval = () => {}
    host(t, () => duringApproval())
    await accept(root, 'goal')
    const previewed = await preview(evidenceLifecycleReview(binding, () => root, () => 'session'))
    let workspace = root, selected = 'session'
    duringApproval = () => { if (mode === 'workspace') workspace = other; else selected = 'foreign' }
    const result = await evidenceLifecycleReview(binding, () => workspace, () => selected).handler(command(previewed))
    assert.equal(result.approved, true)
    assert.equal(result.changed, false)
    assert.equal(result.status, 'stale_after_approval')
    const goal = workflow(root).get('goal', 'goal')
    assert.equal(goal.state, 'achieved')
    assert.equal(goal.validity, 'valid')
    assert.equal(rows(root, 'evidence').find(row => row.id === 'evidence').status, 'active')
    assert.equal(events(root, IMPACT).length, 0)
  }
})

test('unresolved approval fails closed, rejects a replacement key and resumes the durable decision', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  host(t)
  await accept(root, 'goal')
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const previewed = await preview(tool), args = command(previewed)
  let requests = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, () => { requests++; throw new Error('Transport interrupted') })
  await assert.rejects(tool.handler(args), /Transport interrupted/)
  await assert.rejects(tool.handler(args), /unresolved/)
  await assert.rejects(tool.handler({ ...args, idempotencyKey: 'replacement-key' }), /unresolved/)
  assert.equal(requests, 1)
  assert.equal(events(root, DECISION).length, 0)
  read(root, (_persistence, store) => {
    const pending = store.events({ kind: REQUEST })[0].payload
    store.appendEvent(DECISION, { key: pending.key, request: pending.request, reviewId: pending.reviewId, approved: true })
  })
  const resumed = await tool.handler(args)
  assert.equal(resumed.status, 'applied')
  assert.equal(resumed.changed, true)
  assert.equal(requests, 1)
  assert.equal(events(root, REVIEW).length, 1)
  assert.equal(workflow(root).get('goal', 'goal').validity, 'invalidated')
})

test('a transaction rollback retries the same durable approval without asking the host again', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  let requests = 0
  host(t, () => { requests++ })
  await accept(root, 'goal')
  requests = 0
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const previewed = await preview(tool), args = command(previewed)
  const nativeAppend = Store.prototype.appendEvent
  Store.prototype.appendEvent = function (kind, ...rest) {
    if (kind === IMPACT) throw new Error('Injected impact write failure')
    return nativeAppend.call(this, kind, ...rest)
  }
  t.after(() => { Store.prototype.appendEvent = nativeAppend })
  await assert.rejects(tool.handler(args), /Injected impact write failure/)
  assert.equal(rows(root, 'evidence').find(row => row.id === 'evidence').status, 'active')
  assert.equal(workflow(root).get('goal', 'goal').validity, 'valid')
  assert.equal(events(root, IMPACT).length, 0)
  assert.equal(events(root, 'codex.amp.workflow.goal.invalidated').length, 0)
  assert.equal(events(root, REVIEW).length, 0)
  Store.prototype.appendEvent = nativeAppend
  const result = await tool.handler(args)
  assert.equal(result.status, 'applied')
  assert.equal(result.changed, true)
  assert.equal(requests, 1)
  assert.equal(events(root, REVIEW).length, 1)
  assert.equal(events(root, IMPACT).length, 1)
  assert.equal(rows(root, 'evidence').find(row => row.id === 'evidence').status, 'revoked')
  assert.equal(workflow(root).get('goal', 'goal').validity, 'invalidated')
})

test('caller mutation during await is detached and extra model fields are rejected', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  let duringApproval = () => {}
  host(t, () => duringApproval())
  await accept(root, 'goal')
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const previewed = await preview(tool), args = command(previewed)
  duringApproval = () => {
    args.reason = 'mutated'
    args.evidenceId = 'other'
    args.action = 'stale'
    args.expectedProofHead = 'sha256:' + '0'.repeat(64)
    args.idempotencyKey = 'mutated-key'
  }
  const result = await tool.handler(args)
  assert.equal(result.status, 'applied')
  assert.equal(result.changed, true)
  const impact = events(root, IMPACT)[0]
  assert.equal(impact.action, 'revoke')
  assert.equal(impact.sourceEvidenceId, 'evidence')
  assert.equal(impact.reason, 'Evidence no longer supports the accepted result')
  await assert.rejects(tool.handler({ ...command(previewed), approved: true }), /Invalid evidence lifecycle parameters/)
  await assert.rejects(tool.handler({ ...command(previewed), valid: true }), /Invalid evidence lifecycle parameters/)
  await assert.rejects(tool.handler({ action: 'preview', evidenceId: 'evidence', expectedProofHead: previewed.expectedProofHead }), /Preview accepts only action and evidenceId/)
  await assert.rejects(tool.handler({ ...command(previewed), tenantId: 'foreign' }), /parameter tenantId|bound by the host/)
  assert.equal(events(root, IMPACT).length, 1)
})

test('scope callback failures close the native store before propagating', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  const nativeClose = Store.prototype.close
  let closes = 0
  Store.prototype.close = function (...rest) { closes++; return nativeClose.apply(this, rest) }
  t.after(() => { Store.prototype.close = nativeClose })
  await assert.rejects(evidenceLifecycleReview(binding, () => root, () => { throw new Error('Scope unavailable') }).handler({ action: 'preview', evidenceId: 'evidence' }), /Scope unavailable/)
  assert.equal(closes, 1)
  closes = 0
  await assert.rejects(evidenceLifecycleReview(binding, () => root, () => undefined).handler({ action: 'preview', evidenceId: 'evidence' }), /Select a native workflow first/)
  assert.equal(closes, 1)
})

test('foreign tenant, principal and session evidence never reaches a review request', async t => {
  for (const mode of ['tenant', 'principal', 'session']) {
    const root = makeWorkspace(t); fixture(root, 'goal')
    await evidence(root, mode === 'tenant' ? { tenantId: 'foreign', principalId: 'foreign' } : mode === 'principal' ? { principalId: 'foreign' } : { sessionId: 'foreign' })
    host(t)
    const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
    await assert.rejects(preview(tool), mode === 'tenant' ? /outside the host tenant scope/ : mode === 'principal' ? /another tenant, principal or session/ : /outside the selected session scope/)
    assert.deepEqual(events(root, REQUEST), [])
    assert.deepEqual(events(root, REVIEW), [])
  }
})

test('a current assessment without a sealed acceptance proof is rejected', async t => {
  const root = makeWorkspace(t); fixture(root); await evidence(root)
  read(root, persistence => {
    const task = persistence.workflow.get('task', 'task')
    persistence.transition('task', task.id, 'completed', {
      expectedVersion: task.version, actor: 'fixture', cancellationEpoch: 0,
      acceptance: { valid: true, contractVersion: 'v1', verificationId: 'verification-evidence', evidenceIds: ['evidence'] },
    })
  })
  assert.equal(workflow(root).get('task', 'task').state, 'completed')
  assert.deepEqual(events(root, SEALED), [])
  host(t)
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  await assert.rejects(preview(tool), /missing a sealed proof/)
  assert.deepEqual(events(root, REQUEST), [])
  assert.deepEqual(events(root, REVIEW), [])
})

test('repeating the same invalidation on an already-invalid root fails closed instead of re-applying', async t => {
  const root = makeWorkspace(t); fixture(root, 'goal'); await evidence(root)
  let approvals = 0
  host(t, () => approvals++)
  await accept(root, 'goal')
  approvals = 0 // the acceptance above used its own independent approval
  const tool = evidenceLifecycleReview(binding, () => root, () => 'session')
  const previewed = await preview(tool)
  const first = await tool.handler(command(previewed))
  assert.equal(first.status, 'applied')
  assert.equal(approvals, 1)
  assert.equal(rows(root, 'evidence')[0].status, 'revoked')
  const impacts = events(root, IMPACT).length
  // Native revoke always returns the root even when its state cannot change, so a
  // traversal-length guard cannot catch this; the second review must be refused.
  await assert.rejects(preview(tool), /already invalidated for this action/)
  await assert.rejects(tool.handler(command(previewed, 'revoke', { idempotencyKey: 'second-revoke' })), /already invalidated for this action/)
  assert.equal(approvals, 1, 'a refused repeat never reaches the host')
  assert.equal(events(root, IMPACT).length, impacts)
  // A stale -> revoke escalation stays legal because it changes the root status.
  const staleRoot = makeWorkspace(t); fixture(staleRoot, 'goal'); await evidence(staleRoot)
  await accept(staleRoot, 'goal')
  const staleTool = evidenceLifecycleReview(binding, () => staleRoot, () => 'session')
  assert.equal((await staleTool.handler(command(await preview(staleTool), 'stale', { idempotencyKey: 'stale-first' }))).status, 'applied')
  assert.equal(rows(staleRoot, 'evidence')[0].status, 'stale')
  const escalated = await staleTool.handler(command(await preview(staleTool), 'revoke', { idempotencyKey: 'stale-now-revoke' }))
  assert.equal(escalated.status, 'applied')
  assert.equal(rows(staleRoot, 'evidence')[0].status, 'revoked')
})
