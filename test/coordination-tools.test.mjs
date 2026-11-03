import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AmpHost } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { TOOLS, toolNamed } from '../plugins/codex-coordination/mcp/lib/tools.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
import { advertisedSchema } from '../plugins/codex-coordination/mcp/coordination/schema.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-copied-tools-'))
  const workspace = join(directory, 'repo'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'copied-tools', scripts: { test: 'node -e "process.exit(0)"' } }))
  writeFileSync(join(workspace, 'a.ts'), 'export const answer = 42\n')
  writeFileSync(join(workspace, 'b.ts'), 'import { answer } from "./a"\nexport { answer } from "./a"\nexport const value = answer\n')
  mkdirSync(join(workspace, '.codex-coordination')); writeFileSync(join(workspace, '.codex-coordination/private.txt'), 'private host state')
  const host = new AmpHost({ databasePath: join(directory, 'host.sqlite') })
  host.setToolCatalog(TOOLS)
  await host.select(workspace)
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }) })
  return { host, workspace, directory }
}
test('all 24 copied registrations retain formal names and project has a native port', () => {
  const definitions = JSON.parse(readFileSync('src/mcp/coordination/catalog.json', 'utf8'))
  assert.equal(definitions.length, 24)
  const snapshot = JSON.parse(readFileSync('vendor/coordination-runtime/SNAPSHOT.json', 'utf8'))
  assert.deepEqual(definitions.map(item => item.name).sort(), [...snapshot.tools].sort())
  for (const definition of definitions) assert.ok(toolNamed(definition.name), definition.name)
  assert.ok(toolNamed('coordination_project'))
  assert.equal(TOOLS.length, 98)
  const read = toolNamed('coordination_read')
  assert.ok(read.inputSchema.properties.mode.description)
  assert.equal(advertisedSchema(read).properties.mode.description, undefined)
  assert.ok(read.inputSchema.properties.mode.description, 'compact declarations must not alter validation/documentation schemas')
})
test('copied approval and command execution consume a correlated host decision', async t => {
  const { host } = await fixture(t)
  const seen = []
  configureHostClient({ elicitation: { form: {} } }, message => {
    seen.push(message)
    queueMicrotask(() => acceptHostResponse({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  t.after(() => { closeHostClient(); configureHostClient({}, () => {}) })
  const approved = await host.coordination('coordination_approve', { message: 'Approve a fixture operation' })
  assert.equal(approved.outcome, 'approved')
  const command = await host.coordination('coordination_workspace', { action: 'run', command: 'node -e "process.stdout.write(12345..toString())"', timeoutMs: 5000 })
  assert.equal(command.ok, true, JSON.stringify(command)); assert.equal(command.exitCode, 0)
  assert.equal(command.stdout, '12345'); assert.equal(seen.length, 2)
})
test('copied parser, describe, chain and content reads use real source and preserve authorization', async t => {
  const { host } = await fixture(t)
  const parsed = await host.coordination('coordination_parse', { path: 'a.ts' })
  assert.notEqual(parsed.ok, false, JSON.stringify(parsed))
  assert.ok(parsed.cards.length, JSON.stringify(parsed))
  const handle = parsed.cards.find(card => card.name?.includes('answer'))?.identity ?? parsed.cards[0].identity
  const described = await host.coordination('coordination_describe', { handle })
  assert.notEqual(described.ok, false, JSON.stringify(described))
  assert.notEqual((await host.coordination('coordination_chain', { handle, action: 'dependents' })).ok, false)
  const read = await host.coordination('coordination_read', { path: 'a.ts', mode: 'lines', start: 1, maxLines: 2 })
  assert.match(read.content, /answer = 42/)
  await assert.rejects(host.coordination('coordination_read', { path: '../host.sqlite', mode: 'bytes', start: 0 }), /outside|relative|path|traversal/i)
  await assert.rejects(host.coordination('coordination_read', { path: '.codex-coordination/private.txt', mode: 'bytes', start: 0 }), /authorization|permission|outside|not found/i)
})
test('copied index, file, outline and import/export tools project the same real workspace', async t => {
  const { host } = await fixture(t)
  const indexed = await host.coordination('coordination_index', { action: 'index', paths: ['a.ts', 'b.ts', 'package.json'] })
  assert.notEqual(indexed.ok, false, JSON.stringify(indexed))
  for (const name of ['coordination_file', 'coordination_outline', 'coordination_importation', 'coordination_exportation']) {
    const result = await host.coordination(name, {})
    assert.notEqual(result.ok, false, `${name}: ${JSON.stringify(result)}`)
    assert.ok(JSON.stringify(result).includes('a.ts') || JSON.stringify(result).includes('b.ts'), `${name}: ${JSON.stringify(result)}`)
    assert.equal(JSON.stringify(result).includes('private.txt'), false)
  }
  assert.notEqual((await host.coordination('coordination_workspace', { action: 'structure' })).ok, false)
  assert.equal((await host.project({ action: 'detect' })).ok, true)
  assert.equal((await host.project({ action: 'test', dryRun: true })).ok, true)
})
test('copied mission and planning lifecycle persists across a host reopen', async t => {
  const { host, workspace } = await fixture(t)
  const goal = { amp: '0.1', kind: 'goal', id: 'copied.goal', statement: 'Inspect copied tools', success: [{ id: 'checked', statement: 'Tools work', check: 'Run copied tool tests' }], value: 1, priority: 1, horizon: 'task' }
  const created = await host.coordination('coordination_mission', { action: 'create', goal })
  assert.ok(created.mission, JSON.stringify(created))
  assert.ok((await host.coordination('coordination_goal', { action: 'list' })).goals.length)
  assert.notEqual((await host.coordination('coordination_mission', { action: 'activate' })).ok, false)
  await host.close(); await host.select(workspace)
  assert.equal((await host.coordination('coordination_mission', { action: 'list' })).missions.length, 1)
  assert.notEqual((await host.coordination('coordination_plan', { action: 'list' })).ok, false)
  assert.notEqual((await host.coordination('coordination_collaboration', { action: 'list' })).ok, false)
})
test('copied knowledge and controls mutate native copied stores while consent fails closed', async t => {
  const { host } = await fixture(t)
  for (const name of ['coordination_profession', 'coordination_profession_lock', 'coordination_selection', 'coordination_environment']) assert.notEqual((await host.coordination(name, {})).ok, false, name)
  const marked = await host.coordination('coordination_knowledge', { action: 'mark', path: 'a.ts', title: 'Answer module' })
  assert.notEqual(marked.ok, false, JSON.stringify(marked))
  assert.match(JSON.stringify(await host.coordination('coordination_knowledge', { action: 'list' })), /Answer module/)
  for (const name of ['coordination_control', 'coordination_workspace_adjust']) assert.notEqual((await host.coordination(name, { registry: 'knowledge', action: 'list' })).ok, false)
  const notification = await host.coordination('coordination_notification', { surface: 'snackbar', message: 'Copied tools test' })
  assert.equal(notification.ok, true, JSON.stringify(notification)); assert.equal(notification.notifications.length, 1)
  const approval = await host.coordination('coordination_approve', { message: 'Fixture approval without an MCP host' })
  assert.notEqual(approval.outcome, 'approved', JSON.stringify(approval))
  const command = await host.coordination('coordination_workspace', { action: 'run', command: 'node -e "process.exit(0)"' })
  assert.equal(command.ok, false); assert.match(command.error.message, /approve/i)
})
