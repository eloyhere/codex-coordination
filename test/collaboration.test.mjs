/**
 * Duties, handoffs and the owner/assignee authority split.
 * @module codex-coordination/test/collaboration
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assignDuty,
  getDuty,
  listDuties,
  normaliseDutyInput,
  pendingDutyActions,
  transitionDuty,
} from '../plugins/codex-coordination/mcp/lib/collaboration.mjs'
import { createPlan } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { dutyPayload, makeWorkspace, planPayload, rejectsCode, state, throwsCode, transact } from './helpers.mjs'

test('a duty needs two distinct declared identities', () => {
  throwsCode(
    () => normaliseDutyInput({ goals: {}, plans: {}, duties: {} }, { ...dutyPayload(), assignee: 'codex-main' }),
    'INVALID_ARGUMENT',
    /must differ/,
  )
  throwsCode(
    () => normaliseDutyInput({ goals: {}, plans: {}, duties: {} }, { ...dutyPayload(), acceptance: [] }),
    'INVALID_ARGUMENT',
    /acceptance/,
  )
})

test('the full handoff path records evidence and the owner review', async (t) => {
  const workspace = makeWorkspace(t)
  const assigned = await transact(workspace, (context) => assignDuty(context, dutyPayload('review-it')))
  assert.equal(assigned.status, 'assigned')
  assert.deepEqual(assigned.history[0].actor, 'codex-main')

  await transact(workspace, (context) => transitionDuty(context, { id: 'review-it', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'review-it', action: 'start', actor: 'codex-sub-1' }))
  const submitted = await transact(workspace, (context) => transitionDuty(context, {
    id: 'review-it',
    action: 'submit',
    actor: 'codex-sub-1',
    summary: 'Ran the smoke script twice',
    evidence: ['node scripts/mcp-smoke.mjs -> exit 0', 'node --test test -> 0 failures'],
  }))
  assert.equal(submitted.status, 'submitted')
  assert.equal(submitted.evidence.length, 2)

  const verified = await transact(workspace, (context) => transitionDuty(context, {
    id: 'review-it',
    action: 'verify',
    actor: 'codex-main',
    review: 'Re-ran both commands; results match',
  }))
  assert.equal(verified.status, 'verified')
  assert.equal(verified.review, 'Re-ran both commands; results match')
  assert.equal(pendingDutyActions(state(workspace)).length, 0)
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'review-it', action: 'cancel', actor: 'codex-main' })),
    'INVALID_STATE',
    /closed/,
  )
})

test('only the recorded side may move a duty', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => assignDuty(context, dutyPayload('guarded')))
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'guarded', action: 'accept', actor: 'codex-main' })),
    'PERMISSION',
    /only the assignee/,
  )
  await transact(workspace, (context) => transitionDuty(context, { id: 'guarded', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'guarded', action: 'start', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, {
    id: 'guarded',
    action: 'submit',
    actor: 'codex-sub-1',
    summary: 'done',
    evidence: ['observed output'],
  }))
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'guarded', action: 'verify', actor: 'codex-sub-1', review: 'self-certified' })),
    'PERMISSION',
    /only the owner/,
  )
})

test('submit and verify demand their records', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => assignDuty(context, dutyPayload('evidence')))
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'evidence', action: 'submit', actor: 'codex-sub-1', summary: 'did it', evidence: [] })),
    'INVALID_STATE',
    /cannot move/,
  )
  await transact(workspace, (context) => transitionDuty(context, { id: 'evidence', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'evidence', action: 'start', actor: 'codex-sub-1' }))
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'evidence', action: 'submit', actor: 'codex-sub-1', summary: 'did it', evidence: [] })),
    'INVALID_ARGUMENT',
    /evidence must contain 1-32/,
  )
  await rejectsCode(
    () => transact(workspace, (context) => transitionDuty(context, { id: 'evidence', action: 'verify', actor: 'codex-main', review: 'ok' })),
    'INVALID_STATE',
    /cannot move/,
  )
})

test('a rejected duty can be accepted again', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => assignDuty(context, dutyPayload('rework')))
  await transact(workspace, (context) => transitionDuty(context, { id: 'rework', action: 'accept', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, { id: 'rework', action: 'start', actor: 'codex-sub-1' }))
  await transact(workspace, (context) => transitionDuty(context, {
    id: 'rework',
    action: 'submit',
    actor: 'codex-sub-1',
    summary: 'First attempt',
    evidence: ['partial output'],
  }))
  const rejected = await transact(workspace, (context) => transitionDuty(context, {
    id: 'rework',
    action: 'reject',
    actor: 'codex-main',
    review: 'Evidence does not cover commands 3-5',
  }))
  assert.equal(rejected.status, 'rejected')
  const reaccepted = await transact(workspace, (context) => transitionDuty(context, { id: 'rework', action: 'accept', actor: 'codex-sub-1' }))
  assert.equal(reaccepted.status, 'accepted')
})

test('a plan task reference is validated against the ledger', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createPlan(context, planPayload('ref-plan')))
  await rejectsCode(
    () => transact(workspace, (context) => assignDuty(context, { ...dutyPayload('bad-ref'), plan: 'missing-plan' })),
    'NOT_FOUND',
    /does not exist/,
  )
  await rejectsCode(
    () => transact(workspace, (context) => assignDuty(context, { ...dutyPayload('bad-task'), plan: 'ref-plan', task: 'ghost' })),
    'NOT_FOUND',
    /ghost/,
  )
  const duty = await transact(workspace, (context) => assignDuty(context, { ...dutyPayload('good-ref'), plan: 'ref-plan', task: 'verify' }))
  assert.deepEqual(duty.reference, { kind: 'task', plan: 'ref-plan', id: 'verify' })
  assert.deepEqual(getDuty(state(workspace), 'good-ref').reference, duty.reference)
  assert.equal(listDuties(state(workspace), { status: 'assigned' }).length, 1)
})
