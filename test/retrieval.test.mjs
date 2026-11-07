import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AmpHost } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { TOOLS } from '../plugins/codex-coordination/mcp/lib/tools.mjs'
import { SERVER_INSTRUCTIONS } from '../plugins/codex-coordination/mcp/guidance.mjs'
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-retrieval-'))
  const workspace = join(directory, 'repo'); mkdirSync(workspace)
  writeFileSync(join(workspace, 'a.ts'), '// heading\n\nexport function answer() {\n  return 42\n}\n')
  const host = new AmpHost({ databasePath: join(directory, 'host.sqlite') }); host.setToolCatalog(TOOLS)
  await host.select(workspace)
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }) })
  const query = await host.call('amp_tool_workspace_query', { revision: host.status().revision, text: 'answer', limit: 10 })
  const node = query.data.candidates.find(item => item.id.startsWith('symbol.'))
  assert.ok(node, JSON.stringify(query))
  return { host, workspace, directory, node }
}
test('all tool names are discoverable without Elasticsearch and catalog metrics stay stable', async t => {
  const { host } = await fixture(t)
  for (const name of ['coordination_context', 'coordination_goal', 'coordination_mission', 'coordination_project', 'coordination_knowledge']) {
    const result = await host.context({ action: 'search', query: name })
    assert.equal(result.hits[0].id, name); assert.equal(result.exact, true)
    assert.equal((await host.context({ action: 'detail', name })).tool.name, name)
  }
  const before = await host.context({ action: 'metrics' })
  const after = await host.context({ action: 'metrics' })
  assert.equal(before.catalog.hash, after.catalog.hash); assert.equal(before.catalog.tools, 163)
  assert.equal(before.catalog.names, undefined)
  assert.ok(SERVER_INSTRUCTIONS.length <= 512)
})
test('quick reading compacts the native lifecycle, archives full detail and resolves file-relative lines', async t => {
  const { host, node } = await fixture(t)
  const result = await host.context({ action: 'read', targets: [node.id], maxLines: 2, startLine: 1, budgetTokens: 2000 })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.archive.settled, true)
  assert.match(result.pages[0].text, /function answer/)
  assert.deepEqual(result.pages[0].source.fileLines, [3, 4])
  assert.equal(host.context({ action: 'pending' }).pending.length, 0)
  const detail = await host.context({ action: 'detail', id: result.archive.id })
  assert.equal(detail.result.reads[0].data.text, result.pages[0].text)
  assert.deepEqual(detail.result.settlement.receipt.usage, {})
  const rawChars = JSON.stringify(detail.result).length
  assert.ok(JSON.stringify(result).length < rawChars * 0.6, `${JSON.stringify(result).length} vs ${rawChars}`)
})
test('quick read failures settle their own contexts without touching another pending context', async t => {
  const { host, node } = await fixture(t)
  const allocation = host.context({ action: 'allocate', targets: [node.id], budgetTokens: 2000 })
  const held = await host.call('amp_tool_workspace_materialize', { revision: host.status().revision, frameId: allocation.frame.id, budgetTokens: 2000 })
  const failed = await host.context({ action: 'read', targets: [node.id], startLine: 10000, budgetTokens: 2000 })
  assert.equal(failed.ok, false); assert.equal(failed.archive.settled, true)
  assert.deepEqual(host.context({ action: 'pending' }).pending.map(item => item.contextId), [held.data.contextId])
  host.context({ action: 'settle', contextId: held.data.contextId })
})
test('archived retrieval persists but cannot be expanded from another selected workspace', async t => {
  const { host, node, workspace, directory } = await fixture(t)
  const result = await host.context({ action: 'read', targets: [node.id], maxLines: 1 })
  await host.close(); await host.select(workspace)
  assert.equal((await host.context({ action: 'detail', id: result.archive.id })).ok, true)
  const other = join(directory, 'other'); mkdirSync(other); await host.select(other)
  await assert.rejects(host.context({ action: 'detail', id: result.archive.id }), { code: 'NOT_FOUND' })
})
