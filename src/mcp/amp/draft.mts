/** Materialize agent plan proposals as native drafts, never approvals. */
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import Ajv from 'ajv'

const submissionSchema = { type: 'object', additionalProperties: false, required: ['id', 'bounds', 'tasks'], properties: {
  id: { type: 'string', minLength: 1 }, bounds: { type: 'object', additionalProperties: false, required: ['maxAttempts', 'deadline', 'progressMetric', 'deadLetterOwner'], properties: { maxAttempts: { type: 'integer', minimum: 1 }, deadline: { type: 'string' }, progressMetric: { type: 'string', minLength: 1 }, deadLetterOwner: { type: 'string', minLength: 1 } } },
  tasks: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'dependsOn', 'required', 'contractVersion', 'requiredEffects'], properties: { id: { type: 'string', minLength: 1 }, dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }, required: { type: 'boolean' }, contractVersion: { type: 'string', minLength: 1 }, requiredEffects: { type: 'array', items: { type: 'string', minLength: 1 } } } } },
} }
const validateSubmission = new (Ajv as any)({ allErrors: true }).compile(submissionSchema)

export function draftBinding(binding: AgentBinding, workspace: () => unknown, scope: WorkflowScopeCallback): ToolDefinition {
  const name = 'attention_manifest_protocol_plan.propose_draft'
  const standard = createAgentSurface()
  const descriptor = standard.tools.find(tool => tool.name === name)!
  const gateway = new AgentGateway({ surface: { ...standard, tools: [descriptor] }, authorize: values => values.every(value => descriptor.authority.includes(value)), handlers: {
    [name](parameters, context) {
      const { root, store } = openNativeStore(workspace)
      try {
        return store.transaction(() => {
          // The callback is live-aware: an explicitly selected imported snapshot
          // still wins, otherwise the observed Codex thread's native session is
          // used. The resolved scope replaces the old connection-id equality gate.
          const selected = scope(root, store)
          if (!selected) throw new Error('Select a native workflow first')
          const request = nativeRequest({ parameters, scope: selected })
          const key = binding.principalId + ':' + context.idempotencyKey
          const prior = store.events({ kind: 'codex.amp.plan.draft' }).find(event => (event.payload as any).key === key)
          if (prior) { const value = prior.payload as any; if (value.request !== request) throw new Error('Idempotency key already used for another draft'); return { ...value.result, replayed: true } }
          const archived = parameters.submissionId === undefined ? undefined : store.events({ kind: 'codex.amp.submission' }).find(event => (event.payload as any).id === parameters.submissionId)?.payload as any
          if (parameters.submissionId !== undefined && (!archived || archived.tool !== name)) throw new Error('Unknown plan submission')
          if (archived && (archived.binding?.principalId !== binding.principalId || archived.binding?.tenantId !== binding.tenantId)) throw new Error('Submission belongs to another principal')
          if (archived && (parameters.targetId !== undefined || parameters.submission !== undefined)) throw new Error('Pass submissionId or a new proposal, not both')
          const consumed = archived && store.events({ kind: 'codex.amp.plan.draft' }).find(event => (event.payload as any).submissionId === archived.id)
          if (consumed) {
            const value = consumed.payload as any
            if (value.scope !== selected) throw new Error('Submission was consumed in another workflow')
            return { ...value.result, replayed: true }
          }
          const payload = archived?.parameters ?? parameters
          const submission = payload.submission
          if (!validateSubmission(submission)) throw new Error('Invalid native plan proposal: ' + JSON.stringify(validateSubmission.errors))
          if (!Number.isFinite(Date.parse(submission.bounds.deadline)) || Date.parse(submission.bounds.deadline) <= Date.now()) throw new Error('Draft progress deadline must be in the future')
          const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
          const report = persistence.restoreAll()
          if (report.skipped.length) throw new Error('Native workflow contains invalid facts')
          // Imported snapshots keep their legacy reference mapping; a live scope
          // uses the native Goal id verbatim, so the two origins never accept
          // each other's ids (a foreign Goal fails the session check below).
          const imported = store.events({ kind: 'codex.amp.legacy_import' }).find(event => (event.payload as any).sessionId === selected)?.payload as any
          const targetId = archived ? imported?.references?.['goal:' + payload.targetId] ?? payload.targetId : payload.targetId
          const goal = persistence.workflow.get('goal', String(targetId))
          if (goal.sessionId !== selected) throw new Error('Goal is outside the selected workflow scope')
          const session = persistence.workflow.get('session', selected)
          if (!['active', 'idle'].includes(session.state)) throw new Error('Selected workflow session must be active/idle before proposing a plan')
          if (goal.state !== 'active') throw new Error('Plan proposal target Goal must be active')
          const plan = persistence.create('plan', { id: submission.id, sessionId: selected, goalId: goal.id, bounds: submission.bounds }, binding.principalId)
          const pending = new Map<string, any>(submission.tasks.map((task: any) => [task.id, task]))
          if (pending.size !== submission.tasks.length) throw new Error('Duplicate task id in draft')
          const created = new Set<string>()
          const tasks = []
          while (pending.size) {
            let advanced = false
            for (const [id, task] of pending) if (task.dependsOn.every((dependency: string) => created.has(dependency))) {
              tasks.push(persistence.create('task', { ...task, sessionId: selected, planId: plan.id }, binding.principalId))
              pending.delete(id); created.add(id); advanced = true
            }
            if (!advanced) throw new Error('Draft task dependencies are cyclic or reference missing tasks')
          }
          const result = { plan, tasks, approval: 'not_granted', executionAuthorized: false, origin: imported ? 'native-plugin-workflow' : 'codex-live', scope: selected }
          store.appendEvent('codex.amp.plan.draft', { key, request, scope: selected, submissionId: archived?.id ?? null, result })
          return result
        })
      } finally { store.close() }
    },
  }, onCall(record) { if (typeof workspace() !== 'string') return; const { store } = openNativeStore(workspace); try { store.appendEvent('codex.amp.plan.draft_call', { ...record, principalId: binding.principalId }) } finally { store.close() } } })
  return { name, description: 'Create a native draft plan and pending task DAG for the active Goal of the selected workflow, which is either an imported snapshot or the observed live Codex thread selected with attention_manifest_protocol_session.get. For a live workflow the proposal targetId is the native Goal id; imported snapshots keep their legacy reference mapping. Supply a typed proposal or consume an old pending plan submission by submissionId. Creation is transactional and idempotent; it does not approve the plan or authorize execution.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], oneOf: [{ required: ['targetId', 'submission'] }, { required: ['submissionId'] }], properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, targetId: { type: 'string', minLength: 1 }, submission: submissionSchema, submissionId: { type: 'string', minLength: 1 } } }, annotations: { readOnlyHint: false },
    async handler(args) {
      const { idempotencyKey, ...parameters } = args
      // Resolve the exact scope with an open Store and hand it to the gateway as
      // the host-bound session. The handler resolves again inside its own Store,
      // so a failed lookup is still journaled and reported through the gateway.
      const resolved = (() => {
        const { root, store } = openNativeStore(workspace)
        try { return scope(root, store) } catch { return undefined } finally { store.close() }
      })()
      return await gateway.call(name, parameters, { binding: { ...binding, sessionId: resolved ?? binding.sessionId }, idempotencyKey: idempotencyKey as string }) as Record<string, any>
    },
  }
}
