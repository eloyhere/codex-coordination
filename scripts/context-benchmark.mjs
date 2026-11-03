/** Compare actual returned JSON, not inferred Codex/provider token usage. */
import { AmpHost } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { TOOLS } from '../plugins/codex-coordination/mcp/lib/tools.mjs'
const host = new AmpHost({ databasePath: ':memory:' })
host.setToolCatalog(TOOLS)
try {
  const started = performance.now()
  await host.select(process.cwd())
  const bindMs = Math.round(performance.now() - started)
  const found = await host.call('amp_tool_workspace_query', { revision: host.status().revision, text: 'scanWorkspace', limit: 20 })
  const target = found.data.candidates.find(item => item.id.startsWith('symbol.'))
  if (!target) throw new Error('Benchmark source target was not found')
  const compact = await host.context({ action: 'read', targets: [target.id], maxLines: 15, budgetTokens: 4000 })
  if (!compact.ok) throw new Error(JSON.stringify(compact))
  const archive = (await host.context({ action: 'detail', id: compact.archive.id })).result
  const nativeChars = [archive.allocation, archive.materialization, ...archive.reads, archive.release, archive.settlement].reduce((sum, result) => sum + JSON.stringify(result).length, 0)
  const compactChars = JSON.stringify(compact).length
  console.log(JSON.stringify({ workspace: process.cwd(), source: compact.pages[0].source, bindMs, nativeLifecycleCalls: 5, quickReadCalls: 1, nativeChars, compactChars, reductionPercent: Math.round((1 - compactChars / nativeChars) * 1000) / 10, measured: 'Returned JSON UTF-16 characters. Excludes input schemas, protocol envelopes, model tokens and provider cache effects.' }, null, 2))
} finally { await host.close() }
