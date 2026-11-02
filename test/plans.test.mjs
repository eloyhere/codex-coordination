/**
 * Plan validation, dependency gates and promotion.
 * @module codex-coordination/test/plans
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import {
  createPlan,
  derivedEdges,
  getPlan,
  normalisePlanInput,
  planProgress,
  transitionPlan,
  updateTask,
} from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { goalPayload, makeWorkspace, planPayload, rejectsCode, state, throwsCode, transact } from './helpers.mjs'

test('a created plan is a draft with derived edges', async (t) => {
  const workspace = makeWorkspace(t)
  const plan = await transact(workspace, (context) => createPlan(context, planPayload('p1')))
  assert.equal(plan.status, 'draft')
  assert.deepEqual(plan.edges, [['write-server', 'verify']])
  assert.deepEqual(derivedEdges(plan), plan.edges)
  const progress = planProgress(plan)
  assert.deepEqual(progress.ready, ['write-server'])
  assert.deepEqual(progress.blocked, [{ id: 'verify', blockedBy: ['write-server'] }])
  assert.equal(progress.byStatus.pending, 2)
  assert.equal(getPlan(state(workspace), 'p1').tasks.length, 2)
})

test('plan validation rejects cycles, unknown predecessors and oversized graphs', () => {
  const cyclic = planPayload('cyclic')
  cyclic.tasks[0].pre = ['verify']
  throwsCode(() => normalisePlanInput(cyclic), 'INVALID_ARGUMENT', /cycle/)

  const unknown = planPayload('unknown')
  unknown.tasks[1].pre = ['ghost']
  throwsCode(() => normalisePlanInput(unknown), 'INVALID_ARGUMENT', /unknown task ghost/)

  const duplicate = planPayload('duplicate')
  duplicate.tasks[1].id = 'write-server'
  duplicate.tasks[1].pre = []
  throwsCode(() => normalisePlanInput(duplicate), 'INVALID_ARGUMENT', /repeats id/)

  const crowded = planPayload('crowded')
  crowded.tasks = Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    intent: 'work',
    actor: 'self',
    expect: { observation: 'x', check: 'y' },
  }))
  throwsCode(() => normalisePlanInput(crowded), 'INVALID_ARGUMENT', /at most 12/)

  const selfDependency = planPayload('self-dep')
  selfDependency.tasks[0].pre = ['write-server']
  throwsCode(() => normalisePlanInput(selfDependency), 'INVALID_ARGUMENT', /itself/)

  const noCheck = planPayload('no-check')
  delete noCheck.tasks[0].expect.check
  throwsCode(() => normalisePlanInput(noCheck), 'INVALID_ARGUMENT', /expect.check/)
})

test('a plan may only reference an existing goal', async (t) => {
  const workspace = makeWorkspace(t)
  await rejectsCode(
    () => transact(workspace, (context) => createPlan(context, planPayload('orphan', { goal: 'missing' }))),
    'NOT_FOUND',
    /does not exist/,
  )
  await transact(workspace, (context) => createGoal(context, goalPayload('real')))
  const plan = await transact(workspace, (context) => createPlan(context, planPayload('linked', { goal: 'real' })))
  assert.equal(plan.goal.id, 'real')
})

test('tasks cannot move while the plan is a draft', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createPlan(context, planPayload('draft-plan')))
  await rejectsCode(
    () => transact(workspace, (context) => updateTask(context, 'draft-plan', 'write-server', 'running')),
    'INVALID_STATE',
    /draft/,
  )
})

test('a predecessor gate blocks a dependent task', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createPlan(context, planPayload('gated')))
  await transact(workspace, (context) => transitionPlan(context, 'gated', 'committed'))
  await rejectsCode(
    () => transact(workspace, (context) => updateTask(context, 'gated', 'verify', 'running')),
    'INVALID_STATE',
    /blocked by unfinished predecessors/,
  )
})

test('starting the first task promotes a committed plan to executing', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createPlan(context, planPayload('promote')))
  await transact(workspace, (context) => transitionPlan(context, 'promote', 'committed'))
  const plan = await transact(workspace, (context) => updateTask(context, 'promote', 'write-server', 'running'))
  assert.equal(plan.status, 'executing')
  assert.equal(plan.tasks[0].status, 'running')
  assert.deepEqual(plan.history.at(-1), {
    at: plan.updatedAt,
    from: 'committed',
    to: 'executing',
    note: 'task write-server started',
  })
})

test('a plan can only be closed when every task is terminal', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createPlan(context, planPayload('closing')))
  await transact(workspace, (context) => transitionPlan(context, 'closing', 'committed'))
  await transact(workspace, (context) => transitionPlan(context, 'closing', 'executing'))
  await rejectsCode(
    () => transact(workspace, (context) => transitionPlan(context, 'closing', 'done')),
    'INVALID_STATE',
    /unfinished tasks/,
  )
  await transact(workspace, (context) => updateTask(context, 'closing', 'write-server', 'done'))
  await transact(workspace, (context) => updateTask(context, 'closing', 'verify', 'skipped', 'covered elsewhere'))
  const plan = await transact(workspace, (context) => transitionPlan(context, 'closing', 'done'))
  assert.equal(plan.status, 'done')
  await rejectsCode(
    () => transact(workspace, (context) => updateTask(context, 'closing', 'verify', 'running')),
    'INVALID_STATE',
    /its tasks are closed/,
  )
})
