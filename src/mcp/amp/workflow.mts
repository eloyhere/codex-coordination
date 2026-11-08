/** Scoped native workflow queries; reads follow the selected imported snapshot or the selected live Codex thread. */
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { Store } from 'attention-manifest-protocol/service'
import type { WorkflowKind } from 'attention-manifest-protocol/workflow'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore } from './native-store.mjs'
import { workflowReview } from './workflow-review.mjs'
import { draftBinding } from './draft.mjs'
import { progressBinding } from './progress.mjs'
import { scopedAttempt } from './attempt-scope.mjs'

export type WorkflowOrigin = 'native-plugin-workflow' | 'codex-live'
export interface WorkflowScopeResolution {
  readonly scope: string
  readonly origin: WorkflowOrigin
  readonly threadId?: string
}
/**
 * Host-only scope lookup shared by the canonical mutating workflow tools.
 *
 * A supplied `Store` is reused so the callback never opens a second connection
 * inside an already-open transaction; without one a Store is opened and closed
 * for the single lookup. A legacy `(root) => string` callback remains valid
 * because the Store argument is optional.
 */
export type WorkflowScopeCallback = (root: string, store?: Store) => string | undefined

const SELECT_SCOPE_ERROR = 'Select an imported native workflow with attention_manifest_protocol_workflow_scope or an observed Codex thread with attention_manifest_protocol_session.get first'
const LIVE_ORIGIN: WorkflowOrigin = 'codex-live'
const IMPORTED_ORIGIN: WorkflowOrigin = 'native-plugin-workflow'

/**
 * Resolves one read scope from the durable selection made on this MCP connection.
 * An explicitly selected imported snapshot always wins; otherwise the observed
 * Codex thread selected through `session.get` is followed to its native Session.
 * There is deliberately no fallback from a live thread to imported facts.
 */
export function resolveWorkflowScope(store: Store, root: string, selected: Map<string, string>, threadForRoot?: (root: string) => string | undefined): WorkflowScopeResolution {
  const imported = selected.get(root)
  if (imported) return { scope: imported, origin: IMPORTED_ORIGIN }
  const threadId = threadForRoot?.(root)
  if (!threadId) throw new Error(SELECT_SCOPE_ERROR)
  const mapping = store.events({ kind: 'codex.sync.session_mapping' })
    .map(item => item.payload as { threadId?: unknown; sessionId?: unknown })
    .find(item => item.threadId === threadId)
  if (!mapping || typeof mapping.sessionId !== 'string' || !mapping.sessionId) throw new Error(`Selected Codex thread ${threadId} has no native session mapping in this project`)
  if (!store.list<any>('session').some(item => item?.id === mapping.sessionId)) throw new Error(`Native session ${mapping.sessionId} is missing for Codex thread ${threadId}`)
  return { scope: mapping.sessionId, origin: LIVE_ORIGIN, threadId }
}

/** Resolves one scope from an already-open Store, reusing the exact selection rules. */
export function scopeForRoot(store: Store, root: string, selected: Map<string, string>, threadForRoot?: (root: string) => string | undefined): string {
  return resolveWorkflowScope(store, root, selected, threadForRoot).scope
}

/**
 * Builds the live-aware callback handed to workflow review, plan proposals and
 * task progress. Imported selection still wins; otherwise the observed Codex
 * thread is followed. The callback resolves against the caller's open Store when
 * one is supplied, so a live scope never requires a second SQLite connection.
 */
export function scopeCallback(selected: Map<string, string>, threadForRoot?: (root: string) => string | undefined): WorkflowScopeCallback {
  return (root, store) => {
    if (store) return scopeForRoot(store, root, selected, threadForRoot)
    const opened = openNativeStore(() => root)
    try { return scopeForRoot(opened.store, opened.root, selected, threadForRoot) } finally { opened.store.close() }
  }
}

export function workflowBindings(binding: AgentBinding, workspace: () => unknown, selected = new Map<string, string>(), threadForRoot?: (root: string) => string | undefined): ToolDefinition[] {
  const standard = createAgentSurface()
  // One live-aware resolver is shared by the canonical mutating workflow tools
  // so review, plan proposals and task progress follow exactly the same
  // selection precedence as the reads below (imported wins, else live thread).
  const resolveScope = scopeCallback(selected, threadForRoot)
  const modules = new Set(['goal', 'plan', 'mission', 'intent', 'task', 'action'])
  const descriptors = standard.tools.filter(tool => modules.has(tool.module) && ['get', 'list', 'list_ready', 'ready_tasks'].includes(tool.verb))
  const handlers: Record<string, GatewayHandler> = {}
  for (const descriptor of descriptors) handlers[descriptor.name] = (parameters, _context) => {
    const { root, store } = openNativeStore(workspace)
    try {
      // Scope is resolved inside the opened Store on every call. Imported
      // selection wins over a live thread; no entity from one origin is mixed
      // into a result from the other.
      const resolution = resolveWorkflowScope(store, root, selected, threadForRoot)
      const scope = resolution.scope
      const provenance = resolution.origin === LIVE_ORIGIN
        ? { origin: LIVE_ORIGIN, threadId: resolution.threadId!, sessionId: scope }
        : { origin: IMPORTED_ORIGIN }
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
      const report = persistence.restoreAll()
      if (report.skipped.length) throw new Error('Native workflow has invalid facts: ' + report.skipped.join(', '))
      const workflow = persistence.workflow
      const kind = descriptor.module as WorkflowKind
      const get = (id: unknown) => {
        if (typeof id !== 'string' || !id.length) throw new Error('id is required')
        const entity = workflow.get(kind, id)
        if (entity.sessionId !== scope) throw new Error('Entity is outside the selected workflow scope')
        return entity
      }
      if (kind === 'action') {
        if (descriptor.verb === 'get') {
          if (typeof parameters.id !== 'string' || !parameters.id.length) throw new Error('attempt id is required')
          const { attempt } = scopedAttempt(workflow, parameters.id, scope)
          return { attempt, scope, ...provenance }
        }
        if (typeof parameters.taskId !== 'string' || !parameters.taskId.length) throw new Error('taskId is required')
        const task = workflow.get('task', parameters.taskId)
        if (task.sessionId !== scope) throw new Error('Task is outside the selected workflow scope')
        const attempts = workflow.list('action', scope).filter(action => action.taskId === task.id)
          .flatMap(action => action.attemptIds.map(id => workflow.getAttempt(id)))
        return { attempts, taskId: task.id, scope, total: attempts.length, ...provenance }
      }
      if (descriptor.verb === 'get') return { entity: get(parameters.id), scope, ...provenance, ...(kind === 'task' ? { progress: store.events({ kind: 'codex.amp.task.progress' }).map(event => event.payload as any).filter(report => report.taskId === parameters.id && report.sessionId === scope).slice(-20) } : {}) }
      if (descriptor.verb === 'ready_tasks' || descriptor.verb === 'list_ready') {
        const session = workflow.get('session', scope)
        const planId = descriptor.verb === 'ready_tasks' ? get(parameters.id).id : undefined
        const tasks = workflow.list('task', scope).filter(task => (!planId || task.planId === planId) && task.state === 'ready')
          .filter(task => {
            const plan = workflow.get('plan', task.planId)
            return ['approved', 'ready', 'executing', 'running'].includes(plan.state) && task.dependsOn.every(id => ['completed', 'succeeded', 'skipped'].includes(workflow.get('task', id).state))
          })
        return { tasks: ['active', 'idle'].includes(session.state) ? tasks : [], sessionState: session.state, scope, ...provenance, executionAuthorized: false }
      }
      const limit = Number(parameters.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100')
      const entities = workflow.list(kind, scope)
      return { entities: entities.slice(0, limit), total: entities.length, scope, ...provenance }
    } finally { store.close() }
  }
  const permitted = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...standard, tools: descriptors }, authorize: values => values.every(value => permitted.has(value)),
    onCall(record) {
      if (typeof workspace() !== 'string') return
      const { root, store } = openNativeStore(workspace)
      try {
        const imported = selected.get(root)
        const threadId = imported ? undefined : threadForRoot?.(root)
        const mapping = threadId === undefined ? undefined : store.events({ kind: 'codex.sync.session_mapping' })
          .map(item => item.payload as { threadId?: unknown; sessionId?: unknown })
          .find(item => item.threadId === threadId)
        const workflowScope = imported ?? (typeof mapping?.sessionId === 'string' ? mapping.sessionId : null)
        store.appendEvent('codex.amp.workflow.call', {
          ...record,
          principalId: binding.principalId,
          workflowOrigin: imported ? IMPORTED_ORIGIN : threadId === undefined ? null : LIVE_ORIGIN,
          workflowScope,
          ...(threadId === undefined ? {} : { threadId }),
        })
      } finally { store.close() }
    },
  })
  const tools: ToolDefinition[] = descriptors.map(descriptor => ({ name: descriptor.name,
    description: descriptor.description + ' Reads native entities for the observed Codex thread selected with attention_manifest_protocol_session.get, or for the imported workflow snapshot selected with attention_manifest_protocol_workflow_scope (imported wins when both are selected). Results report origin "codex-live" with threadId and the native sessionId, or origin "native-plugin-workflow". Live reads never fall back to imported facts. Plan proposals, task progress and workflow review follow the same selection: an imported snapshot wins when explicitly selected, otherwise the observed live Codex thread is used. attention_manifest_protocol_workflow_scope still selects imported snapshots only. This is plugin workflow state, not Codex chat lifecycle. Legacy reads remain available through coordination tools.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['get', 'ready_tasks'].includes(descriptor.verb) ? ['id'] : descriptor.module === 'action' && descriptor.verb === 'list' ? ['taskId'] : [], properties: ['get', 'ready_tasks'].includes(descriptor.verb) ? { id: { type: 'string', minLength: 1 } } : descriptor.module === 'action' && descriptor.verb === 'list' ? { taskId: { type: 'string', minLength: 1 } } : { limit: { type: 'integer', minimum: 1, maximum: 100 } } }, annotations: { readOnlyHint: true },
    async handler(args) {
      // Best-effort binding scope; the handler resolves again inside its own
      // Store and reports the exact selection error through the gateway so the
      // failed call is still journaled by onCall.
      const resolution = (() => {
        const { root, store } = openNativeStore(workspace)
        try { return resolveWorkflowScope(store, root, selected, threadForRoot) } catch { return undefined } finally { store.close() }
      })()
      return await gateway.call(descriptor.name, args, { binding: { ...binding, sessionId: resolution?.scope ?? binding.sessionId } }) as Record<string, any>
    },
  }))
  tools.push({ name: 'attention_manifest_protocol_workflow_scope', description: 'List or select imported native workflow snapshots for this MCP connection and workspace. Imported selection takes precedence over a live observed thread for canonical workflow reads. Selection grants no execution and is not a Codex session switch. Restart requires selection again.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['list', 'select', 'current'] }, sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    async handler(args) {
      const { root, store } = openNativeStore(workspace)
      try {
        const imports = store.events({ kind: 'codex.amp.legacy_import' }).map(event => event.payload as Record<string, any>)
        if (args.action === 'select') {
          const target = imports.find(item => item.sourceDigest === args.sourceDigest)
          if (!target) throw new Error('No imported workflow matches sourceDigest in this workspace')
          store.appendEvent('codex.amp.workflow.scope_selected', { principalId: binding.principalId, connection: binding.sessionId, sessionId: target.sessionId })
          selected.set(root, target.sessionId)
        } else if (!['list', 'current'].includes(String(args.action))) throw new Error('Unknown scope action')
        return { selected: selected.get(root) ?? null, workflows: imports.map(({ sourceDigest, sessionId, goals, plans }) => ({ sourceDigest, sessionId, goals, plans })), executionAuthorized: false }
      } finally { store.close() }
    },
  })
  tools.push(workflowReview(binding, workspace, resolveScope))
  tools.push(draftBinding(binding, workspace, resolveScope))
  tools.push(progressBinding(binding, workspace, resolveScope))
  return tools
}
