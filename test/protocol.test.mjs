import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { canonicalJson as referenceCanonical } from 'amp-legacy/semantic'
import { verifySnapshot as referenceVerify } from 'amp-legacy/ledger'
import { canonicalJson, GENESIS } from '../plugins/codex-coordination/mcp/lib/amp.mjs'
import { validateArtifact } from '../plugins/codex-coordination/mcp/lib/protocol.mjs'
import { toolNamed } from '../plugins/codex-coordination/mcp/lib/tools.mjs'
import { ledgerPath, peekState, snapshotOf } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { makeWorkspace } from './helpers.mjs'

const receipt = { amp: '0.1', kind: 'receipt', id: 'read-result', op: 'read', at: '2026-11-03T00:00:00Z', usage: {}, outcome: 'success' }
const frame = { amp: '0.1', kind: 'frame', id: 'focus', agent: 'codex-main', cycle: 0, ts: '2026-11-03T00:00:00Z', digest: GENESIS, mode: 'exploit', slots: [], ignored: [{ target: { kind: 'task', id: 'later' }, reason: 'deferred', revisit_if: 'current work is verified' }], budget: { allocated: { calls: 4 }, spent: {} } }
const protocol = args => toolNamed('coordination_protocol').handler(args)

test('runtime canonical bytes use the installed AMP implementation and reject accessors without invoking them', () => {
  assert.equal(canonicalJson({ text: '注意', b: 2 }), referenceCanonical({ text: '注意', b: 2 }))
  let reads = 0
  const object = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; return 1 } })
  assert.throws(() => canonicalJson(object), /accessor/)
  assert.equal(reads, 0)
})

test('npm schemas validate receipts, attention capacity, exclusion reasons and RFC 3339 dates', () => {
  assert.equal(validateArtifact(receipt).ok, true)
  assert.equal(validateArtifact(frame).ok, true)
  assert.equal(validateArtifact({ ...receipt, at: '2026-02-30T00:00:00Z' }).ok, false)
  assert.equal(validateArtifact({ ...receipt, invented: true }).ok, false)
  assert.equal(validateArtifact({ ...frame, ignored: [{ ...frame.ignored[0], reason: 'forgot' }] }).ok, false)
  const slot = { target: { kind: 'task', id: 'one' }, role: 'goal', salience: 0.5, why: 'finish', cost: {}, state: 'active' }
  assert.equal(validateArtifact({ ...frame, slots: Array.from({ length: 10 }, () => slot) }).ok, false)
})

test('protocol records survive reload, are immutable, and export under the npm snapshot verifier', async t => {
  const workspace = makeWorkspace(t)
  await protocol({ workspace, action: 'record', artifact: frame })
  await protocol({ workspace, action: 'record', artifact: receipt })
  await assert.rejects(protocol({ workspace, action: 'record', artifact: receipt }), { code: 'CONFLICT' })
  const before = peekState(workspace)
  await assert.rejects(protocol({ workspace, action: 'record', artifact: { ...receipt, id: 'bad', outcome: 'invented' } }), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual(peekState(workspace), before)
  assert.equal(referenceVerify(snapshotOf(before)).ok, true)
  const list = await protocol({ workspace, action: 'list', limit: 1 })
  assert.equal(list.total, 2)
  assert.equal(list.records[0].payload.id, receipt.id)
  const filtered = await protocol({ workspace, action: 'list', kind: 'frame' })
  assert.equal(filtered.total, 1)
  assert.equal(filtered.records[0].payload.id, frame.id)
  const snapshot = snapshotOf(before)
  snapshot.entries[0].payload.mode = 'rest'
  assert.equal(validateArtifact(snapshot).ok, false)
})

test('dashboard opens without a workspace and reads real ledger state without writing', async t => {
  const workspace = makeWorkspace(t)
  const dashboard = toolNamed('coordination_dashboard')
  assert.equal((await dashboard.handler({})).workspace, null)
  const view = await dashboard.handler({ workspace })
  assert.equal(view.protocol.version, '0.6.3')
  assert.equal(view.status.ledger.verified, true)
  assert.equal(existsSync(ledgerPath(workspace)), false)
})
