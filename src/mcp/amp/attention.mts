/** Read actual native attention; host observations supply session and turn scope. */
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import { compileContext } from 'attention-manifest-protocol/context'
import { ENTITY_REGISTRY } from 'attention-manifest-protocol/entity'
import type { EntityKind } from 'attention-manifest-protocol/entity'
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { readCodexThread } from '../codex/events.mjs'
import { openNativeStore } from './native-store.mjs'
import { createHash } from 'node:crypto'

export function attentionBindings(binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  const surface = createAgentSurface()
  const descriptors = surface.tools.filter(tool => tool.module === 'attention' && ['get', 'context'].includes(tool.verb))
  const handlers: Record<string, GatewayHandler> = {}
  for (const descriptor of descriptors) handlers[descriptor.name] = parameters => {
    if (typeof parameters.threadId !== 'string') throw new Error('An observed Codex threadId is required')
    const host = readCodexThread(workspace, parameters.threadId)
    if (!host.nativeSession) throw new Error('Thread has no native AMP session mapping')
    const { root, store } = openNativeStore(workspace)
    const rootId = createHash('sha256').update(root).digest('hex')
    try {
      const owned = (object: AttentionObject) => object.scope.sessionId === host.nativeSession.id && object.scope.principalId === binding.principalId && object.scope.tenantId === binding.tenantId
      const objects = store.list<AttentionObject>('attention').filter(owned).map(object => JSON.parse(JSON.stringify(object)) as AttentionObject)
      if (descriptor.verb === 'get') {
        const object = objects.find(object => object.id === parameters.id)
        if (!object) throw new Error('Attention object is not visible in this thread and principal scope')
        return { object, source: 'native-attention-store', authorization: 'not_granted' }
      }
      const current = host.turns.at(-1)
      if (!current || current.status !== 'inProgress' || !['active', 'idle'].includes(host.nativeSession.state) || host.sessionState !== 'active') throw new Error('No active Codex turn observed; context scope cannot be inferred')
      if (objects.length > 1000) throw new Error('Attention scope exceeds the host compilation limit')
      const maxBytes = Number(parameters.maxBytes ?? 32768)
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) throw new Error('maxBytes must be between 1 and 32768')
      const compiled = compileContext(objects, {
        scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: host.nativeSession.id, turnId: current.id },
        now: new Date().toISOString(), budget: { bytes: maxBytes },
        currentVersion(pointer) {
          if (!Object.hasOwn(ENTITY_REGISTRY, pointer.kind)) return undefined
          const entity = store.list<any>(pointer.kind as EntityKind).find(entity => entity.id === pointer.id)
          // A reference never grants visibility into another session's entity.
          if (!entity || entity.sessionId !== undefined && entity.sessionId !== host.nativeSession.id) return undefined
          if (entity.rootId !== undefined && entity.rootId !== rootId) return undefined
          if (entity.scope && (entity.scope.sessionId !== host.nativeSession.id || entity.scope.principalId !== binding.principalId || entity.scope.tenantId !== binding.tenantId)) return undefined
          return entity.version === undefined ? undefined : String(entity.version)
        },
      })
      return { compiled, source: 'native-context-compiler', delivery: 'tool-result-preview; no hidden Codex context injection', usageBasis: 'Compiler default token count is conservative UTF-8 bytes, not Codex/provider usage.' }
    } finally { store.close() }
  }
  const authorities = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...surface, tools: descriptors }, authorize: values => values.every(value => authorities.has(value)), onCall(record) {
    if (typeof workspace() !== 'string') return
    const { store } = openNativeStore(workspace)
    try { store.appendEvent('codex.amp.attention.call', { ...record, principalId: binding.principalId }) } finally { store.close() }
  } })
  return descriptors.map(descriptor => ({ name: descriptor.name, description: descriptor.description + ' Reads persisted native attention for an observed Codex thread. Context uses its latest active observed turn, native freshness/expiry/mount checks and a 32 KiB host byte cap. No attention creation, mounting, source fetch, execution or hidden context injection.',
    inputSchema: { type: 'object', additionalProperties: false, required: descriptor.verb === 'get' ? ['threadId', 'id'] : ['threadId'], properties: { threadId: { type: 'string', minLength: 1 }, ...(descriptor.verb === 'get' ? { id: { type: 'string', minLength: 1 } } : { maxBytes: { type: 'integer', minimum: 1, maximum: 32768 } }) } }, annotations: { readOnlyHint: true },
    async handler(args) { return await gateway.call(descriptor.name, args, { binding }) as Record<string, any> },
  }))
}
