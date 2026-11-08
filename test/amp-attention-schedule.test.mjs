import test from 'node:test'
import assert from 'node:assert/strict'
import { createAttention } from 'attention-manifest-protocol/attention'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { attentionScheduleBinding } from '../plugins/codex-coordination/mcp/amp/attention-schedule.mjs'
import { scopeCallback } from '../plugins/codex-coordination/mcp/amp/workflow.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: 'schedule-connection', policyVersion: 'test', cancellationEpoch: 0 })
const DELIVERY = 'read-only routing preview; no mount, retention, persistence or hidden context injection'

/** Resolve the native Session and latest native Turn captured for one observed thread. */
function nativeIds(root, threadId) {
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(item => item.payload).find(item => item.threadId === threadId)
    assert.ok(mapping, `SessionStart must map ${threadId} to a native session`)
    const turns = persistence.workflow.list('turn', mapping.sessionId)
    return { sessionId: mapping.sessionId, turnId: turns.at(-1)?.id }
  } finally { store.close() }
}

/** Persist one valid AttentionObject for the routing fixture. */
function saveAttention(root, { id, sessionId, turnId, scores, expiresAt, stale, scope }) {
  const now = new Date().toISOString()
  const object = createAttention({
    id,
    summary: `Attention ${id}`,
    pointer: { kind: 'session', id: sessionId, version: '1' },
    scope: { tenantId: 'local', principalId: 'codex', sessionId, turnId, ...scope },
    scores,
    budget: { bytes: 4096 },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    reason: 'Host test fixture',
  }, now)
  // createAttention refuses already-expired input; the fixture mutates the valid
  // result instead so the scheduler classifies the real stored row.
  const stored = { ...object, ...(expiresAt === undefined ? {} : { expiresAt }), ...(stale === undefined ? {} : { stale }) }
  const { store } = openNativeStore(() => root)
  try { store.save('attention', stored) } finally { store.close() }
}

/** Durable attention rows plus event count, used to prove the preview is read-only. */
function storeSnapshot(root) {
  const { store } = openNativeStore(() => root)
  try {
    return {
      events: store.events().length,
      attention: store.list('attention').map(row => ({ id: row.id, version: row.version, mounted: row.mounted, stale: row.stale, retention: row.retention ?? null })).sort((left, right) => left.id.localeCompare(right.id)),
    }
  } finally { store.close() }
}

test('attention schedule rejects model-bound identity and out-of-range bounds before resolving scope', async t => {
  const root = makeWorkspace(t)
  let scopeCalls = 0
  const tool = attentionScheduleBinding(binding, () => root, () => { scopeCalls += 1; return undefined })

  await assert.rejects(tool.handler({ tenantId: 'local' }), /bound by the host/)
  await assert.rejects(tool.handler({ scope: { sessionId: 'forged' } }), /bound by the host/)
  await assert.rejects(tool.handler({ stage: 'unknown' }), /Unknown attention stage/)
  await assert.rejects(tool.handler({ maxSelected: 0 }), /maxSelected must be 1-50/)
  await assert.rejects(tool.handler({ maxSelected: 51 }), /maxSelected must be 1-50/)
  await assert.rejects(tool.handler({ maxSelected: 1.5 }), /maxSelected must be 1-50/)
  await assert.rejects(tool.handler({ maxSelected: '20' }), /maxSelected must be 1-50/)
  await assert.rejects(tool.handler({ maxBytes: 0 }), /maxBytes must be 1-32768/)
  await assert.rejects(tool.handler({ maxBytes: 32769 }), /maxBytes must be 1-32768/)
  await assert.rejects(tool.handler({ maxBytes: '1024' }), /maxBytes must be 1-32768/)
  await assert.rejects(tool.handler({ surprise: true }), /Unknown attention schedule parameter/)
  assert.equal(scopeCalls, 0, 'invalid arguments never reach the native workflow')
})

test('attention schedule fails closed without a host selection or a durable native turn', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'schedule-live', hook_event_name: 'SessionStart' })
  let seenRoot
  let seenStore
  const unselected = attentionScheduleBinding(binding, () => root, (rootArg, store) => { seenRoot = rootArg; seenStore = store; return undefined })
  await assert.rejects(unselected.handler({}), /Select a native workflow before routing attention/)
  assert.equal(typeof seenRoot, 'string')
  assert.ok(seenStore && typeof seenStore.close === 'function', 'the scope callback receives the already-open Store')

  const live = attentionScheduleBinding(binding, () => root, scopeCallback(new Map(), () => 'schedule-live'))
  await assert.rejects(live.handler({}), /durable turn/)
})

test('attention schedule routes scoped attention into the derived stage and stays read-only', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'schedule-live', hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'schedule-live', turn_id: 'codex-live-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Route my attention' })
  const { sessionId, turnId } = nativeIds(root, 'schedule-live')
  assert.ok(turnId)
  saveAttention(root, { id: 'focus-high', sessionId, turnId, scores: { relevance: 0.9 } })
  saveAttention(root, { id: 'focus-low', sessionId, turnId, scores: { relevance: 0.1 } })
  saveAttention(root, { id: 'expired', sessionId, turnId, expiresAt: '2000-01-01T00:00:00Z' })
  saveAttention(root, { id: 'stale', sessionId, turnId, stale: true })
  saveAttention(root, { id: 'other-turn', sessionId, turnId: 'different-turn' })
  saveAttention(root, { id: 'other-principal', sessionId, turnId, scope: { principalId: 'someone-else' } })
  saveAttention(root, { id: 'other-session', sessionId: 'different-session', turnId })

  const tool = attentionScheduleBinding(binding, () => root, scopeCallback(new Map(), () => 'schedule-live'))
  const before = storeSnapshot(root)
  const result = await tool.handler({ maxSelected: 1, maxBytes: 1024 })

  assert.equal(result.scope.tenantId, 'local')
  assert.equal(result.scope.principalId, 'codex')
  assert.equal(result.scope.sessionId, sessionId)
  assert.equal(result.scope.turnId, turnId)
  assert.equal(result.stage, 'parse')
  assert.equal(result.previousStage, null)
  assert.equal(result.profile.stage, 'parse')
  assert.equal(result.signals.inputReceived, true)
  assert.equal(result.candidates, 5)
  assert.deepEqual(result.selected.map(item => item.id), ['focus-high'])
  assert.equal(result.selected[0].reason, 'rank')
  assert.ok(result.selected[0].score > 1)
  assert.equal(result.selected[0].pointer.kind, 'session')
  const reasons = new Map(result.deferred.map(item => [item.id, item.reason]))
  assert.equal(reasons.get('focus-low'), 'top_n')
  assert.equal(reasons.get('expired'), 'expired')
  assert.equal(reasons.get('stale'), 'stale')
  assert.equal(reasons.get('other-turn'), 'scope')
  assert.deepEqual(result.suppressed, [])
  assert.equal(result.usage.calls, 2)
  assert.equal(result.decision.action, 'route')
  assert.equal(result.decision.budget.bytes, 1024)
  assert.equal(result.decisionLog.length, 1)
  assert.equal(result.decisionLog[0].action, 'route')
  assert.equal(result.decisionLog[0].authorization, 'not_granted')
  assert.equal(result.authorization, 'not_granted')
  assert.equal(result.delivery, DELIVERY)
  assert.deepEqual(result.transitions, ['receive', 'strategy', 'respond'])
  assert.equal(result.limitations.length, 3)

  // An explicit stage and a wider selection cap keep the same read-only shape.
  const verify = await tool.handler({ stage: 'verify', maxSelected: 50, maxBytes: 32768 })
  assert.equal(verify.stage, 'verify')
  assert.equal(verify.previousStage, null)
  assert.deepEqual(verify.transitions, ['execute', 'diagnose', 'respond'])
  assert.deepEqual(verify.selected.map(item => item.id), ['focus-high', 'focus-low'])
  assert.equal(verify.decision.budget.bytes, 32768)

  assert.deepEqual(storeSnapshot(root), before, 'routing must not mount, retain, persist or journal anything')
})

test('an explicitly selected imported workflow wins over the live thread and fails closed when suspended', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'schedule-live', hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'schedule-live', turn_id: 'codex-live-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Live prompt must not replace the selected import' })
  const imported = 'imported-schedule-session'
  const { store } = openNativeStore(() => root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    let session = persistence.create('session', { id: imported, sessionId: imported, participants: ['test-host'], sessionType: 'autonomous' }, 'test-host')
    session = persistence.transition('session', imported, 'active', { expectedVersion: session.version, actor: 'test-host' })
    persistence.create('turn', { id: imported + '-turn', sessionId: imported, classification: 'new_intent' }, 'test-host')
    persistence.transition('session', imported, 'suspended', { expectedVersion: session.version, actor: 'test-host' })
  } finally { store.close() }

  const importedTool = attentionScheduleBinding(binding, () => root, scopeCallback(new Map([[root, imported]]), () => 'schedule-live'))
  await assert.rejects(importedTool.handler({}), /Resume the selected workflow/)

  const liveTool = attentionScheduleBinding(binding, () => root, scopeCallback(new Map(), () => 'schedule-live'))
  const preview = await liveTool.handler({})
  assert.notEqual(preview.scope.sessionId, imported)
  assert.equal(preview.scope.sessionId, nativeIds(root, 'schedule-live').sessionId)
})
