import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BudgetLedger } from 'attention-manifest-protocol/budget'
import { bindBudget } from 'attention-manifest-protocol/persistence'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace } from './helpers.mjs'

test('direct native reads share the executor quota and cannot bypass an exhausted ledger', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'quota.txt'), 'visible\n')
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const found = await call('execution.find_tools', { query: 'attention_manifest_protocol_workspace.read', limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_workspace.read').pinned
  const direct = await call('workspace.read', { path: 'quota.txt' })
  assert.equal(direct.text, 'visible\n')
  assert.equal((await call('budget.remaining')).snapshot.settled.calls, 1)
  const batch = await call('execution.run', { idempotencyKey: 'single-charge', calls: [{ id: 'one', ...pinned, arguments: { path: 'quota.txt' } }] })
  assert.equal(batch.execution.children[0].observation.status, 'success')
  const current = (await call('budget.remaining')).snapshot
  assert.equal(current.settled.calls, 2, 'executor must not double-debit direct-call wrappers')
  const { store } = openNativeStore(() => root)
  try {
    const bound = bindBudget(store, new BudgetLedger()); bound.rehydrate()
    bound.configure('native-read:codex', { ...current.limit, calls: current.settled.calls })
  } finally { store.close() }
  await assert.rejects(call('workspace.read', { path: 'quota.txt' }), /Reservation would exceed/)
  const denied = await call('execution.run', { idempotencyKey: 'quota-empty', calls: [{ id: 'denied', ...pinned, arguments: { path: 'quota.txt' } }] })
  assert.equal(denied.execution.children[0].observation.status, 'failure')
  assert.match(denied.execution.children[0].failure, /Reservation would exceed/)
  assert.equal((await call('budget.remaining')).snapshot.settled.calls, 2)
})

test('native execution pins read contracts, persists budgets/receipts and blocks unresolved retries', async t => {
  const root = makeWorkspace(t)
  const other = makeWorkspace(t)
  let workspace = root
  const tools = withAmpSurface([], () => workspace)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const found = await call('execution.find_tools', { query: 'project rules', limit: 20 })
  const candidate = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_project.rules')
  assert.ok(candidate)
  assert.equal((await call('execution.inspect_tool', candidate.pinned)).tool.effect, 'read_only')
  await assert.rejects(call('execution.inspect_tool', { ...candidate.pinned, digest: 'stale' }), /stale/)
  const request = { idempotencyKey: 'read-1', calls: [{ id: 'one', ...candidate.pinned, arguments: {} }] }
  const first = await call('execution.run', request)
  assert.equal(first.execution.children[0].observation.status, 'success', JSON.stringify(first.execution))
  assert.equal(first.receipts[0].lifecycle, 'issued')
  assert.equal(first.businessVerification, 'not_performed')
  assert.equal((await call('execution.run', request)).replayed, true)
  const budget = await call('budget.remaining')
  assert.equal(budget.snapshot.settled.calls, 1)
  assert.equal((await call('execution.read_handle', { id: first.resultHandle.id, limit: 1 })).page.items.length, 1)
  workspace = other
  await assert.rejects(call('execution.read_handle', { id: first.resultHandle.id }), /scope|session/i)
  workspace = root
  const batch = await call('execution.run', { idempotencyKey: 'batch', calls: [{ id: 'two', ...candidate.pinned, arguments: {} }, { id: 'three', ...candidate.pinned, arguments: {} }] })
  assert.ok(batch.execution.children.every(child => child.observation.status === 'success'), JSON.stringify(batch.execution))
  assert.equal((await call('budget.remaining')).snapshot.settled.calls, 3)
  await assert.rejects(call('execution.run', { ...request, calls: [{ ...request.calls[0], arguments: { unexpected: true } }] }), /Idempotency/)
  await assert.rejects(call('execution.run', { idempotencyKey: 'write', calls: [{ id: 'write', toolId: 'attention_manifest_protocol_project.put_rule', digest: 'made-up', arguments: {} }] }), /stale/)
  const restarted = withAmpSurface([], () => root)
  assert.equal((await restarted.find(tool => tool.name === 'attention_manifest_protocol_execution.run').handler(request)).replayed, true)
  await assert.rejects(restarted.find(tool => tool.name === 'attention_manifest_protocol_execution.read_handle').handler({ id: first.resultHandle.id }), /handle/i)
  const { store } = openNativeStore(() => root)
  try {
    assert.equal(store.list('receipt').length, 3)
    assert.ok(store.list('budget_reservation').every(item => item.state === 'settled'))
    store.appendEvent('codex.amp.execution.started', { key: 'codex:interrupted', request: JSON.stringify({ calls: [], idempotencyKey: 'interrupted' }), runId: 'interrupted-run' })
  } finally { store.close() }
  await assert.rejects(call('execution.run', { calls: [], idempotencyKey: 'interrupted' }), /unresolved/)
})
