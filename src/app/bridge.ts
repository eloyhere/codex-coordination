import { App, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { type CallTool, type ToolResponse } from '../mcp/contracts.mjs'

function applyContext(context?: McpUiHostContext) {
  if (!context) return
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context.theme) {
    document.documentElement.dataset.hostTheme = context.theme
    window.dispatchEvent(new Event('coordination-theme'))
  }
  const insets = context.safeAreaInsets
  if (insets) for (const edge of ['top', 'right', 'bottom', 'left'] as const) document.documentElement.style.setProperty(`--safe-${edge}`, `${insets[edge]}px`)
}

export interface Connection { call: CallTool; preview: boolean; close: () => void }
export async function connect(onResult: (result: ToolResponse) => void): Promise<Connection> {
  if (import.meta.env.DEV && window.parent === window) return {
    preview: true,
    close() {},
    async call(name, args) {
      const response = await fetch('/api/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coordination-Preview': '1' }, body: JSON.stringify({ name, args }) })
      return await response.json() as ToolResponse
    },
  }
  const app = new App({ name: 'Coordination', version: '0.6.3' }, {}, { strict: true })
  app.ontoolresult = params => onResult(params as ToolResponse)
  app.onhostcontextchanged = () => applyContext(app.getHostContext())
  await app.connect()
  applyContext(app.getHostContext())
  return { preview: false, call: async (name, args) => await app.callServerTool({ name, arguments: args }) as ToolResponse, close() { void app.close() } }
}
