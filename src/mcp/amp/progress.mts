/** Version-anchored agent progress claims, independent of task acceptance. */
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest, sameNativeRequest } from './native-store.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import { randomUUID } from 'node:crypto'
import { currentAttempt } from './attempt-scope.mjs'

export function progressBinding(binding: AgentBinding, workspace: () => unknown, scope: WorkflowScopeCallback): ToolDefinition {
  const standard = createAgentSurface()
  const descriptor = standard.tools.find(tool => tool.module === 'task' && tool.verb === 'report_progress')!
  const gateway = new AgentGateway({ surface: { ...standard, tools: [descriptor] }, authorize: values => values.every(value => descriptor.authority.includes(value)), handlers: {
    [descriptor.name]: (parameters, context) => {
      const { root, store } = openNativeStore(workspace)
      try { return store.transaction(() => {
        // Reuse the already-open Store so the same imported/live precedence as
        // the canonical reads applies without a second SQLite connection.
        const selected = scope(root, store)
        if (!selected) throw new Error('Select a native workflow first')
        if (typeof parameters.id !== 'string' || typeof parameters.summary !== 'string' || !parameters.summary.trim() || parameters.summary.length > 4000 || !Number.isSafeInteger(parameters.expectedVersion) || Number(parameters.expectedVersion) < 0) throw new Error('Task id, expectedVersion and a nonempty bounded summary are required')
        const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
        if (persistence.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
        const task = persistence.workflow.get('task', parameters.id)
        if (task.sessionId !== selected) throw new Error('Task is outside the selected workflow scope')
        const key = binding.principalId + ':' + context.idempotencyKey
        const request = nativeRequest({ ...parameters, scope: selected })
        const previous = store.events({ kind: 'codex.amp.task.progress' }).find(event => (event.payload as any).key === key)?.payload as any
        if (previous) {
          if (!sameNativeRequest(previous.request, request)) throw new Error('Idempotency key already used for a different progress report')
          return { ...previous, replayed: true }
        }
        const { attempt, action } = currentAttempt(persistence.workflow, binding, selected, task.id)
        const epoch = attempt.cancellationEpoch
        if (task.version !== parameters.expectedVersion) throw new Error('Task version changed; read current task before reporting progress')
        if (!['active', 'idle'].includes(persistence.workflow.get('session', selected).state)) throw new Error('Resume the selected workflow before reporting progress')
        if (['completed', 'succeeded', 'skipped', 'failed', 'dead_letter', 'cancelled', 'completed_after_cancel'].includes(task.state)) throw new Error('Task is settled; progress cannot be appended')
        const report = { id: randomUUID(), key, request, taskId: task.id, sessionId: selected, taskVersion: task.version, taskState: task.state, attemptId: attempt.attemptId, executionId: attempt.executionId, operationId: attempt.operationId, cancellationEpoch: epoch, summary: parameters.summary, principalId: binding.principalId, source: 'agent-progress-claim', verified: false, recordedAt: new Date().toISOString() }
        store.appendEvent('codex.amp.task.progress', report, report.id)
        return { ...report, replayed: false }
      }) } finally { store.close() }
    },
  }, onCall(record) {
    if (typeof workspace() !== 'string') return
    const { store } = openNativeStore(workspace)
    try { store.appendEvent('codex.amp.task.progress.call', { ...record, principalId: binding.principalId }) } finally { store.close() }
  } })
  return { name: descriptor.name, description: descriptor.description + ' Persist a version-anchored progress claim for a task in the selected native workflow. Does not execute, transition, verify or complete the task. Claims are visible in task.get.', inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'expectedVersion', 'summary', 'idempotencyKey'], properties: { id: { type: 'string', minLength: 1 }, expectedVersion: { type: 'integer', minimum: 0 }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 } } }, annotations: { readOnlyHint: false }, async handler(args) {
    const { idempotencyKey, ...parameters } = args
    return await gateway.call(descriptor.name, parameters, { binding, idempotencyKey: idempotencyKey as string }) as Record<string, any>
  } }
}
