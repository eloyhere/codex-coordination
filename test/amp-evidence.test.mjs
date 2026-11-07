import test from 'node:test'
import assert from 'node:assert/strict'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'

test('native evidence requires integrity and independent approval, survives restart and rejects environment drift', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  let workspace = root
  const tools = withAmpSurface([], () => workspace)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  const found = await call('execution.find_tools', { query: 'project rules', limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_project.rules').pinned
  const run = await call('execution.run', { idempotencyKey: 'evidence-read', calls: [{ id: 'read', ...pinned, arguments: {} }] })
  const input = { receiptId: run.receipts[0].id, claim: 'The current project has no configured rules', criteriaVersion: 'rules/1', idempotencyKey: 'verify-1' }
  configureHostClient({}, () => {})
  assert.equal((await call('evidence_review', input)).evidence, null)
  assert.equal((await call('evidence.list')).evidence.length, 0)
  let approvals = 0
  configureHostClient({ elicitation: {} }, message => {
    approvals++
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  const verified = await call('evidence_review', { ...input, idempotencyKey: 'verify-2' })
  assert.equal(verified.verification.status, 'semantic_verified')
  assert.equal(verified.evidence.claim, input.claim)
  assert.equal(verified.acceptanceGranted, false)
  assert.equal((await call('evidence_review', { ...input, idempotencyKey: 'verify-2' })).replayed, true)
  assert.equal(approvals, 1)
  assert.equal((await call('evidence.cite', { ids: [verified.evidence.id] })).citations.length, 1)
  const restarted = withAmpSurface([], () => root)
  assert.equal((await restarted.find(tool => tool.name === 'attention_manifest_protocol_evidence.get').handler({ id: verified.evidence.id })).evidence.claim, input.claim)
  workspace = other
  await assert.rejects(call('evidence.get', { id: verified.evidence.id }), /not found/)
  workspace = root
  await call('project.put_rule', { idempotencyKey: 'new-rule', id: 'testing', text: 'New rule changes the environment' })
  await assert.rejects(call('evidence.cite', { ids: [verified.evidence.id] }), /environment is stale/)
  await assert.rejects(call('evidence_review', { ...input, idempotencyKey: 'stale-env' }), /stale/)
  const fresh = await call('execution.run', { idempotencyKey: 'fresh-read', calls: [{ id: 'fresh', ...pinned, arguments: {} }] })
  configureHostClient({ elicitation: {} }, message => {
    void call('project.put_rule', { idempotencyKey: 'during-review', id: 'another-rule', text: 'Changes while review is open' }).then(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(call('evidence_review', { ...input, receiptId: fresh.receipts[0].id, idempotencyKey: 'env-race' }), /environment changed/)
  assert.equal((await call('evidence.list')).evidence.length, 1)
  const latest = await call('execution.run', { idempotencyKey: 'tamper-read', calls: [{ id: 'latest', ...pinned, arguments: {} }] })
  const { store } = openNativeStore(() => root)
  try {
    const receipt = JSON.parse(JSON.stringify(store.list('receipt').find(item => item.id === latest.receipts[0].id)))
    receipt.observation.value = { forged: true }
    store.save('receipt', receipt)
  } finally { store.close() }
  await assert.rejects(call('evidence_review', { ...input, receiptId: latest.receipts[0].id, idempotencyKey: 'corrupt-receipt' }), /integrity verification failed/)
})
