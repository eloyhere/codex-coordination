/** Every agent tool registered by deepseek-coordination 0.23.2. */
import catalog from './catalog.json' with { type: 'json' }
import type { ToolDefinition } from '../lib/tools.mjs'
import { DASHBOARD_URI } from '../lib/dashboard.mjs'
export const COORDINATION_CATALOG = catalog
interface Host { coordination(name: string, args: Record<string, unknown>): Promise<Record<string, any>>; project(args: Record<string, unknown>): Promise<Record<string, any>> }
export function withCoordinationTools(existing: ToolDefinition[], host: Host): ToolDefinition[] {
  const result = [...existing]
  for (const definition of catalog) {
    const original = result.find(tool => tool.name === definition.name)
    const handler = async (args: Record<string, unknown>) => host.coordination(definition.name, args)
    const descriptions: Record<string, string> = {
      coordination_notification: 'Display a snackbar, popover, dialog or alert in the plugin MCP App. Supports severity, title, message, six anchors, duration (0 keeps it open), and up to four dismiss-only action buttons. Returns immediately; never use it as an approval or question. Requires a host that renders MCP Apps; it does not create operating-system notifications.',
      coordination_approve: 'Ask the human through correlated MCP host elicitation and wait for approve/reject. Missing host capability, timeout and cancellation never count as approval.',
      coordination_search: 'Search the selected workspace metadata using the configured native AMP Elasticsearch backend. Returns bounded document references. index is workspace, from is 0; no arbitrary index access.',
      coordination_workspace: 'Inspect workspace structure or run build/test/package commands in the selected root. Any execution requires correlated host approval. Output and duration are bounded; this is not the DSH shell sandbox.',
    }
    const adapted: ToolDefinition = { ...definition, description: descriptions[definition.name] ?? definition.description + (['coordination_profession', 'coordination_profession_lock', 'coordination_selection'].includes(definition.name) ? ' State is plugin-managed and does not change the Codex composer.' : ''), handler }
    if (definition.name === 'coordination_search') adapted.inputSchema = { ...adapted.inputSchema, properties: { ...adapted.inputSchema.properties, index: { type: 'string', enum: ['workspace'] }, from: { type: 'integer', const: 0 }, size: { type: 'integer', minimum: 1, maximum: 20 }, fields: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Top-level AMP metadata keys, such as id, label, summary or sourceUri; * wildcards are allowed.' } } }
    if (definition.name === 'coordination_notification') adapted._meta = { ui: { resourceUri: DASHBOARD_URI } }
    if (!original) { result.push(adapted); continue }
    const left = original.inputSchema, right = adapted.inputSchema
    const properties = { ...left.properties, ...right.properties }
    for (const name of Object.keys(left.properties ?? {})) if (right.properties?.[name]) properties[name] = { anyOf: [left.properties[name], right.properties[name]] }
    const legacy = (args: Record<string, unknown>) => definition.name === 'coordination_workspace' ? args.action === undefined || ['select', 'status', 'refresh'].includes(String(args.action)) : Object.hasOwn(args, 'workspace')
    const compatibility = definition.name === 'coordination_workspace' ? ' select/status/refresh bind AMP; structure/build/test/run use the copied workspace implementation.' : ' Omit workspace for this interface. Calls containing workspace use the original JSON ledger; these stores are distinct.'
    result[result.indexOf(original)] = { ...original, description: adapted.description + compatibility, inputSchema: { type: 'object', properties, anyOf: [left, right] }, handler: args => legacy(args) ? original.handler(args) : handler(args) }
  }
  result.push({ name: 'coordination_project', description: 'Detect the selected project brand and build/compile/run/test commands through native AMP. detect only reads metadata; dryRun previews a command. Execution requires exact MCP host approval.', inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['detect', 'build', 'compile', 'run', 'test'] }, projectId: { type: 'string' }, brand: { type: 'string' }, dryRun: { type: 'boolean' } } }, handler: args => host.project(args) })
  return result
}
