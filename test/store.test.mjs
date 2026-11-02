/**
 * Ledger storage: atomic materialisation, the AMP chain and serialisation.
 * @module codex-coordination/test/store
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { GENESIS, DIGEST_PATTERN } from '../plugins/codex-coordination/mcp/lib/amp.mjs'
import {
  LEDGER_VERSION,
  ledgerPath,
  readState,
  resolveWorkspace,
  snapshotOf,
  verifyChain,
  verifySnapshot,
  writeState,
} from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { goalPayload, makeWorkspace, rejectsCode, seedGoal, transact, throwsCode } from './helpers.mjs'

test('a transaction materialises one verifiable ledger file', async (t) => {
  const workspace = makeWorkspace(t)
  const record = await transact(workspace, (context) => createGoal(context, goalPayload('first-goal')))

  assert.ok(existsSync(join(workspace, '.codex-coordination', 'ledger.json')))
  const state = readState(workspace)
  assert.equal(state.version, LEDGER_VERSION)
  assert.equal(state.count, 1)
  assert.equal(state.journal.length, 1)
  assert.deepEqual(Object.keys(state.journal[0]).sort(), ['at', 'hash', 'kind', 'payload', 'prev', 'seq'])
  assert.equal(state.journal[0].kind, 'goal')
  assert.equal(state.journal[0].seq, 0)
  assert.equal(state.journal[0].prev, GENESIS)
  assert.match(state.journal[0].hash, DIGEST_PATTERN)
  assert.deepEqual(state.journal[0].payload, record.artifact)
  assert.equal(state.tip, state.journal[0].hash)
  assert.equal(verifyChain(state).ok, true)
  assert.equal(ledgerPath(workspace), join(workspace, '.codex-coordination', 'ledger.json'))
})

test('an untouched workspace reads as an empty document with a genesis tip', (t) => {
  const workspace = makeWorkspace(t)
  const state = readState(workspace)
  assert.equal(state.count, 0)
  assert.equal(state.tip, GENESIS)
  assert.deepEqual(state.goals, {})
  assert.equal(verifyChain(state).ok, true)
  const snapshot = snapshotOf(state)
  assert.deepEqual(snapshot, { amp: '0.1', kind: 'ledger-snapshot', agent: 'codex-coordination', tip: GENESIS, count: 0, entries: [] })
  assert.equal(verifySnapshot(snapshot).ok, true)
})

test('the derived snapshot is exactly AMP ChainEntry values', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'snapshot-target')
  const snapshot = snapshotOf(readState(workspace))
  assert.equal(snapshot.kind, 'ledger-snapshot')
  assert.equal(snapshot.amp, '0.1')
  assert.equal(snapshot.count, 1)
  assert.equal(snapshot.tip, snapshot.entries[0].hash)
  assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), ['hash', 'kind', 'payload', 'prev', 'seq'])
  assert.equal('at' in snapshot.entries[0], false)
  assert.equal(verifySnapshot(snapshot).ok, true)
})

test('an edited payload is reported, not repaired', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'tamper-target')
  const state = readState(workspace)
  state.journal[0].payload.statement = 'A different outcome'
  writeState(workspace, state)

  const verdict = verifyChain(readState(workspace))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.problems.some((problem) => problem.code === 'HASH_MISMATCH'), true)
})

test('an edited tip, count or sequence is reported', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'tip-target')

  const tipState = readState(workspace)
  tipState.tip = `sha256:${'1'.repeat(64)}`
  writeState(workspace, tipState)
  assert.equal(verifyChain(readState(workspace)).problems.some((problem) => problem.code === 'TIP_MISMATCH'), true)

  const countState = readState(workspace)
  countState.count = 7
  writeState(workspace, countState)
  assert.equal(verifyChain(readState(workspace)).problems.some((problem) => problem.code === 'COUNT_MISMATCH'), true)

  const seqState = readState(workspace)
  seqState.journal[0].seq = 4
  writeState(workspace, seqState)
  assert.equal(verifyChain(readState(workspace)).problems.some((problem) => problem.code === 'SEQ_MISMATCH'), true)
})

test('concurrent transactions serialise without breaking the chain', async (t) => {
  const workspace = makeWorkspace(t)
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      transact(workspace, (context) => createGoal(context, goalPayload(`goal-${index}`)))),
  )
  const state = readState(workspace)
  assert.equal(state.count, 8)
  assert.equal(Object.keys(state.goals).length, 8)
  assert.equal(state.journal.length, 8)
  assert.equal(verifyChain(state).ok, true)
  assert.deepEqual(state.journal.map((entry) => entry.seq), [0, 1, 2, 3, 4, 5, 6, 7])
})

test('a rejected mutation leaves the file untouched', async (t) => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'kept')
  const before = readState(workspace)

  await rejectsCode(
    () => transact(workspace, (context) => createGoal(context, goalPayload('kept'))),
    'CONFLICT',
  )
  const after = readState(workspace)
  assert.equal(after.count, before.count)
  assert.equal(after.tip, before.tip)
  assert.equal(after.journal.length, before.journal.length)
})

test('a version 1 ledger is refused instead of re-chained', (t) => {
  const workspace = makeWorkspace(t)
  const path = ledgerPath(workspace)
  const directory = join(workspace, '.codex-coordination')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `${JSON.stringify({ amp: '0.1', kind: 'coordination-ledger', version: 1, journal: [] })}\n`, 'utf8')
  throwsCode(() => readState(workspace), 'INVALID_STATE', /version 1 is not supported/)
})

test('resolveWorkspace rejects relative paths and missing directories', async (t) => {
  const workspace = makeWorkspace(t)
  delete process.env.CODEX_COORDINATION_WORKSPACE
  assert.equal(resolveWorkspace(workspace), workspace)
  await rejectsCode(async () => resolveWorkspace('relative/path'), 'INVALID_ARGUMENT', /absolute/)
  await rejectsCode(async () => resolveWorkspace(join(workspace, 'nope')), 'NOT_FOUND', /does not exist/)
  await rejectsCode(async () => resolveWorkspace(''), 'INVALID_ARGUMENT', /workspace is required/)
})
