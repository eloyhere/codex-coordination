/**
 * Goal artifacts and lifecycle.
 * @module codex-coordination/test/goals
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GOAL_EDGES,
  createGoal,
  getGoal,
  goalView,
  listGoals,
  normaliseGoalArtifact,
  transitionGoal,
} from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { createPlan, transitionPlan, updateTask } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { goalPayload, makeWorkspace, planPayload, rejectsCode, seedGoal, state, throwsCode, transact } from './helpers.mjs'

test('a created goal is a strict AMP artifact with a host lifecycle', async (t) => {
  const workspace = makeWorkspace(t)
  const record = await transact(workspace, (context) => createGoal(context, goalPayload('ship-it')))

  assert.deepEqual(Object.keys(record.artifact).sort(), ['amp', 'horizon', 'id', 'kind', 'priority', 'statement', 'success', 'value'])
  assert.equal(record.artifact.amp, '0.1')
  assert.equal(record.artifact.kind, 'goal')
  assert.equal(record.artifact.success.length, 1)
  assert.deepEqual(record.lifecycle, { state: 'proposed' })
  assert.deepEqual(record.history, [{ at: record.createdAt, from: null, to: 'proposed' }])

  const stored = getGoal(state(workspace), 'ship-it')
  assert.deepEqual(stored.artifact, record.artifact)
  assert.equal(stored.lifecycle.state, 'proposed')

  const view = goalView(stored)
  assert.deepEqual(view.goal, record.artifact)
  assert.deepEqual(view.lifecycle, { state: 'proposed' })
  assert.equal(view.createdAt, record.createdAt)
})

test('the chain records the goal artifact, not the projection', async (t) => {
  const workspace = makeWorkspace(t)
  const record = await transact(workspace, (context) => createGoal(context, goalPayload('chained')))
  const document = state(workspace)
  assert.equal(document.journal.length, 1)
  assert.equal(document.journal[0].kind, 'goal')
  assert.deepEqual(document.journal[0].payload, record.artifact)
  assert.equal('state' in document.journal[0].payload, false)
  assert.equal('history' in document.journal[0].payload, false)
})

test('duplicate goal ids conflict', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'dup')
  await rejectsCode(() => transact(workspace, (context) => createGoal(context, goalPayload('dup'))), 'CONFLICT', /already exists/)
})

test('goal validation rejects malformed and non-AMP input', () => {
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), success: [] }), 'INVALID_ARGUMENT', /success/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), success: [{ id: 'x', statement: 's' }] }), 'INVALID_ARGUMENT', /check/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), value: 2 }), 'INVALID_ARGUMENT', /between 0 and 1/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), id: 'Bad Id' }), 'INVALID_ARGUMENT', /must match/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), priority: -1 }), 'INVALID_ARGUMENT', /priority/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), deadline: '2026-11-03 05:00:00 UTC' }), 'INVALID_ARGUMENT', /RFC 3339/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), statement: undefined }), 'INVALID_ARGUMENT', /statement is required/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), owner: 'me' }), 'INVALID_ARGUMENT', /owner is not a known field/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), amp: '0.2' }), 'INVALID_ARGUMENT', /goal.amp/)
  throwsCode(() => normaliseGoalArtifact({ ...goalPayload(), kind: 'plan' }), 'INVALID_ARGUMENT', /goal.kind/)
})

test('the lifecycle only moves along declared edges', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'edge')
  await rejectsCode(() => transact(workspace, (context) => transitionGoal(context, 'edge', 'achieved')), 'INVALID_STATE', /cannot move/)
  await transact(workspace, (context) => transitionGoal(context, 'edge', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'edge', 'active'))
  const achieved = await transact(workspace, (context) => transitionGoal(context, 'edge', 'achieved', 'checks ran'))
  assert.equal(achieved.lifecycle.state, 'achieved')
  assert.equal(typeof achieved.lifecycle.startedAt, 'string')
  assert.equal(typeof achieved.lifecycle.achievedAt, 'string')
  assert.deepEqual(achieved.history.at(-1), {
    at: achieved.updatedAt,
    from: 'active',
    to: 'achieved',
    note: 'checks ran',
  })
  await rejectsCode(() => transact(workspace, (context) => transitionGoal(context, 'edge', 'abandoned')), 'INVALID_STATE')
  assert.deepEqual(Object.keys(GOAL_EDGES).sort(), ['abandoned', 'achieved', 'active', 'committed', 'proposed'])
})

test('a transition is recorded as an event beside the unchanged artifact', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'evented')
  await transact(workspace, (context) => transitionGoal(context, 'evented', 'committed', 'agreed'))
  const document = state(workspace)
  assert.equal(document.journal.length, 2)
  assert.equal(document.journal[1].kind, 'event')
  assert.deepEqual(document.journal[1].payload, {
    type: 'goal.transitioned',
    goal: 'evented',
    from: 'proposed',
    to: 'committed',
    note: 'agreed',
  })
})

test('achieved is refused while a linked plan is open', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'gated')
  await transact(workspace, (context) => transitionGoal(context, 'gated', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'gated', 'active'))
  await transact(workspace, (context) => createPlan(context, planPayload('gated-plan', 'gated')))

  await rejectsCode(
    () => transact(workspace, (context) => transitionGoal(context, 'gated', 'achieved')),
    'INVALID_STATE',
    /unfinished plans/,
  )

  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'committed'))
  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'executing'))
  await transact(workspace, (context) => updateTask(context, 'gated-plan', 'write-server', 'done'))
  await transact(workspace, (context) => updateTask(context, 'gated-plan', 'verify', 'done'))
  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'done'))
  const record = await transact(workspace, (context) => transitionGoal(context, 'gated', 'achieved'))
  assert.equal(record.lifecycle.state, 'achieved')
})

test('list filters by lifecycle state', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'one')
  await seedGoal(workspace, 'two')
  await transact(workspace, (context) => transitionGoal(context, 'two', 'committed'))

  const proposed = listGoals(state(workspace), { state: 'proposed' })
  assert.deepEqual(proposed.map((goal) => goal.id), ['one'])
  const all = listGoals(state(workspace))
  assert.deepEqual(all.map((goal) => goal.id), ['one', 'two'])
  assert.equal(all[0].state, 'proposed')
  assert.equal(all[0].success, 1)
})
