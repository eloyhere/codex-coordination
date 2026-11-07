import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { governanceBindings } from '../plugins/codex-coordination/mcp/amp/governance.mjs'
import { openNativeStore, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { projectBindings } from '../plugins/codex-coordination/mcp/amp/project.mjs'
import { filesystemBindings } from '../plugins/codex-coordination/mcp/amp/filesystem.mjs'
import { executionBindings } from '../plugins/codex-coordination/mcp/amp/execution.mjs'
import { evidenceBindings } from '../plugins/codex-coordination/mcp/amp/evidence.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { bindEvidence } from 'attention-manifest-protocol/persistence'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test/1', cancellationEpoch: 0 }
const eventKind = 'codex.amp.governance.command'
const pendingKind = 'codex.amp.governance.review_requested'
const decisionKind = 'codex.amp.governance.host_decision'
const resultKind = 'codex.amp.governance.review'
const requirements = { minimumTaskSuccessRate: 0.5, minimumSampleSize: 1, maximumSideEffectRate: 1 }
const digest = value => 'sha256:' + createHash('sha256').update(nativeRequest(value)).digest('hex')
const scopedSession = (root, identity = binding) => identity.sessionId + ':' + digest(root)

function makeWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'amp-governance-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function withStore(root, operation) {
  const { store } = openNativeStore(() => root)
  try { return operation(store) } finally { store.close() }
}

function autoApprove(decision = 'approve', hook = () => {}) {
  configureHostClient({ elicitation: {} }, message => {
    hook(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision } } }))
  })
}

function captureApprovals() {
  let message
  let requests = 0
  configureHostClient({ elicitation: {} }, value => { message = value; requests++ })
  return { get message() { return message }, get requests() { return requests } }
}

const profile = (id = 'engineer', overrides = {}) => ({
  id, name: 'Engineer', version: '1',
  permissionScope: { capabilityIds: [], operations: ['read'], resources: ['workspace'], allowWrite: false },
  deniedCapabilityIds: [], requirements, ...overrides,
})
const register = (id, kind = 'tool', references) => ({ operation: 'capability.register', registration: { capabilityId: id, version: '1', kind, ...(references ? { references } : {}) } })
const transition = (id, next, version = '1') => ({ operation: 'capability.transition', capabilityId: id, version, next })

function trustedHost(calls, overrides = {}) {
  return {
    evaluateProfession(input) {
      calls.push(input)
      return { evaluationId: input.evaluationId, taskSuccessRate: 1, averageTokens: 5, sideEffectRate: 0, sampleSize: 1, evaluator: 'trusted-host', evaluatedAt: '2026-11-07T00:00:00.000Z', ...overrides }
    },
  }
}

function fixture(t, host = {}, options = {}) {
  const root = options.root ?? makeWorkspace(t)
  let selected = root
  const tools = governanceBindings(binding, () => selected, host, options.policy ? () => options.policy() : undefined)
  let sequence = 0
  const list = () => tools[0].handler({ action: 'list' })
  const describe = () => tools[0].handler({ action: 'describe' })
  const review = tools[1].handler
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  return {
    root, tools, list, describe, review,
    head: async () => (await list()).head,
    input: async (command, key) => ({ command, expectedHead: (await list()).head, idempotencyKey: key ?? 'command-' + (++sequence) }),
    command: async (value, key) => review({ command: value, expectedHead: (await list()).head, idempotencyKey: key ?? 'command-' + (++sequence) }),
    select(value) { selected = value },
  }
}

let evidenceSequence = 0
async function createEvidence(root, identity = binding, options = {}) {
  const project = projectBindings(identity, () => root)
  const filesystem = filesystemBindings(identity, () => root, options.policy)
  const execution = executionBindings([...project, ...filesystem], identity, () => root)
  const call = (tools, name) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler
  const query = options.file ? 'workspace read text range' : 'project rules'
  const toolId = options.file ? 'attention_manifest_protocol_workspace.read' : 'attention_manifest_protocol_project.rules'
  const found = await call(execution, 'execution.find_tools')({ query, limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === toolId)?.pinned
  assert.ok(pinned, 'expected a pinned ' + toolId + ' contract')
  const suffix = ++evidenceSequence
  const run = await call(execution, 'execution.run')({ idempotencyKey: 'governance-run-' + suffix, calls: [{ id: 'read', ...pinned, arguments: options.file ? { path: options.file } : {} }] })
  const receipt = run.receipts[0]
  assert.equal(receipt.invocation.context.sessionId, scopedSession(root, identity))
  const evidenceTools = evidenceBindings(identity, () => root, options.policy)
  const reviewed = await call(evidenceTools, 'evidence_review')({ receiptId: receipt.id, claim: options.claim ?? 'Project rules inspected', criteriaVersion: '1', idempotencyKey: 'governance-evidence-' + suffix })
  assert.equal(reviewed.approved, true)
  assert.ok(reviewed.evidence?.id, 'evidence review must persist an evidence row')
  assert.equal(reviewed.evidence.status, 'active')
  return { evidence: reviewed.evidence, receipt, run }
}

test('describe/list return detached plain snapshots, persist no governance state and survive Store close', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'seed-profile')
  const before = withStore(f.root, store => ({ entities: store.stats().entities, events: store.stats().events, records: store.events().map(event => ({ kind: event.kind, payload: event.payload })) }))

  const closed = []
  const original = Store.prototype.close
  Store.prototype.close = function (...args) { closed.push(this); return original.apply(this, args) }
  let described, listed
  try { described = await f.describe(); listed = await f.list() } finally { Store.prototype.close = original }

  assert.ok(closed.length >= 2, 'each read must close the store it opened')
  assert.ok(closed.every(store => store.open === false))
  assert.equal(described.version, 1)
  assert.equal(listed.version, 1)
  assert.equal(listed.certification, 'unsupported_without_host_evaluator')
  assert.equal(listed.behavior, 'not_connected')
  assert.equal(listed.professions.length, 1)
  assert.equal(listed.capabilities.length, 0)
  assert.equal(Object.getPrototypeOf(listed), Object.prototype)
  assert.equal(Object.getPrototypeOf(listed.professions), Array.prototype)
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)
  assert.doesNotThrow(() => structuredClone(listed))
  assert.doesNotThrow(() => JSON.stringify(listed), 'a closed Store must not leave live proxies in the snapshot')

  listed.professions[0].certificationStatus = 'certified'
  assert.equal((await f.list()).professions[0].certificationStatus, 'uncertified')

  const after = withStore(f.root, store => ({ entities: store.stats().entities, events: store.stats().events, records: store.events().map(event => ({ kind: event.kind, payload: event.payload })) }))
  assert.equal(after.entities, before.entities)
  assert.equal(after.events, before.events)
  assert.deepEqual(after.records, before.records)
  assert.equal(withStore(f.root, store => store.events({ kind: pendingKind }).length), 1, 'reads must not request reviews')
  assert.equal(withStore(f.root, store => store.events({ kind: resultKind }).length), 1, 'reads must not append review results')
})

test('profession.register and capability.register force native initial state and reject model-supplied state', async t => {
  const f = fixture(t)
  autoApprove()
  await assert.rejects(f.review(await f.input({ operation: 'profession.register', profile: profile('forged', { scores: { taskSuccessRate: 1, averageTokens: 1, sideEffectRate: 0, sampleSize: 99 } }) }, 'forged-scores')), /fields/)
  await assert.rejects(f.review(await f.input({ operation: 'profession.register', profile: profile('forged', { certificationStatus: 'certified' }) }, 'forged-status')), /fields/)
  await assert.rejects(f.review(await f.input({ operation: 'profession.register', profile: profile('forged', { lifecycle: [{ eventType: 'certified', at: '2026-01-01T00:00:00.000Z' }] }) }, 'forged-lifecycle')), /fields/)
  assert.equal((await f.list()).professions.length, 0)

  const registered = await f.command({ operation: 'profession.register', profile: profile() }, 'profile-real')
  assert.equal(registered.status, 'applied')
  assert.equal(registered.result.profile.certificationStatus, 'uncertified')
  assert.deepEqual(registered.result.profile.scores, { taskSuccessRate: 0, averageTokens: 0, sideEffectRate: 0, sampleSize: 0 })
  assert.deepEqual(registered.result.profile.lifecycle, [])

  const beforeCapabilities = (await f.list()).capabilities.length
  await assert.rejects(f.review(await f.input({ operation: 'capability.register', registration: { capabilityId: 'stateful', version: '1', kind: 'tool', state: 'available' } }, 'forged-state')), /fields/)
  await assert.rejects(f.review(await f.input({ operation: 'capability.register', registration: { capabilityId: 'stateful', version: '1', kind: 'tool' }, state: 'available' }, 'forged-command-state')), /fields/)
  assert.equal((await f.list()).capabilities.length, beforeCapabilities)
  for (const [id, kind, state] of [['tool-one', 'tool', 'registered'], ['skill-one', 'skill', 'draft'], ['protocol-one', 'protocol', 'defined'], ['cognition-one', 'cognition', 'registered']]) {
    const result = await f.command(register(id, kind), 'register-' + id)
    assert.equal(result.result.capability.state, state)
    assert.equal(result.result.capability.events.length, 1)
  }
  const snapshot = await f.list()
  assert.equal(snapshot.capabilities.find(row => row.capabilityId === 'tool-one').state, 'registered')
  assert.equal(snapshot.capabilities.find(row => row.capabilityId === 'skill-one').state, 'draft')
})

test('capability transitions accept only native edges and persist tool-to-skill propagation', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command(register('tool'), 'reg-tool')
  await f.command(register('skill', 'skill', { tools: [{ id: 'tool', version: '1' }] }), 'reg-skill')
  await f.command(register('advisor', 'skill', { cognitions: [{ id: 'cognition', version: '1' }] }), 'reg-advisor')
  await f.command(register('cognition', 'cognition'), 'reg-cognition')
  const stateOf = async id => (await f.list()).capabilities.find(row => row.capabilityId === id)?.state

  await assert.rejects(f.command(transition('tool', 'available'), 'illegal-registered-available'), /invalid|transition/i)
  assert.equal(await stateOf('tool'), 'registered')
  await assert.rejects(f.command(transition('skill', 'binding'), 'illegal-draft-binding'), /invalid|transition/i)
  await assert.rejects(f.command(transition('tool', 'validated', '2'), 'unknown-version'), /unknown/i)

  await f.command(transition('tool', 'validated'), 'tool-validated')
  await assert.rejects(f.command(transition('tool', 'degraded'), 'illegal-validated-degraded'), /invalid|transition/i)
  await f.command(transition('tool', 'available'), 'tool-available')
  for (const next of ['validated', 'binding', 'ready']) await f.command(transition('skill', next), 'skill-' + next)
  for (const next of ['validated', 'binding', 'ready']) await f.command(transition('advisor', next), 'advisor-' + next)

  for (const next of ['validated', 'available', 'activated', 'evaluated']) await f.command(transition('cognition', next), 'cognition-' + next)
  const demoted = await f.command(transition('cognition', 'demoted'), 'cognition-demoted')
  const weight = demoted.result.impacts.find(impact => impact.skillId === 'advisor')
  assert.equal(weight.action, 'weight_reduced')
  assert.equal(weight.applied, false, 'a weight-only impact must not claim a lifecycle transition')
  assert.equal(weight.selectionEffect, 'audit_only_no_selector_connected')
  assert.equal(await stateOf('advisor'), 'ready')

  const degraded = await f.command(transition('tool', 'degraded'), 'tool-degraded')
  const cooling = degraded.result.impacts.find(impact => impact.skillId === 'skill')
  assert.equal(cooling.action, 'cooling')
  assert.equal(cooling.to, 'cooling')
  assert.equal(cooling.applied, true)
  assert.equal(await stateOf('skill'), 'cooling')

  await f.command(transition('tool', 'unavailable'), 'tool-unavailable')
  assert.equal(await stateOf('skill'), 'failed')
  await assert.rejects(f.command(transition('tool', 'available'), 'illegal-unavailable-available'), /invalid|transition/i)
  await assert.rejects(f.command(transition('skill', 'active'), 'illegal-failed-active'), /invalid|transition/i)

  const restored = await governanceBindings(binding, () => f.root)[0].handler({})
  assert.equal(restored.capabilities.find(row => row.capabilityId === 'skill').state, 'failed')
  assert.equal(restored.capabilities.find(row => row.capabilityId === 'advisor').state, 'ready')
  assert.equal(restored.capabilities.find(row => row.capabilityId === 'cognition').state, 'demoted')
  assert.equal(restored.capabilities.find(row => row.capabilityId === 'tool').state, 'unavailable')
})

test('certification without an injected trusted evaluator is explicitly unsupported and state-neutral', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const capture = captureApprovals()
  const eventsBefore = withStore(f.root, store => store.events().length)
  const entitiesBefore = withStore(f.root, store => store.stats().entities)
  await assert.rejects(f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'evaluation', evidenceIds: ['missing'] }, 'unsupported')), /unsupported.*trusted host evaluator/i)
  assert.equal(capture.requests, 0, 'unsupported certification must not prompt the host')
  assert.equal(withStore(f.root, store => store.events().length), eventsBefore)
  assert.equal(withStore(f.root, store => store.stats().entities), entitiesBefore)
  assert.equal(withStore(f.root, store => store.events({ kind: pendingKind }).length), 1)
  const snapshot = await f.list()
  assert.equal(snapshot.certification, 'unsupported_without_host_evaluator')
  assert.equal(snapshot.professions[0].certificationStatus, 'uncertified')

  const lateHost = {}
  const lateTools = governanceBindings(binding, () => f.root, lateHost)
  lateHost.evaluateProfession = () => { throw new Error('late evaluator must never run') }
  const lateHead = (await lateTools[0].handler({})).head
  await assert.rejects(lateTools[1].handler({ command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'late', evidenceIds: ['missing'] }, expectedHead: lateHead, idempotencyKey: 'late-evaluator' }), /unsupported/)

  const nonFunction = governanceBindings(binding, () => f.root, { evaluateProfession: 'not-a-function' })
  const nonFunctionSnapshot = await nonFunction[0].handler({})
  assert.equal(nonFunctionSnapshot.certification, 'unsupported_without_host_evaluator')
  await assert.rejects(nonFunction[1].handler({ command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'non-function', evidenceIds: ['missing'] }, expectedHead: nonFunctionSnapshot.head, idempotencyKey: 'non-function' }), /unsupported/)

  const calls = []
  const g = fixture(t, trustedHost(calls))
  autoApprove()
  await g.command({ operation: 'profession.register', profile: profile() }, 'profile')
  await assert.rejects(g.review(await g.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'model-eval', evidenceIds: ['missing'], evaluation: { taskSuccessRate: 1 } }, 'model-evaluation')), /fields/)
  await assert.rejects(g.review(await g.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'model-scores', evidenceIds: ['missing'], scores: { taskSuccessRate: 1 } }, 'model-scores')), /fields/)
  assert.equal(calls.length, 0, 'a model-supplied evaluation must never reach the trusted evaluator')
})

test('trusted evaluation certifies from stored file evidence and refuses evidence whose file changed', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'note.txt'), 'hello world\n')
  const calls = []
  let approvals = 0
  const f = fixture(t, trustedHost(calls), { root })
  autoApprove('approve', () => approvals++)
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const { evidence } = await createEvidence(root, binding, { file: 'note.txt', claim: 'The note contains hello world' })
  const approvalsBefore = approvals
  const certifyInput = { command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'evaluation-one', evidenceIds: [evidence.id] }, expectedHead: await f.head(), idempotencyKey: 'certify-one' }
  const certified = await f.review(certifyInput)
  assert.equal(certified.status, 'applied')
  assert.equal(certified.result.profile.certificationStatus, 'certified')
  assert.equal(certified.result.profile.evaluationId, 'evaluation-one')
  assert.deepEqual(certified.result.profile.scores, { taskSuccessRate: 1, averageTokens: 5, sideEffectRate: 0, sampleSize: 1 })
  assert.equal(calls.length, 1)
  assert.equal(approvals, approvalsBefore + 1)

  const input = calls[0]
  assert.ok(Object.isFrozen(input))
  assert.equal(input.evaluationId, 'evaluation-one')
  assert.equal(input.profile.id, 'engineer')
  assert.equal(input.evidence.length, 1)
  const citation = input.evidence[0]
  assert.equal(citation.evidence.id, evidence.id)
  assert.equal(citation.evidence.status, 'active')
  assert.equal(citation.receipt.invocation.toolId, 'attention_manifest_protocol_workspace.read')
  assert.equal(citation.receipt.invocation.context.sessionId, scopedSession(root))
  assert.equal(citation.receipt.invocation.context.principalId, binding.principalId)
  assert.equal(citation.receipt.invocation.context.tenantId, binding.tenantId)
  assert.equal(citation.verification.status, 'semantic_verified')
  assert.equal(citation.integrity.status, 'integrity_verified')
  assert.deepEqual(citation.receipt.workspaceAnchor.affectedFiles, ['note.txt'])

  const replay = await f.review(certifyInput)
  assert.equal(replay.replayed, true)
  assert.equal(replay.status, 'applied')
  assert.equal(calls.length, 1, 'a replay must not evaluate evidence again')
  assert.equal(approvals, approvalsBefore + 1, 'a replay must not request approval again')

  const recertified = await f.review(await f.input({ operation: 'profession.recertify', profileId: 'engineer', evaluationId: 'evaluation-two', evidenceIds: [evidence.id] }, 'recertify-one'))
  assert.equal(recertified.status, 'applied')
  assert.equal(recertified.result.profile.certificationStatus, 'recertified')
  assert.equal(recertified.result.profile.evaluationId, 'evaluation-two')
  assert.equal(calls.length, 2)

  writeFileSync(join(root, 'note.txt'), 'changed after certification\n')
  const callsBefore = calls.length
  await assert.rejects(f.review(await f.input({ operation: 'profession.recertify', profileId: 'engineer', evaluationId: 'evaluation-three', evidenceIds: [evidence.id] }, 'recertify-stale')), /file|changed|freshness/i)
  assert.equal(calls.length, callsBefore, 'stale file evidence must be rejected before the evaluator runs')
  const snapshot = await f.list()
  assert.equal(snapshot.professions[0].certificationStatus, 'recertified')
  assert.equal(snapshot.professions[0].evaluationId, 'evaluation-two')
  assert.equal(snapshot.professions[0].lifecycle.length, 2)
})

test('certification rejects evidence whose receipt belongs to another session, principal or tenant', async t => {
  const root = makeWorkspace(t)
  const calls = []
  const f = fixture(t, trustedHost(calls), { root })
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const foreignSession = await createEvidence(root, { ...binding, sessionId: 'other-session' }, { claim: 'foreign session' })
  const foreignPrincipal = await createEvidence(root, { ...binding, principalId: 'other' }, { claim: 'foreign principal' })
  const foreignTenant = await createEvidence(root, { ...binding, tenantId: 'other-tenant' }, { claim: 'foreign tenant' })

  await assert.rejects(f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'eval-session', evidenceIds: [foreignSession.evidence.id] }, 'foreign-session')), /another session/)
  await assert.rejects(f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'eval-principal', evidenceIds: [foreignPrincipal.evidence.id] }, 'foreign-principal')), /another principal/)
  await assert.rejects(f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'eval-tenant', evidenceIds: [foreignTenant.evidence.id] }, 'foreign-tenant')), /absent|stale|expired/)

  const revocable = await createEvidence(root, binding, { claim: 'revoked before certification' })
  withStore(root, store => {
    const bound = bindEvidence(store, new EvidenceLedger())
    bound.rehydrate()
    bound.revoke(revocable.evidence.id, binding.tenantId, 'revoked by test host', new Date().toISOString())
  })
  await assert.rejects(f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'eval-revoked', evidenceIds: [revocable.evidence.id] }, 'revoked')), /absent|stale|expired/)
  assert.equal(calls.length, 0)
  const snapshot = await f.list()
  assert.equal(snapshot.professions[0].certificationStatus, 'uncertified')
  assert.equal(withStore(root, store => store.events({ kind: pendingKind }).length), 1, 'rejected evidence must not create a pending certification')
})

test('approval is bound to the exact head and a valid concurrent commit yields stale_after_approval', async t => {
  const f = fixture(t)
  let recorded
  autoApprove('approve', () => {
    const pending = withStore(f.root, store => store.events({ kind: pendingKind }).at(-1).payload)
    const committed = withStore(f.root, store => store.events({ kind: eventKind }).length)
    withStore(f.root, store => store.appendEvent(eventKind, {
      tenantId: binding.tenantId, principalId: binding.principalId,
      sequence: committed + 1, previous: pending.head,
      command: pending.command, evaluation: pending.evaluation, at: pending.at,
      result: pending.preview, reviewId: pending.reviewId,
    }))
    recorded = pending
  })
  const result = await f.review(await f.input(register('raced'), 'head-race'))
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.changed, false)
  assert.equal(result.reviewId, recorded.reviewId)
  assert.equal('result' in result, false)
  assert.equal(result.approved, true)

  const snapshot = await f.list()
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.head, digest(withStore(f.root, store => store.events({ kind: eventKind }).map(event => event.payload))))
  assert.equal(snapshot.capabilities.length, 1)
  assert.equal(snapshot.capabilities[0].capabilityId, 'raced')

  autoApprove()
  const next = await f.command(register('after-race'), 'after-race')
  assert.equal(next.status, 'applied')
  assert.equal((await f.list()).capabilities.length, 2)
  assert.equal(withStore(f.root, store => store.events({ kind: eventKind }).length), 2)
})

test('unresolved reviews fail closed and a different key at the same head is blocked', async t => {
  const f = fixture(t)
  const capture = captureApprovals()
  const input = await f.input(register('pending'), 'pending-key')
  const running = f.review(input)
  const head = await f.head()
  await assert.rejects(f.review(input), /unresolved/)
  await assert.rejects(f.review({ ...input, expectedHead: head, idempotencyKey: 'different-key' }), /unresolved/)
  assert.equal(capture.requests, 1)
  assert.equal(withStore(f.root, store => store.events({ kind: eventKind }).length), 0)
  assert.equal((await f.list()).head, head)

  acceptHostResponse({ id: capture.message.id, result: { action: 'accept', content: { decision: 'reject' } } })
  const rejected = await running
  assert.equal(rejected.status, 'rejected')
  assert.equal((await f.review(input)).replayed, true)
})

test('a durable host decision resumes without a second prompt and applies exactly once', async t => {
  const f = fixture(t)
  const capture = captureApprovals()
  const input = await f.input(register('resumed'), 'resume-key')
  const running = f.review(input)
  const pending = withStore(f.root, store => store.events({ kind: pendingKind }).at(-1).payload)
  assert.equal(capture.requests, 1)
  withStore(f.root, store => store.appendEvent(decisionKind, { tenantId: binding.tenantId, principalId: binding.principalId, reviewId: pending.reviewId, key: pending.key, request: pending.request, approved: true }))

  const resumed = await f.review(input)
  assert.equal(resumed.status, 'applied')
  assert.equal(resumed.changed, true)
  assert.equal(capture.requests, 1, 'a durable decision must not prompt again')

  acceptHostResponse({ id: capture.message.id, result: { action: 'accept', content: { decision: 'reject' } } })
  const late = await running
  assert.equal(late.replayed, true)
  assert.equal(late.status, 'applied')
  assert.equal((await f.review(input)).replayed, true)
  assert.equal(withStore(f.root, store => store.events({ kind: eventKind }).length), 1)
  assert.equal((await f.list()).capabilities[0].capabilityId, 'resumed')
})

test('in-flight arguments are detached before independent host approval', async t => {
  const f = fixture(t)
  const input = await f.input(register('original'), 'immutable')
  const original = structuredClone(input)
  autoApprove('approve', () => {
    input.command.registration.capabilityId = 'mutated'
    input.command.registration.kind = 'skill'
    input.command.operation = 'profession.register'
    input.expectedHead = 'sha256:' + '0'.repeat(64)
  })
  const result = await f.review(input)
  assert.equal(result.status, 'applied')
  assert.equal(result.result.capability.capabilityId, 'original')
  assert.equal(result.result.capability.kind, 'tool')
  const snapshot = await f.list()
  assert.equal(snapshot.capabilities.length, 1)
  assert.equal(snapshot.capabilities[0].capabilityId, 'original')
  assert.equal((await f.review(original)).replayed, true)
  assert.equal((await f.list()).capabilities.length, 1)
})

test('extra approval, validity and model-evaluation fields are rejected', async t => {
  const calls = []
  const f = fixture(t, trustedHost(calls))
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const head = await f.head()
  await assert.rejects(f.review({ command: { ...register('x'), approved: true }, expectedHead: head, idempotencyKey: 'command-approved' }), /fields/)
  await assert.rejects(f.review({ command: { ...register('x'), valid: true }, expectedHead: head, idempotencyKey: 'command-valid' }), /fields/)
  await assert.rejects(f.review({ command: register('x'), expectedHead: head, idempotencyKey: 'top-approved', approved: true }), /fields/)
  await assert.rejects(f.review({ command: register('x'), expectedHead: head, idempotencyKey: 'top-valid', valid: true }), /fields/)
  await assert.rejects(f.review({ command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'e', evidenceIds: ['missing'], evaluation: { taskSuccessRate: 1 } }, expectedHead: head, idempotencyKey: 'model-eval' }), /fields/)
  assert.equal(calls.length, 0)
  assert.equal((await f.list()).capabilities.length, 0)
})

test('workspace change during approval is rejected as stale_after_approval', async t => {
  const f = fixture(t)
  const other = makeWorkspace(t)
  autoApprove('approve', () => f.select(other))
  const result = await f.review(await f.input(register('elsewhere'), 'workspace-change'))
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.changed, false)
  f.select(f.root)
  assert.equal((await f.list()).capabilities.length, 0)
  assert.equal(withStore(f.root, store => store.events({ kind: eventKind }).length), 0)
  assert.equal(withStore(other, store => store.events({ kind: eventKind }).length), 0)
})

test('filesystem scope change during certification approval is rejected as stale_after_approval', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'note.txt'), 'scope check\n')
  let policyRoot = root
  const policy = () => ({ root: policyRoot, exclude: [] })
  const calls = []
  const f = fixture(t, trustedHost(calls), { root, policy })
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const { evidence } = await createEvidence(root, binding, { file: 'note.txt', claim: 'scope check', policy })
  autoApprove('approve', () => { policyRoot = makeWorkspace(t) })
  const commandsBefore = withStore(root, store => store.events({ kind: eventKind }).length)
  const result = await f.review(await f.input({ operation: 'profession.certify', profileId: 'engineer', evaluationId: 'scope-eval', evidenceIds: [evidence.id] }, 'scope-change'))
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.changed, false)
  assert.equal(calls.length, 1, 'the evaluator ran once before approval and must not re-run on a failed commit')
  assert.equal((await f.list()).professions[0].certificationStatus, 'uncertified')
  assert.equal(withStore(root, store => store.events({ kind: eventKind }).length), commandsBefore)
})

test('native stores are closed on every exception path', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const head = await f.head()
  const original = Store.prototype.close
  let closed = 0
  Store.prototype.close = function (...args) { closed++; return original.apply(this, args) }
  try {
    await assert.rejects(f.review({ command: register('wrong-head'), expectedHead: 'sha256:' + '0'.repeat(64), idempotencyKey: 'wrong-head' }), /head changed/)
    assert.equal(closed, 1)
    closed = 0
    await assert.rejects(f.review({ command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'e', evidenceIds: ['missing'] }, expectedHead: head, idempotencyKey: 'unsupported-close' }), /unsupported/)
    assert.equal(closed, 1)
  } finally { Store.prototype.close = original }

  const g = fixture(t, trustedHost([]))
  autoApprove()
  await g.command({ operation: 'profession.register', profile: profile() }, 'profile')
  const gHead = await g.head()
  let evidenceClosed = 0
  Store.prototype.close = function (...args) { evidenceClosed++; return original.apply(this, args) }
  try {
    await assert.rejects(g.review({ command: { operation: 'profession.certify', profileId: 'engineer', evaluationId: 'e', evidenceIds: ['missing'] }, expectedHead: gHead, idempotencyKey: 'missing-evidence-close' }), /absent|stale|expired/)
    assert.equal(evidenceClosed, 1)
  } finally { Store.prototype.close = original }
})

test('journal replay inconsistency from an edited or forged command event is rejected', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command(register('alpha'), 'alpha')
  withStore(f.root, store => {
    const row = store.events({ kind: eventKind })[0]
    const payload = JSON.parse(JSON.stringify(row.payload))
    payload.result.capability.capabilityId = 'forged'
    store.driver.run({ sql: 'UPDATE events SET payload = ? WHERE sequence = ?', parameters: [JSON.stringify(payload), Number(row.sequence)] })
  })
  const original = Store.prototype.close
  let closed = 0
  Store.prototype.close = function (...args) { closed++; return original.apply(this, args) }
  try {
    await assert.rejects(f.list(), /replay differs/)
    assert.equal(closed, 1)
  } finally { Store.prototype.close = original }

  const g = fixture(t)
  autoApprove()
  await g.command(register('beta'), 'beta')
  withStore(g.root, store => {
    const row = store.events({ kind: eventKind })[0]
    const payload = JSON.parse(JSON.stringify(row.payload))
    payload.previous = 'sha256:' + '0'.repeat(64)
    store.driver.run({ sql: 'UPDATE events SET payload = ? WHERE sequence = ?', parameters: [JSON.stringify(payload), Number(row.sequence)] })
  })
  await assert.rejects(g.list(), /sequence or commitment/)

  const h = fixture(t)
  autoApprove()
  await h.command(register('gamma'), 'gamma')
  withStore(h.root, store => store.appendEvent(eventKind, { tenantId: binding.tenantId, principalId: binding.principalId, sequence: 99, previous: 'changed' }))
  await assert.rejects(h.list(), /sequence or commitment/)
})

test('journal corruption discovered at approval commit rejects and records nothing', async t => {
  const f = fixture(t)
  autoApprove()
  await f.command(register('first'), 'first-commit')
  const resultsBefore = withStore(f.root, store => store.events({ kind: resultKind }).length)
  autoApprove('approve', () => {
    withStore(f.root, store => {
      const row = store.events({ kind: eventKind })[0]
      const payload = JSON.parse(JSON.stringify(row.payload))
      payload.result.capability.capabilityId = 'forged-during-approval'
      store.driver.run({ sql: 'UPDATE events SET payload = ? WHERE sequence = ?', parameters: [JSON.stringify(payload), Number(row.sequence)] })
    })
  })
  await assert.rejects(f.review(await f.input(register('second'), 'second-commit')), /replay differs/)
  assert.equal(withStore(f.root, store => store.events({ kind: resultKind }).length), resultsBefore, 'a corrupt journal must not append a review result')
  assert.equal(withStore(f.root, store => store.events({ kind: eventKind }).length), 1, 'a corrupt journal must not append a command')
  await assert.rejects(f.list(), /replay differs/)
})
