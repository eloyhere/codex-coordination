import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { openCodexStore } from '../plugins/codex-coordination/mcp/codex/store.mjs'
import { sessionBindings } from '../plugins/codex-coordination/mcp/codex/session-tools.mjs'
import { sessionSnapshot } from '../plugins/codex-coordination/mcp/codex/snapshot.mjs'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { ingestHook, readCodexThread, goalDigest, mirrorGoal } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { readPersistedCodexGoal } from '../plugins/codex-coordination/mcp/codex/goals.mjs'
import { codexSyncTool } from '../plugins/codex-coordination/mcp/codex/tools.mjs'
import { makeWorkspace } from './helpers.mjs'

test('Codex hooks preserve real identities/messages/results in project-local storage with workspace isolation', t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  const base = { session_id: 'real-thread', cwd: root }
  ingestHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' })
  const prompt = { ...base, turn_id: 'real-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Use AMP' }
  assert.equal(ingestHook(prompt).duplicate, false)
  assert.equal(ingestHook(prompt).duplicate, true)
  ingestHook({ ...base, turn_id: 'real-turn', hook_event_name: 'PreToolUse', tool_use_id: 'call-1', tool_name: 'Bash', tool_input: { command: 'test' } })
  ingestHook({ ...base, turn_id: 'real-turn', hook_event_name: 'PostToolUse', tool_use_id: 'call-1', tool_name: 'Bash', tool_input: { command: 'test' }, tool_response: { exit_code: 0 } })
  ingestHook({ ...base, turn_id: 'real-turn', hook_event_name: 'Stop', last_assistant_message: 'Done' })
  const current = readCodexThread(() => root, 'real-thread')
  assert.equal(current.turns[0].id, 'real-turn')
  assert.equal(current.turns[0].status, 'completed')
  assert.deepEqual(current.turns[0].messages.map(item => item.role), ['user', 'assistant'])
  assert.equal(current.turns[0].calls[0].output.exit_code, 0)
  assert.equal(existsSync(join(root, '.codex-coordination', 'amp-07', 'store.sqlite')), true)
  assert.equal(readFileSync(join(root, '.codex-coordination', '.gitignore'), 'utf8'), '*\n')
  assert.throws(() => readCodexThread(() => other, 'real-thread'), /not been observed/)
  assert.throws(() => ingestHook({ ...base, hook_event_name: 'UserPromptSubmit' }), /turn_id/)
})

test('goal synchronization preserves Codex priority, uses automatic provenance and keeps usage out of conflict hashes', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'thread-goal', hook_event_name: 'SessionStart' })
  let goal = { threadId: 'thread-goal', objective: 'Finish integration', status: 'active', tokenBudget: null, createdAt: 1000, updatedAt: 1000, tokensUsed: 5, timeUsedSeconds: 1 }
  const writes = []
  const tool = codexSyncTool(() => root, async (method, params) => { writes.push({ method, params }); goal = { ...goal, status: params.status }; return { goal } }, async () => ({ goal, source: 'codex-app-server' }))
  const snapshot = await tool.handler({ action: 'pull_goal', threadId: goal.threadId })
  assert.equal(snapshot.digest, goalDigest(goal))
  goal = { ...goal, tokensUsed: 55, updatedAt: 2000 }
  assert.equal(snapshot.digest, goalDigest(goal))
  const updated = await tool.handler({ action: 'push_goal', threadId: goal.threadId, expectedDigest: snapshot.digest, status: 'paused' })
  assert.equal(updated.goal.status, 'paused')
  assert.equal(writes[0].params.origin, 'automatic')
  assert.equal(updated.goal.tokensUsed, 55)
  const conflict = await tool.handler({ action: 'push_goal', threadId: goal.threadId, expectedDigest: snapshot.digest, status: 'active' })
  assert.equal(conflict.winner, 'codex')
  assert.equal(writes.length, 1)
  assert.equal(updated.atomicGoalCAS, false)
})

test('projects independently persist the same thread identity and preserve existing ignore rules across reopen', t => {
  const first = makeWorkspace(t), second = makeWorkspace(t)
  mkdirSync(join(first, '.codex-coordination'))
  writeFileSync(join(first, '.codex-coordination', '.gitignore'), '# project policy\n*.sqlite\n')
  for (const [root, prompt] of [[first, 'first project'], [second, 'second project']]) {
    ingestHook({ cwd: root, session_id: 'shared-id', hook_event_name: 'SessionStart' })
    ingestHook({ cwd: root, session_id: 'shared-id', turn_id: 'same-turn', hook_event_name: 'UserPromptSubmit', prompt })
    mirrorGoal(() => root, 'shared-id', { threadId: 'shared-id', objective: prompt, status: 'active' })
  }
  for (const [root, expected] of [[first, 'first project'], [second, 'second project']]) {
    const state = readCodexThread(() => root, 'shared-id')
    assert.equal(state.turns.length, 1)
    assert.equal(state.turns[0].messages[0].content, expected)
    assert.equal(state.goal.objective, expected)
    assert.equal(existsSync(join(root, '.codex-coordination', 'amp-07', 'store.sqlite')), true)
  }
  assert.equal(readFileSync(join(first, '.codex-coordination', '.gitignore'), 'utf8'), '# project policy\n*.sqlite\n')
})

test('read-only goal fallback validates its schema and leaves the source database unchanged', t => {
  const root = makeWorkspace(t), path = join(root, 'goals.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,token_budget INTEGER,tokens_used INTEGER,time_used_seconds INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER)')
  db.prepare('INSERT INTO thread_goals VALUES(?,?,?,?,?,?,?,?,?)').run('t1', 'g1', 'Keep going', 'usage_limited', 100, 20, 5, 1000000, 2000000)
  db.close()
  const before = readFileSync(path)
  const result = readPersistedCodexGoal('t1', path)
  assert.equal(result.goal.status, 'usageLimited')
  assert.equal(result.goal.createdAt, 1000)
  assert.equal(readPersistedCodexGoal('other', path).goal, null)
  assert.deepEqual(readFileSync(path), before)
})

test('packaged hook entry captures lifecycle without blocking the host and rejects malformed input', t => {
  const root = makeWorkspace(t)
  const plugin = new URL('../plugins/codex-coordination/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', plugin), 'utf8'))
  const hooks = JSON.parse(readFileSync(new URL(manifest.hooks, plugin), 'utf8')).hooks
  const entry = fileURLToPath(new URL('mcp/codex/hook.mjs', plugin))
  assert.equal(Object.keys(hooks).length, 11)
  for (const groups of Object.values(hooks)) {
    assert.equal(groups[0].hooks[0].command, 'node "${PLUGIN_ROOT}/mcp/codex/hook.mjs"')
    assert.equal(groups[0].hooks[0].type, 'command')
  }
  // This event does not query goals or any external service.
  const result = spawnSync(process.execPath, [entry], { input: JSON.stringify({ cwd: root, session_id: 'packaged-thread', turn_id: 'packaged-turn', hook_event_name: 'PreToolUse', tool_use_id: 'packaged-call', tool_name: 'example', tool_input: { value: 7 } }), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {})
  assert.equal(readCodexThread(() => root, 'packaged-thread').turns[0].calls[0].input.value, 7)
  const rejected = spawnSync(process.execPath, [entry], { input: '{invalid', encoding: 'utf8', timeout: 10000 })
  assert.equal(rejected.status, 0)
  assert.deepEqual(JSON.parse(rejected.stdout), {})
  assert.match(rejected.stderr, /lifecycle capture failed/)
})

test('host tool identities cannot collide with object prototype properties', t => {
  const root = makeWorkspace(t)
  for (const id of ['__proto__', 'constructor', 'toString']) {
    ingestHook({ cwd: root, session_id: 'identity-thread', turn_id: 'identity-turn', hook_event_name: 'PostToolUse', tool_use_id: id, tool_name: 'example', tool_input: {}, tool_response: { value: id } })
  }
  const calls = readCodexThread(() => root, 'identity-thread').turns[0].calls
  assert.deepEqual(calls.map(call => call.id), ['__proto__', 'constructor', 'toString'])
  assert.equal(Object.prototype.tool, undefined)
})

test('host sessions persist native transitions across restart without inferring turn classifications or closure', t => {
  const root = makeWorkspace(t)
  const emit = hook_event_name => ingestHook({ cwd: root, session_id: 'native-thread', hook_event_name })
  const snapshot = () => {
    const store = openCodexStore(root)
    try {
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
      assert.deepEqual(persistence.restoreAll().skipped, [])
      return persistence.workflow.snapshot()
    } finally { store.close() }
  }
  emit('SessionEnd')
  assert.equal(snapshot().entities.length, 0)
  emit('SessionStart')
  const active = snapshot()
  assert.equal(active.entities[0].state, 'active')
  emit('SessionStart')
  assert.equal(snapshot().events.length, active.events.length)
  emit('SessionEnd')
  assert.equal(snapshot().entities[0].state, 'suspended')
  emit('SessionStart')
  const resumed = snapshot()
  assert.equal(resumed.entities[0].id, active.entities[0].id)
  assert.equal(resumed.entities[0].state, 'active')
  assert.equal(readCodexThread(() => root, 'native-thread').nativeSession.id, active.entities[0].id)
  assert.deepEqual(resumed.events.map(event => event.to), ['created', 'active', 'suspended', 'resumed', 'active'])
  assert.equal(resumed.entities.filter(entity => entity.kind === 'turn').length, 0)
})

test('standard session reads expose only this project host mappings and reject spoofed gateway identity', async t => {
  const first = makeWorkspace(t), second = makeWorkspace(t)
  ingestHook({ cwd: first, session_id: 'visible-thread', hook_event_name: 'SessionStart' })
  const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'connection', policyVersion: 'test', cancellationEpoch: 0 }
  const tools = sessionBindings(binding, () => first)
  const get = tools.find(tool => tool.name.endsWith('session.get'))
  const list = tools.find(tool => tool.name.endsWith('session.list'))
  const result = await get.handler({ threadId: 'visible-thread' })
  assert.equal(result.entity.state, 'active')
  assert.equal(result.origin, 'codex-command-hook')
  assert.equal((await list.handler({})).total, 1)
  await assert.rejects(get.handler({ threadId: 'unknown-thread' }), /no native session mapping/)
  await assert.rejects(get.handler({ threadId: 'visible-thread', principalId: 'forged' }))
  const other = sessionBindings(binding, () => second)
  assert.equal((await other.find(tool => tool.name.endsWith('session.list')).handler({})).total, 0)
  await assert.rejects(other.find(tool => tool.name.endsWith('session.get')).handler({ threadId: 'visible-thread' }), /no native session mapping/)
})

test('dialog snapshot is read-only, requires explicit chat selection and excludes other session entities', t => {
  withAmpSurface([])
  const root = makeWorkspace(t), empty = makeWorkspace(t)
  assert.equal(sessionSnapshot(empty), null)
  assert.equal(existsSync(join(empty, '.codex-coordination')), false)
  for (const id of ['chat-one', 'chat-two']) ingestHook({ cwd: root, session_id: id, hook_event_name: 'SessionStart' })
  const path = join(root, '.codex-coordination', 'amp-07', 'store.sqlite')
  const before = readFileSync(path)
  const unselected = sessionSnapshot(root)
  assert.equal(unselected.selected, null)
  assert.equal(unselected.groups.session.records.length, 0)
  const selected = sessionSnapshot(root, 'chat-one')
  assert.equal(selected.groups.session.records.length, 1)
  assert.equal(selected.groups.session.records[0].id, selected.selected.sessionId)
  assert.equal(selected.groups.codex_observations.total, 1)
  assert.equal(selected.groups.codex_observations.records[0].event.session_id, 'chat-one')
  assert.ok(selected.modules.some(item => item.module === 'profession'))
  assert.throws(() => sessionSnapshot(root, 'missing'), /no session mapping/)
  assert.deepEqual(readFileSync(path), before)
})
