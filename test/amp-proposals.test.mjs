import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { createHash } from 'node:crypto'

test('native Store submissions survive adapter restart, enforce idempotency and isolate workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amp07-submissions-'))
  const other = mkdtempSync(join(tmpdir(), 'amp07-other-'))
  let workspace = root
  try {
    const tools = () => withAmpSurface([], () => workspace)
    const submit = () => tools().find(tool => tool.name === 'attention_manifest_protocol_intent.submit_clarification')
    const input = { idempotencyKey: 'proposal-1', targetId: 'goal-1', submission: { statement: 'Draft plan' } }
    const first = await submit().handler(input)
    assert.equal(first.status, 'pending_host_review')
    const replay = await submit().handler(input)
    assert.equal(replay.id, first.id)
    assert.equal(replay.replayed, true)
    const reordered = await submit().handler({ submission: input.submission, targetId: input.targetId, idempotencyKey: input.idempotencyKey })
    assert.equal(reordered.id, first.id)
    await assert.rejects(submit().handler({ ...input, targetId: 'different' }), /Idempotency/)
    await assert.rejects(submit().handler({ ...input, submission: { sessionId: 'spoof' } }))
    const read = () => tools().find(tool => tool.name === 'attention_manifest_protocol_submissions').handler({})
    assert.equal((await read()).submissions.length, 1)
    workspace = other
    assert.equal((await read()).submissions.length, 0)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})

test('legacy submission JSON key ordering remains retryable without rewriting old records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amp07-old-request-'))
  try {
    const submit = withAmpSurface([], () => root).find(tool => tool.name === 'attention_manifest_protocol_intent.submit_clarification')
    const input = { idempotencyKey: 'old-key', targetId: 'goal', submission: { b: 2, a: 1 } }
    const first = await submit.handler(input)
    const { store } = openNativeStore(() => root)
    // Seed a pre-migration request as a separate historical event.
    const old = { ...first, id: 'historical-submission', key: createHash('sha256').update('codex:old-legacy-key').digest('hex'), request: JSON.stringify({ tool: first.tool, parameters: { submission: { b: 2, a: 1 }, targetId: 'goal' } }) }
    store.appendEvent('codex.amp.submission', old, 'historical')
    store.close()
    const { sameNativeRequest, nativeRequest } = await import('../plugins/codex-coordination/mcp/amp/native-store.mjs')
    assert.ok(sameNativeRequest(old.request, nativeRequest({ tool: first.tool, parameters: { targetId: 'goal', submission: { a: 1, b: 2 } } })))
    assert.equal((await submit.handler({ ...input, idempotencyKey: 'old-legacy-key', submission: { a: 1, b: 2 } })).id, old.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

