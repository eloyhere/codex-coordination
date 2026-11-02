#!/usr/bin/env node
/**
 * Export the strict AMP `ledger-snapshot` of one workspace.
 *
 * The snapshot is derived from the chain, verified before it is written, and
 * written through a temporary file plus `rename` so a reader never sees a partial
 * artifact. It is the same value `coordination_check` returns for
 * `action: "snapshot"`.
 *
 * Usage:
 *
 * ```
 * node scripts/amp-snapshot.mjs <workspace> [--json]
 * ```
 *
 * `--json` prints the snapshot on stdout instead of writing
 * `<workspace>/.codex-coordination/ledger-snapshot.json`. The exit code is 1 when
 * the chain does not verify — a broken chain is never exported.
 *
 * @module codex-coordination/scripts/amp-snapshot
 */

import { renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readState, resolveWorkspace, snapshotOf, verifySnapshot } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { CoordinationError } from '../plugins/codex-coordination/mcp/lib/amp.mjs'

/**
 * Print usage and exit.
 * @param {number} code - process exit code.
 * @returns {never}
 */
function usage(code) {
  const text = 'usage: node scripts/amp-snapshot.mjs <workspace> [--json]'
  if (code === 0) console.log(text)
  else console.error(text)
  process.exit(code)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) usage(0)
const json = args.includes('--json')
const positional = args.filter((argument) => !argument.startsWith('--'))
if (positional.length !== 1) usage(2)

try {
  const workspace = resolveWorkspace(positional[0])
  const state = readState(workspace)
  const snapshot = snapshotOf(state)
  const verdict = verifySnapshot(snapshot)
  if (!verdict.ok) {
    console.error(`FAIL the chain does not verify; refusing to export a snapshot`)
    for (const problem of verdict.problems) console.error(`  ${JSON.stringify(problem)}`)
    process.exit(1)
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    process.exit(0)
  }
  const path = join(workspace, '.codex-coordination', 'ledger-snapshot.json')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  console.log(`ok ${path} tip=${snapshot.tip} count=${snapshot.count}`)
  process.exit(0)
} catch (error) {
  if (error instanceof CoordinationError) {
    console.error(`FAIL ${error.code}: ${error.message}`)
    process.exit(1)
  }
  console.error(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
}
