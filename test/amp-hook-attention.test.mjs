import test from 'node:test'
import assert from 'node:assert/strict'
import { createAttention, mount, persist } from 'attention-manifest-protocol/attention'
import { prepareHookAttention } from '../plugins/codex-coordination/mcp/codex/attention-lifecycle.mjs'
import { ingestHook, readCodexThread } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace } from './helpers.mjs'

function setup(t) {
  const root = makeWorkspace(t), now = new Date().toISOString(), expiresAt = new Date(Date.now() + 3600000).toISOString()
  ingestHook({ cwd: root, session_id: 'hook-thread', hook_event_name: 'SessionStart' })
  const session = readCodexThread(() => root, 'hook-thread').nativeSession
  const create = (id, summary = id) => mount(createAttention({ id, summary, pointer: { kind: 'session', id: session.id, version: String(session.version) }, scope: { tenantId: 'local', principalId: 'codex', sessionId: session.id, turnId: 'old-turn' }, budget: { bytes: 8192 }, expiresAt, reason: 'Trusted host fixture' }, now), { expectedVersion: 1, now, reason: 'Host mount' })
  const save = object => { const { store } = openNativeStore(() => root); try { store.save('attention', object) } finally { store.close() } }
  const list = () => { const { store } = openNativeStore(() => root); try { return store.list('attention').map(value => JSON.parse(JSON.stringify(value))) } finally { store.close() } }
  const input = turn_id => ingestHook({ cwd: root, session_id: 'hook-thread', turn_id, hook_event_name: 'UserPromptSubmit', prompt: 'Continue' })
  return { root, now, expiresAt, create, save, list, input }
}

test('trusted hook restores explicit live retention, resets transient mounts and retains expired history', t => {
  const { root, now, expiresAt, create, save, list, input } = setup(t)
  const retained = persist(create('retained', 'Retained summary'), { across: 'turns', expiresAt, budget: { bytes: 8192 }, reason: 'Host retained across inputs' }, { expectedVersion: 2, now, reason: 'Host retention' })
  save(retained)
  save(create('transient'))
  save({ ...create('expired'), expiresAt: '2000-01-01T00:00:00Z' })
  save({ ...retained, id: 'foreign', summary: 'FOREIGN', scope: { ...retained.scope, principalId: 'other' } })
  save({ ...retained, id: 'stale', summary: 'STALE', stale: true })
  save({ ...retained, id: 'unknown-pointer', summary: 'UNKNOWN', pointer: { kind: 'unsupported-source', id: 'absent', version: '1', uri: 'https://example.invalid/private' } })
  input('new-turn')
  const result = prepareHookAttention(() => root, 'hook-thread', 'new-turn')
  assert.equal(result.items, 1)
  assert.match(result.text, /Retained summary/)
  assert.doesNotMatch(result.text, /FOREIGN|STALE|UNKNOWN/)
  const after = list()
  assert.equal(after.find(object => object.id === 'retained').scope.turnId, 'new-turn')
  assert.equal(after.find(object => object.id === 'transient').mounted, false)
  assert.equal(after.find(object => object.id === 'expired').mounted, false)
  assert.equal(after.find(object => object.id === 'foreign').mounted, true)
  // Replaying the same boundary does not erase mounts installed in that turn.
  save({ ...create('current-transient'), scope: { ...retained.scope, turnId: 'new-turn' } })
  const replay = prepareHookAttention(() => root, 'hook-thread', 'new-turn')
  assert.match(replay.text, /current-transient/)
  input('next-turn')
  prepareHookAttention(() => root, 'hook-thread', 'next-turn')
  assert.equal(list().find(object => object.id === 'current-transient').mounted, false)
})

test('foreign attention rows do not consume the current principal compilation cap', t => {
  const { root, now, expiresAt, create, save, input } = setup(t)
  const retained = persist(create('zzz-owned', 'Visible owned attention'), { across: 'turns', expiresAt, budget: { bytes: 8192 }, reason: 'Host retention' }, { expectedVersion: 2, now, reason: 'Host retention' })
  save(retained)
  const { store } = openNativeStore(() => root)
  try {
    store.transaction(() => {
      for (let index = 0; index < 1001; index++) store.save('attention', { ...retained, id: 'aaa-foreign-' + index, summary: 'FOREIGN', scope: { ...retained.scope, principalId: 'other' } })
    })
  } finally { store.close() }
  input('current-turn')
  const result = prepareHookAttention(() => root, 'hook-thread', 'current-turn')
  assert.equal(result.items, 1)
  assert.match(result.text, /Visible owned attention/)
  assert.doesNotMatch(result.text, /FOREIGN/)
})

test('hook compilation bounds payload and requires the latest active observed turn', t => {
  const { root, now, expiresAt, create, save, input } = setup(t)
  save(persist(create('oversized', 'x'.repeat(10000)), { across: 'turns', expiresAt, budget: { bytes: 8192 }, reason: 'Host retention' }, { expectedVersion: 2, now, reason: 'Host retention' }))
  input('current-turn')
  const result = prepareHookAttention(() => root, 'hook-thread', 'current-turn')
  assert.equal(result.items, 0)
  assert.ok(Buffer.byteLength(result.text) <= 8192)
  assert.equal(prepareHookAttention(() => root, 'hook-thread', undefined).items, 0)
  ingestHook({ cwd: root, session_id: 'hook-thread', turn_id: 'current-turn', hook_event_name: 'Stop', last_assistant_message: 'Done' })
  assert.equal(prepareHookAttention(() => root, 'hook-thread', 'current-turn').delivery, 'no-active-observed-turn')
})
