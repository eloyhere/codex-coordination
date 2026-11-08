/** Requests an independent MCP host decision for exact nonterminal workflow transitions. */
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { WorkflowKind } from 'attention-manifest-protocol/workflow'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import { requestHostApproval } from './host-client.mjs'
import { randomUUID } from 'node:crypto'

const allowed: Record<string, string[]> = {
  session: ['resumed', 'active', 'idle', 'suspended'],
  intent: ['confirmed', 'accepted', 'abandoned'],
  mission: ['proposed', 'active', 'paused', 'resumed', 'abandoned'],
  goal: ['proposed', 'active', 'blocked', 'abandoned'],
  plan: ['approved', 'executing', 'paused'],
  task: ['proposed', 'ready', 'active', 'paused', 'blocked', 'unblocked'],
}

export function workflowReview(binding: AgentBinding, workspace: () => unknown, scope: WorkflowScopeCallback): ToolDefinition {
  return { name: 'attention_manifest_protocol_workflow_review', description: 'Request an independent MCP host approval for one exact nonterminal transition in the selected plugin workflow, which is either an imported snapshot or the observed live Codex thread selected with attention_manifest_protocol_session.get, including bounded plan approval and task readiness. Fails closed when host elicitation is unavailable. Does not start actions, verify evidence or declare success. It controls AMP plugin workflows, not Codex chat lifecycle.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['kind', 'id', 'to', 'expectedVersion', 'idempotencyKey', 'reason'], properties: {
      kind: { enum: Object.keys(allowed) }, id: { type: 'string', minLength: 1 }, to: { type: 'string', enum: [...new Set(Object.values(allowed).flat())] }, expectedVersion: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    } }, annotations: { readOnlyHint: false },
    async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, unknown>
      if (Object.keys(args).some(key => !['kind', 'id', 'to', 'expectedVersion', 'idempotencyKey', 'reason'].includes(key))) throw new Error('Unknown review parameter')
      if (!allowed[String(args.kind)]?.includes(String(args.to))) throw new Error('This transition is not available through host review')
      if (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.length || typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('A stable idempotency key and reason are required')
      const opened = openNativeStore(workspace)
      const root = opened.root
      let selected: string
      try {
        // Resolve against the already-open Store: imported selection wins,
        // otherwise the observed live Codex thread's native session is used.
        const candidate = scope(root, opened.store)
        if (!candidate) throw new Error('Select a native workflow first')
        selected = candidate
      } catch (error) { opened.store.close(); throw error }
      const request = nativeRequest({ ...args, selected })
      const key = binding.principalId + ':' + args.idempotencyKey
      const kind = args.kind as WorkflowKind
      let head: string
      const admission = (workflow: WorkflowStore) => {
        const entity = workflow.get(kind, String(args.id))
        if (entity.sessionId !== selected) throw new Error('Entity is outside the selected workflow scope')
        if (kind !== 'session' && !['active', 'idle'].includes(workflow.get('session', selected).state)) throw new Error('Resume the selected workflow before reviewing its work')
        if ((kind === 'plan' && ['approved', 'executing'].includes(String(args.to))) || (kind === 'task' && ['ready', 'active'].includes(String(args.to)))) {
          const plan = kind === 'plan' ? workflow.get('plan', entity.id) : workflow.get('plan', workflow.get('task', entity.id).planId)
          if (Date.parse(plan.bounds.deadline) <= Date.now()) throw new Error('Plan progress bounds have expired; propose a new draft with reviewed bounds')
          const goal = workflow.get('goal', plan.goalId)
          // Applies to live and imported facts alike: a plan may only be admitted
          // under an active Goal that belongs to the same selected scope.
          if (goal.sessionId !== selected) throw new Error('Plan goal is outside the selected workflow scope')
          if (goal.state !== 'active') throw new Error('Plan goal must be active before plan/task admission')
          if (!workflow.list('task', selected).some(task => task.planId === plan.id)) throw new Error('Plan must have a task DAG before admission')
        }
        return entity
      }
      const apply = (persistence: WorkflowPersistence) => {
        const entity = admission(persistence.workflow)
        return persistence.transition(kind, entity.id, args.to as any, { expectedVersion: Number(args.expectedVersion), actor: 'mcp-host-review', reason: String(args.reason), cancellationEpoch: entity.cancellationEpoch })
      }
      try {
        const prior = opened.store.events({ kind: 'codex.amp.workflow.review' }).find(event => (event.payload as any).key === key)
        if (prior) {
          const value = prior.payload as any
          if (value.request !== request) throw new Error('Idempotency key already used for another review')
          return { ...value.result, replayed: true }
        }
        const persistence = new WorkflowPersistence({ store: opened.store, workflow: new WorkflowStore() })
        const restored = persistence.restoreAll()
        if (restored.skipped.length) throw new Error('Native workflow has invalid facts')
        head = nativeRequest(persistence.workflow.snapshot())
        // Validate the exact command without durable changes or authority claims.
        const candidate = WorkflowStore.restore(persistence.workflow.snapshot())
        const entity = admission(candidate)
        candidate.transition(kind, entity.id, args.to as any, { expectedVersion: Number(args.expectedVersion), actor: 'host-review-preview', reason: String(args.reason), cancellationEpoch: entity.cancellationEpoch })
      } finally { opened.store.close() }
      const reviewId = randomUUID()
      const approved = await requestHostApproval('native-workflow:' + selected, 'transition', { reviewId, ...args, workspace: root })
      const current = openNativeStore(workspace)
      try {
        if (current.root !== root || scope(root, current.store) !== selected) throw new Error('Workspace or workflow scope changed while awaiting host review')
        return current.store.transaction(() => {
          const prior = current.store.events({ kind: 'codex.amp.workflow.review' }).find(event => (event.payload as any).key === key)
          if (prior) {
            const value = prior.payload as any
            if (value.request !== request) throw new Error('Idempotency key already used for another review')
            return { ...value.result, replayed: true }
          }
          const persistence = new WorkflowPersistence({ store: current.store, workflow: new WorkflowStore() })
          const report = persistence.restoreAll()
          if (report.skipped.length || nativeRequest(persistence.workflow.snapshot()) !== head) throw new Error('Workflow changed while awaiting host review; submit a new review')
          const result = approved ? { approved: true, entity: apply(persistence), reviewId } : { approved: false, changed: false, reviewId }
          current.store.appendEvent('codex.amp.workflow.review', { key, request, result, scope: selected, principalId: binding.principalId })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
