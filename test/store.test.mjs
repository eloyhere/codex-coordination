/**
 * Ledger storage: atomic materialisation, chained journal, serialisation.
 * @module codex-coordination/test/store
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import {
  ledgerPath,
  readState,
  resolveWorkspace,
  verifyJournal,
  writeState,
} from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { goalPayload, makeWorkspace, rejectsCode, transact } from './helpers.mjs'

test('a transaction materialises one verifiable ledger file', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('first-goal')))

  assert.ok(existsSync(join(workspace, '.codex-coordination', 'ledger.json')))
  const state = readState(workspace)
  assert.equal(state.version, 1)
  assert.equal(state.seq, 1)
  assert.equal(state.journal.length, 1)
  assert.equal(state.journal[0].type, 'goal/created')
  assert.equal(state.journal[0].id, 'first-goal')
  assert.equal(typeof state.head, 'string')
  assert.equal(verifyJournal(state).ok, true)
  assert.equal(ledgerPath(workspace), join(workspace, '.codex-coordination', 'ledger.json'))
})

test('an untouched workspace reads as an empty document', (t) => {
  const workspace = makeWorkspace(t)
  const state = readState(workspace)
  assert.equal(state.seq, 0)
  assert.equal(state.head, null)
  assert.deepEqual(state.goals, {})
  assert.equal(verifyJournal(state).ok, true)
})

test('an edited digest is reported, not repaired', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('tamper-target')))
  const state = readState(workspace)
  state.journal[0].digest = 'deadbeef'
  writeState(workspace, state)

  const verdict = verifyJournal(readState(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.problems.some((problem) => problem.code === 'DIGEST_MISMATCH'), true)
})

test('concurrent transactions serialise without breaking the chain', async (t) => {
  const workspace = makeWorkspace(t)
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      transact(workspace, (context) => createGoal(context, goalPayload(`goal-${index}`)))),
  )
  const state = readState(workspace)
  assert.equal(state.seq, 8)
  assert.equal(Object.keys(state.goals).length, 8)
  assert.equal(state.journal.length, 8)
  assert.equal(verifyJournal(state).ok, true)
  // Sequence numbers are contiguous even though the promises settled in any order.
  assert.deepEqual(state.journal.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7, 8])
})

test('a rejected mutation leaves the file untouched', async (t) => {
  const workspace = makeWorkspace(t)
  await transact(workspace, (context) => createGoal(context, goalPayload('kept')))
  const before = readState(workspace)

  await rejectsCode(
    () => transact(workspace, (context) => createGoal(context, goalPayload('kept'))),
    'CONFLICT',
  )
  const after = readState(workspace)
  assert.equal(after.seq, before.seq)
  assert.equal(after.head, before.head)
  assert.equal(after.journal.length, before.journal.length)
})

test('resolveWorkspace rejects relative paths and missing directories', async (t) => {
  const workspace = makeWorkspace(t)
  delete process.env.CODEX_COORDINATION_WORKSPACE
  assert.equal(resolveWorkspace(workspace), workspace)
  await rejectsCode(async () => resolveWorkspace('relative/path'), 'INVALID_ARGUMENT', /absolute/)
  await rejectsCode(async () => resolveWorkspace(join(workspace, 'nope')), 'NOT_FOUND', /does not exist/)
  await rejectsCode(async () => resolveWorkspace(''), 'INVALID_ARGUMENT', /workspace is required/)
})
