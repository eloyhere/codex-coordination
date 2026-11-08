import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { workflowBindings } from '../plugins/codex-coordination/mcp/amp/workflow.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace, seedGoal } from './helpers.mjs'

const binding = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: 'test-connection', policyVersion: 'test', cancellationEpoch: 0 })
const BOOTSTRAP = 'attention_manifest_protocol_workflow_bootstrap'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const APPROVAL_SUFFIX = '. This requirement comes from AMP action policy §3.8 (host-issued approval).'

function toolsFor(root) {
  return withAmpSurface([], () => root)
}

function call(tools, name, args = {}) {
  const tool = tools.find(item => item.name === name)
  assert.ok(tool, `missing ${name}`)
  return tool.handler(args)
}

function bootstrap(tools, args) {
  return call(tools, BOOTSTRAP, args)
}

function approvals(t, options = {}) {
  const requests = []
  configureHostClient({ elicitation: {} }, message => {
    requests.push(message)
    options.onRequest?.(message)
    queueMicrotask(() => acceptHostResponse({
      id: message.id,
      result: options.decision === 'reject'
        ? { action: 'decline' }
        : { action: 'accept', content: { decision: 'approve' } },
    }))
  })
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  return requests
}

function approvalPayload(message) {
  const body = String(message.params?.message ?? '')
  assert.ok(body.endsWith(APPROVAL_SUFFIX), body)
  const marker = 'Arguments: '
  const start = body.indexOf(marker)
  assert.ok(start >= 0, body)
  return JSON.parse(body.slice(start + marker.length, body.length - APPROVAL_SUFFIX.length))
}

function threadSession(root, threadId) {
  const store = openCodexStore(root)
  try {
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(event => event.payload).find(item => item.threadId === threadId)
    assert.ok(mapping, `thread ${threadId} has a native session mapping`)
    return mapping.sessionId
  } finally { store.close() }
}

function rows(root, kind) {
  const { store } = openNativeStore(() => root)
  try { return store.list(kind).map(value => JSON.parse(JSON.stringify(value))) } finally { store.close() }
}

function events(root, kind) {
  const { store } = openNativeStore(() => root)
  try { return store.events({ kind }).map(event => JSON.parse(JSON.stringify(event.payload))) } finally { store.close() }
}

function seedThread(root, threadId, turnId, prompt) {
  ingestHook({ cwd: root, session_id: threadId, hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: threadId, turn_id: turnId, hook_event_name: 'UserPromptSubmit', prompt })
  const sessionId = threadSession(root, threadId)
  const intent = rows(root, 'intent').find(item => item.sessionId === sessionId)
  assert.ok(intent, 'host capture created a live Intent')
  return { sessionId, intent }
}

test('host-approved bootstrap accepts a live Intent and creates/activates a Mission and Goal without plans, tasks or achievement', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { sessionId, intent } = seedThread(root, 'thread-a', 'turn-a1', 'Live intent A')
  const requests = approvals(t)
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const listed = await call(tools, 'attention_manifest_protocol_intent.list')
  assert.equal(listed.origin, 'codex-live')
  assert.equal(listed.threadId, 'thread-a')
  assert.equal(listed.sessionId, sessionId)
  assert.equal(listed.total, 1)
  assert.equal(listed.entities[0].id, intent.id)
  assert.equal(listed.entities[0].state, 'captured')
  assert.equal(listed.entities[0].version, 0)

  const accepted = await bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'accept-1' })
  assert.equal(accepted.approved, true)
  assert.equal(accepted.changed, true)
  assert.equal(accepted.status, 'intent_accepted')
  assert.equal(accepted.origin, 'codex-live')
  assert.equal(accepted.threadId, 'thread-a')
  assert.equal(accepted.scope, sessionId)
  assert.equal(accepted.acceptanceGranted, false)
  assert.equal(accepted.achievementDeclared, false)
  assert.equal(accepted.planCreated, false)
  assert.equal(accepted.taskCreated, false)
  assert.equal(accepted.intent.id, intent.id)
  assert.equal(accepted.intent.sessionId, sessionId)
  assert.equal(accepted.intent.state, 'accepted')
  assert.equal(accepted.intent.version, 2)

  const missionCreated = await bootstrap(tools, { action: 'create_mission', intentId: intent.id, expectedVersion: accepted.intent.version, idempotencyKey: 'mission-1' })
  assert.equal(missionCreated.status, 'mission_proposed')
  assert.equal(missionCreated.changed, true)
  assert.match(missionCreated.mission.id, UUID)
  assert.equal(missionCreated.mission.state, 'proposed')
  assert.equal(missionCreated.mission.version, 1)
  assert.equal(missionCreated.mission.sessionId, sessionId)
  assert.equal(missionCreated.mission.intentId, intent.id)

  const missionActive = await bootstrap(tools, { action: 'activate_mission', targetId: missionCreated.mission.id, expectedVersion: missionCreated.mission.version, idempotencyKey: 'mission-active-1' })
  assert.equal(missionActive.status, 'mission_active')
  assert.equal(missionActive.mission.state, 'active')
  assert.equal(missionActive.mission.version, 2)

  const criteria = ['The live goal is active', 'No Plan or Task is created']
  const goalCreated = await bootstrap(tools, { action: 'create_goal', missionId: missionActive.mission.id, expectedVersion: missionActive.mission.version, contractVersion: 'bootstrap/1', acceptanceCriteria: criteria, idempotencyKey: 'goal-1' })
  assert.equal(goalCreated.status, 'goal_proposed')
  assert.match(goalCreated.goal.id, UUID)
  assert.equal(goalCreated.goal.state, 'proposed')
  assert.equal(goalCreated.goal.version, 1)
  assert.equal(goalCreated.goal.sessionId, sessionId)
  assert.equal(goalCreated.goal.missionId, missionActive.mission.id)
  assert.equal(goalCreated.goal.contractVersion, 'bootstrap/1')
  assert.deepEqual(goalCreated.goal.acceptanceCriteria, criteria)
  assert.equal(goalCreated.goal.validity, 'verification_pending')

  const goalActive = await bootstrap(tools, { action: 'activate_goal', targetId: goalCreated.goal.id, expectedVersion: goalCreated.goal.version, idempotencyKey: 'goal-active-1' })
  assert.equal(goalActive.status, 'goal_active')
  assert.equal(goalActive.goal.state, 'active')
  assert.equal(goalActive.goal.version, 2)
  assert.equal(goalActive.goal.validity, 'verification_pending')
  assert.equal('achievedAt' in goalActive.goal, false)
  assert.equal(goalActive.acceptanceGranted, false)
  assert.equal(goalActive.achievementDeclared, false)

  // No Plan, Task or achievement was fabricated anywhere.
  assert.deepEqual(rows(root, 'plan'), [])
  assert.deepEqual(rows(root, 'task'), [])
  assert.equal(rows(root, 'goal').length, 1)
  assert.equal(rows(root, 'goal')[0].state, 'active')
  assert.equal(rows(root, 'mission').length, 1)
  assert.equal(rows(root, 'mission')[0].state, 'active')

  // The approval payload is the exact reviewed command, including host ids.
  assert.equal(requests.length, 5)
  const payloads = requests.map(approvalPayload)
  assert.deepEqual(payloads.map(payload => payload.action), ['accept_intent', 'create_mission', 'activate_mission', 'create_goal', 'activate_goal'])
  assert.deepEqual(payloads.map(payload => payload.expectedVersion), [0, 2, 1, 2, 1])
  for (const [index, payload] of payloads.entries()) {
    assert.equal(payload.workspace, root)
    assert.equal(payload.threadId, 'thread-a')
    assert.equal(payload.reviewId, [accepted, missionCreated, missionActive, goalCreated, goalActive][index].reviewId)
    assert.ok(requests[index].params.message.includes('native-workflow-bootstrap:' + sessionId))
  }
  assert.deepEqual(payloads[0].ids, { targetId: intent.id })
  assert.deepEqual(payloads[1].ids, { intentId: intent.id, missionId: missionCreated.mission.id })
  assert.deepEqual(payloads[2].ids, { targetId: missionCreated.mission.id })
  assert.deepEqual(payloads[3].ids, { missionId: missionActive.mission.id, goalId: goalCreated.goal.id })
  assert.deepEqual(payloads[3].acceptanceCriteria, criteria)
  assert.equal(payloads[3].contractVersion, 'bootstrap/1')
  assert.deepEqual(payloads[4].ids, { targetId: goalCreated.goal.id })

  const journal = events(root, 'codex.amp.workflow.bootstrap')
  assert.equal(journal.length, 5)
  assert.ok(journal.every(item => item.approved === true && item.result.changed === true && item.result.acceptanceGranted === false && item.result.achievementDeclared === false))
})

test('a committed bootstrap action replays its exact result without asking approval twice', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { intent } = seedThread(root, 'thread-a', 'turn-a1', 'Idempotent intent')
  const requests = approvals(t)
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const input = { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'idem-1' }
  const first = await bootstrap(tools, input)
  assert.equal(first.approved, true)
  assert.equal(requests.length, 1)
  const second = await bootstrap(tools, input)
  assert.equal(second.replayed, true)
  assert.equal(second.reviewId, first.reviewId)
  assert.equal(second.intent.id, first.intent.id)
  assert.equal(second.intent.state, 'accepted')
  assert.equal(second.intent.version, first.intent.version)
  assert.equal(requests.length, 1)
  // Same key with a different request is rejected rather than silently replayed.
  await assert.rejects(bootstrap(tools, { ...input, expectedVersion: 99 }), /another workflow bootstrap request/)
  assert.equal(requests.length, 1)
  const intentRows = rows(root, 'intent')
  assert.equal(intentRows.length, 1)
  assert.equal(intentRows[0].state, 'accepted')
  assert.equal(intentRows[0].version, 2)
})

test('denied approval changes nothing and is durably replayed without a second prompt', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { intent } = seedThread(root, 'thread-a', 'turn-a1', 'Denied intent')
  const requests = approvals(t, { decision: 'reject' })
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const input = { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'deny-1' }
  const denied = await bootstrap(tools, input)
  assert.equal(denied.approved, false)
  assert.equal(denied.changed, false)
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.acceptanceGranted, false)
  assert.equal(requests.length, 1)
  assert.equal(rows(root, 'intent')[0].state, 'captured')
  assert.equal(rows(root, 'intent')[0].version, 0)
  const replay = await bootstrap(tools, input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.approved, false)
  assert.equal(replay.status, 'rejected')
  assert.equal(requests.length, 1)
  const journal = events(root, 'codex.amp.workflow.bootstrap')
  assert.equal(journal.length, 1)
  assert.equal(journal[0].approved, false)
  assert.equal(journal[0].result.status, 'rejected')
})

test('an imported snapshot selection rejects bootstrap before any approval', async t => {
  const root = makeWorkspace(t)
  await seedGoal(root, 'imported-goal')
  const { intent } = seedThread(root, 'thread-a', 'turn-a1', 'Live intent behind import')
  const tools = toolsFor(root)
  const preview = await call(tools, 'attention_manifest_protocol_migration', { action: 'preview' })
  await call(tools, 'attention_manifest_protocol_migration', { action: 'import', sourceDigest: preview.sourceDigest })
  await call(tools, 'attention_manifest_protocol_workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const requests = approvals(t)
  await assert.rejects(
    bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'imported-1' }),
    /bootstrap requires a live Codex thread/,
  )
  assert.equal(requests.length, 0)
  assert.equal(rows(root, 'intent').find(item => item.id === intent.id).state, 'captured')
})

test('wrong expected versions and wrong source states reject before approval', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { intent } = seedThread(root, 'thread-a', 'turn-a1', 'State gate intent')
  const requests = approvals(t)
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })

  await assert.rejects(bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: 0, idempotencyKey: 'spoofed-identity', sessionId: 'forged' }), /bound by the host/)
  await assert.rejects(bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: 1, idempotencyKey: 'wrong-version' }), /version changed/)
  await assert.rejects(bootstrap(tools, { action: 'create_mission', intentId: intent.id, expectedVersion: 0, idempotencyKey: 'too-early' }), /accepted Intent/)
  assert.equal(requests.length, 0)

  const accepted = await bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: 0, idempotencyKey: 'accept-gate' })
  assert.equal(requests.length, 1)
  await assert.rejects(bootstrap(tools, { action: 'create_mission', intentId: intent.id, expectedVersion: 1, idempotencyKey: 'stale-intent' }), /version changed/)
  assert.equal(requests.length, 1)

  const mission = await bootstrap(tools, { action: 'create_mission', intentId: intent.id, expectedVersion: accepted.intent.version, idempotencyKey: 'mission-gate' })
  assert.equal(requests.length, 2)
  await assert.rejects(bootstrap(tools, { action: 'create_goal', missionId: mission.mission.id, expectedVersion: mission.mission.version, contractVersion: 'gate/1', acceptanceCriteria: ['x'], idempotencyKey: 'goal-too-early' }), /active Mission/)
  await assert.rejects(bootstrap(tools, { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: 0, idempotencyKey: 'stale-mission' }), /version changed/)
  assert.equal(requests.length, 2)

  const activeMission = await bootstrap(tools, { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: mission.mission.version, idempotencyKey: 'mission-active-gate' })
  assert.equal(requests.length, 3)
  await assert.rejects(bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'gate/1', acceptanceCriteria: [], idempotencyKey: 'no-criteria' }), /1-20/)
  await assert.rejects(bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'gate/1', acceptanceCriteria: Array.from({ length: 21 }, (_, index) => `criterion ${index}`), idempotencyKey: 'too-many-criteria' }), /1-20/)
  await assert.rejects(bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'gate/1', acceptanceCriteria: ['   '], idempotencyKey: 'blank-criteria' }), /nonempty/)
  await assert.rejects(bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: '', acceptanceCriteria: ['x'], idempotencyKey: 'blank-contract' }), /contractVersion/)
  assert.equal(requests.length, 3)

  const goal = await bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'gate/1', acceptanceCriteria: ['x'], idempotencyKey: 'goal-gate' })
  assert.equal(requests.length, 4)
  await assert.rejects(bootstrap(tools, { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: 0, idempotencyKey: 'stale-goal' }), /version changed/)
  assert.equal(requests.length, 4)
  const activeGoal = await bootstrap(tools, { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: 'goal-active-gate' })
  assert.equal(requests.length, 5)
  assert.equal(activeGoal.goal.state, 'active')
  assert.equal(activeGoal.goal.validity, 'verification_pending')
})

test('selecting one live thread cannot target another thread Intent, Mission or Goal', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const a = seedThread(root, 'thread-a', 'turn-a1', 'Only A')
  const b = seedThread(root, 'thread-b', 'turn-b1', 'Only B')
  assert.notEqual(a.sessionId, b.sessionId)
  const requests = approvals(t)
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })

  await assert.rejects(bootstrap(tools, { action: 'accept_intent', targetId: b.intent.id, expectedVersion: b.intent.version, idempotencyKey: 'cross-intent' }), /outside the selected live thread/)
  assert.equal(requests.length, 0)

  const accepted = await bootstrap(tools, { action: 'accept_intent', targetId: a.intent.id, expectedVersion: a.intent.version, idempotencyKey: 'a-accept' })
  const mission = await bootstrap(tools, { action: 'create_mission', intentId: a.intent.id, expectedVersion: accepted.intent.version, idempotencyKey: 'a-mission' })
  const activeMission = await bootstrap(tools, { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: mission.mission.version, idempotencyKey: 'a-mission-active' })
  const goal = await bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'cross/1', acceptanceCriteria: ['only A'], idempotencyKey: 'a-goal' })
  assert.equal(requests.length, 4)

  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-b' })
  await assert.rejects(bootstrap(tools, { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: 'cross-goal' }), /outside the selected live thread/)
  await assert.rejects(bootstrap(tools, { action: 'activate_mission', targetId: activeMission.mission.id, expectedVersion: activeMission.mission.version, idempotencyKey: 'cross-mission' }), /outside the selected live thread/)
  await assert.rejects(bootstrap(tools, { action: 'accept_intent', targetId: a.intent.id, expectedVersion: accepted.intent.version, idempotencyKey: 'cross-accepted-intent' }), /outside the selected live thread/)
  assert.equal(requests.length, 4)
  assert.equal(rows(root, 'goal').find(item => item.id === goal.goal.id).state, 'proposed')
  assert.equal(rows(root, 'mission').find(item => item.id === activeMission.mission.id).state, 'active')
})

test('a workflow changed during approval returns stale_after_approval and commits nothing', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { sessionId, intent } = seedThread(root, 'thread-a', 'turn-a1', 'Stale intent')
  const requests = approvals(t, { onRequest() {
    const { store } = openNativeStore(() => root)
    try {
      store.transaction(() => {
        const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
        assert.deepEqual(persistence.restoreAll().skipped, [])
        const session = persistence.workflow.get('session', sessionId)
        persistence.transition('session', sessionId, 'idle', { expectedVersion: session.version, actor: 'concurrent-host', reason: 'mutate during approval' })
      })
    } finally { store.close() }
  } })
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const input = { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'stale-1' }
  const stale = await bootstrap(tools, input)
  assert.equal(stale.approved, true)
  assert.equal(stale.changed, false)
  assert.equal(stale.status, 'stale_after_approval')
  assert.equal(requests.length, 1)
  assert.equal(rows(root, 'intent').find(item => item.id === intent.id).state, 'captured')
  assert.equal(rows(root, 'intent').find(item => item.id === intent.id).version, 0)
  assert.equal(rows(root, 'session').find(item => item.id === sessionId).state, 'idle')
  const replay = await bootstrap(tools, input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.status, 'stale_after_approval')
  assert.equal(requests.length, 1)
  const journal = events(root, 'codex.amp.workflow.bootstrap')
  assert.equal(journal.length, 1)
  assert.equal(journal[0].result.status, 'stale_after_approval')
  assert.equal(journal[0].result.changed, false)
})

test('canonical live mission and goal reads expose the bootstrapped entities', async t => {
  const root = makeWorkspace(t)
  const tools = toolsFor(root)
  const { sessionId, intent } = seedThread(root, 'thread-a', 'turn-a1', 'Readable live chain')
  approvals(t)
  await call(tools, 'attention_manifest_protocol_session.get', { threadId: 'thread-a' })
  const accepted = await bootstrap(tools, { action: 'accept_intent', targetId: intent.id, expectedVersion: intent.version, idempotencyKey: 'read-accept' })
  const mission = await bootstrap(tools, { action: 'create_mission', intentId: intent.id, expectedVersion: accepted.intent.version, idempotencyKey: 'read-mission' })
  const activeMission = await bootstrap(tools, { action: 'activate_mission', targetId: mission.mission.id, expectedVersion: mission.mission.version, idempotencyKey: 'read-mission-active' })
  const goal = await bootstrap(tools, { action: 'create_goal', missionId: activeMission.mission.id, expectedVersion: activeMission.mission.version, contractVersion: 'read/1', acceptanceCriteria: ['readable criterion'], idempotencyKey: 'read-goal' })
  const activeGoal = await bootstrap(tools, { action: 'activate_goal', targetId: goal.goal.id, expectedVersion: goal.goal.version, idempotencyKey: 'read-goal-active' })

  const reads = workflowBindings(binding, () => root, new Map(), () => 'thread-a')
  const read = (name, args = {}) => reads.find(tool => tool.name === name).handler(args)
  const missionRead = await read('attention_manifest_protocol_mission.get', { id: activeMission.mission.id })
  assert.equal(missionRead.origin, 'codex-live')
  assert.equal(missionRead.threadId, 'thread-a')
  assert.equal(missionRead.scope, sessionId)
  assert.equal(missionRead.entity.id, activeMission.mission.id)
  assert.equal(missionRead.entity.state, 'active')
  assert.equal(missionRead.entity.version, 2)

  const goalRead = await read('attention_manifest_protocol_goal.get', { id: activeGoal.goal.id })
  assert.equal(goalRead.origin, 'codex-live')
  assert.equal(goalRead.threadId, 'thread-a')
  assert.equal(goalRead.entity.id, activeGoal.goal.id)
  assert.equal(goalRead.entity.state, 'active')
  assert.equal(goalRead.entity.version, 2)
  assert.equal(goalRead.entity.validity, 'verification_pending')
  assert.deepEqual(goalRead.entity.acceptanceCriteria, ['readable criterion'])

  const goals = await read('attention_manifest_protocol_goal.list')
  assert.equal(goals.origin, 'codex-live')
  assert.equal(goals.total, 1)
  assert.equal(goals.entities[0].id, activeGoal.goal.id)
})
