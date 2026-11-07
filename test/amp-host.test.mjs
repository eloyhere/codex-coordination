import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AmpHost, AMP_DEFINITIONS } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { syntax, database, semantic } from '../plugins/codex-coordination/mcp/amp/runtime.mjs'
import { workspaceToolDefinitions } from 'amp-legacy/protocol/workspace.js'
import { globalToolDefinitions } from 'amp-legacy/protocol/global.js'
import { filesystemToolDefinitions } from 'amp-legacy/protocol/filesystem.js'
import { globalFilesystemToolDefinitions } from 'amp-legacy/protocol/globalFilesystem.js'
import { controlToolDefinitions } from 'amp-legacy/protocol/control.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-amp-host-'))
  const workspace = join(directory, 'repository')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'probe.ts'), 'export const probe = 1\n')
  const host = new AmpHost({ databasePath: join(directory, 'host.sqlite') })
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }) })
  return { host, workspace, directory }
}

test('all 60 canonical tool definitions preserve the published AMP contracts', () => {
  const original = [...workspaceToolDefinitions(), ...globalToolDefinitions(), ...filesystemToolDefinitions(), ...globalFilesystemToolDefinitions(), ...controlToolDefinitions('session')]
  assert.equal(AMP_DEFINITIONS.length, 60)
  assert.deepEqual(AMP_DEFINITIONS, original)
  assert.equal(new Set(original.map(tool => tool.name)).size, original.length)
})

test('host migrates only the selected project legacy artifacts and keeps later writes local across switches', async t => {
  const { host, workspace, directory } = fixture(t)
  const id = `workspace.${semantic.digestOf(workspace).slice(7, 39)}`
  mkdirSync(join(directory, 'workspaces'))
  const sourcePath = join(directory, 'workspaces', id + '.sqlite')
  const source = new database.Database(sourcePath)
  const artifact = { amp: '0.1', kind: 'receipt', id: 'old-receipt', at: '2026-11-03T00:00:00Z', op: 'act', outcome: 'success', usage: {} }
  source.objectService.put('amp-artifact.receipt', artifact.id, artifact, artifact.at)
  source.close()
  const before = readFileSync(sourcePath)
  await host.select(workspace)
  assert.equal((await host.adapter('artifacts', { action: 'get', kind: 'receipt', id: artifact.id })).artifact.id, artifact.id)
  await host.adapter('artifacts', { action: 'record', artifact: { ...artifact, id: 'new-local-receipt' } })
  const other = join(directory, 'other'); mkdirSync(other)
  await host.select(other)
  await assert.rejects(host.adapter('artifacts', { action: 'get', kind: 'receipt', id: artifact.id }), /Unknown recorded/)
  await host.select(workspace)
  assert.equal((await host.adapter('artifacts', { action: 'get', kind: 'receipt', id: 'new-local-receipt' })).artifact.id, 'new-local-receipt')
  assert.deepEqual(readFileSync(sourcePath), before)
})

test('host binds sessions, preserves filesystem CAS and rejects forged scope and escaping paths', async t => {
  const { host, workspace } = fixture(t)
  await assert.rejects(host.call('amp_tool_workspace_capabilities', {}), { code: 'INVALID_STATE' })
  const status = await host.select(workspace)
  assert.ok(status.sessionId)
  assert.equal('token' in status, false)
  const read = await host.call('amp_tool_filesystem_read', { path: 'probe.ts' })
  assert.equal(read.ok, true, JSON.stringify(read))
  const rejected = await host.call('amp_tool_filesystem_read', { path: '../host.sqlite' })
  assert.equal(rejected.ok, false)
  const forged = await host.call('amp_tool_filesystem_read', { path: 'probe.ts', sessionId: 'other' })
  assert.equal(forged.ok, false)
  const stale = await host.call('amp_tool_filesystem_write', { path: 'probe.ts', content: 'wrong', expectFingerprint: `sha256:${'0'.repeat(64)}` })
  assert.equal(stale.ok, false)
  assert.equal(readFileSync(join(workspace, 'probe.ts'), 'utf8'), 'export const probe = 1\n')
  const dry = await host.call('amp_tool_filesystem_write', { path: 'probe.ts', content: 'dry run', dryRun: true })
  assert.equal(dry.ok, true, JSON.stringify(dry))
  assert.equal(readFileSync(join(workspace, 'probe.ts'), 'utf8'), 'export const probe = 1\n')
})

test('specialized registries persist versions and activate actual parser registries with workspace isolation', async t => {
  const { host, workspace, directory } = fixture(t)
  await host.select(workspace)
  const definition = { registry: 'languages', action: 'register', id: 'custom', value: { family: 'code', extensions: ['ampx'], keywords: ['special'] }, expectedVersion: 0 }
  const dry = await host.registry({ ...definition, dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(syntax.DefaultSyntaxRegistry.languages().some(value => value.id === 'custom'), false)
  assert.equal((await host.registry({ registry: 'languages', action: 'list' })).version, 0)
  assert.equal((await host.registry(definition)).version, 1)
  assert.equal(syntax.DefaultSyntaxRegistry.languages().some(value => value.id === 'custom'), true)
  await assert.rejects(host.registry(definition), /version_conflict/)
  await host.close()
  await host.select(workspace)
  assert.equal((await host.registry({ registry: 'languages', action: 'get', id: 'custom' })).entry.id, 'custom')
  const before = await host.call('amp_tool_filesystem_outline', { path: 'probe.ts' })
  assert.equal(before.ok, true, JSON.stringify(before))
  const strategy = before.data.strategy
  await host.registry({ registry: 'outlines', action: 'update', id: strategy, value: { template: strategy, language: 'amp-probe' }, expectedVersion: 0, dryRun: true })
  assert.equal((await host.call('amp_tool_filesystem_outline', { path: 'probe.ts' })).data.language, before.data.language)
  await host.registry({ registry: 'outlines', action: 'update', id: strategy, value: { template: strategy, language: 'amp-probe' }, expectedVersion: 0 })
  assert.equal((await host.call('amp_tool_filesystem_outline', { path: 'probe.ts' })).data.language, 'amp-probe')
  await assert.rejects(host.registry({ registry: 'outlines', action: 'invoke', id: 'not-registered', arguments: { path: 'probe.ts' } }), { code: 'NOT_FOUND' })
  const other = join(directory, 'other')
  mkdirSync(other)
  await host.select(other)
  assert.equal(syntax.DefaultSyntaxRegistry.languages().some(value => value.id === 'custom'), false)
})

test('metadata tool registrations execute only installed AMP handlers', async t => {
  const { host, workspace } = fixture(t)
  await host.select(workspace)
  await assert.rejects(host.registry({ registry: 'tools', action: 'register', id: 'bad', value: { target: 'arbitrary_code' } }), /installed AMP tool/)
  const registered = await host.registry({ registry: 'tools', action: 'register', id: 'read-probe', value: { target: 'amp_tool_filesystem_read' }, expectedVersion: 0 })
  assert.equal(registered.ok, true)
  const result = await host.registry({ registry: 'tools', action: 'invoke', id: 'read-probe', arguments: { path: 'probe.ts' } })
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('materialization requires a host frame and release keeps settlement accountable', async t => {
  const { host, workspace } = fixture(t)
  await host.select(workspace)
  const capabilities = await host.call('amp_tool_workspace_capabilities', {})
  const revision = capabilities.revision
  const tree = await host.call('amp_tool_workspace_tree', { revision, parentId: 'project:.' })
  assert.equal(tree.ok, true, JSON.stringify(tree))
  const target = tree.data.items.find(item => item.label === 'probe.ts')
  assert.ok(target, JSON.stringify(tree))
  const forged = await host.call('amp_tool_workspace_materialize', { revision, frameId: 'invented', budgetTokens: 1000 })
  assert.equal(forged.ok, false)
  const allocation = host.context({ action: 'allocate', targets: [target.id], budgetTokens: 1000 })
  const materialized = await host.call('amp_tool_workspace_materialize', { revision, frameId: allocation.frame.id, budgetTokens: 1000 })
  assert.equal(materialized.ok, true, JSON.stringify(materialized))
  const contextId = materialized.data.contextId
  assert.ok(contextId)
  assert.equal((await host.call('amp_tool_workspace_release', { revision, contextId })).ok, true)
  assert.equal(host.context({ action: 'pending' }).pending.length, 1)
  const settlement = host.context({ action: 'settle', contextId })
  assert.deepEqual(settlement.receipt.usage, {})
  assert.equal(host.context({ action: 'pending' }).pending.length, 0)
})
