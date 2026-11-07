/** Host-reviewed cancellation through the native kernel; no execution settlement is inferred. */
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { WorkflowKind, WorkflowSnapshot } from 'attention-manifest-protocol/workflow'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import { nativeRequest, openNativeStore } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { randomUUID } from 'node:crypto'

const requested = 'codex.amp.workflow.cancel_requested'
const decided = 'codex.amp.workflow.cancel_host_decision'
const reviewed = 'codex.amp.workflow.cancel_review'
const kinds = ['mission', 'goal', 'plan', 'task', 'action', 'intent']
const fields = ['operation', 'kind', 'id', 'expectedVersion', 'idempotencyKey', 'reason']
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max
const plain = <T,>(value: T): T => JSON.parse(nativeRequest(value))
type Command = { operation: 'request_cancel' | 'cascade'; kind: WorkflowKind; id: string; expectedVersion: number; idempotencyKey: string; reason: string }

export function workflowCancelReview(binding: AgentBinding, workspace: () => unknown, scope: (root: string) => string | undefined): ToolDefinition {
  const identity = { tenantId: binding.tenantId, principalId: binding.principalId, connection: binding.sessionId }
  const terminal = (store: Store, key: string, request: string) => {
    const prior = store.events({ kind: reviewed }).map(event => event.payload as any).find(value => value.key === key)
    if (!prior) return undefined
    if (prior.request !== request) throw new Error('Idempotency key already used for another cancellation')
    return { ...prior.result, replayed: true }
  }
  const unresolvedTarget = (store: Store, args: Command, selected: string) => {
    const completed = new Set(store.events({ kind: reviewed }).map(event => (event.payload as any).result?.reviewId))
    return store.events({ kind: requested }).map(event => event.payload as any).find(value => !completed.has(value.reviewId) && value.snapshot?.selected === selected && value.snapshot?.target?.kind === args.kind && value.snapshot?.target?.id === args.id)
  }
  const read = (store: Store, root: string, args: Command) => {
    const selected = scope(root)
    if (!selected) throw new Error('Select a native workflow first')
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    if (persistence.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
    const target = persistence.workflow.get(args.kind, args.id)
    const session = persistence.workflow.get('session', selected)
    if (target.sessionId !== selected || session.id !== session.sessionId) throw new Error('Target is outside the selected workflow scope')
    if (target.version !== args.expectedVersion) throw new Error('Target version changed; read the current target before cancellation')
    return { selected, target, snapshot: persistence.workflow.snapshot() }
  }
  const apply = (snapshot: WorkflowSnapshot, args: Command) => {
    const workflow = WorkflowStore.restore(snapshot)
    const target = workflow.get(args.kind, args.id)
    if (target.version !== args.expectedVersion) throw new Error('Cancellation expectedVersion changed')
    if (args.operation === 'cascade') workflow.cancelCascade(args.id, { actor: 'mcp-host-review', reason: args.reason })
    else workflow.requestCancel(args.kind as 'mission' | 'goal' | 'plan' | 'task' | 'action', args.id, { expectedVersion: args.expectedVersion, cancellationEpoch: target.cancellationEpoch, actor: 'mcp-host-review', reason: args.reason })
    const after = workflow.snapshot()
    const events = after.events.slice(snapshot.events.length)
    const updated = after.entities.filter(entity => events.some(event => event.entityKind === entity.kind && event.entityId === entity.id))
    if (updated.some(entity => entity.sessionId !== target.sessionId)) throw new Error('Cancellation propagation escaped selected workflow scope')
    return { workflow, after, events, updated }
  }
  return {
    name: 'attention_manifest_protocol_workflow_cancel_review',
    description: 'Host extension: independently approve native request_cancel for mission/goal/plan/task/action, or cascade from intent. Exact version, selected scope and complete workflow head are rechecked. Propagates native cancellation epochs without claiming effects settled. Unresolved decisions fail closed on retry.',
    inputSchema: { type: 'object', additionalProperties: false, required: fields, properties: {
      operation: { enum: ['request_cancel', 'cascade'] }, kind: { enum: kinds }, id: { type: 'string', minLength: 1, maxLength: 200 }, expectedVersion: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    } }, annotations: { readOnlyHint: false },
    async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(plain(input)) as Command
      if (Object.keys(args).some(key => !fields.includes(key)) || !kinds.includes(args.kind) || !['request_cancel', 'cascade'].includes(args.operation) || (args.operation === 'cascade') !== (args.kind === 'intent') || !text(args.id, 200) || !text(args.idempotencyKey, 200) || !text(args.reason, 2000) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0) throw new Error('Invalid cancellation parameters: use request_cancel for work or cascade for intent, with exact version, key and reason')
      const opened = openNativeStore(workspace), root = opened.root
      const key = nativeRequest({ ...identity, idempotencyKey: args.idempotencyKey }), request = nativeRequest(args)
      let snapshot: ReturnType<typeof read>, head: string, reviewId: string, approved = false, resumed = false
      try {
        const replay = terminal(opened.store, key, request)
        if (replay) return replay
        const pending = opened.store.events({ kind: requested }).map(event => event.payload as any).find(value => value.key === key)
        if (pending) {
          if (pending.request !== request) throw new Error('Idempotency key already used for another cancellation')
          const decision = opened.store.events({ kind: decided }).map(event => event.payload as any).find(value => value.reviewId === pending.reviewId && value.key === key && value.request === request)
          if (!decision) throw new Error('Cancellation review is unresolved; host reconciliation is required, no repeated approval requested')
          snapshot = pending.snapshot; head = pending.head; reviewId = pending.reviewId; approved = decision.approved === true; resumed = true
        } else {
          snapshot = read(opened.store, root, args)
          if (unresolvedTarget(opened.store, args, snapshot.selected)) throw new Error('Cancellation target has an unresolved review; retry its original review key')
          apply(snapshot.snapshot, args) // Native proof only, no durable workflow changes.
          head = nativeRequest(snapshot)
          reviewId = randomUUID()
          opened.store.transaction(() => {
            if (opened.store.events({ kind: requested }).some(event => (event.payload as any).key === key) || unresolvedTarget(opened.store, args, snapshot.selected)) throw new Error('Cancellation review is unresolved; retry its original key')
            opened.store.appendEvent(requested, { key, request, reviewId, snapshot, head, ...identity })
          })
        }
      } finally { opened.store.close() }
      if (!resumed) {
        approved = await requestHostApproval('native-workflow:' + snapshot!.selected, args.operation, { reviewId: reviewId!, ...args, workspace: root, selected: snapshot!.selected, target: snapshot!.target, effect: { cancellationRequested: true, executionSettled: false } })
        const audit = openNativeStore(() => root)
        try { audit.store.appendEvent(decided, { key, request, reviewId: reviewId!, approved, ...identity }) } finally { audit.store.close() }
      }
      const current = openNativeStore(() => root)
      try {
        return current.store.transaction(() => {
          const replay = terminal(current.store, key, request)
          if (replay) return replay
          let valid = false
          try {
            const active = openNativeStore(workspace)
            try { valid = active.root === root } finally { active.store.close() }
            valid = valid && approved && nativeRequest(read(current.store, root, args)) === head!
          } catch { valid = false }
          let result: Record<string, any> = { approved, changed: false, reviewId: reviewId!, status: approved ? 'stale_after_approval' : 'rejected', executionSettled: false }
          if (valid) {
            const effect = apply(snapshot!.snapshot, args)
            const persistence = new WorkflowPersistence({ store: current.store, workflow: effect.workflow })
            for (const entity of effect.updated) {
              const before = snapshot!.snapshot.entities.find(value => value.kind === entity.kind && value.id === entity.id)!
              current.store.save(entity.kind, entity, { expectedVersion: before.version })
            }
            for (const event of effect.events) persistence.persistEvent(event)
            result = { ...result, status: 'cancel_requested', changed: effect.updated.length > 0, cancellationEpoch: effect.after.cancellationEpoch, updated: effect.updated }
          }
          current.store.appendEvent(reviewed, { key, request, ...identity, scope: snapshot!.selected, result })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
