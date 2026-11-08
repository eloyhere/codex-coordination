import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { workflowBindings } from '../plugins/codex-coordination/mcp/amp/workflow.mjs'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { makeWorkspace, seedGoal } from './helpers.mjs'

const binding = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: 'test-connection', policyVersion: 'test', cancellationEpoch: 0 })

function callsFor(root, threadForRoot) {
  const tools = workflowBindings(binding, () => root, new Map(), threadForRoot)
  return (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
}

function nativeSessionId(root, threadId) {
  const store = openCodexStore(root)
  try {
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(item => item.payload).find(item => item.threadId === threadId)
    assert.ok(mapping, `SessionStart must map ${threadId} to a native session`)
    return mapping.sessionId
  } finally { store.close() }
}

/** Seed a complete live chain up to a pending Task under an active live Session. */
function seedLiveTask(root, sessionId, prefix = 'live-task') {
  const store = openCodexStore(root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    let turn = persistence.create('turn', { id: prefix + '-turn', sessionId, classification: 'new_intent' }, 'test-host')
    turn = persistence.transition('turn', turn.id, 'interpreting', { expectedVersion: turn.version, actor: 'test-host' })
    let intent = persistence.create('intent', { id: prefix + '-intent', sessionId, originTurnId: turn.id, text: 'Seed live task chain' }, 'test-host')
    intent = persistence.transition('intent', intent.id, 'confirmed', { expectedVersion: intent.version, actor: 'test-host' })
    intent = persistence.transition('intent', intent.id, 'accepted', { expectedVersion: intent.version, actor: 'test-host' })
    persistence.create('mission', { id: prefix + '-mission', sessionId, intentId: intent.id }, 'test-host')
    let goal = persistence.create('goal', { id: prefix + '-goal', sessionId, missionId: prefix + '-mission', contractVersion: 'test/1', acceptanceCriteria: ['seed'] }, 'test-host')
    goal = persistence.transition('goal', goal.id, 'active', { expectedVersion: goal.version, actor: 'test-host' })
    persistence.create('plan', { id: prefix + '-plan', sessionId, goalId: goal.id, bounds: { maxAttempts: 1, deadline: new Date(Date.now() + 3600000).toISOString(), progressMetric: 'seed', deadLetterOwner: 'test-host' } }, 'test-host')
    return persistence.create('task', { id: prefix + '-task', sessionId, planId: prefix + '-plan', contractVersion: 'test/1', dependsOn: [], required: false, requiredEffects: [] }, 'test-host').id
  } finally { store.close() }
}

/** Seed a suspended, imported-looking session with one goal but no live selection. */
function seedForeignGoal(root, prefix = 'foreign') {
  const sessionId = prefix + '-session'
  const store = openCodexStore(root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    let session = persistence.create('session', { id: sessionId, sessionId, participants: ['test-host'], sessionType: 'autonomous' }, 'test-host')
    session = persistence.transition('session', sessionId, 'active', { expectedVersion: session.version, actor: 'test-host' })
    let turn = persistence.create('turn', { id: prefix + '-turn', sessionId, classification: 'new_intent' }, 'test-host')
    turn = persistence.transition('turn', turn.id, 'interpreting', { expectedVersion: turn.version, actor: 'test-host' })
    let intent = persistence.create('intent', { id: prefix + '-intent', sessionId, originTurnId: turn.id, text: 'Foreign imported fixture' }, 'test-host')
    intent = persistence.transition('intent', intent.id, 'confirmed', { expectedVersion: intent.version, actor: 'test-host' })
    intent = persistence.transition('intent', intent.id, 'accepted', { expectedVersion: intent.version, actor: 'test-host' })
    persistence.create('mission', { id: prefix + '-mission', sessionId, intentId: intent.id }, 'test-host')
    persistence.create('goal', { id: prefix + '-goal', sessionId, missionId: prefix + '-mission', contractVersion: 'test/1', acceptanceCriteria: ['foreign'] }, 'test-host')
    persistence.transition('session', sessionId, 'suspended', { expectedVersion: persistence.workflow.get('session', sessionId).version, actor: 'test-host' })
    return { sessionId, goalId: prefix + '-goal', missionId: prefix + '-mission' }
  } finally { store.close() }
}

test('a live thread selected with session.get exposes host-captured Intents with live provenance', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'thread-a', hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'thread-a', turn_id: 'turn-a1', hook_event_name: 'UserPromptSubmit', prompt: 'Live intent A' })
  const call = callsFor(root, () => 'thread-a')
  const listed = await call('intent.list')
  assert.equal(listed.origin, 'codex-live')
  assert.equal(listed.threadId, 'thread-a')
  assert.equal(listed.sessionId, nativeSessionId(root, 'thread-a'))
  assert.equal(listed.total, 1)
  assert.equal(listed.entities[0].text, 'Live intent A')
  assert.equal(listed.entities[0].state, 'captured')
  const got = await call('intent.get', { id: listed.entities[0].id })
  assert.equal(got.origin, 'codex-live')
  assert.equal(got.threadId, 'thread-a')
  assert.equal(got.sessionId, listed.sessionId)
  assert.equal(got.entity.id, listed.entities[0].id)
  // The audit journal records the resolved origin and the live thread.
  const store = openCodexStore(root)
  try {
    const audit = store.events({ kind: 'codex.amp.workflow.call' }).map(item => item.payload).at(-1)
    assert.equal(audit.workflowOrigin, 'codex-live')
    assert.equal(audit.threadId, 'thread-a')
  } finally { store.close() }
  // The surface wiring selects the observed thread after a successful session.get.
  const surface = withAmpSurface([], () => root)
  const surfaceCall = (name, args = {}) => surface.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  assert.equal((await surfaceCall('session.get', { threadId: 'thread-a' })).threadId, 'thread-a')
  const fromSurface = await surfaceCall('intent.list')
  assert.equal(fromSurface.origin, 'codex-live')
  assert.equal(fromSurface.threadId, 'thread-a')
  assert.equal(fromSurface.total, 1)
})

test('live reads return normal missing/empty results and never leak another workflow', async t => {
  const root = makeWorkspace(t)
  for (const thread of ['thread-empty', 'thread-task']) ingestHook({ cwd: root, session_id: thread, hook_event_name: 'SessionStart' })
  const taskId = seedLiveTask(root, nativeSessionId(root, 'thread-task'))
  const foreign = seedForeignGoal(root)
  let thread = 'thread-empty'
  const call = callsFor(root, () => thread)

  await assert.rejects(call('mission.get', { id: 'missing-mission' }), /does not exist/)
  await assert.rejects(call('mission.get', { id: foreign.missionId }), /outside the selected workflow scope/)
  const goals = await call('goal.list')
  assert.deepEqual(goals.entities, [])
  assert.equal(goals.total, 0)
  assert.equal(goals.origin, 'codex-live')
  assert.equal(goals.threadId, 'thread-empty')
  assert.equal(goals.sessionId, nativeSessionId(root, 'thread-empty'))

  thread = 'thread-task'
  const actions = await call('action.list', { taskId })
  assert.deepEqual(actions.attempts, [])
  assert.equal(actions.total, 0)
  assert.equal(actions.origin, 'codex-live')
  assert.equal(actions.threadId, 'thread-task')
  const mission = await call('mission.get', { id: 'live-task-mission' })
  assert.equal(mission.origin, 'codex-live')
  assert.equal(mission.threadId, 'thread-task')
  assert.equal(mission.entity.id, 'live-task-mission')
  const goal = await call('goal.get', { id: 'live-task-goal' })
  assert.equal(goal.entity.id, 'live-task-goal')
  const plans = await call('plan.list')
  assert.equal(plans.total, 1)
  assert.equal(plans.entities[0].id, 'live-task-plan')
  assert.equal(plans.origin, 'codex-live')
  const job = await call('task.get', { id: taskId })
  assert.equal(job.entity.id, taskId)
  assert.equal(job.origin, 'codex-live')
  const planReady = await call('plan.ready_tasks', { id: 'live-task-plan' })
  assert.deepEqual(planReady.tasks, [])
  assert.equal(planReady.origin, 'codex-live')
  const ready = await call('task.list_ready')
  assert.deepEqual(ready.tasks, [])
  assert.equal(ready.sessionState, 'active')
  assert.equal(ready.origin, 'codex-live')
  assert.equal(ready.executionAuthorized, false)
})

test('two live threads in one workspace stay isolated', async t => {
  const root = makeWorkspace(t)
  for (const thread of ['thread-a', 'thread-b']) ingestHook({ cwd: root, session_id: thread, hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'thread-a', turn_id: 'turn-a1', hook_event_name: 'UserPromptSubmit', prompt: 'Only A' })
  ingestHook({ cwd: root, session_id: 'thread-b', turn_id: 'turn-b1', hook_event_name: 'UserPromptSubmit', prompt: 'Only B' })
  let thread = 'thread-a'
  const call = callsFor(root, () => thread)
  const a = await call('intent.list')
  assert.equal(a.total, 1)
  assert.equal(a.entities[0].text, 'Only A')
  assert.equal(a.threadId, 'thread-a')
  assert.equal(a.sessionId, nativeSessionId(root, 'thread-a'))

  thread = 'thread-b'
  const b = await call('intent.list')
  assert.equal(b.total, 1)
  assert.equal(b.entities[0].text, 'Only B')
  assert.equal(b.threadId, 'thread-b')
  assert.equal(b.sessionId, nativeSessionId(root, 'thread-b'))
  assert.notEqual(a.sessionId, b.sessionId)
  const taskA = seedLiveTask(root, nativeSessionId(root, 'thread-a'), 'thread-a-task')
  await assert.rejects(call('intent.get', { id: a.entities[0].id }), /outside the selected workflow scope/)
  await assert.rejects(call('action.list', { taskId: taskA }), /Task is outside the selected workflow scope/)
})

test('reads with no selected thread and no imported scope reject with the selection error', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'thread-unselected', hook_event_name: 'SessionStart' })
  const tools = workflowBindings(binding, () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  await assert.rejects(call('goal.list'), /Select an imported native workflow/)
  await assert.rejects(call('intent.list'), /observed Codex thread with attention_manifest_protocol_session\.get/)
  await assert.rejects(call('task.list_ready'), /Select an imported native workflow/)
  // The failed calls still reach the gateway journal; a missing scope is
  // recorded explicitly and never throws from onCall.
  const store = openCodexStore(root)
  try {
    const audits = store.events({ kind: 'codex.amp.workflow.call' }).map(item => item.payload)
    assert.equal(audits.length, 3)
    assert.ok(audits.every(audit => audit.workflowOrigin === null && audit.workflowScope === null))
  } finally { store.close() }
})

test('an explicitly selected imported snapshot wins over a selected live thread', async t => {
  const root = makeWorkspace(t)
  await seedGoal(root, 'imported-goal')
  ingestHook({ cwd: root, session_id: 'thread-live', hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'thread-live', turn_id: 'turn-live', hook_event_name: 'UserPromptSubmit', prompt: 'Live prompt must not leak into imported reads' })
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const preview = await call('migration', { action: 'preview' })
  const imported = await call('migration', { action: 'import', sourceDigest: preview.sourceDigest })
  await call('workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  assert.equal((await call('session.get', { threadId: 'thread-live' })).threadId, 'thread-live')

  const goals = await call('goal.list')
  assert.equal(goals.origin, 'native-plugin-workflow')
  assert.equal(goals.scope, imported.sessionId)
  assert.equal(goals.entities.length, 1)
  assert.equal(goals.entities[0].id, imported.references['goal:imported-goal'])
  assert.equal('threadId' in goals, false)

  const intents = await call('intent.list')
  assert.equal(intents.origin, 'native-plugin-workflow')
  assert.equal(intents.scope, imported.sessionId)
  assert.ok(intents.entities.every(entity => entity.sessionId === imported.sessionId))
  assert.equal(intents.entities.some(entity => entity.text === 'Live prompt must not leak into imported reads'), false)
})
