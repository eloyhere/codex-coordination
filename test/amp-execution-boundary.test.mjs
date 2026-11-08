/**
 * Model-facing execution boundary: the native read-only catalog, the explicit
 * plugin-native I/O budget semantics, and admission errors for withheld writes.
 *
 * These tests deliberately stay on the surface factory: they exercise the same
 * handlers `tools/list` exposes, without claiming any business acceptance.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace } from './helpers.mjs'

const WRITE_TOOL = 'attention_manifest_protocol_workspace.write'
const REPLACE_TOOL = 'attention_manifest_protocol_replace'
const NATIVE_READ_QUOTA = { calls: 1000, bytes: 64 * 1024 * 1024, milliseconds: 3600000, tokens: 0, retries: 0, concurrency: 8 }
const pin = toolId => ({ toolId, digest: 'sha256:' + '0'.repeat(64) })

function surfaceFor(root) {
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  return { tools, call }
}

test('budget.remaining reports explicit plugin-native I/O fields and keeps the native-read quota', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'quota.txt'), 'visible\n')
  const { call } = surfaceFor(root)

  const fresh = await call('budget.remaining')
  assert.equal(fresh.usageScope, 'plugin-native-io')
  assert.equal(fresh.tokens, 0, 'tokens is a literal zero, not a Codex token counter')
  assert.equal(fresh.notCodexTokenUsage, true)
  assert.equal(fresh.quotaSource, 'host-fixed')
  assert.equal(fresh.configured, false)
  assert.deepEqual({ ...fresh.snapshot.limit }, NATIVE_READ_QUOTA, 'unconfigured reads report the host-fixed native I/O quota')
  assert.deepEqual(fresh.snapshot.settled, {})

  const direct = await call('workspace.read', { path: 'quota.txt' })
  assert.equal(direct.text, 'visible\n')

  const used = await call('budget.remaining')
  assert.equal(used.usageScope, 'plugin-native-io')
  assert.equal(used.tokens, 0)
  assert.equal(used.notCodexTokenUsage, true)
  assert.equal(used.quotaSource, 'host-fixed')
  assert.equal(used.configured, true)
  assert.equal(used.snapshot.settled.calls, 1)
  assert.deepEqual({ ...used.snapshot.limit }, NATIVE_READ_QUOTA, 'the durable native-read ledger still reports its I/O quota')
  assert.equal(used.snapshot.limit.tokens, 0, 'the native I/O quota itself never meters Codex tokens')
})

test('execution.find_tools never ranks write or replace contracts for write/edit/replace queries', async t => {
  const root = makeWorkspace(t)
  const { tools, call } = surfaceFor(root)
  const names = tools.map(tool => tool.name)
  // Non-vacuity: the withheld tools really do exist on the surface.
  assert.ok(names.includes(WRITE_TOOL), 'workspace.write is registered on the surface')
  assert.ok(names.includes(REPLACE_TOOL), 'replace is registered on the surface')

  const baseline = await call('execution.find_tools', { query: 'workspace', limit: 20 })
  assert.ok(baseline.tools.length > 0, 'read-only workspace contracts stay discoverable')
  assert.ok(baseline.tools.every(item => item.tool.effect === 'read_only' && item.tool.risk === 'read'), 'every ranked contract is read-only')

  for (const query of ['write', 'edit', 'replace', 'workspace.write', 'write edit replace', 'workspace write replace']) {
    const found = await call('execution.find_tools', { query, limit: 20 })
    assert.equal(found.considered, baseline.considered, `query "${query}" searches the same admitted read-only catalog`)
    assert.equal(found.tools.some(item => item.pinned.toolId === WRITE_TOOL || item.pinned.toolId === REPLACE_TOOL), false, `query "${query}" must not return workspace.write or replace`)
    assert.equal(found.tools.some(item => item.tool.effect !== 'read_only' || item.tool.risk !== 'read'), false, `query "${query}" must not return a write contract`)
  }
})

test('execution.run and inspect_tool reject write/replace ids and unknown pinned digests without charging the ledger', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'note.txt'), 'note\n')
  const { tools, call } = surfaceFor(root)

  const direct = await call('workspace.read', { path: 'note.txt' })
  assert.equal(direct.text, 'note\n')
  assert.equal((await call('budget.remaining')).snapshot.settled.calls, 1)

  const found = await call('execution.find_tools', { query: 'project rules', limit: 20 })
  const rules = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_project.rules')
  assert.ok(rules, 'a read contract is available for the stale-digest case')

  for (const toolId of [WRITE_TOOL, REPLACE_TOOL]) {
    await assert.rejects(call('execution.run', { idempotencyKey: 'withheld-' + toolId, calls: [{ id: 'one', ...pin(toolId), arguments: {} }] }), /not admitted to read-only execution/, `execution.run must refuse ${toolId}`)
    await assert.rejects(call('execution.inspect_tool', pin(toolId)), /not admitted to read-only execution/, `execution.inspect_tool must refuse ${toolId}`)
  }
  await assert.rejects(call('execution.run', { idempotencyKey: 'unknown-digest', calls: [{ id: 'one', toolId: rules.pinned.toolId, digest: 'sha256:' + 'f'.repeat(64), arguments: {} }] }), /Unknown or stale tool contract/, 'a wrong digest for an admitted read contract is refused clearly')

  const budget = await call('budget.remaining')
  assert.equal(budget.snapshot.settled.calls, 1, 'refused admissions are not charged to the native I/O ledger')
  const { store } = openNativeStore(() => root)
  try {
    assert.equal(store.events({ kind: 'codex.amp.execution.started' }).length, 0, 'refused admissions never journal an execution')
    assert.equal(store.events({ kind: 'codex.amp.read.finished' }).length, 1, 'only the direct read was settled')
  } finally { store.close() }

  const run = tools.find(tool => tool.name === 'attention_manifest_protocol_execution.run')
  assert.match(run.description, /workspace\.write/)
  assert.match(run.description, /not admitted to execution\.run/)

  const writable = tools.find(tool => tool.name === WRITE_TOOL)
  assert.equal(writable.annotations?.readOnlyHint, false, 'workspace.write itself stays mutating')
})
