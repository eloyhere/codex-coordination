import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const moduleRoot = process.env.AMP_WRITE_TEST_MODULE_ROOT ? pathToFileURL(resolve(process.env.AMP_WRITE_TEST_MODULE_ROOT) + '/').href : new URL('../plugins/codex-coordination/mcp/amp/', import.meta.url).href
const { writeBinding } = await import(moduleRoot + 'write.mjs')
const { configureHostClient, acceptHostResponse, closeHostClient } = await import(moduleRoot + 'host-client.mjs')
const { openNativeStore } = await import(moduleRoot + 'native-store.mjs')
const { createOutlineProvider } = await import('attention-manifest-protocol/file')
import { makeWorkspace } from './helpers.mjs'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'

const sha = value => createHash('sha256').update(value).digest('hex')
const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test-v1', cancellationEpoch: 0 }

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

function writer(root) {
  return writeBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session-write')
}

/** Approve every elicitation and expose the exact payload the host receives. */
function approvals(t) {
  const messages = []
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => {
    messages.push(message)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  return { get prompts() { return messages.length }, get message() { return messages.at(-1) } }
}

function writeEvents(root) {
  const { store } = openNativeStore(() => root)
  try { return store.events({ kind: 'codex.amp.workspace.write' }) } finally { store.close() }
}

test('line target replaces only the addressed lines and pins target plus buffer version', async t => {
  const root = makeWorkspace(t)
  const original = 'line one\nline two\nline three\n'
  writeFileSync(join(root, 'notes.md'), original, 'utf8')
  seed(root)
  const approval = approvals(t)
  const target = { mode: 'line', start: 1, end: 2 }
  const input = { path: 'notes.md', content: 'line two updated\n', expectedHash: sha(original), target, expectedBufferVersion: 0, taskId: 'task-write', idempotencyKey: 'line-target' }

  const result = await writer(root).handler(input)
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.receipt.kind, 'file_flush_receipt')
  assert.equal(result.receipt.lifecycle, 'issued')
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'line one\nline two updated\nline three\n')
  assert.equal(approval.prompts, 1)
  assert.match(approval.message.params.message, /"target":\{"mode":"line","start":1,"end":2\}/)
  assert.match(approval.message.params.message, /"expectedBufferVersion":0/)
  assert.match(approval.message.params.message, /"resolved":\{"mode":"line","ranges":\[\{"startLine":1,"endLine":2,/)
  assert.deepEqual(result.receipt.invocation.arguments.target, target)
  assert.equal(result.receipt.invocation.arguments.expectedBufferVersion, 0)
  assert.deepEqual(result.receipt.observation.value.target, target)

  const replay = await writer(root).handler(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.id, result.receipt.id)
  assert.equal(approval.prompts, 1)
})

test('byte target replaces only the addressed UTF-8 byte range', async t => {
  const root = makeWorkspace(t)
  const original = 'alpha βeta gamma\n'
  const start = Buffer.byteLength('alpha ', 'utf8'), end = start + Buffer.byteLength('βeta', 'utf8')
  writeFileSync(join(root, 'notes.md'), original, 'utf8')
  seed(root)
  const approval = approvals(t)
  const target = { mode: 'byte', start, end }

  const result = await writer(root).handler({ path: 'notes.md', content: 'BETA', expectedHash: sha(original), target, taskId: 'task-write', idempotencyKey: 'byte-target' })
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'alpha BETA gamma\n')
  assert.equal(approval.prompts, 1)
  assert.match(approval.message.params.message, /"target":\{"mode":"byte","start":6,"end":11\}/)
  assert.match(approval.message.params.message, /"resolved":\{"mode":"byte",/)
  assert.deepEqual(result.receipt.invocation.arguments.target, target)
})

test('outline target replaces the addressed Markdown section and nothing else', async t => {
  const root = makeWorkspace(t)
  const original = '# Title\n\nintro\n\n## First\n\nfirst body\n\n## Second\n\nsecond body\n'
  const expected = '# Title\n\nintro\n\n## First\n\nfirst body\n\n## Second\n\nreplaced body\n'
  writeFileSync(join(root, 'guide.md'), original, 'utf8')
  seed(root)
  const node = createOutlineProvider().entries('guide.md', original).find(entry => entry.name === 'Second')
  assert.ok(node, 'the Markdown outline exposes the Second heading')
  const approval = approvals(t)
  const target = { mode: 'outline', id: node.id }

  const result = await writer(root).handler({ path: 'guide.md', content: '## Second\n\nreplaced body\n', expectedHash: sha(original), target, taskId: 'task-write', idempotencyKey: 'outline-target' })
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(readFileSync(join(root, 'guide.md'), 'utf8'), expected)
  assert.equal(approval.prompts, 1)
  assert.match(approval.message.params.message, /"target":\{"mode":"outline","id":"markdown:heading:Second:1:38"\}/)
  assert.match(approval.message.params.message, /"resolved":\{"mode":"outline","ranges":\[\{"startLine":8,"endLine":12,/)
  assert.match(approval.message.params.message, /"verification":"hash"/)
  assert.deepEqual(result.receipt.invocation.arguments.target, target)
  assert.equal(createOutlineProvider().entries('guide.md', expected).some(entry => entry.name === 'Second'), true)
})

test('a stale expectedBufferVersion is rejected before approval without changing the file', async t => {
  const root = makeWorkspace(t)
  const original = 'untouched\n'
  writeFileSync(join(root, 'notes.md'), original, 'utf8')
  seed(root)
  const approval = approvals(t)

  await assert.rejects(writer(root).handler({ path: 'notes.md', content: 'changed\n', expectedHash: sha(original), expectedBufferVersion: 1, taskId: 'task-write', idempotencyKey: 'stale-buffer' }), /buffer is at version 0/)
  assert.equal(approval.prompts, 0)
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), original)
  assert.equal(writeEvents(root).length, 0)
})

test('malformed targets and versions are rejected before approval or any claim', async t => {
  const root = makeWorkspace(t)
  const original = 'untouched\n'
  writeFileSync(join(root, 'notes.md'), original, 'utf8')
  seed(root)
  const approval = approvals(t)
  const base = { path: 'notes.md', content: 'changed\n', expectedHash: sha(original), taskId: 'task-write' }
  const malformed = [
    [{ mode: 'line', start: 2, end: 1 }, /target end must be greater than or equal to start/],
    [{ mode: 'paragraph', start: 0, end: 1 }, /target mode must be one of line, byte, outline/],
    [{ mode: 'line', start: 0, end: 1, extra: true }, /Unknown target parameter/],
    [{ mode: 'outline' }, /target id must be a nonempty string/],
    [{ mode: 'byte', start: 0.5, end: 1 }, /target start must be a nonnegative integer/],
    [{ mode: 'line', start: -1, end: 1 }, /target start must be a nonnegative integer/],
    [null, /target must be an object with a mode/],
  ]
  for (const [index, [target, message]] of malformed.entries()) await assert.rejects(writer(root).handler({ ...base, target, idempotencyKey: 'malformed-' + index }), message)
  await assert.rejects(writer(root).handler({ ...base, expectedBufferVersion: -1, idempotencyKey: 'negative-version' }), /expectedBufferVersion must be a nonnegative integer/)
  assert.equal(approval.prompts, 0)
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), original)
  assert.equal(writeEvents(root).length, 0)
  const { store } = openNativeStore(() => root)
  try {
    assert.equal(store.list('action_attempt').length, 0)
    assert.equal(store.list('receipt').length, 0)
  } finally { store.close() }
})

test('whole-file writes keep their payload, receipt shape and idempotent replay', async t => {
  const root = makeWorkspace(t)
  const original = 'whole file\n'
  writeFileSync(join(root, 'notes.md'), original, 'utf8')
  seed(root)
  const approval = approvals(t)
  const input = { path: 'notes.md', content: 'whole replacement\n', expectedHash: sha(original), taskId: 'task-write', idempotencyKey: 'whole-file' }

  const result = await writer(root).handler(input)
  assert.equal(result.approved, true)
  assert.equal(result.changed, true)
  assert.equal(result.businessVerification, 'not_performed')
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'whole replacement\n')
  assert.equal(approval.prompts, 1)
  assert.equal(approval.message.params.message.includes('"target"'), false)
  assert.equal(approval.message.params.message.includes('"resolved"'), false)
  assert.equal(approval.message.params.message.includes('"expectedBufferVersion"'), false)
  assert.equal(result.receipt.invocation.arguments.contentDigest, 'sha256:' + sha('whole replacement\n'))
  assert.equal(result.receipt.invocation.arguments.target, undefined)

  const replay = await writer(root).handler(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approved, true)
  assert.equal(replay.receipt.id, result.receipt.id)
  assert.equal(approval.prompts, 1)
})
