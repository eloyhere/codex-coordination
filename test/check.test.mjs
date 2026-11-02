/**
 * Structural audit: clean ledgers pass, broken ones are named precisely.
 * @module codex-coordination/test/check
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { auditLedger } from '../plugins/codex-coordination/mcp/lib/check.mjs'
import { assignDuty, transitionDuty } from '../plugins/codex-coordination/mcp/lib/collaboration.mjs'
import { createGoal, transitionGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { createPlan, transitionPlan, updateTask } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { writeState } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { dutyPayload, goalPayload, makeWorkspace, planPayload, seedGoal, state, transact } from './helpers.mjs'

/**
 * Drive one goal/plan/duty set to a fully settled state.
 * @param {string} workspace - the workspace root.
 * @returns {Promise<void>} resolves when settled.
 */
async function settleEverything(workspace) {
  await transact(workspace, (context) => createGoal(context, goalPayload('audit-goal')))
  await transact(workspace, (context) => transitionGoal(context, 'audit-goal', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'audit-goal', 'active'))
  await transact(workspace, (context) => createPlan(context, planPayload('audit-plan', 'audit-goal')))
  await transact(workspace, (context) => transitionPlan(context, 'audit-plan', 'committed'))
  await transact(workspace, (context) => transitionPlan(context, 'audit-plan', 'executing'))
  await transact(workspace, (context) => updateTask(context, 'audit-plan', 'write-server', 'done'))
  await transact(workspace, (context) => updateTask(context, 'audit-plan', 'verify', 'done'))
  await transact(workspace, (context) => transitionPlan(context, 'audit-plan', 'done'))
  await transact(workspace, (context) => transitionGoal(context, 'audit-goal', 'achieved'))
  await transact(workspace, (context) => assignDuty(context, dutyPayload('audit-duty')))
  await transact(workspace, (context) => transitionDuty(context, { id: 'audit-duty', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'audit-duty', action: 'start', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, {
    id: 'audit-duty',
    action: 'submit',
    actor: 'codex-sub-1',
    summary: 'Ran the checks',
    evidence: ['node --test test -> 0 failures'],
  }))
  await transact(workspace, (context) => transitionDuty(context, {
    id: 'audit-duty',
    action: 'verify',
    actor: 'codex-main',
    review: 'Matched the recorded evidence',
  }))
}

test('a settled ledger audits clean and reports its shape', async (t) => {
  const workspace = makeWorkspace(t)
  await settleEverything(workspace)
  const verdict = auditLedger(state(workspace))
  assert.deepEqual(verdict.violations, [])
  assert.deepEqual(verdict.warnings, [])
  assert.equal(verdict.ok, true)
  assert.equal(verdict.summary.goals, 1)
  assert.equal(verdict.summary.plans, 1)
  assert.equal(verdict.summary.duties, 1)
  assert.equal(verdict.summary.chain.verified, true)
  assert.ok(verdict.summary.chain.count > 10)
  assert.match(verdict.summary.chain.tip, /^sha256:[0-9a-f]{64}$/)
})

test('an edited chain entry is a chain violation', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'chain')
  const document = state(workspace)
  document.journal[0].payload.value = 0.1
  writeState(workspace, document)

  const verdict = auditLedger(state(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations.some((violation) => violation.code === 'LEDGER_CHAIN'), true)
})

test('an injected dependency cycle is reported', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, (context) => createPlan(context, planPayload('cycle-plan')))
  const document = state(workspace)
  document.plans['cycle-plan'].artifact.tasks[0].pre = ['verify']
  writeState(workspace, document)

  const verdict = auditLedger(state(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations.some((violation) => violation.code === 'PLAN_CYCLE'), true)
})

test('an achieved goal with an open plan is reported', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'premature')
  await transact(workspace, (context) => transitionGoal(context, 'premature', 'committed'))
  await transact(workspace, (context) => transitionGoal(context, 'premature', 'active'))
  await transact(workspace, (context) => createPlan(context, planPayload('open-plan', 'premature')))

  const document = state(workspace)
  const goal = document.goals['premature']
  goal.lifecycle.state = 'achieved'
  goal.updatedAt = new Date().toISOString()
  goal.history.push({ at: goal.updatedAt, from: 'active', to: 'achieved' })
  writeState(workspace, document)

  const verdict = auditLedger(state(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations.some((violation) => violation.code === 'GOAL_ACHIEVED_WITH_PLAN'), true)
})

test('a verified duty without a review is reported', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => assignDuty(context, dutyPayload('no-review')))
  await transact(workspace, (context) => transitionDuty(context, { id: 'no-review', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'no-review', action: 'start', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, {
    id: 'no-review',
    action: 'submit',
    actor: 'codex-sub-1',
    summary: 'done',
    evidence: ['some output'],
  }))

  const document = state(workspace)
  const duty = document.duties['no-review']
  duty.status = 'verified'
  duty.updatedAt = new Date().toISOString()
  duty.history.push({ at: duty.updatedAt, from: 'submitted', to: 'verified' })
  writeState(workspace, document)

  const verdict = auditLedger(state(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations.some((violation) => violation.code === 'DUTY_REVIEW_MISSING'), true)
})

test('a plan artifact that stopped matching its key is reported', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, (context) => createPlan(context, planPayload('renamed-plan')))
  const document = state(workspace)
  document.plans['renamed-plan'].artifact.id = 'other-id'
  writeState(workspace, document)

  const verdict = auditLedger(state(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.violations.some((violation) => violation.code === 'PLAN_ARTIFACT_ID'), true)
})
