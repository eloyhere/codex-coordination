import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionBindings } from '../plugins/codex-coordination/mcp/amp/attention.mjs'
import { ingestHook, readCodexThread } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { createAttention, mount } from 'attention-manifest-protocol/attention'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test', cancellationEpoch: 0 }

test('native attention context uses actual host scope and enforces mount, expiry, version and byte bounds', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'attention-thread', hook_event_name: 'SessionStart' })
  const tools = attentionBindings(binding, () => root)
  const context = args => tools.find(tool => tool.name.endsWith('.context')).handler({ threadId: 'attention-thread', ...args })
  await assert.rejects(context(), /No active Codex turn/)
  ingestHook({ cwd: root, session_id: 'attention-thread', turn_id: 'actual-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Inspect context' })
  const session = readCodexThread(() => root, 'attention-thread').nativeSession
  const now = new Date().toISOString()
  const base = { summary: 'Actual scoped session context', pointer: { kind: 'session', id: session.id, version: String(session.version) }, scope: { tenantId: 'local', principalId: 'codex', sessionId: session.id, turnId: 'actual-turn' }, budget: { bytes: 32768 }, expiresAt: new Date(Date.now() + 3600000).toISOString(), reason: 'Host fixture selected current session' }
  const save = object => { const { store } = openNativeStore(() => root); try { store.save('attention', object) } finally { store.close() } }
  const active = mount(createAttention({ ...base, id: 'active' }, now), { expectedVersion: 1, now, reason: 'Host fixture mounted reference' })
  save(active)
  save(createAttention({ ...base, id: 'unmounted' }, now))
  save({ ...active, id: 'expired', expiresAt: '2000-01-01T00:00:00Z' })
  save({ ...active, id: 'stale', stale: true })
  save({ ...active, id: 'foreign', scope: { ...active.scope, principalId: 'different' } })
  save({ ...active, id: 'foreign-pointer', pointer: { kind: 'attention', id: 'foreign', version: String(active.version) } })
  const result = await context()
  assert.deepEqual(result.compiled.items.map(item => item.id), ['active'])
  assert.deepEqual(result.compiled.exclusions.map(item => item.reason).sort(), ['expired', 'stale', 'unmounted', 'version'])
  assert.equal(result.compiled.scope.turnId, 'actual-turn')
  assert.equal(result.compiled.scope.sessionId, session.id)
  assert.equal(result.compiled.authorization, 'not_granted')
  assert.match(result.delivery, /no hidden/)
  assert.equal((await context({ maxBytes: 1 })).compiled.items.length, 0)
  assert.equal((await context({ maxBytes: 1 })).compiled.exclusions.find(item => item.id === 'active').reason, 'budget')
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() }); persistence.restoreAll()
    persistence.transition('session', session.id, 'idle', { expectedVersion: session.version, actor: 'test-host' })
  } finally { store.close() }
  assert.equal((await context()).compiled.exclusions.find(item => item.id === 'active').reason, 'version')
  ingestHook({ cwd: root, session_id: 'attention-thread', turn_id: 'actual-turn', hook_event_name: 'Stop', last_assistant_message: 'Done' })
  await assert.rejects(context(), /No active Codex turn/)
})

test('attention reads cannot cross thread, principal or workspace boundaries', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  for (const id of ['one', 'two']) ingestHook({ cwd: root, session_id: id, hook_event_name: 'SessionStart' })
  const session = readCodexThread(() => root, 'one').nativeSession
  const object = createAttention({ id: 'owned', summary: 'Owned metadata', pointer: { kind: 'session', id: session.id, version: String(session.version) }, scope: { tenantId: 'local', principalId: 'codex', sessionId: session.id, turnId: 'historical-turn' }, budget: { bytes: 4096 }, expiresAt: new Date(Date.now() + 3600000).toISOString(), reason: 'Fixture host metadata' }, new Date().toISOString())
  const { store } = openNativeStore(() => root); try { store.save('attention', object) } finally { store.close() }
  const get = (selected, identity = binding) => attentionBindings(identity, () => selected).find(tool => tool.name.endsWith('.get'))
  assert.equal((await get(root).handler({ threadId: 'one', id: 'owned' })).object.summary, object.summary)
  await assert.rejects(get(root).handler({ threadId: 'two', id: 'owned' }), /not visible/)
  await assert.rejects(get(root, { ...binding, principalId: 'different' }).handler({ threadId: 'one', id: 'owned' }), /not visible/)
  await assert.rejects(get(other).handler({ threadId: 'one', id: 'owned' }), /not been observed/)
  await assert.rejects(get(root).handler({ threadId: 'one', id: 'owned', sessionId: session.id }))
})
