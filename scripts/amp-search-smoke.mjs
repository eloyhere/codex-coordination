#!/usr/bin/env node
/** Actual AMP CatalogSearch + Elasticsearch integration, no search test double. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AmpHost } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { TOOLS } from '../plugins/codex-coordination/mcp/lib/tools.mjs'
const directory = mkdtempSync(join(tmpdir(), 'amp-live-search-'))
const workspace = join(directory, 'repo')
mkdirSync(workspace)
writeFileSync(join(workspace, 'package.json'), '{"name":"search-probe"}')
writeFileSync(join(workspace, 'probe.ts'), 'export function attentionProbe(){ return "catalog lifecycle" }')
const host = new AmpHost({ databasePath: join(directory, 'host.sqlite'), ...(process.env.CODEX_AMP_SEARCH_NODE ? { searchNode: process.env.CODEX_AMP_SEARCH_NODE } : {}) })
host.setToolCatalog(TOOLS)
try {
  await host.select(workspace)
  const capabilities = await host.call('amp_tool_workspace_capabilities', {})
  const revision = capabilities.revision
  const discover = async (queries, kinds) => {
    const result = await host.call('amp_tool_workspace_discover', { revision, queries, ...(kinds ? { kinds } : {}) })
    assert.equal(result.ok, true, JSON.stringify(result))
    return JSON.stringify(result.data)
  }
  const registered = await host.registry({ registry: 'knowledge', action: 'register', id: 'knowledge.probe', value: { title: 'Registry lifecycle probe', summary: 'quartzregistrytoken', content: 'Private body omitted from discovery output.' }, expectedVersion: 0 })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  const found = await discover('quartzregistrytoken', ['knowledge'])
  assert.ok(found.includes('knowledge.probe'), found)
  assert.equal(found.includes('Private body omitted'), false)
  const unchanged = await discover('quartzregistrytoken', ['knowledge'])
  assert.ok(unchanged.includes('knowledge.probe'))
  const updated = await host.registry({ registry: 'knowledge', action: 'update', id: 'knowledge.probe', value: { title: 'Updated lifecycle', summary: 'updatedregistrytoken', content: 'New private body.' }, expectedVersion: 1 })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.ok((await discover('updatedregistrytoken', ['knowledge'])).includes('knowledge.probe'))
  assert.equal((await discover('quartzregistrytoken', ['knowledge'])).includes('knowledge.probe'), false)
  const removed = await host.registry({ registry: 'knowledge', action: 'remove', id: 'knowledge.probe', expectedVersion: 2 })
  assert.equal(removed.ok, true)
  assert.equal((await discover('updatedregistrytoken', ['knowledge'])).includes('knowledge.probe'), false)
  assert.ok((await discover('amp_tool_filesystem_read', ['tool'])).includes('amp_tool_filesystem_read'))
  assert.ok((await discover('attentionProbe')).includes('attentionProbe'))
  assert.ok((await discover('coordination_project', ['tool'])).includes('coordination_project'))
  const copied = await host.coordination('coordination_search', { query: 'attentionProbe', size: 3 })
  assert.equal(copied.ok, true, JSON.stringify(copied))
  assert.ok(copied.hits.length > 0, JSON.stringify(copied))
  const filtered = await host.coordination('coordination_search', { query: 'attentionProbe', fields: ['label'], size: 1 })
  assert.equal(filtered.ok, true, JSON.stringify(filtered))
  assert.deepEqual(Object.keys(filtered.hits[0].source), ['label'])
  await host.coordination('coordination_knowledge', { action: 'mark', path: 'probe.ts', title: 'copiedknowledgetoken' })
  assert.ok((await discover('copiedknowledgetoken', ['knowledge'])).includes('copied.knowledge.'))
  await host.close(); await host.select(workspace)
  assert.ok((await discover('copiedknowledgetoken', ['knowledge'])).includes('copied.knowledge.'))
  await host.coordination('coordination_knowledge', { action: 'unmark', path: 'probe.ts' })
  assert.equal((await discover('copiedknowledgetoken', ['knowledge'])).includes('copied.knowledge.'), false)
  const refused = await host.coordination('coordination_search', { query: 'attentionProbe', index: '*' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  console.log('ok live AMP search: registry lifecycle, copied search/field projection, knowledge mark/unmark/reopen, metadata privacy, all tool indexing and code symbols')
} finally { await host.close(); rmSync(directory, { recursive: true, force: true }) }
