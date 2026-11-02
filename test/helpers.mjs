/**
 * Shared test helpers.
 *
 * Every test owns a fresh temporary workspace: the ledger is a file on disk, so
 * isolation means a new directory, not a mocked store. `makeWorkspace` registers
 * its own cleanup with the test context so a failing assertion cannot leave a
 * `.codex-coordination` directory behind.
 *
 * @module codex-coordination/test/helpers
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoordinationError } from '../plugins/codex-coordination/mcp/lib/amp.mjs'
import { readState, withLedger } from '../plugins/codex-coordination/mcp/lib/store.mjs'

/**
 * Create a temporary workspace and register its cleanup.
 * @param {import('node:test').TestContext} t - the running test context.
 * @returns {string} the absolute workspace root.
 */
export function makeWorkspace(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-coordination-test-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  return workspace
}

/**
 * Run one ledger transaction.
 * @param {string} workspace - the workspace root.
 * @param {(context: { state: Record<string, any>, record: Function }) => any} operation - the mutation.
 * @returns {Promise<any>} the operation result.
 */
export function transact(workspace, operation) {
  return withLedger(workspace, operation)
}

/**
 * Read the ledger without holding the write slot.
 * @param {string} workspace - the workspace root.
 * @returns {Record<string, any>} the document.
 */
export function state(workspace) {
  return readState(workspace)
}

/**
 * Assert that a function throws a typed coordination error.
 * @param {() => any} operation - the call under test.
 * @param {string} code - expected {@link CoordinationError} code.
 * @param {RegExp} [message] - expected message fragment.
 * @returns {CoordinationError} the caught error.
 */
export function throwsCode(operation, code, message) {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof CoordinationError, `expected CoordinationError, got ${String(error)}`)
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return error
  }
  assert.fail(`expected ${code}, but nothing was thrown`)
}

/**
 * Assert that an async operation rejects with a typed coordination error.
 * @param {() => Promise<any>} operation - the call under test.
 * @param {string} code - expected {@link CoordinationError} code.
 * @param {RegExp} [message] - expected message fragment.
 * @returns {Promise<void>} resolves when the assertion held.
 */
export async function rejectsCode(operation, code, message) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof CoordinationError, `expected CoordinationError, got ${String(error)}`)
    assert.equal(error.code, code)
    if (message !== undefined) assert.match(error.message, message)
    return true
  })
}

/**
 * A minimal valid goal payload.
 * @param {string} id - goal id.
 * @returns {Record<string, unknown>} the payload.
 */
export function goalPayload(id = 'ship-it') {
  return {
    amp: '0.1',
    kind: 'goal',
    id,
    statement: 'Ship the coordination plugin',
    success: [
      { id: 'smoke', statement: 'the smoke script exits 0', check: 'run node scripts/mcp-smoke.mjs' },
    ],
    value: 0.6,
    priority: 1,
    horizon: 'task',
  }
}

/**
 * A minimal valid plan payload with one task.
 * @param {string} id - plan id.
 * @param {{ goal?: string }} [options] - optional goal reference.
 * @returns {Record<string, unknown>} the payload.
 */
export function planPayload(id = 'ship-plan', options = {}) {
  return {
    amp: '0.1',
    kind: 'plan',
    id,
    ...(options.goal === undefined ? {} : { goal: { kind: 'goal', id: options.goal } }),
    commitmentWindow: 2,
    tasks: [
      {
        id: 'write-server',
        intent: 'Write the MCP server',
        actor: 'self',
        expect: { observation: 'tools/list answers', check: 'run the smoke script' },
      },
      {
        id: 'verify',
        intent: 'Call every tool once',
        actor: 'tool',
        pre: ['write-server'],
        expect: { observation: 'every tool returns ok', check: 'run the smoke script' },
      },
    ],
  }
}

/**
 * A minimal valid duty payload.
 * @param {string} id - duty id.
 * @returns {Record<string, unknown>} the payload.
 */
export function dutyPayload(id = 'review-work') {
  return {
    id,
    role: 'qualification',
    owner: 'codex-main',
    assignee: 'codex-sub-1',
    responsibilities: ['Re-run the smoke script and report the observed output'],
    acceptance: ['The reported output matches the run'],
  }
}
