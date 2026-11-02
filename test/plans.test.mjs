/**
 * Plan artifacts, dependency gates and promotion.
 * @module codex-coordination/test/plans
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPlan,
  derivedEdges,
  getPlan,
  normalisePlanArtifact,
  planView,
  transitionPlan,
  updateTask,
} from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { verifyChain } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { makeWorkspace, planPayload, rejectsCode, seedGoal, state, throwsCode, transact } from './helpers.mjs'

test('a created plan is a strict AMP artifact in draft', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  const record = await transact(workspace, (context) => createPlan(context, planPayload('p1')))
  const artifact = record.artifact

  assert.equal(artifact.amp, '0.1')
  assert.equal(artifact.kind, 'plan')
  assert.equal(artifact.status, 'draft')
  assert.equal(artifact.goal.kind, 'goal')
  assert.equal(artifact.goal.id, 'ship-it')
  assert.equal(artifact.commitment_window, 2)
  assert.deepEqual(artifact.budget, {})
  assert.equal(artifact.abandon_if.length, 1)
  assert.equal(typeof artifact.created, 'string')
  assert.deepEqual(artifact.edges, [['write-server', 'verify']])
  assert.deepEqual(derivedEdges(artifact.tasks), artifact.edges)
  assert.deepEqual(artifact.tasks[0], {
    id: 'write-server',
    intent: 'Write the MCP server',
    actor: 'self',
    pre: [],
    expect: { observation: 'tools/list answers', check: 'run the smoke script' },
    irreversibility: 0,
    status: 'pending',
  })

  const view = planView(getPlan(state(workspace), 'p1'))
  assert.deepEqual(view.plan, artifact)
  assert.deepEqual(view.progress.ready, ['write-server'])
  assert.deepEqual(view.progress.blocked, [{ id: 'verify', blockedBy: ['write-server'] }])
  assert.equal(view.progress.byStatus.pending, 2)
})

test('plan validation rejects non-AMP input', () => {
  const cyclic = planPayload('cyclic')
  cyclic.tasks[0].pre = ['verify']
  throwsCode(() => normalisePlanArtifact(cyclic), 'INVALID_ARGUMENT', /cycle/)

  const unknown = planPayload('unknown')
  unknown.tasks[1].pre = ['ghost']
  throwsCode(() => normalisePlanArtifact(unknown), 'INVALID_ARGUMENT', /unknown task ghost/)

  const duplicate = planPayload('duplicate')
  duplicate.tasks[1].id = 'write-server'
  duplicate.tasks[1].pre = []
  throwsCode(() => normalisePlanArtifact(duplicate), 'INVALID_ARGUMENT', /repeats id/)

  const crowded = planPayload('crowded')
  crowded.tasks = Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    intent: 'work',
    actor: 'self',
    expect: { observation: 'x', check: 'y' },
  }))
  throwsCode(() => normalisePlanArtifact(crowded), 'INVALID_ARGUMENT', /at most 12/)

  const selfDependency = planPayload('self-dep')
  selfDependency.tasks[0].pre = ['write-server']
  throwsCode(() => normalisePlanArtifact(selfDependency), 'INVALID_ARGUMENT', /itself/)

  const noCheck = planPayload('no-check')
  delete noCheck.tasks[0].expect.check
  throwsCode(() => normalisePlanArtifact(noCheck), 'INVALID_ARGUMENT', /expect.check/)

  const noGoal = planPayload('no-goal')
  delete noGoal.goal
  throwsCode(() => normalisePlanArtifact(noGoal), 'INVALID_ARGUMENT', /goal is required/)

  const wrongGoalKind = planPayload('wrong-goal')
  wrongGoalKind.goal.kind = 'plan'
  throwsCode(() => normalisePlanArtifact(wrongGoalKind), 'INVALID_ARGUMENT', /plan.goal.kind must be "goal"/)

  const noAbandon = planPayload('no-abandon')
  delete noAbandon.abandon_if
  throwsCode(() => normalisePlanArtifact(noAbandon), 'INVALID_ARGUMENT', /abandon_if is required/)

  const emptyAbandon = planPayload('empty-abandon')
  emptyAbandon.abandon_if = []
  throwsCode(() => normalisePlanArtifact(emptyAbandon), 'INVALID_ARGUMENT', /abandon_if must contain 1-8/)

  const camel = planPayload('camel')
  camel.commitmentWindow = 2
  throwsCode(() => normalisePlanArtifact(camel), 'INVALID_ARGUMENT', /not the AMP spelling/)

  const computed = planPayload('computed')
  computed.status = 'draft'
  throwsCode(() => normalisePlanArtifact(computed), 'INVALID_ARGUMENT', /computed by the server/)

  const badBudget = planPayload('bad-budget')
  badBudget.budget = { tokens: 1.5 }
  throwsCode(() => normalisePlanArtifact(badBudget), 'INVALID_ARGUMENT', /integer/)

  const unknownField = planPayload('unknown-field')
  unknownField.owner = 'me'
  throwsCode(() => normalisePlanArtifact(unknownField), 'INVALID_ARGUMENT', /owner is not a known field/)
})

test('a plan may only reference an existing goal', async (t) => {
  const workspace = makeWorkspace(t)
  await rejectsCode(
    () => transact(workspace, (context) => createPlan(context, planPayload('orphan', 'missing'))),
    'NOT_FOUND',
    /does not exist/,
  )
  await seedGoal(workspace, 'real')
  const record = await transact(workspace, (context) => createPlan(context, planPayload('linked', 'real')))
  assert.equal(record.artifact.goal.id, 'real')
})

test('tasks cannot move while the plan is a draft', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, (context) => createPlan(context, planPayload('draft-plan')))
  await rejectsCode(
    () => transact(workspace, (context) => updateTask(context, 'draft-plan', 'write-server', 'running')),
    'INVALID_STATE',
    /draft/,
  )
})

test('a predecessor gate blocks a dependent task', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
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
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, (context) => createPlan(context, planPayload('promote')))
  await transact(workspace, (context) => transitionPlan(context, 'promote', 'committed'))
  const record = await transact(workspace, (context) => updateTask(context, 'promote', 'write-server', 'running'))
  assert.equal(record.artifact.status, 'executing')
  assert.equal(record.artifact.tasks[0].status, 'running')
  assert.deepEqual(record.history.at(-1), {
    at: record.updatedAt,
    from: 'committed',
    to: 'executing',
    note: 'task write-server started',
  })
  assert.deepEqual(record.history.at(-2), { at: record.updatedAt, task: 'write-server', from: 'pending', to: 'running' })
})

test('a plan can only be closed when every task is terminal', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
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
  const record = await transact(workspace, (context) => transitionPlan(context, 'closing', 'done'))
  assert.equal(record.artifact.status, 'done')
  await rejectsCode(
    () => transact(workspace, (context) => updateTask(context, 'closing', 'verify', 'running')),
    'INVALID_STATE',
    /its tasks are closed/,
  )
})

test('every plan mutation appends the updated artifact and keeps the chain valid', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, (context) => createPlan(context, planPayload('chained')))
  await transact(workspace, (context) => transitionPlan(context, 'chained', 'committed'))
  await transact(workspace, (context) => updateTask(context, 'chained', 'write-server', 'running'))
  await transact(workspace, (context) => updateTask(context, 'chained', 'write-server', 'done'))

  const document = state(workspace)
  const planEntries = document.journal.filter((entry) => entry.kind === 'plan')
  assert.equal(planEntries.length, 4)
  assert.deepEqual(planEntries.map((entry) => entry.payload.status), ['draft', 'committed', 'executing', 'executing'])
  assert.deepEqual(planEntries.map((entry) => entry.payload.tasks[0].status), ['pending', 'pending', 'running', 'done'])
  // Earlier payloads are copies: a later mutation cannot rewrite them.
  assert.equal(planEntries[0].payload.tasks[0].status, 'pending')
  assert.equal(verifyChain(document).ok, true)
})
