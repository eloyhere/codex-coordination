import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_INTERFACES } from '../plugins/codex-coordination/mcp/contracts.mjs'
import { settingsView, withSettingsWorkspaceGuard } from '../plugins/codex-coordination/mcp/lib/settings.mjs'
import { wrapLegacyTools } from '../plugins/codex-coordination/mcp/amp/legacy-policy.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { makeWorkspace } from './helpers.mjs'

test('settings view uses actual registered schemas without reading business ledgers or creating storage', t => {
  const root = makeWorkspace(t)
  const tools = SETTINGS_INTERFACES.map(({ name }) => ({ name, description: name, inputSchema: { type: 'object', properties: { action: { enum: ['list'] } } }, async handler() { throw new Error('must not execute for metadata') } }))
  const empty = settingsView(undefined, tools)
  assert.equal(empty.workspace, null)
  assert.deepEqual(empty.interfaces.map(item => item.name), SETTINGS_INTERFACES.map(item => item.name))
  settingsView(root, tools)
  assert.equal(existsSync(join(root, '.codex-coordination')), false)
  mkdirSync(join(root, '.codex-coordination'))
  const path = join(root, '.codex-coordination', 'ledger.json')
  writeFileSync(path, 'deliberately invalid ledger')
  const before = readFileSync(path)
  const view = settingsView(root, tools.slice(0, 1))
  assert.equal(view.workspace, realpathSync(root))
  assert.equal(view.view, 'settings')
  assert.equal(view.interfaces.length, 1)
  assert.equal('status' in view || 'records' in view || 'ampSession' in view, false)
  assert.deepEqual(readFileSync(path), before)
})

test('settings project guard rejects stale bindings and strips its pin before native dispatch', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  let selected = root, dispatched = []
  const raw = { name: 'coordination_environment', description: 'settings', inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string' } } }, async handler(args) { dispatched.push(args); return { ok: true } } }
  const tool = withSettingsWorkspaceGuard([raw], () => selected)[0]
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.ok(tool.inputSchema.properties.expectedWorkspace)
  await tool.handler({ action: 'list', expectedWorkspace: root })
  assert.deepEqual(dispatched, [{ action: 'list' }])
  selected = other
  await assert.rejects(tool.handler({ action: 'set', expectedWorkspace: root }), /binding changed/)
  assert.equal(dispatched.length, 1)
  await tool.handler({ action: 'list' })
  assert.equal(dispatched.length, 2)
})

test('settings pin preserves native host approval and rejects workspace changes during approval', async t => {
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  const root = makeWorkspace(t), other = makeWorkspace(t)
  let selected = root, writes = 0
  const raw = { name: 'coordination_registry', description: 'registry', inputSchema: { type: 'object' }, async handler() { writes++; return { ok: true } } }
  const tool = withSettingsWorkspaceGuard(wrapLegacyTools([raw], () => selected), () => selected)[0]
  configureHostClient({}, () => {})
  const input = { action: 'register', registry: 'skills', id: 'setting', value: {}, expectedWorkspace: root }
  await assert.rejects(tool.handler(input), /approval was not granted/)
  assert.equal(writes, 0)
  configureHostClient({ elicitation: {} }, message => {
    selected = other
    queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  await assert.rejects(tool.handler(input), /Workspace changed/)
  assert.equal(writes, 0)
})
