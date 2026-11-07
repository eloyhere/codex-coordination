/** Durable AMP submissions. Submission is deliberately separate from approval. */
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { openNativeStore, nativeRequest, sameNativeRequest } from './native-store.mjs'

export function proposalBindings(binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  const names = new Set(['plan.propose_draft', 'intent.submit_clarification', 'goal.submit_evidence', 'attention.request_focus'])
  const surface = createAgentSurface()
  const descriptors = surface.tools.filter(tool => names.has(tool.module + '.' + tool.verb))
  const handlers: Record<string, GatewayHandler> = {}
  const open = () => openNativeStore(workspace).store
  const tools: ToolDefinition[] = descriptors.map(descriptor => {
    handlers[descriptor.name] = (parameters, context) => {
      const store = open()
      try {
        return store.transaction(() => {
          const key = createHash('sha256').update(binding.principalId + ':' + context.idempotencyKey).digest('hex')
          const request = nativeRequest({ tool: descriptor.name, parameters })
          const existing = store.events({ kind: 'codex.amp.submission' }).find(event => (event.payload as any).key === key)
          if (existing) {
            const value = existing.payload as Record<string, any>
            if (!sameNativeRequest(value.request, request)) throw new Error('Idempotency key already used for a different submission')
            return { ...value, replayed: true }
          }
          const value = { id: randomUUID(), key, request, tool: descriptor.name, parameters, binding, status: 'pending_host_review', recordedAt: new Date().toISOString() }
          store.appendEvent('codex.amp.submission', value, value.id)
          return value
        })
      } finally { store.close() }
    }
    return { name: descriptor.name, description: descriptor.description + ' Persist a submission for host review in the selected workspace AMP 0.7 Store. Does not activate plans, accept evidence or change attention residency.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey', 'targetId', 'submission'], properties: {
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, targetId: { type: 'string', minLength: 1, maxLength: 200 }, submission: { type: 'object', additionalProperties: true },
      } }, annotations: { readOnlyHint: false },
      async handler(args) {
        const { idempotencyKey, ...parameters } = args
        return await gateway.call(descriptor.name, parameters, { binding, idempotencyKey: idempotencyKey as string }) as Record<string, any>
      },
    }
  })
  const allowed = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...surface, tools: descriptors }, authorize: authorities => authorities.every(value => allowed.has(value)),
    onCall(record) {
      // Failed validation is audited as well; calls without a selected repository
      // cannot create a store or an execution context.
      if (typeof workspace() !== 'string') return
      const store = open()
      try { store.appendEvent('codex.amp.gateway_call', { ...record, binding, recordedAt: new Date().toISOString() }) }
      finally { store.close() }
    },
  })
  tools.push({ name: 'attention_manifest_protocol_submissions', description: 'Read AMP 0.7 submissions and persistence statistics in the selected workspace. Reports when an old plan proposal has been materialized as a native draft; draft creation does not imply plan approval.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, status: { enum: ['pending_host_review', 'consumed', 'rejected', 'stale_after_approval', 'materialized_native_draft'] } } }, annotations: { readOnlyHint: true },
    async handler(args) { const store = open(); try {
      const consumed = new Map(store.events({ kind: 'codex.amp.plan.draft' }).map(event => { const value = event.payload as any; return [value.submissionId, value.result.plan.id] }))
      const reviews = new Map(store.events({ kind: 'codex.amp.submission.review' }).map(event => { const value = event.payload as any; return [value.submissionId, value.result] }))
      const submissions = store.events({ kind: 'codex.amp.submission' }).slice(-Number(args.limit ?? 20)).map(event => {
        const value = event.payload as any, review = reviews.get(value.id) as any
        if (consumed.has(value.id)) return { ...value, status: 'materialized_native_draft', nativePlanId: consumed.get(value.id) }
        return review ? { ...value, status: review.status, review: { approved: review.approved, consumed: review.consumed, changed: review.changed, reviewId: review.reviewId } } : value
      }).filter(value => args.status === undefined || value.status === args.status)
      return { submissions, total: submissions.length, stats: store.stats() }
    } finally { store.close() } },
  })
  return tools
}
