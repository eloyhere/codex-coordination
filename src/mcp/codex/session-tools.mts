/** Native session reads and unverified status claims scoped to observed Codex mappings. */
import { randomUUID } from 'node:crypto'
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest, sameNativeRequest } from '../amp/native-store.mjs'

export function sessionBindings(binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  const standard = createAgentSurface()
  const descriptors = standard.tools.filter(tool => tool.module === 'session' && ['get', 'list', 'report_status'].includes(tool.verb))
  const handlers: Record<string, GatewayHandler> = {}
  for (const descriptor of descriptors) handlers[descriptor.name] = (parameters, context) => {
    const { store } = openNativeStore(workspace)
    try { return store.transaction(() => {
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
      if (persistence.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
      const mappings = store.events({ kind: 'codex.sync.session_mapping' }).map(item => item.payload as { threadId: string; sessionId: string })
      const read = (mapping: typeof mappings[number]) => {
        const entity = persistence.workflow.get('session', mapping.sessionId)
        const latest = store.events({ kind: 'codex.amp.session.status' }).map(item => item.payload as any).filter(item => item.threadId === mapping.threadId && item.sessionId === mapping.sessionId).at(-1)
        return { threadId: mapping.threadId, entity, ...(latest ? { reportedStatus: latest.status, statusReport: latest } : {}), origin: 'codex-command-hook' }
      }
      if (descriptor.verb === 'get') {
        const mapping = mappings.find(item => item.threadId === parameters.threadId)
        if (!mapping) throw new Error('Thread has no native session mapping in this project')
        return read(mapping)
      }
      if (descriptor.verb === 'report_status') {
        const mapping = mappings.find(item => item.threadId === parameters.threadId)
        if (!mapping) throw new Error('Thread has no native session mapping in this project')
        if (typeof parameters.status !== 'string' || !parameters.status.trim() || parameters.status.length > 120 || /[\r\n]/.test(parameters.status)) throw new Error('status must be a nonempty bounded status line')
        if (parameters.summary !== undefined && (typeof parameters.summary !== 'string' || parameters.summary.length > 2000)) throw new Error('summary exceeds the status report bound')
        if (!Number.isSafeInteger(parameters.expectedVersion) || Number(parameters.expectedVersion) < 0) throw new Error('expectedVersion must be a nonnegative integer')
        if (typeof context.idempotencyKey !== 'string' || !context.idempotencyKey.trim() || context.idempotencyKey.length > 200) throw new Error('A bounded idempotencyKey is required')
        const session = persistence.workflow.get('session', mapping.sessionId)
        const key = `${binding.principalId}:${context.idempotencyKey}`
        const request = nativeRequest({ threadId: mapping.threadId, sessionId: mapping.sessionId, expectedVersion: parameters.expectedVersion, status: parameters.status, summary: parameters.summary ?? null })
        const previous = store.events({ kind: 'codex.amp.session.status' }).map(item => item.payload as any).find(item => item.key === key)
        if (previous) {
          if (!sameNativeRequest(previous.request, request)) throw new Error('Idempotency key already used for a different session status')
          return { ...previous, replayed: true }
        }
        if (parameters.expectedVersion !== session.version) throw new Error('Session version changed; read the mapped session before reporting status')
        const report = { id: randomUUID(), key, request, threadId: mapping.threadId, sessionId: mapping.sessionId, sessionVersion: session.version, status: parameters.status.trim(), summary: parameters.summary ?? null, principalId: binding.principalId, source: 'agent-session-status-claim', verified: false, recordedAt: new Date().toISOString() }
        store.appendEvent('codex.amp.session.status', report, report.id)
        return { ...report, replayed: false }
      }
      const limit = Number(parameters.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100')
      return { sessions: mappings.slice(0, limit).map(read), total: mappings.length, scope: 'selected-project-host-observations' }
    }) } finally { store.close() }
  }
  const authorities = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...standard, tools: descriptors }, authorize: values => values.every(value => authorities.has(value)), onCall(record) {
    if (typeof workspace() !== 'string') return
    const { store } = openNativeStore(workspace)
    try { store.appendEvent('codex.amp.session.call', { ...record, principalId: binding.principalId }) } finally { store.close() }
  } })
  return descriptors.map(descriptor => ({ name: descriptor.name, description: descriptor.description + (descriptor.verb === 'report_status' ? ' Appends an unverified status claim for an observed Codex session; expectedVersion anchors the claim to the current native session without changing its lifecycle state.' : ' Reads native sessions mapped from real Codex hooks in the selected project. get requires the observed Codex threadId. Imported workflows are not Codex sessions.'),
    inputSchema: { type: 'object', additionalProperties: false, required: descriptor.verb === 'get' ? ['threadId'] : descriptor.verb === 'report_status' ? ['threadId', 'expectedVersion', 'status', 'idempotencyKey'] : [], properties: descriptor.verb === 'get' ? { threadId: { type: 'string', minLength: 1 } } : descriptor.verb === 'report_status' ? { threadId: { type: 'string', minLength: 1 }, expectedVersion: { type: 'integer', minimum: 0 }, status: { type: 'string', minLength: 1, maxLength: 120 }, summary: { type: 'string', maxLength: 2000 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 } } : { limit: { type: 'integer', minimum: 1, maximum: 100 } } }, annotations: { readOnlyHint: descriptor.verb !== 'report_status' },
    async handler(args) {
      if (descriptor.verb === 'report_status') {
        const { idempotencyKey, ...parameters } = args
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) throw new Error('A bounded idempotencyKey is required')
        return await gateway.call(descriptor.name, parameters, { binding, idempotencyKey }) as Record<string, any>
      }
      return await gateway.call(descriptor.name, args, { binding }) as Record<string, any>
    },
  }))
}
