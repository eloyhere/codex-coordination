import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { ingestHook, readCodexThread } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { makeWorkspace } from './helpers.mjs'

const POLICY_VERSION = 'codex-hook/live-v1'
const keyOf = (threadId, turnId) => createHash('sha256').update(threadId + '\0' + turnId).digest('hex')

/** Reopened, read-only view of the project's native workflow plus host observations. */
function inspect(root) {
  const store = openCodexStore(root)
  try {
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    const report = persistence.restoreAll()
    const events = store.events()
    const ofKind = kind => events.filter(item => item.kind === kind)
    return {
      report,
      turns: persistence.workflow.list('turn'),
      intents: persistence.workflow.list('intent'),
      snapshot: persistence.workflow.snapshot(),
      live: ofKind('codex.amp.live_workflow').map(item => item.payload),
      errors: ofKind('codex.amp.live_workflow.error').map(item => item.payload),
      hooks: ofKind('codex.sync.hook').map(item => item.payload),
      mapping: ofKind('codex.sync.session_mapping').map(item => item.payload),
      workflowEvents: events.filter(item => /^(session|turn|intent)\.(created|transitioned)$/.test(item.kind)),
    }
  } finally { store.close() }
}

test('UserPromptSubmit creates exactly one host-classified Turn and one captured Intent', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'live-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Implement live capture' })
  const state = inspect(root)
  assert.deepEqual(state.report.skipped, [])
  const key = keyOf('live-thread', 'turn-1'), turnId = 'codex:turn:' + key, intentId = 'codex:intent:' + key
  assert.equal(state.turns.length, 1)
  const [turn] = state.turns
  assert.equal(turn.id, turnId)
  assert.equal(turn.state, 'interpreting')
  assert.equal(turn.classification, 'new_intent')
  assert.equal(turn.sessionId, state.mapping[0].sessionId)
  assert.equal(state.intents.length, 1)
  const [intent] = state.intents
  assert.equal(intent.id, intentId)
  assert.equal(intent.state, 'captured')
  assert.equal(intent.originTurnId, turnId)
  assert.equal(intent.sessionId, turn.sessionId)
  assert.equal(intent.text, 'Implement live capture')
  const transitions = state.workflowEvents.filter(item => item.kind === 'turn.transitioned').map(item => item.payload)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].from, 'received')
  assert.equal(transitions[0].to, 'interpreting')
  assert.equal(transitions[0].actor, 'codex:host-hook')
  assert.match(transitions[0].reason, /Observed Codex UserPromptSubmit/)
  // Captured is the host capture state: no Intent confirmation/acceptance is invented.
  assert.equal(state.workflowEvents.filter(item => item.kind.startsWith('intent.')).length, 1)
  assert.equal(state.live.length, 1)
  assert.deepEqual(state.live[0], { threadId: 'live-thread', sessionId: turn.sessionId, turnId, intentId, classification: 'new_intent', classificationPolicyVersion: POLICY_VERSION, truncated: false, source: 'codex-user-prompt-hook' })
})

test('repeated UserPromptSubmit for one real turn_id is idempotent even when the hook payload differs', t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'idem-thread', hook_event_name: 'SessionStart' })
  const prompt = { cwd: root, session_id: 'idem-thread', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Only once' }
  assert.equal(ingestHook(prompt).duplicate, false)
  const before = inspect(root)
  assert.equal(ingestHook(prompt).duplicate, true)
  // A different delivery hash must not hide a non-idempotent capture path.
  assert.equal(ingestHook({ ...prompt, delivery_attempt: 2 }).duplicate, false)
  const after = inspect(root)
  assert.equal(after.turns.length, 1)
  assert.equal(after.intents.length, 1)
  assert.equal(after.live.length, 1)
  assert.equal(after.snapshot.sequence, before.snapshot.sequence)
  assert.deepEqual(after.turns, before.turns)
  assert.deepEqual(after.intents, before.intents)
})

test('a second prompt while the first Turn is interpreting is classified as steering', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'steer-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Start the work' })
  ingestHook({ ...base, turn_id: 'turn-2', hook_event_name: 'UserPromptSubmit', prompt: 'Change direction' })
  const state = inspect(root)
  assert.equal(state.turns.length, 2)
  const first = state.turns.find(item => item.id === 'codex:turn:' + keyOf('steer-thread', 'turn-1'))
  const second = state.turns.find(item => item.id === 'codex:turn:' + keyOf('steer-thread', 'turn-2'))
  assert.equal(first.classification, 'new_intent')
  assert.equal(second.classification, 'steering')
  assert.equal(second.state, 'interpreting')
  assert.deepEqual(state.live.map(item => [item.classification, item.source]), [['new_intent', 'codex-user-prompt-hook'], ['steering', 'codex-user-prompt-hook']])
  assert.equal(state.intents.length, 2)
})

test('Stop completes the observed Turn and the state survives a store reopen', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'stop-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Finish the work' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'Stop', last_assistant_message: 'Done' })
  const completed = inspect(root), turnId = completed.turns[0].id
  const [turn] = completed.turns
  assert.equal(turn.state, 'completed')
  assert.equal(completed.intents[0].state, 'captured')
  assert.deepEqual(completed.workflowEvents.filter(item => item.kind === 'turn.transitioned').map(item => [item.payload.from, item.payload.to]), [['received', 'interpreting'], ['interpreting', 'responding'], ['responding', 'completed']])
  assert.equal(completed.live.length, 2)
  assert.deepEqual(completed.live[1], { event: 'Stop', turnId, from: 'interpreting', to: 'completed', source: 'codex-stop-hook' })
  const reopened = inspect(root)
  assert.deepEqual(reopened.report.skipped, [])
  assert.deepEqual(reopened.turns, completed.turns)
  assert.deepEqual(reopened.intents, completed.intents)
  assert.deepEqual(reopened.snapshot, completed.snapshot)
  assert.deepEqual(reopened.live, completed.live)
})

test('Interrupt does not fabricate a native interruption snapshot and still records the hook observation', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'interrupt-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'Interruptible work' })
  ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'Interrupt', reason: 'user pressed escape' })
  const state = inspect(root)
  assert.equal(state.turns[0].state, 'interpreting')
  assert.equal(state.turns[0].interruption, undefined)
  assert.deepEqual(state.workflowEvents.filter(item => item.kind === 'turn.transitioned').map(item => item.payload.to), ['interpreting'])
  assert.equal(state.live.length, 1)
  assert.equal(state.errors.length, 0)
  assert.ok(state.hooks.some(item => item.event.hook_event_name === 'Interrupt'))
  // The hook-level observation still reports the interrupt; the native Turn does not.
  assert.equal(readCodexThread(() => root, 'interrupt-thread').turns[0].status, 'interrupted')
})

test('a prompt without a native session mapping creates no Turn or Intent', t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'unmapped-thread', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'No mapped session' })
  const state = inspect(root)
  assert.equal(state.turns.length, 0)
  assert.equal(state.intents.length, 0)
  assert.equal(state.live.length, 0)
  assert.equal(state.errors.length, 0)
  assert.deepEqual(state.mapping, [])
  assert.equal(state.hooks.length, 1)
})

test('a UserPromptSubmit after SessionEnd creates no Turn or Intent and journals no capture failure', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'error-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, hook_event_name: 'SessionEnd' })
  // The mapped native session is suspended, so capture is a silent no-op.
  assert.equal(ingestHook({ ...base, turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt: 'After the session ended' }).duplicate, false)
  const state = inspect(root)
  assert.equal(state.turns.length, 0)
  assert.equal(state.intents.length, 0)
  assert.equal(state.live.length, 0)
  assert.equal(state.errors.length, 0)
  assert.equal(state.hooks.filter(item => item.event.hook_event_name === 'UserPromptSubmit').length, 1)
})

test('an oversized prompt is truncated by UTF-8 bytes and the live event records it', t => {
  const root = makeWorkspace(t), prompt = '😀'.repeat(3000)
  ingestHook({ cwd: root, session_id: 'cap-thread', hook_event_name: 'SessionStart' })
  ingestHook({ cwd: root, session_id: 'cap-thread', turn_id: 'turn-1', hook_event_name: 'UserPromptSubmit', prompt })
  const state = inspect(root)
  assert.equal(state.live.length, 1)
  assert.equal(state.live[0].truncated, true)
  assert.equal(state.intents[0].text, '😀'.repeat(2048))
  assert.equal(Buffer.byteLength(state.intents[0].text, 'utf8'), 8192)
  assert.ok(Buffer.byteLength(state.intents[0].text, 'utf8') < Buffer.byteLength(prompt, 'utf8'))
})

test('after SessionEnd a prompt is a no-op until SessionStart resumes the native session', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'resume-capture-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, hook_event_name: 'SessionEnd' })
  ingestHook({ ...base, turn_id: 'turn-ended', hook_event_name: 'UserPromptSubmit', prompt: 'Ignored while suspended' })
  let state = inspect(root)
  assert.equal(state.turns.length, 0)
  assert.equal(state.intents.length, 0)
  assert.equal(state.live.length, 0)
  assert.equal(state.errors.length, 0)
  // SessionStart moves suspended -> resumed -> active, so capture is live again.
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  ingestHook({ ...base, turn_id: 'turn-live', hook_event_name: 'UserPromptSubmit', prompt: 'Captured after resume' })
  state = inspect(root)
  assert.equal(state.turns.length, 1)
  assert.equal(state.intents.length, 1)
  assert.equal(state.intents[0].text, 'Captured after resume')
  assert.equal(state.intents[0].state, 'captured')
  assert.equal(state.live.length, 1)
  assert.equal(state.live[0].threadId, 'resume-capture-thread')
})

test('a resumed Turn makes the next prompt steering instead of new_intent', t => {
  const root = makeWorkspace(t), base = { cwd: root, session_id: 'resumed-turn-thread' }
  ingestHook({ ...base, hook_event_name: 'SessionStart' })
  const store = openCodexStore(root)
  try {
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(item => item.payload).find(item => item.threadId === base.session_id)
    assert.ok(mapping, 'SessionStart must map the Codex thread to a native session')
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    assert.deepEqual(persistence.restoreAll().skipped, [])
    // Seed an explicit interrupted -> resumed Turn through the real persistence
    // stack; no capture policy shortcut is assumed by the test.
    let turn = persistence.create('turn', { id: 'seed-resumed-turn', sessionId: mapping.sessionId, classification: 'new_intent' }, 'test-host')
    for (const next of ['interpreting', 'acting', 'interrupted', 'resumed']) turn = persistence.transition('turn', 'seed-resumed-turn', next, { expectedVersion: turn.version, actor: 'test-host' })
    assert.equal(turn.state, 'resumed')
  } finally { store.close() }
  ingestHook({ ...base, turn_id: 'turn-after-resume', hook_event_name: 'UserPromptSubmit', prompt: 'Steer the resumed turn' })
  const state = inspect(root)
  assert.equal(state.turns.find(item => item.id === 'seed-resumed-turn').state, 'resumed')
  const captured = state.turns.find(item => item.id === 'codex:turn:' + keyOf(base.session_id, 'turn-after-resume'))
  assert.ok(captured, 'the prompt after a resumed Turn must still create a Turn')
  assert.equal(captured.classification, 'steering')
  assert.equal(state.intents.length, 1)
  assert.equal(state.live.length, 1)
  assert.equal(state.live[0].classification, 'steering')
})
