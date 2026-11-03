/** Reuse the copied lean-schema algorithm; host validation keeps full schemas. */
import catalog from './catalog.json' with { type: 'json' }
import { leanParameters } from './runtime.mjs'
const copiedNames = new Set(catalog.map(tool => tool.name))
export function advertisedSchema(tool: { name: string; inputSchema: Record<string, any> }) {
  return copiedNames.has(tool.name) && process.env.CODEX_COORDINATION_SCHEMA_DETAIL !== 'full' ? leanParameters(tool.inputSchema) : tool.inputSchema
}
