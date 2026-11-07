import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { resolve } from 'node:path'
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

function host(t, approve = true) {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: approve ? 'approve' : 'reject' } } })))
}

const base = { taskId: 'task', idempotencyKey: 'replace-1', path: 'a.txt' }

test('canonical replace applies literal, regex and line edits under host approval with CAS guards', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'a.txt'), 'alpha beta\nsecond line\nthird line\n')
  seed(root)
  host(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session')
  const literal = await tool.handler({ ...base, mode: 'string', text: 'beta', replacement: 'BETA' })
  assert.equal(literal.changed, true)
  assert.equal(literal.approved, true)
  assert.equal(literal.mode, 'string')
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha BETA\nsecond line\nthird line\n')
  assert.equal((await tool.handler({ ...base, mode: 'string', text: 'beta', replacement: 'BETA' })).replayed, true)
  const regex = await tool.handler({ ...base, idempotencyKey: 'replace-2', mode: 'regex', pattern: '^second', flags: 'm', replacement: 'SECOND' })
  assert.equal(regex.changed, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha BETA\nSECOND line\nthird line\n')
  const line = await tool.handler({ ...base, idempotencyKey: 'replace-3', mode: 'line', start: 2, end: 3, replacement: 'REPLACED\n' })
  assert.equal(line.changed, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'alpha BETA\nSECOND line\nREPLACED\n')
  const byte = await tool.handler({ ...base, idempotencyKey: 'replace-4', mode: 'byte', start: 0, end: 5, replacement: 'ALPHA' })
  assert.equal(byte.changed, true)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'ALPHA BETA\nSECOND line\nREPLACED\n')
})

test('replace refuses stale CAS guards, foreign scope, model approval fields and rejected approval', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'a.txt'), 'original\n')
  seed(root)
  host(t)
  const tool = replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => 'session')
  await assert.rejects(tool.handler({ ...base, mode: 'string', text: 'original', replacement: 'next', expectedBaseHash: sha('different') }), /\S/)
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original\n')
  await assert.rejects(tool.handler({ ...base, mode: 'string', text: 'original', replacement: 'next', approved: true }), /Unknown replace parameter/)
  await assert.rejects(replaceBinding(binding, () => root, () => ({ root, exclude: [] }), () => undefined).handler({ ...base, mode: 'string', text: 'original', replacement: 'next' }), /Select an active native workflow/)
  const unapproved = makeWorkspace(t)
  writeFileSync(join(unapproved, 'a.txt'), 'original\n')
  seed(unapproved)
  host(t, false)
  const denied = await replaceBinding(binding, () => unapproved, () => ({ root: unapproved, exclude: [] }), () => 'session').handler({ ...base, mode: 'string', text: 'original', replacement: 'next' })
  assert.equal(denied.approved, false)
  assert.equal(denied.changed, false)
  assert.equal(readFileSync(join(unapproved, 'a.txt'), 'utf8'), 'original\n')
})
