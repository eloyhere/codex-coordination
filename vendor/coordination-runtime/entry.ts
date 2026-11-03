/** Codex composition seam. Business/tool modules below are copied verbatim. */
import { CoordinationService } from './src/host/coordination.js'
import { resolveConfig } from './src/host/config.js'
import { coordinationToolDefinitions, coordinationFileToolDefinitions, coordinationGraphToolDefinitions, coordinationIndexToolDefinition, disposeCoordinationToolRuntime } from './src/host/tools.js'
import { coordinationControlTools } from './src/host/controlTools.js'
import { coordinationWorkspaceTool } from './src/host/workspaceTools.js'
import { coordinationNotificationToolDefinition } from './src/host/notifyTools.js'
import { coordinationApproveToolDefinition } from './src/host/approveTools.js'
import { coordinationSearchToolDefinition } from './src/host/searchTools.js'
import { NotificationCenter } from './src/host/notify.js'
import { ApprovalCenter } from './src/host/approve.js'
import { ToolCatalog } from './src/host/toolCatalog.js'
import { withAmpReceipts } from './src/host/amp.js'
import { bindFiles } from './fs-guard.js'
export { leanParameters } from './src/host/leanSchemas.js'

export function createCoordination(options: any) {
  const unbindFiles = bindFiles(options.workspace, options.authorize)
  const config = resolveConfig({ databasePath: options.databasePath })
  const runtime = { rawSession: () => undefined, rawAgent: () => undefined, ...(options.runtime ?? {}) }
  const service = new CoordinationService({ reflect: { provide() {} } } as any, config, runtime)
  const facade = service as any
  facade.workspaceRoot = options.workspace
  service.session.ensure(options.session ?? 'catalog', { cwd: options.workspace, principal: 'codex-plugin' })
  const notifications = new NotificationCenter()
  const approvals = new ApprovalCenter()
  const open = approvals.open.bind(approvals)
  if (options.approve) approvals.open = (session, request) => {
    const opened = open(session, request)
    Promise.resolve(options.approve(request)).then(approved => approvals.answer(session, opened.id, approved === true), () => approvals.cancel(session, opened.id))
    return opened
  }
  const context = { get: (name: string) => name === 'sessionQuery' ? { observeSession: (id: string) => ({ header: { id, cwd: id === options.session ? options.workspace : undefined } }) } : undefined }
  const toolOptions = { workspaceRoot: options.workspace, context }
  const definitions = [
    ...coordinationToolDefinitions(facade, 'en-US'),
    ...coordinationFileToolDefinitions(facade, 'en-US', toolOptions),
    ...coordinationGraphToolDefinitions(facade, 'en-US', toolOptions),
    coordinationIndexToolDefinition(facade, 'en-US', toolOptions),
    ...coordinationControlTools(facade),
    coordinationWorkspaceTool(facade, 'en-US', { ...toolOptions, ...(options.shell ? { shell: options.shell } : {}) }),
    coordinationNotificationToolDefinition(notifications, 'en-US'),
    coordinationApproveToolDefinition(approvals, 'en-US'),
    coordinationSearchToolDefinition('en-US', options.search ?? {}),
  ]
  const tools = new Map<string, any>()
  const catalog = new ToolCatalog()
  const registry = withAmpReceipts({ register(definition: any) { tools.set(definition.name, definition); catalog.add(definition); return () => tools.delete(definition.name) } }, service.amp)
  definitions.forEach(definition => registry.register(definition))
  let indexed = false
  return {
    definitions: definitions.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
    async call(name: string, args: any, session: string) {
      const tool = tools.get(name)
      if (!tool) throw new Error('Unknown coordination tool')
      const exec = { agent: { id: session } }
      if (!indexed && ['coordination_file', 'coordination_outline', 'coordination_importation', 'coordination_exportation'].includes(name)) {
        const value = await tools.get('coordination_index').execute({}, exec)
        if (value?.error || value?.ok === false) return value
        indexed = true
      }
      const value = await tool.execute(args, exec)
      if (name === 'coordination_index' && !value?.error && value?.ok !== false) indexed = true
      return value
    },
    drain: (session: string) => notifications.drain(session),
    metrics: () => catalog.metrics('en-US'),
    knowledge: () => service.knowledge.list({ workspace: options.workspace, session: options.session }),
    async close() { approvals.cancelAll(); disposeCoordinationToolRuntime(facade); try { await service.amp.flush() } finally { service.dispose(); unbindFiles() } },
  }
}
