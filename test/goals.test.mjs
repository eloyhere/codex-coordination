/**
 * Goal validation and lifecycle.
 * @module codex-coordination/test/goals
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GOAL_EDGES,
  createGoal,
  getGoal,
  listGoals,
  normaliseGoalInput,
  transitionGoal,
} from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { createPlan, transitionPlan, updateTask } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { goalPayload, makeWorkspace, planPayload, rejectsCode, state, throwsCode, transact } from './helpers.mjs'

test('a created goal starts proposed and records its history', async (t) => {
  const workspace = makeWorkspace(t)
  const goal = await transact(workspace, (context) => createGoal(context, goalPayload('ship-it')))
  assert.equal(goal.state, 'proposed')
  assert.equal(goal.amp, '0.1')
  assert.equal(goal.kind, 'goal')
  assert.equal(goal.success.length, 1)
  assert.deepEqual(goal.history, [{ at: goal.createdAt, from: null, to: 'proposed' }])
  assert.equal(getGoal(state(workspace), 'ship-it').id, 'ship-it')
})

test('duplicate goal ids conflict', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('dup')))
  await rejectsCode(() => transact(workspace, (context) => createGoal(context, goalPayload('dup'))), 'CONFLICT', /already exists/)
})

test('goal validation rejects malformed input', () => {
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), success: [] }), 'INVALID_ARGUMENT', /success/)
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), success: [{ id: 'x', statement: 's' }] }), 'INVALID_ARGUMENT', /check/)
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), value: 2 }), 'INVALID_ARGUMENT', /between 0 and 1/)
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), id: 'Bad Id' }), 'INVALID_ARGUMENT', /must match/)
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), priority: -1 }), 'INVALID_ARGUMENT', /priority/)
  throwsCode(() => normaliseGoalInput({ ...goalPayload(), deadline: '2026-11-03 05:00:00 UTC' }), 'INVALID_ARGUMENT', /RFC 3339/)
})

test('the lifecycle only moves along declared edges', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('edge')))
  await rejectsCode(() => transact(workspace, (context) => transitionGoal(context, 'edge', 'achieved')), 'INVALID_STATE', /cannot move/)
  await transact(workspace, (context) => transitionGoal(context, 'edge', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'edge', 'active'))
  const achieved = await transact(workspace, (context) => transitionGoal(context, 'edge', 'achieved', 'checks ran'))
  assert.equal(achieved.state, 'achieved')
  assert.deepEqual(achieved.history.at(-1), {
    at: achieved.updatedAt,
    from: 'active',
    to: 'achieved',
    note: 'checks ran',
  })
  await rejectsCode(() => transact(workspace, (context) => transitionGoal(context, 'edge', 'abandoned')), 'INVALID_STATE')
  assert.deepEqual(Object.keys(GOAL_EDGES).sort(), ['abandoned', 'achieved', 'active', 'committed', 'proposed'])
})

test('achieved is refused while a linked plan is open', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('gated')))
  await transact(workspace, (context) => transitionGoal(context, 'gated', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'gated', 'active'))
  await transact(workspace, (context) => createPlan(context, planPayload('gated-plan', { goal: 'gated' })))

  await rejectsCode(
    () => transact(workspace, (context) => transitionGoal(context, 'gated', 'achieved')),
    'INVALID_STATE',
    /unfinished plans/,
  )

  // Drive the plan to done, then the goal becomes achievable.
  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'committed'))
  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'executing'))
  await transact(workspace, (context) => updateTask(context, 'gated-plan', 'write-server', 'done'))
  await transact(workspace, (context) => updateTask(context, 'gated-plan', 'verify', 'done'))
  await transact(workspace, (context) => transitionPlan(context, 'gated-plan', 'done'))
  const goal = await transact(workspace, (context) => transitionGoal(context, 'gated', 'achieved'))
  assert.equal(goal.state, 'achieved')
})

test('list filters by state and reports the linked plans', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('one')))
  await transact(workspace, (context) => createGoal(context, goalPayload('two')))
  await transact(workspace, (context) => transitionGoal(context, 'two', 'committed'))

  const proposed = listGoals(state(workspace), { state: 'proposed' })
  assert.deepEqual(proposed.map((goal) => goal.id), ['one'])
  const all = listGoals(state(workspace))
  assert.deepEqual(all.map((goal) => goal.id), ['one', 'two'])
})
