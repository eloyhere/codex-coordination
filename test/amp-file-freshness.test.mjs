import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'

test('file receipts pin raw bytes and reject content or BOM changes during verification and citation', async t => {
  const root = makeWorkspace(t)
  const path = join(root, 'evidence.md')
  writeFileSync(path, '# Hello\r\n')
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  const found = await call('execution.find_tools', { query: 'workspace read text range', limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_workspace.read').pinned
  const run = await call('execution.run', { idempotencyKey: 'read-file', calls: [{ id: 'file', ...pinned, arguments: { path: 'evidence.md' } }] })
  const receipt = run.receipts[0]
  assert.deepEqual(receipt.workspaceAnchor.affectedFiles, ['evidence.md'])
  assert.equal(receipt.workspaceAnchor.snapshotId, run.execution.children[0].output.rawHash)
  configureHostClient({ elicitation: {} }, message => queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } })))
  const request = { receiptId: receipt.id, claim: 'The source contains the Hello heading', criteriaVersion: 'heading/1', idempotencyKey: 'verify-file' }
  const verified = await call('evidence_review', request)
  assert.equal(verified.approved, true)
  assert.equal((await call('evidence.cite', { ids: [verified.evidence.id] })).citations.length, 1)
  writeFileSync(path, '\uFEFF# Hello\r\n')
  await assert.rejects(call('evidence.cite', { ids: [verified.evidence.id] }), /file.*changed/)
  await assert.rejects(call('evidence_review', { ...request, idempotencyKey: 'changed-file' }), /file.*changed/)
  writeFileSync(path, '# Hello\r\n')
  configureHostClient({ elicitation: {} }, message => {
    writeFileSync(path, '# Changed during review\n')
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(call('evidence_review', { ...request, idempotencyKey: 'race-file' }), /file.*changed/)
  assert.equal((await call('evidence.list')).evidence.length, 1)
})
