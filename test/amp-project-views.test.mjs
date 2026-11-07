import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Project, createProjectToolHandlers } from 'attention-manifest-protocol/project'
import { bindProject } from 'attention-manifest-protocol/persistence'
import { createReceiptCore } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { projectViewsBindings } from '../plugins/codex-coordination/mcp/amp/project-views.mjs'
import { projectBindings } from '../plugins/codex-coordination/mcp/amp/project.mjs'
import { openNativeStore, nativeEnvironment, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { NativeReadStorage } from '../plugins/codex-coordination/mcp/amp/filesystem.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { Store } from '../plugins/codex-coordination/mcp/amp/storage.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test', cancellationEpoch: 0 }
const rootIdOf = root => createHash('sha256').update(realpathSync(root)).digest('hex')
const plain = value => JSON.parse(JSON.stringify(value))
const anchorRegistered = 'codex.amp.project.anchor_registered'
const reviewRequested = 'codex.amp.project.review_requested'
const reviewDecision = 'codex.amp.project.review_host_decision'
const reviewRecorded = 'codex.amp.project.review'
const entityMigration = 'codex.amp.project.entity_migration'
let sequence = 0
const key = prefix => `${prefix}-${++sequence}`

function receipt(root, path = 'anchor.txt', options = {}) {
  const now = new Date().toISOString()
  const seed = options.seed ?? path
  const raw = new NativeReadStorage({ root, exclude: [] }, options.tenantId ?? binding.tenantId).raw(path)
  const context = {
    tenantId: options.tenantId ?? binding.tenantId,
    principalId: options.principalId ?? binding.principalId,
    agentId: 'codex',
    sessionId: options.sessionId === null ? undefined : options.sessionId ?? 'session',
    operationId: 'op-' + seed,
    attemptId: 'attempt-' + seed,
    executionId: 'execution-' + seed,
  }
  const invocation = { id: 'invocation-' + seed, context, toolId: options.toolId ?? 'attention_manifest_protocol_workspace.read', arguments: { path }, createdAt: now }
  const observation = { id: 'observation-' + seed, invocationId: invocation.id, status: 'success', value: 'observed', observedAt: now }
  let environment
  const opened = openNativeStore(() => root)
  try { environment = nativeEnvironment(opened.store, root) } finally { opened.store.close() }
  const value = createReceiptCore({
    id: options.id ?? 'receipt-' + seed, invocation, observation, issuedAt: now,
    lifecycle: options.lifecycle ?? 'issued',
    hashAlgorithm: 'sha256-json-execution-facts/2',
    payloadDigest: options.payloadDigest ?? executionFactDigest(invocation, observation),
    workspaceAnchor: { workspaceId: root, snapshotId: options.snapshotId ?? raw.hash, affectedFiles: [path], changeHash: environment },
  })
  const saved = openNativeStore(() => root)
  try { saved.store.save('receipt', value) } finally { saved.store.close() }
  return value
}

function storedReceipt(root, value, mutate) {
  const next = plain(value)
  mutate(next)
  const opened = openNativeStore(() => root)
  try { opened.store.save('receipt', next) } finally { opened.store.close() }
  return next
}

function calls(initialRoot, options = {}) {
  let root = initialRoot
  const policy = options.hostPolicy ?? { purpose: 'verification', constraints: ['host-only'] }
  const filesystemPolicy = () => ({ root: options.scope?.() ?? root, exclude: [] })
  const tools = projectViewsBindings(binding, () => root, filesystemPolicy, policy)
  const tool = suffix => {
    const found = tools.find(item => item.name === 'attention_manifest_protocol_project' + suffix)
    assert.ok(found, 'missing tool ' + suffix)
    return found
  }
  return { read: tool('_views'), review: tool('_review'), select: next => { root = next }, root: () => root, policy }
}

function projectTool(root, verb) {
  const found = projectBindings(binding, () => root).find(tool => tool.name === 'attention_manifest_protocol_project.' + verb)
  assert.ok(found, 'missing project tool ' + verb)
  return found
}

async function putRule(root, id, text, options = {}) {
  return projectTool(root, 'put_rule').handler({ idempotencyKey: key('rule-' + id), id, text, ...options })
}

function storeEvents(root, kind) {
  const opened = openNativeStore(() => root)
  try { return opened.store.events({ kind }).map(event => plain(event.payload)) } finally { opened.store.close() }
}

function storeRows(root, kind) {
  const opened = openNativeStore(() => root)
  try { return plain(opened.store.list(kind)) } finally { opened.store.close() }
}

function directProject(root, work) {
  const opened = openNativeStore(() => root)
  try {
    const project = new Project({ tenantId: binding.tenantId, rootId: rootIdOf(opened.root) })
    const native = bindProject(opened.store, project)
    native.rehydrate()
    return work({ project, native, store: opened.store })
  } finally { opened.store.close() }
}

function approvalArgs(message) {
  const text = message.params.message
  const start = text.indexOf('Arguments: ') + 'Arguments: '.length
  const end = text.indexOf('. This requirement')
  assert.ok(start > 'Arguments: '.length && end > start, 'approval message has no argument payload')
  return JSON.parse(text.slice(start, end))
}

function host(t, respond) {
  const messages = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => { messages.push(message); respond(message) })
  return messages
}

function accept(message, decision = 'approve') {
  queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision } } }))
}

function approve(t, callback, decision = 'approve') {
  return host(t, message => { callback?.(message); accept(message, decision) })
}

test('project views read is a plain, non-creating snapshot that withholds host-only policy', async t => {
  const root = makeWorkspace(t)
  const tools = calls(root)
  const empty = await tools.read.handler({})
  assert.deepEqual(empty, { metadata: [], views: [], anchors: [], registryVersion: 0 })
  // A read on a workspace without a store creates no storage at all.
  assert.equal(existsSync(join(root, '.codex-coordination')), false)
  assert.deepEqual(tools.read.inputSchema, { type: 'object', additionalProperties: false, properties: {} })
  assert.equal(tools.read.annotations.readOnlyHint, true)
  assert.equal(tools.review.annotations.readOnlyHint, false)

  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'observed anchor')
  const observed = receipt(root)
  const messages = approve(t)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register observed file anchor' })
  assert.equal(anchor.status, 'applied')
  const view = await tools.review.handler({ operation: 'put_view', viewKind: 'architecture', projection: { nodes: ['source'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('view'), reason: 'Store host-reviewed architecture view' })
  assert.equal(view.status, 'applied')

  const callCount = storeEvents(root, 'codex.amp.project.call').length
  const firstRead = await tools.read.handler({})
  assert.equal(firstRead.registryVersion, 1)
  assert.equal(firstRead.views[0].kind, 'architecture')
  assert.equal(firstRead.metadata.length, 0)
  // Plain, detached snapshot: JSON round-trips and later mutation cannot leak back.
  assert.deepEqual(plain(firstRead), firstRead)
  const expected = plain(firstRead)
  firstRead.views.push({ kind: 'flow' }); firstRead.anchors.push({ anchor: 'invented' }); firstRead.metadata.push({ path: 'invented' })
  const stable = await tools.read.handler({})
  assert.deepEqual(stable, expected)
  assert.equal(stable.views.length, 1)
  assert.equal(stable.views[0].anchors[0], anchor.anchor)
  // Host-only purpose/constraints never enter the model-facing snapshot.
  assert.equal(Object.hasOwn(stable.views[0], 'purpose'), false)
  assert.equal(Object.hasOwn(stable.views[0], 'constraints'), false)
  assert.equal(JSON.stringify(stable).includes('host-only'), false)
  assert.equal(JSON.stringify(stable).includes('verification'), false)
  assert.deepEqual(Object.keys(stable.views[0]).sort(), ['anchors', 'freshness', 'kind', 'projection', 'rootId', 'sourceRuleIds', 'sourceVersions', 'stale', 'tenantId', 'updatedAt', 'version'])
  // The host-side row still carries the policy, so withholding is a projection choice.
  const rows = storeRows(root, 'project_view')
  assert.equal(rows[0].purpose, 'verification')
  assert.deepEqual(rows[0].constraints, ['host-only'])
  // Reading appends no migration, approval, anchor or project fact (the canonical
  // adapter's gateway audit is untouched because a migrated store is read in place).
  assert.equal(storeEvents(root, 'codex.amp.project.call').length, callCount)
  assert.equal(storeEvents(root, entityMigration).length, 1)
  assert.equal(storeEvents(root, anchorRegistered).length, 1)
  assert.equal(storeEvents(root, reviewRecorded).length, 2)
  assert.equal(storeRows(root, 'project_metadata').length, 0)
  assert.equal(storeRows(root, 'project_view').length, 1)
  assert.equal(messages.length, 2)
})

test('a review without an independent host approval writes nothing', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({}, () => {})
  const tools = calls(root)
  const rejected = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('no-host'), reason: 'Attempt registration' })
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.approved, false)
  assert.equal(rejected.changed, false)
  assert.equal((await tools.read.handler({})).registryVersion, 0)
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
  assert.equal(storeEvents(root, reviewDecision)[0].approved, false)
})

test('metadata and views persist through bindProject, share canonical versions and survive restart', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  approve(t)
  const tools = calls(root)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register observed file anchor' })
  assert.equal(anchor.status, 'applied')
  const rule = await putRule(root, 'source', 'Source rule')
  assert.equal(rule.version, 1)

  const metadata = await tools.review.handler({ operation: 'put_metadata', path: 'src/index.ts', tags: ['source'], ruleIds: ['source'], expectedVersion: 0, idempotencyKey: key('metadata'), reason: 'Describe source metadata' })
  assert.equal(metadata.status, 'applied')
  assert.equal(metadata.entity.version, 1)
  const canonicalMetadata = await projectTool(root, 'metadata').handler({})
  assert.equal(canonicalMetadata.metadata.length, 1)
  assert.equal(canonicalMetadata.metadata[0].path, 'src/index.ts')
  assert.equal(canonicalMetadata.metadata[0].version, 1)
  assert.deepEqual(canonicalMetadata.metadata[0].tags, ['source'])
  const metadataRows = storeRows(root, 'project_metadata')
  assert.equal(metadataRows.length, 1)
  assert.equal(metadataRows[0].rootId, rootIdOf(root))
  assert.equal(metadataRows[0].version, 1)

  const view = await tools.review.handler({ operation: 'put_view', viewKind: 'architecture', projection: { nodes: ['source'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('view'), reason: 'Store reviewed architecture view' })
  assert.equal(view.status, 'applied')
  assert.equal(view.entity.version, 1)
  assert.equal(view.entity.stale, false)
  assert.deepEqual(view.entity.sourceVersions, [{ ruleId: 'source', version: 1 }])

  // The canonical adapter owns rule versions: updating a rule stales the stored view
  // through its recorded sourceVersions without rewriting it.
  const updatedRule = await putRule(root, 'source', 'Source rule v2', { expectedVersion: rule.version })
  assert.equal(updatedRule.version, 2)
  const afterRule = await tools.read.handler({})
  assert.deepEqual(afterRule.views[0].sourceVersions, [{ ruleId: 'source', version: 1 }])
  assert.equal(afterRule.views[0].stale, true)

  // Metadata CAS uses the canonical version.
  await assert.rejects(tools.review.handler({ operation: 'put_metadata', path: 'src/index.ts', tags: ['stale'], ruleIds: ['source'], expectedVersion: 0, idempotencyKey: key('metadata-stale'), reason: 'Wrong version' }), /Metadata version changed/)
  const updatedMetadata = await tools.review.handler({ operation: 'put_metadata', path: 'src/index.ts', tags: ['source', 'read'], ruleIds: ['source'], expectedVersion: 1, idempotencyKey: key('metadata'), reason: 'Update source metadata' })
  assert.equal(updatedMetadata.entity.version, 2)
  assert.equal((await projectTool(root, 'metadata').handler({})).metadata[0].version, 2)
  const updatedView = await tools.review.handler({ operation: 'put_view', viewKind: 'architecture', projection: { nodes: ['source'], updated: true }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 1, idempotencyKey: key('view'), reason: 'Update reviewed architecture view' })
  assert.equal(updatedView.entity.version, 2)
  assert.equal(updatedView.entity.stale, false)
  assert.deepEqual(updatedView.entity.sourceVersions, [{ ruleId: 'source', version: 2 }])

  // Restart: a fresh binding graph reads the same durable entities and versions.
  const restarted = calls(root)
  const after = await restarted.read.handler({})
  assert.equal(after.registryVersion, 1)
  assert.equal(after.metadata[0].version, 2)
  assert.equal(after.views[0].version, 2)
  assert.deepEqual(after.views[0].projection, { nodes: ['source'], updated: true })
  assert.equal(after.views[0].stale, false)
  assert.equal((await projectTool(root, 'metadata').handler({})).metadata[0].version, 2)
  const rows = storeRows(root, 'project_view')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].version, 2)
  assert.equal(rows[0].purpose, 'verification')
  assert.deepEqual(rows[0].constraints, ['host-only'])
  assert.equal(rows[0].freshness, 1)
  assert.equal(rows[0].rootId, rootIdOf(root))
})

test('anchors are derived only from observed whitelisted receipts validated by the host', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  const files = { read: 'a.txt', outline: 'b.txt', document_outline: 'c.txt', write: 'd.txt' }
  for (const file of Object.values(files)) writeFileSync(join(root, file), 'content of ' + file)
  const observed = {}
  for (const [verb, file] of Object.entries(files)) observed[verb] = receipt(root, file, { toolId: 'attention_manifest_protocol_workspace.' + verb, seed: verb })
  const messages = approve(t)
  const tools = calls(root)
  let expectedVersion = 0
  for (const verb of Object.keys(files)) {
    const result = await tools.review.handler({ operation: 'register_anchor', receiptId: observed[verb].id, expectedVersion: expectedVersion++, idempotencyKey: key('anchor-' + verb), reason: 'Register observed ' + verb + ' receipt' })
    assert.equal(result.status, 'applied', 'whitelisted receipt tool ' + verb)
    assert.match(result.anchor, new RegExp('^file:' + files[verb].replace('.', '\\.') + '@sha256:[0-9a-f]{64}$'))
    assert.equal(result.registryVersion, expectedVersion)
  }
  // The approval payload carries the host-derived anchor and the host policy.
  assert.equal(approvalArgs(messages[0]).operation, 'register_anchor')
  assert.equal(approvalArgs(messages[0]).receiptId, observed.read.id)
  assert.equal(approvalArgs(messages[0]).expectedVersion, 0)
  assert.equal(approvalArgs(messages[0]).hostPolicy.purpose, 'verification')
  assert.match(approvalArgs(messages[0]).effect.anchor, /^file:a\.txt@sha256:/)
  assert.match(messages[0].params.message, /^AMP requires host approval for native-project:/)
  assert.equal(approvalArgs(messages[0]).workspace, realpathSync(root))
  // Anchor events remember the observed receipt identity for the tenant and root.
  const events = storeEvents(root, anchorRegistered)
  assert.equal(events.length, 4)
  assert.equal(events[0].receiptId, observed.read.id)
  assert.equal(events[0].tenantId, binding.tenantId)
  assert.equal(events[0].rootId, rootIdOf(root))
  assert.equal(events[0].revision, 1)
  assert.equal(events[0].receipt.id, observed.read.id)
  const read = await tools.read.handler({})
  assert.equal(read.registryVersion, 4)
  assert.deepEqual(read.anchors.map(item => item.current), [true, true, true, true])
  assert.deepEqual(read.anchors.map(item => item.receiptId), Object.values(observed).map(item => item.id))

  const before = messages.length
  // Non-file tools can never become anchors, even with a valid execution digest.
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: receipt(root, 'a.txt', { toolId: 'attention_manifest_protocol_workspace.list', seed: 'list' }).id, expectedVersion: 4, idempotencyKey: key('bad-tool'), reason: 'Bad tool' }), /Only observed native filesystem receipts/)
  // Foreign principals, tenants, incomplete session identity, revoked lifecycle and
  // tampered execution digests are all rejected by the host before approval.
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: receipt(root, 'a.txt', { principalId: 'intruder', seed: 'principal' }).id, expectedVersion: 4, idempotencyKey: key('bad-principal'), reason: 'Bad principal' }), /invalid or belongs to another principal/)
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: receipt(root, 'a.txt', { tenantId: 'other', seed: 'tenant' }).id, expectedVersion: 4, idempotencyKey: key('bad-tenant'), reason: 'Bad tenant' }), /invalid or belongs to another principal/)
  // A receipt without session identity is rejected before its digest is trusted.
  const sessionless = receipt(root, 'a.txt', { seed: 'session' })
  storedReceipt(root, sessionless, next => { delete next.invocation.context.sessionId })
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: sessionless.id, expectedVersion: 4, idempotencyKey: key('bad-session'), reason: 'Bad session' }), /incomplete native execution identity/)
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: receipt(root, 'a.txt', { lifecycle: 'revoked', seed: 'lifecycle' }).id, expectedVersion: 4, idempotencyKey: key('bad-lifecycle'), reason: 'Bad lifecycle' }), /invalid or belongs to another principal/)
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: receipt(root, 'a.txt', { payloadDigest: 'sha256:' + '0'.repeat(64), seed: 'digest' }).id, expectedVersion: 4, idempotencyKey: key('bad-digest'), reason: 'Bad digest' }), /invalid or belongs to another principal/)
  // The model cannot name an anchor itself; anchors only come from observed receipts.
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: observed.read.id, anchor: 'file:a.txt@sha256:' + '0'.repeat(64), expectedVersion: 4, idempotencyKey: key('invented'), reason: 'Invent anchor' }), /Invalid project review parameters/)
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'flow', projection: {}, sourceRuleIds: ['source'], anchors: ['file:invented.txt@sha256:' + '0'.repeat(64)], expectedVersion: 0, idempotencyKey: key('invented-view'), reason: 'Invent view anchor' }), /anchor|does not exist|absent/i)
  assert.equal(messages.length, before)
  assert.equal(storeEvents(root, anchorRegistered).length, 4)
})

test('anchor freshness is re-derived from raw bytes so drift stales views and re-registration', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'before drift')
  writeFileSync(join(root, 'stable.txt'), 'stable')
  const observed = receipt(root, 'anchor.txt')
  const stableReceipt = receipt(root, 'stable.txt')
  approve(t)
  const tools = calls(root)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register anchor' })
  const stable = await tools.review.handler({ operation: 'register_anchor', receiptId: stableReceipt.id, expectedVersion: 1, idempotencyKey: key('anchor-stable'), reason: 'Register stable anchor' })
  const view = await tools.review.handler({ operation: 'put_view', viewKind: 'flow', projection: { nodes: ['anchor'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('view'), reason: 'Store anchored view' })
  assert.equal(view.status, 'applied')
  assert.equal((await tools.read.handler({})).views[0].stale, false)

  writeFileSync(join(root, 'anchor.txt'), 'after drift')
  const read = await tools.read.handler({})
  assert.equal(read.anchors.find(item => item.anchor === anchor.anchor).current, false)
  assert.equal(read.anchors.find(item => item.anchor === stable.anchor).current, true)
  assert.equal(read.views[0].stale, true)
  // A view may not be re-put against a stale anchor, and the drifted receipt cannot
  // be registered again: both fail in the pre-approval preview.
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'flow', projection: { nodes: ['anchor'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 1, idempotencyKey: key('stale-view'), reason: 'Stale anchor' }), /absent or stale|missing, excluded or changed/)
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 2, idempotencyKey: key('stale-anchor'), reason: 'Stale anchor' }), /missing, excluded or changed/)
  // A restored raw file becomes fresh again because the anchor is byte-derived.
  writeFileSync(join(root, 'anchor.txt'), 'before drift')
  assert.equal((await tools.read.handler({})).views[0].stale, false)
})

test('view writes need registered anchors and real rule versions and fail closed on corrupt facts', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const messages = approve(t)
  const tools = calls(root)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register anchor' })
  const before = messages.length
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'er', projection: {}, sourceRuleIds: ['source'], anchors: ['file:ghost.txt@sha256:' + '0'.repeat(64)], expectedVersion: 0, idempotencyKey: key('ghost'), reason: 'Unknown anchor' }), /absent or stale/)
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'er', projection: {}, sourceRuleIds: ['missing'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('missing-rule'), reason: 'Unknown rule' }), /rule missing does not exist/)
  assert.equal(messages.length, before)
  const applied = await tools.review.handler({ operation: 'put_view', viewKind: 'er', projection: { tables: ['source'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('view'), reason: 'Reviewed view' })
  assert.equal(applied.status, 'applied')
  assert.equal((await tools.read.handler({})).views[0].stale, false)

  // A persisted view whose anchor was never registered fails upstream validation on
  // rehydration, and the read does not silently repair or drop it.
  const corrupt = makeWorkspace(t)
  await putRule(corrupt, 'source', 'Source rule')
  writeFileSync(join(corrupt, 'anchor.txt'), 'anchor')
  const corruptReceipt = receipt(corrupt)
  const corruptTools = calls(corrupt)
  approve(t)
  const real = await corruptTools.review.handler({ operation: 'register_anchor', receiptId: corruptReceipt.id, expectedVersion: 0, idempotencyKey: key('corrupt-anchor'), reason: 'Register anchor' })
  assert.equal(real.status, 'applied')
  directProject(corrupt, ({ project, native }) => {
    const rootId = project.rootId
    return native.putView({ tenantId: binding.tenantId, rootId, kind: 'venn', projection: { sets: ['ghost'] }, sourceRuleIds: ['source'], anchors: ['file:ghost.txt@sha256:' + '1'.repeat(64)], purpose: 'planning', constraints: [], freshness: 1 })
  })
  assert.equal(storeRows(corrupt, 'project_view').length, 1)
  await assert.rejects(corruptTools.read.handler({}), /does not exist|invalid/i)
  assert.equal(storeEvents(corrupt, anchorRegistered).length, 1)
  assert.equal(storeRows(corrupt, 'project_view').length, 1)
})

test('a raw file change during approval stales the approved review with no change', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'before')
  const observed = receipt(root)
  const tools = calls(root)
  approve(t, () => { writeFileSync(join(root, 'anchor.txt'), 'after') })
  const result = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('drift'), reason: 'Register anchor' })
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.approved, true)
  assert.equal(result.changed, false)
  assert.equal((await tools.read.handler({})).registryVersion, 0)
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
  assert.equal(storeEvents(root, reviewDecision)[0].approved, true)
  assert.equal(storeEvents(root, reviewRecorded)[0].result.status, 'stale_after_approval')
})

test('metadata written during approval stales the approved review with no change', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  const tools = calls(root)
  approve(t, () => { directProject(root, ({ project, native }) => native.putMetadata({ tenantId: binding.tenantId, rootId: project.rootId, path: 'concurrent.ts', tags: [], ruleIds: [] })) })
  const result = await tools.review.handler({ operation: 'put_metadata', path: 'approved.ts', tags: ['source'], ruleIds: ['source'], expectedVersion: 0, idempotencyKey: key('meta-race'), reason: 'Describe approved metadata' })
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.changed, false)
  const read = await tools.read.handler({})
  assert.deepEqual(read.metadata.map(item => item.path), ['concurrent.ts'])
  assert.equal(storeRows(root, 'project_metadata').length, 1)
  assert.equal(storeEvents(root, reviewRecorded)[0].result.status, 'stale_after_approval')
})

test('a view written during approval stales the approved view review with no change', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  approve(t)
  const tools = calls(root)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register anchor' })
  assert.equal(anchor.status, 'applied')
  const raced = calls(root)
  approve(t, () => {
    directProject(root, ({ project, native }) => native.putView({ tenantId: binding.tenantId, rootId: project.rootId, kind: 'venn', projection: { sets: ['concurrent'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], purpose: 'planning', constraints: [], freshness: 1 }))
  })
  const result = await raced.review.handler({ operation: 'put_view', viewKind: 'flow', projection: { nodes: ['approved'] }, sourceRuleIds: ['source'], anchors: [anchor.anchor], expectedVersion: 0, idempotencyKey: key('view-race'), reason: 'Review raced view' })
  assert.equal(result.status, 'stale_after_approval')
  assert.equal(result.changed, false)
  const read = await raced.read.handler({})
  assert.deepEqual(read.views.map(item => item.kind), ['venn'])
  assert.equal(storeRows(root, 'project_view').length, 1)
  assert.equal(storeEvents(root, reviewRecorded).at(-1).result.status, 'stale_after_approval')
})

test('an anchor registered while another review is approved stales that review exactly once', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'first.txt'), 'first')
  writeFileSync(join(root, 'second.txt'), 'second')
  const firstReceipt = receipt(root, 'first.txt')
  const secondReceipt = receipt(root, 'second.txt')
  const tools = calls(root)
  const secondArgs = { operation: 'register_anchor', receiptId: secondReceipt.id, expectedVersion: 0, idempotencyKey: key('nested'), reason: 'Register second anchor' }
  let nested
  const messages = host(t, message => {
    if (approvalArgs(message).receiptId === secondReceipt.id) { accept(message); return }
    nested = tools.review.handler(secondArgs)
    nested.then(() => accept(message), () => accept(message))
  })
  const first = await tools.review.handler({ operation: 'register_anchor', receiptId: firstReceipt.id, expectedVersion: 0, idempotencyKey: key('pending'), reason: 'Register first anchor' })
  assert.equal((await nested).status, 'applied')
  assert.equal(first.status, 'stale_after_approval')
  assert.equal(first.changed, false)
  assert.equal(messages.length, 2)
  const read = await tools.read.handler({})
  assert.equal(read.registryVersion, 1)
  assert.equal(read.anchors.length, 1)
  assert.match(read.anchors[0].anchor, /^file:second\.txt@sha256:/)
  assert.equal(storeEvents(root, anchorRegistered).length, 1)
  assert.deepEqual(storeEvents(root, reviewRecorded).map(item => item.result.status).sort(), ['applied', 'stale_after_approval'])
})

test('workspace and filesystem-scope switches reject approved reviews without changes', async t => {
  const root = makeWorkspace(t)
  const other = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const tools = calls(root)
  approve(t, () => { tools.select(other) })
  const switched = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('workspace'), reason: 'Register anchor' })
  assert.equal(switched.status, 'stale_after_approval')
  assert.equal(switched.changed, false)
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
  assert.equal((await calls(root).read.handler({})).registryVersion, 0)
  assert.equal((await calls(other).read.handler({})).registryVersion, 0)

  const scoped = makeWorkspace(t)
  writeFileSync(join(scoped, 'anchor.txt'), 'anchor')
  const scopedReceipt = receipt(scoped)
  let scope = scoped
  const scopedTools = calls(scoped, { scope: () => scope })
  approve(t, () => { scope = other })
  const scopeResult = await scopedTools.review.handler({ operation: 'register_anchor', receiptId: scopedReceipt.id, expectedVersion: 0, idempotencyKey: key('scope'), reason: 'Register anchor' })
  assert.equal(scopeResult.status, 'stale_after_approval')
  assert.equal(scopeResult.changed, false)
  assert.equal((await calls(scoped).read.handler({})).registryVersion, 0)
  assert.equal(storeEvents(scoped, anchorRegistered).length, 0)
})

test('a rejected host decision applies nothing and is replayed without a second approval', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const tools = calls(root)
  const messages = approve(t, undefined, 'reject')
  const args = { operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('denied'), reason: 'Register anchor' }
  const rejected = await tools.review.handler(args)
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.approved, false)
  assert.equal(rejected.changed, false)
  assert.equal((await tools.read.handler({})).registryVersion, 0)
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
  const replay = await tools.review.handler(args)
  assert.equal(replay.replayed, true)
  assert.equal(replay.status, 'rejected')
  assert.equal(messages.length, 1)
})

test('model arguments are detached from the caller and extra host fields are rejected', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const messages = approve(t)
  const tools = calls(root)
  await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register anchor' })
  const original = { operation: 'put_metadata', path: 'detached.ts', tags: ['original'], ruleIds: ['source'], expectedVersion: 0, idempotencyKey: key('detached'), reason: 'Detached parameters' }
  const snapshot = plain(original)
  const pending = tools.review.handler(original)
  original.path = 'mutated.ts'; original.tags.push('mutated'); original.reason = 'mutated'
  const detached = await pending
  assert.equal(detached.status, 'applied')
  assert.equal(detached.entity.path, 'detached.ts')
  assert.deepEqual(detached.entity.tags, ['original'])
  const requested = storeEvents(root, reviewRequested).find(item => item.request.includes('detached.ts'))
  assert.ok(requested, 'request event recorded the detached copy')
  assert.equal(requested.request, nativeRequest(snapshot))
  assert.equal(storeRows(root, 'project_metadata')[0].path, 'detached.ts')
  const replay = await tools.review.handler(snapshot)
  assert.equal(replay.replayed, true)
  assert.equal(messages.length, 2)

  const before = messages.length
  await assert.rejects(tools.review.handler({ operation: 'put_metadata', path: 'x.ts', tags: [], ruleIds: [], expectedVersion: 0, idempotencyKey: key('extra-purpose'), reason: 'Extra', purpose: 'planning' }), /Invalid project review parameters/)
  await assert.rejects(tools.review.handler({ operation: 'put_metadata', path: 'x.ts', tags: [], ruleIds: [], expectedVersion: 0, idempotencyKey: key('extra-freshness'), reason: 'Extra', freshness: 1 }), /Invalid project review parameters/)
  await assert.rejects(tools.review.handler({ operation: 'put_metadata', path: 'x.ts', tags: [], ruleIds: [], expectedVersion: 0, idempotencyKey: key('extra-tenant'), reason: 'Extra', tenantId: 'spoof' }), /bound by the host/)
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'flow', projection: { nested: { sessionId: 'spoof' } }, sourceRuleIds: ['source'], anchors: ['file:a.txt@sha256:' + '0'.repeat(64)], expectedVersion: 0, idempotencyKey: key('nested-spoof'), reason: 'Nested spoof' }), /bound by the host/)
  await assert.rejects(tools.review.handler({ operation: 'put_view', viewKind: 'flow', projection: { blob: 'x'.repeat(70_000) }, sourceRuleIds: ['source'], anchors: ['file:a.txt@sha256:' + '0'.repeat(64)], expectedVersion: 0, idempotencyKey: key('oversize'), reason: 'Oversize' }), /Invalid project review parameters/)
  await assert.rejects(tools.review.handler({ operation: 'put_metadata', path: 'x.ts', tags: [], ruleIds: [], expectedVersion: -1, idempotencyKey: key('negative'), reason: 'Negative' }), /Invalid project review parameters/)
  assert.equal(messages.length, before)
  assert.equal(storeRows(root, 'project_metadata').length, 1)
})

test('a review is approved once, replayed durably and resumed from its recorded host decision', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const messages = approve(t)
  const tools = calls(root)
  const args = { operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('once'), reason: 'Register anchor' }
  const applied = await tools.review.handler(args)
  assert.equal(applied.status, 'applied')
  assert.equal(applied.changed, true)
  assert.equal(messages.length, 1)
  assert.equal(storeEvents(root, reviewRequested).length, 1)
  assert.equal(storeEvents(root, reviewDecision).length, 1)
  assert.equal(storeEvents(root, reviewRecorded).length, 1)
  const replay = await tools.review.handler(args)
  assert.equal(replay.replayed, true)
  assert.equal(replay.status, 'applied')
  assert.equal(replay.anchor, applied.anchor)
  assert.equal(messages.length, 1)
  assert.equal(storeEvents(root, anchorRegistered).length, 1)
  // The same key with different arguments is refused before any second approval.
  await assert.rejects(tools.review.handler({ ...args, reason: 'Different request' }), /Idempotency key already used for another project review/)
  assert.equal(messages.length, 1)

  // Durable resume: an interrupted host request leaves a pending fact; retries must
  // not ask the host again and may only proceed from the recorded decision.
  const interrupted = makeWorkspace(t)
  writeFileSync(join(interrupted, 'anchor.txt'), 'anchor')
  const interruptedReceipt = receipt(interrupted)
  let requests = 0
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, () => { requests += 1; throw new Error('host connection interrupted') })
  const resumedTools = calls(interrupted)
  const resumedArgs = { operation: 'register_anchor', receiptId: interruptedReceipt.id, expectedVersion: 0, idempotencyKey: key('resume'), reason: 'Register anchor' }
  await assert.rejects(resumedTools.review.handler(resumedArgs), /host connection interrupted/)
  await assert.rejects(resumedTools.review.handler(resumedArgs), /unresolved; host reconciliation is required/)
  assert.equal(requests, 1)
  assert.equal(storeEvents(interrupted, reviewRequested).length, 1)
  assert.equal(storeEvents(interrupted, reviewDecision).length, 0)
  const opened = openNativeStore(() => interrupted)
  try {
    const pending = opened.store.events({ kind: reviewRequested })[0].payload
    opened.store.appendEvent(reviewDecision, { key: pending.key, request: pending.request, reviewId: pending.reviewId, approved: true })
  } finally { opened.store.close() }
  const resumed = await resumedTools.review.handler(resumedArgs)
  assert.equal(resumed.status, 'applied')
  assert.equal(resumed.changed, true)
  assert.equal(requests, 1)
  assert.equal(storeEvents(interrupted, anchorRegistered).length, 1)
  assert.equal(storeEvents(interrupted, reviewRecorded).length, 1)
})

test('a rolled-back review transaction leaves no fact and the same review can be retried', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const messages = approve(t)
  const tools = calls(root)
  const originalAppend = Store.prototype.appendEvent
  let injected = false
  Store.prototype.appendEvent = function (kind, ...rest) {
    if (!injected && kind === reviewRecorded) { injected = true; throw new Error('injected transaction failure') }
    return Reflect.apply(originalAppend, this, [kind, ...rest])
  }
  t.after(() => { Store.prototype.appendEvent = originalAppend })
  const args = { operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('rollback'), reason: 'Register anchor' }
  await assert.rejects(tools.review.handler(args), /injected transaction failure/)
  // The transaction rolled back the anchor event; the request and host decision remain.
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
  assert.equal(storeEvents(root, reviewRequested).length, 1)
  assert.equal(storeEvents(root, reviewDecision).length, 1)
  assert.equal(storeEvents(root, reviewRecorded).length, 0)
  assert.equal((await tools.read.handler({})).registryVersion, 0)
  assert.equal(messages.length, 1)
  const retried = await tools.review.handler(args)
  assert.equal(retried.status, 'applied')
  assert.equal(retried.changed, true)
  assert.equal(messages.length, 1)
  assert.equal(storeEvents(root, anchorRegistered).length, 1)
  assert.equal(storeEvents(root, reviewRecorded).length, 1)
  assert.equal((await tools.read.handler({})).registryVersion, 1)
})

test('every store opened by reads and reviews is closed on success and failure paths', async t => {
  const root = makeWorkspace(t)
  await putRule(root, 'source', 'Source rule')
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  const opened = []
  const originalOpen = Store.open, originalClose = Store.prototype.close
  let closes = 0
  Store.open = function (...args) {
    const store = Reflect.apply(originalOpen, Store, args)
    opened.push(store)
    return store
  }
  Store.prototype.close = function (...args) { closes += 1; return Reflect.apply(originalClose, this, args) }
  t.after(() => { Store.open = originalOpen; Store.prototype.close = originalClose })
  const sealed = () => {
    assert.ok(opened.length > 0, 'instrumented at least one store')
    assert.equal(closes, opened.length, 'every opened store was closed exactly once')
    assert.ok(opened.every(store => store.open === false), 'no store stayed open')
  }
  const tools = calls(root)
  await tools.read.handler({})
  sealed()
  for (const store of opened) assert.throws(() => store.events({ kind: 'x' }), /store is closed/)

  // Preview failure: an unknown receipt throws before host approval.
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: 'missing', expectedVersion: 0, idempotencyKey: key('missing'), reason: 'Missing receipt' }), /not_found/)
  sealed()

  // Unresolved durable review: the host sender throws mid-approval.
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, () => { throw new Error('interrupted') })
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('interrupted'), reason: 'Interrupted' }), /interrupted/)
  sealed()

  // Stale-after-approval path closes every store it opened.
  approve(t, () => { writeFileSync(join(root, 'anchor.txt'), 'drift') })
  const stale = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('stale'), reason: 'Stale' })
  assert.equal(stale.status, 'stale_after_approval')
  sealed()

  // Transaction failure path closes every store and rolls back.
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const fresh = receipt(root, 'anchor.txt', { seed: 'retry' })
  const originalAppend = Store.prototype.appendEvent
  let injected = false
  Store.prototype.appendEvent = function (kind, ...rest) {
    if (!injected && kind === reviewRecorded) { injected = true; throw new Error('injected') }
    return Reflect.apply(originalAppend, this, [kind, ...rest])
  }
  t.after(() => { Store.prototype.appendEvent = originalAppend })
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: fresh.id, expectedVersion: 0, idempotencyKey: key('rollback'), reason: 'Rollback' }), /injected/)
  sealed()
})

test('legacy project journals migrate exactly once through the views adapter and never bypass reconciliation', async t => {
  const at = '2026-11-07T00:00:00.000Z'
  const root = makeWorkspace(t)
  const rootId = rootIdOf(root)
  const name = 'attention_manifest_protocol_project.put_rule'
  const parameters = { id: 'old-rule', text: 'Original rule' }
  const result = createProjectToolHandlers(new Project({ tenantId: binding.tenantId, rootId, clock: () => at }))[name](parameters, {})
  const seeded = openNativeStore(() => root)
  try {
    seeded.store.appendEvent('codex.amp.project.command', { name, parameters, at, key: 'codex:old-retry', request: nativeRequest({ name, parameters }), result })
  } finally { seeded.store.close() }
  const tools = calls(root)
  const first = await tools.read.handler({})
  assert.deepEqual(first, { metadata: [], views: [], anchors: [], registryVersion: 0 })
  // The pending journal ran through the canonical migration exactly once.
  assert.equal(storeEvents(root, entityMigration).length, 1)
  const rules = storeRows(root, 'project_rule')
  assert.equal(rules.length, 1)
  assert.equal(rules[0].id, 'old-rule')
  assert.equal(rules[0].text, 'Original rule')
  assert.equal(rules[0].updatedAt, at)
  assert.equal(storeEvents(root, 'codex.amp.project.command').length, 1)
  const audit = storeEvents(root, 'codex.amp.project.call').length
  await tools.read.handler({})
  await tools.read.handler({})
  assert.equal(storeEvents(root, entityMigration).length, 1)
  assert.equal(storeEvents(root, 'codex.amp.project.call').length, audit)
  // The canonical adapter sees the migrated fact and can replay the original journal key.
  const canonical = await projectTool(root, 'rules').handler({})
  assert.equal(canonical.rules.length, 1)
  assert.equal(canonical.rules[0].updatedAt, at)
  const replayed = await projectTool(root, 'put_rule').handler({ idempotencyKey: 'old-retry', id: 'old-rule', text: 'Original rule' })
  assert.equal(replayed.replayed, true)
  assert.equal(rules[0].version, replayed.version)
  // A later approved review does not re-run the migration.
  writeFileSync(join(root, 'anchor.txt'), 'anchor')
  const observed = receipt(root)
  approve(t)
  const anchor = await tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('anchor'), reason: 'Register anchor' })
  assert.equal(anchor.status, 'applied')
  assert.equal(storeEvents(root, entityMigration).length, 1)
  assert.equal(storeEvents(root, 'codex.amp.project.command').length, 1)
  assert.equal(storeRows(root, 'project_rule').length, 1)

  // Mixed native facts and an unmigrated journal are refused before any write.
  const mixed = makeWorkspace(t)
  const mixedRootId = rootIdOf(mixed)
  const mixedOpened = openNativeStore(() => mixed)
  try {
    const project = new Project({ tenantId: binding.tenantId, rootId: mixedRootId })
    const native = bindProject(mixedOpened.store, project)
    native.rehydrate()
    project.putRule({ tenantId: binding.tenantId, rootId: mixedRootId, id: 'native-rule', text: 'Native rule' })
    native.flush()
    mixedOpened.store.appendEvent('codex.amp.project.command', { name, parameters, at, key: 'codex:mixed', request: nativeRequest({ name, parameters }), result })
  } finally { mixedOpened.store.close() }
  writeFileSync(join(mixed, 'anchor.txt'), 'anchor')
  const mixedReceipt = receipt(mixed)
  const mixedMessages = approve(t)
  await assert.rejects(calls(mixed).read.handler({}), /both native facts and an unmigrated journal|reconciliation/)
  await assert.rejects(calls(mixed).review.handler({ operation: 'register_anchor', receiptId: mixedReceipt.id, expectedVersion: 0, idempotencyKey: key('mixed'), reason: 'Mixed' }), /both native facts and an unmigrated journal|reconciliation/)
  assert.equal(mixedMessages.length, 0)
  assert.equal(storeEvents(mixed, entityMigration).length, 0)
  assert.equal(storeEvents(mixed, 'codex.amp.project.command').length, 1)
  assert.equal(storeRows(mixed, 'project_rule').length, 1)

  // A journal whose recorded result does not match native replay is refused too.
  const corrupt = makeWorkspace(t)
  const corruptOpened = openNativeStore(() => corrupt)
  try {
    corruptOpened.store.appendEvent('codex.amp.project.command', { name, parameters: { id: 'bad', text: 'Rule' }, at, key: 'codex:corrupt', request: '{}', result: { hash: 'incorrect' } })
  } finally { corruptOpened.store.close() }
  await assert.rejects(calls(corrupt).read.handler({}), /does not match native replay/)
  assert.equal(storeEvents(corrupt, entityMigration).length, 0)
  assert.equal(storeRows(corrupt, 'project_rule').length, 0)
})

test('anchor freshness also rejects a receipt whose file was removed before review', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'gone.txt'), 'gone')
  const observed = receipt(root, 'gone.txt')
  unlinkSync(join(root, 'gone.txt'))
  const tools = calls(root)
  approve(t)
  await assert.rejects(tools.review.handler({ operation: 'register_anchor', receiptId: observed.id, expectedVersion: 0, idempotencyKey: key('gone'), reason: 'Register missing file' }), /missing, excluded or changed/)
  assert.equal((await tools.read.handler({})).registryVersion, 0)
  assert.equal(storeEvents(root, anchorRegistered).length, 0)
})
