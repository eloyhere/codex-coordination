/** Native AMP Project entities, with transactional migration of older command journals. */
import { Project, createProjectToolHandlers } from 'attention-manifest-protocol/project'
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { createHash } from 'node:crypto'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import { bindProject } from 'attention-manifest-protocol/persistence'

interface Command { name: string; parameters: Record<string, unknown>; at: string; key: string; request: string; result: any }

export function projectBindings(binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  const standard = createAgentSurface()
  const descriptors = standard.tools.filter(tool => tool.module === 'project')
  const handlers: Record<string, GatewayHandler> = {}
  const open = () => openNativeStore(workspace)
  for (const descriptor of descriptors) handlers[descriptor.name] = (parameters, context) => {
    const { root, store } = open()
    try {
      return store.transaction(() => {
        let at = new Date().toISOString()
        const project = new Project({ tenantId: binding.tenantId, rootId: createHash('sha256').update(root).digest('hex'), clock: () => at })
        const native = createProjectToolHandlers(project)
        const commands = store.events({ kind: 'codex.amp.project.command' }).map(event => event.payload as Command)
        const persistence = bindProject(store, project)
        persistence.rehydrate()
        if (persistence.report.skipped.length) throw new Error('Project persistence contains invalid facts: ' + persistence.report.skipped.join(', '))
        const migrated = store.events({ kind: 'codex.amp.project.entity_migration' }).length > 0
        if (!migrated) {
          if (commands.length && persistence.report.restored) throw new Error('Project has both native facts and an unmigrated journal; reconciliation is required')
          for (const command of commands) {
            if (!native[command.name]) throw new Error('Unknown project command in migration journal: ' + command.name)
            at = command.at
            const restored = native[command.name](command.parameters, context)
            if (nativeRequest(restored) !== nativeRequest(command.result)) throw new Error('Project journal result does not match native replay')
          }
          persistence.flush()
          store.appendEvent('codex.amp.project.entity_migration', { version: 1, commands: commands.length, tenantId: project.tenantId, rootId: project.rootId })
        }
        const request = nativeRequest({ name: descriptor.name, parameters })
        const key = binding.principalId + ':' + context.idempotencyKey
        if (descriptor.mutating) {
          const previous = commands.find(command => command.key === key)
          if (previous) {
            if (previous.request !== request) throw new Error('Idempotency key already used for another project command')
            return { ...previous.result, replayed: true }
          }
        }
        at = new Date().toISOString()
        let value: unknown
        if (native[descriptor.name]) value = native[descriptor.name](parameters, context)
        else if (descriptor.verb === 'rules') value = { rules: project.listRules() }
        else if (descriptor.verb === 'metadata') value = { metadata: project.listMetadata() }
        else value = { environment: project.environment, version: project.environmentVersion }
        const result = typeof value === 'string' ? { description: value } : value as Record<string, any>
        if (descriptor.mutating) {
          persistence.flush()
          store.appendEvent('codex.amp.project.command', { name: descriptor.name, parameters, at, key, request, result })
        }
        return result
      })
    } finally { store.close() }
  }
  const authorities = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...standard, tools: descriptors }, authorize: values => values.every(value => authorities.has(value)),
    onCall(record) {
      if (typeof workspace() !== 'string') return
      const { store } = open()
      try { store.appendEvent('codex.amp.project.call', { ...record, binding }) } finally { store.close() }
    },
  })
  return descriptors.map(descriptor => {
    const properties: Record<string, any> = descriptor.verb === 'configure_environment' ? {
      variables: { type: 'object', additionalProperties: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } }, dependencies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'scope'], properties: { id: { type: 'string' }, version: { type: 'string' }, manager: { type: 'string' }, scope: { enum: ['runtime', 'build', 'dev', 'tool'] }, optional: { type: 'boolean' } } } }, expectedVersion: { type: 'integer', minimum: 0 },
    } : descriptor.verb === 'put_rule' ? { id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 }, expectedVersion: { type: 'integer', minimum: 0 } } : {}
    if (descriptor.mutating) properties.idempotencyKey = { type: 'string', minLength: 1, maxLength: 200 }
    return { name: descriptor.name, description: descriptor.description + ' Native AMP 0.7 Project state, scoped to the selected workspace and durably journaled. Environment configuration is declarative and does not install dependencies or change the process environment.',
      inputSchema: { type: 'object', additionalProperties: false, properties, required: descriptor.mutating ? ['idempotencyKey', ...(descriptor.verb === 'put_rule' ? ['id', 'text'] : [])] : [] },
      annotations: { readOnlyHint: !descriptor.mutating },
      async handler(args) { const { idempotencyKey, ...parameters } = args; return await gateway.call(descriptor.name, parameters, { binding, idempotencyKey: idempotencyKey as string }) as Record<string, any> },
    }
  })
}
