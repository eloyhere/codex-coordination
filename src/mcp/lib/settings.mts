/** Settings wiring contains no business-ledger read or implicit authority grant. */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SETTINGS_INTERFACES, type SettingsView } from '../contracts.mjs'
import type { ToolDefinition } from './tools.mjs'

export function settingsWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) throw new Error('Settings workspace must be an absolute path')
  const root = realpathSync(value.trim())
  if (!statSync(root).isDirectory()) throw new Error('Settings workspace must be a directory')
  return root
}

export function settingsView(workspace: unknown, tools: readonly ToolDefinition[]): SettingsView {
  const interfaces = SETTINGS_INTERFACES.flatMap(({ name, label }) => {
    const tool = tools.find(tool => tool.name === name)
    return tool ? [{ name, label, inputSchema: tool.inputSchema }] : []
  })
  return { ok: true, view: 'settings', workspace: workspace === undefined ? null : settingsWorkspace(workspace), interfaces }
}

/** Pin UI requests to the expected project before entering existing approval gates. */
export function withSettingsWorkspaceGuard(tools: ToolDefinition[], workspace: () => unknown): ToolDefinition[] {
  const names = new Set<string>(SETTINGS_INTERFACES.map(tool => tool.name))
  return tools.map(tool => {
    if (!names.has(tool.name)) return tool
    const schema = (value: Record<string, any>): Record<string, any> => ({ ...value,
      properties: { ...value.properties, expectedWorkspace: { type: 'string', minLength: 1, description: 'Optional expected canonical project root. Rejects stale settings UI calls; does not select a project or grant authority.' } },
      ...(value.anyOf ? { anyOf: value.anyOf.map(schema) } : {}),
    })
    return { ...tool, inputSchema: schema(tool.inputSchema), async handler(input) {
      const { expectedWorkspace, ...parameters } = input
      if (expectedWorkspace !== undefined && settingsWorkspace(expectedWorkspace) !== settingsWorkspace(workspace())) throw new Error('Settings project binding changed; reconnect the intended project before retrying')
      // Existing wrappers retain their own scope recheck after asynchronous approval.
      return tool.handler(parameters)
    } }
  })
}
