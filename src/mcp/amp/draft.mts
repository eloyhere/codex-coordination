/** Materialize agent plan proposals as native drafts, never approvals. */
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import Ajv from 'ajv'

const submissionSchema = { type: 'object', additionalProperties: false, required: ['id', 'bounds', 'tasks'], properties: {
  id: { type: 'string', minLength: 1 }, bounds: { type: 'object', additionalProperties: false, required: ['maxAttempts', 'deadline', 'progressMetric', 'deadLetterOwner'], properties: { maxAttempts: { type: 'integer', minimum: 1 }, deadline: { type: 'string' }, progressMetric: { type: 'string', minLength: 1 }, deadLetterOwner: { type: 'string', minLength: 1 } } },
  tasks: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'dependsOn', 'required', 'contractVersion', 'requiredEffects'], properties: { id: { type: 'string', minLength: 1 }, dependsOn: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }, required: { type: 'boolean' }, contractVersion: { type: 'string', minLength: 1 }, requiredEffects: { type: 'array', items: { type: 'string', minLength: 1 } } } } },
} }
const validateSubmission = new (Ajv as any)({ allErrors: true }).compile(submissionSchema)

export function draftBinding(binding: AgentBinding, workspace: () => unknown, scope: (root: string) => string | undefined): ToolDefinition {
  const name = 'attention_manifest_protocol_plan.propose_draft'
  const standard = createAgentSurface()
  const descriptor = standard.tools.find(tool => tool.name === name)!
  const gateway = new AgentGateway({ surface: { ...standard, tools: [descriptor] }, authorize: values => values.every(value => descriptor.authority.includes(value)), handlers: {
    [name](parameters, context) {
      const { root, store } = openNativeStore(workspace)
      try {
        return store.transaction(() => {
          const selected = scope(root)
          if (!selected || selected !== context.binding.sessionId) throw new Error('Select a native workflow first')
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
          const imported = store.events({ kind: 'codex.amp.legacy_import' }).find(event => (event.payload as any).sessionId === selected)?.payload as any
          const targetId = archived ? imported?.references['goal:' + payload.targetId] ?? payload.targetId : payload.targetId
          const goal = persistence.workflow.get('goal', String(targetId))
          if (goal.sessionId !== selected) throw new Error('Goal is outside the selected workflow scope')
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
          const result = { plan, tasks, approval: 'not_granted', executionAuthorized: false }
          store.appendEvent('codex.amp.plan.draft', { key, request, scope: selected, submissionId: archived?.id ?? null, result })
          return result
        })
      } finally { store.close() }
    },
  }, onCall(record) { if (typeof workspace() !== 'string') return; const { store } = openNativeStore(workspace); try { store.appendEvent('codex.amp.plan.draft_call', { ...record, principalId: binding.principalId }) } finally { store.close() } } })
  return { name, description: 'Create a native draft plan and pending task DAG for the selected active workflow goal. Supply a typed proposal or consume an old pending plan submission by submissionId. Creation is transactional and idempotent; it does not approve the plan or authorize execution.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey'], oneOf: [{ required: ['targetId', 'submission'] }, { required: ['submissionId'] }], properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, targetId: { type: 'string', minLength: 1 }, submission: submissionSchema, submissionId: { type: 'string', minLength: 1 } } }, annotations: { readOnlyHint: false },
    async handler(args) { const { idempotencyKey, ...parameters } = args; const { root, store } = openNativeStore(workspace); store.close(); return await gateway.call(name, parameters, { binding: { ...binding, sessionId: scope(root) ?? binding.sessionId }, idempotencyKey: idempotencyKey as string }) as Record<string, any> },
  }
}
