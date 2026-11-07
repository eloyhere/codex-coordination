import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { createPlan } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { transitionGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { ledgerPath } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { makeWorkspace, seedGoal, transact, planPayload } from './helpers.mjs'

test('verified legacy ledger imports as suspended native facts with original source and no acceptance claims', async t => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'ship-it')
  await transact(workspace, context => createPlan(context, planPayload('old-plan')))
  const original = readFileSync(ledgerPath(workspace), 'utf8')
  const tool = () => withAmpSurface([], () => workspace).find(tool => tool.name === 'attention_manifest_protocol_migration')
  const preview = await tool().handler({ action: 'preview' })
  assert.equal(preview.goals, 1)
  assert.equal(preview.plans, 1)
  await assert.rejects(tool().handler({ action: 'import', sourceDigest: '0'.repeat(64) }), /sourceDigest/)
  const imported = await tool().handler({ action: 'import', sourceDigest: preview.sourceDigest })
  assert.equal(imported.replayed, false)
  assert.equal((await tool().handler({ action: 'import', sourceDigest: preview.sourceDigest })).replayed, true)
  const { store } = openNativeStore(() => workspace)
  try {
    assert.equal(store.list('session')[0].state, 'suspended')
    assert.equal(store.list('goal')[0].validity, 'verification_pending')
    assert.equal(store.list('goal')[0].state, 'proposed')
    assert.equal(store.list('plan')[0].state, 'draft')
    const tasks = store.list('task')
    assert.equal(tasks.length, 2)
    assert.ok(tasks.every(task => task.state === 'pending'))
    assert.equal(tasks.find(task => task.id.endsWith(':verify')).dependsOn[0], tasks.find(task => task.id.endsWith(':write-server')).id)
    assert.equal(store.events({ kind: 'codex.amp.legacy_import' })[0].payload.originalText, original)
  } finally { store.close() }
  assert.equal(readFileSync(ledgerPath(workspace), 'utf8'), original)
  assert.equal((await tool().handler({ action: 'status' })).imports.length, 1)
  await seedGoal(workspace, 'second-goal')
  await assert.rejects(tool().handler({ action: 'import', sourceDigest: preview.sourceDigest }), /sourceDigest/)
  const next = await tool().handler({ action: 'preview' })
  await tool().handler({ action: 'import', sourceDigest: next.sourceDigest })
  assert.equal((await tool().handler({ action: 'status' })).imports.length, 2)
  const reopened = openNativeStore(() => workspace).store
  try {
    assert.equal(reopened.list('goal').length, 3)
    assert.equal(reopened.list('session').length, 2)
  } finally { reopened.close() }
})

test('legacy achievement stays historical and never becomes native verification', async t => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'historical')
  for (const next of ['committed', 'active', 'achieved']) await transact(workspace, context => transitionGoal(context, 'historical', next))
  const tool = withAmpSurface([], () => workspace).find(tool => tool.name === 'attention_manifest_protocol_migration')
  const preview = await tool.handler({ action: 'preview' })
  await tool.handler({ action: 'import', sourceDigest: preview.sourceDigest })
  const { store } = openNativeStore(() => workspace)
  try {
    const goal = store.list('goal')[0]
    assert.equal(goal.state, 'proposed')
    assert.equal(goal.validity, 'verification_pending')
    assert.equal(goal.assessment, undefined)
    const archived = JSON.parse(store.events({ kind: 'codex.amp.legacy_import' })[0].payload.originalText)
    assert.equal(archived.goals.historical.lifecycle.state, 'achieved')
  } finally { store.close() }
})

test('damaged legacy chains are refused before a native store is created', async t => {
  const workspace = makeWorkspace(t)
  await seedGoal(workspace, 'original')
  const source = JSON.parse(readFileSync(ledgerPath(workspace), 'utf8'))
  source.journal[0].hash = '0'.repeat(64)
  writeFileSync(ledgerPath(workspace), JSON.stringify(source))
  const tool = withAmpSurface([], () => workspace).find(tool => tool.name === 'attention_manifest_protocol_migration')
  await assert.rejects(tool.handler({ action: 'preview' }), /failed audit/)
  assert.equal(existsSync(join(workspace, '.codex-coordination', 'amp-07')), false)
})

test('canonical native workflow reads require connection scope and reject cross-snapshot/workspace identities', async t => {
  const first = makeWorkspace(t), second = makeWorkspace(t)
  let workspace = first
  await seedGoal(first, 'ship-it')
  await transact(first, context => createPlan(context, planPayload('native-plan')))
  const tools = withAmpSurface([], () => workspace)
  const call = (name, args = {}) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  const preview = await call('migration', { action: 'preview' })
  const imported = await call('migration', { action: 'import', sourceDigest: preview.sourceDigest })
  await assert.rejects(call('goal.list'), /Select an imported native workflow/)
  await call('workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest })
  assert.equal((await call('goal.list')).entities[0].id, imported.references['goal:ship-it'])
  assert.equal((await call('goal.get', { id: imported.references['goal:ship-it'] })).entity.validity, 'verification_pending')
  assert.equal((await call('plan.ready_tasks', { id: imported.references['plan:native-plan'] })).tasks.length, 0)
  assert.equal((await call('task.list_ready')).executionAuthorized, false)
  await assert.rejects(call('goal.list', { sessionId: 'spoof' }))
  await seedGoal(first, 'new-source')
  const newer = await call('migration', { action: 'preview' })
  const next = await call('migration', { action: 'import', sourceDigest: newer.sourceDigest })
  await assert.rejects(call('goal.get', { id: next.references['goal:ship-it'] }), /outside the selected/)
  workspace = second
  assert.equal((await call('workflow_scope', { action: 'current' })).selected, null)
  await assert.rejects(call('workflow_scope', { action: 'select', sourceDigest: preview.sourceDigest }), /No imported workflow/)
  workspace = first
  assert.equal((await call('goal.list')).total, 1)
  const restarted = withAmpSurface([], () => first)
  await assert.rejects(restarted.find(tool => tool.name === 'attention_manifest_protocol_goal.list').handler({}), /Select an imported native workflow/)
})
