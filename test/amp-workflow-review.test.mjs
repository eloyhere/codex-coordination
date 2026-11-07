import test from 'node:test'
import assert from 'node:assert/strict'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace, seedGoal } from './helpers.mjs'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'

test('native workflow transitions require correlated host approval, preserve CAS and never expose achievement', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  let workspace = root
  const tools = withAmpSurface([], () => workspace)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  await seedGoal(root, 'review-goal')
  const preview = await call('migration', { action: 'preview' })
  await call('migration', { action: 'import', sourceDigest: preview.sourceDigest })
  await call('workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  const { store } = openNativeStore(() => root)
  const session = JSON.parse(JSON.stringify(store.list('session')[0])); store.close()
  const input = { kind: 'session', id: session.id, to: 'resumed', expectedVersion: session.version, idempotencyKey: 'resume-1', reason: 'Resume imported work for host review' }
  configureHostClient({}, () => {})
  assert.equal((await call('workflow_review', input)).approved, false)
  let requests = 0
  configureHostClient({ elicitation: {} }, message => {
    requests++
    assert.equal(acceptHostResponse({ method: 'tools/call', id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }), false)
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  const approved = await call('workflow_review', { ...input, idempotencyKey: 'resume-2' })
  assert.equal(approved.entity.state, 'resumed')
  assert.equal((await call('workflow_review', { ...input, idempotencyKey: 'resume-2' })).replayed, true)
  assert.equal(requests, 1)
  await assert.rejects(call('workflow_review', { ...input, idempotencyKey: 'stale' }))
  await assert.rejects(call('workflow_review', { ...input, to: 'achieved', idempotencyKey: 'fake-success' }), /not available/)
  await assert.rejects(call('workflow_review', { ...input, approved: true }), /Unknown review parameter/)
  configureHostClient({ elicitation: {} }, message => {
    const { store } = openNativeStore(() => root)
    try {
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
      persistence.restoreAll()
      persistence.transition('session', session.id, 'active', { expectedVersion: approved.entity.version, actor: 'concurrent-host' })
    } finally { store.close() }
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(call('workflow_review', { ...input, to: 'active', expectedVersion: approved.entity.version, idempotencyKey: 'race' }), /Workflow changed/)
  configureHostClient({ elicitation: {} }, message => {
    workspace = other
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(call('workflow_review', { ...input, to: 'idle', expectedVersion: approved.entity.version + 1, idempotencyKey: 'switch' }), /scope changed/)
  const reopened = openNativeStore(() => root).store
  try { assert.equal(reopened.list('session')[0].state, 'active') } finally { reopened.close() }
})
