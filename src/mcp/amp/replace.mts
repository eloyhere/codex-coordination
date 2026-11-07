/** Canonical AMP replace port: host-reviewed, workflow-admitted, journaled pattern edits. */
import { Workspace, WorkspaceError } from 'attention-manifest-protocol/workspace'
import { NodeFileStorage } from 'attention-manifest-protocol/file'
import { createReplaceToolHandler, REPLACE_TOOL } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { lstatSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import { nativeIoBudget, nativeReadReservation } from './read-budget.mjs'

const eventKind = 'codex.amp.workspace.replace'
const actor = 'mcp-host-file-execution'
const MODES = ['string', 'regex', 'line', 'byte', 'outline']
const PARAMETERS = ['path', 'mode', 'replacement', 'text', 'pattern', 'flags', 'occurrence', 'all', 'start', 'end', 'id', 'expectedBufferVersion', 'expectedBaseHash', 'taskId', 'idempotencyKey']

class ScopedReplaceStorage extends NodeFileStorage {
  readonly bounded: NativeReadStorage
  constructor(policy: NativeFilesystemScope, tenantId: string) {
    super({ root: policy.root, createRoot: false, maxFileBytes: 16 * 1024 * 1024, fsync: true })
    this.bounded = new NativeReadStorage(policy, tenantId)
  }
  checked(path: string) {
    const absolute = this.bounded.path(path)
    const stat = lstatSync(absolute)
    if (stat.nlink !== 1) throw new WorkspaceError('invalid_scope', 'Hard-linked files are not editable')
    return { absolute, stat, raw: this.bounded.raw(path) }
  }
  override read(ref: any) { this.checked(ref.path); return super.read(ref) }
  override acquireLease(ref: any, owner: string, ttl?: number) { this.checked(ref.path); return super.acquireLease(ref, owner, ttl) }
  override compareAndSwap(ref: any, expectedHash: string, content: string, fence: number) { this.checked(ref.path); return super.compareAndSwap(ref, expectedHash, content, fence) }
}

function admission(persistence: WorkflowPersistence, selected: string, taskId: string) {
  const workflow = persistence.workflow
  if (!['active', 'idle'].includes(workflow.get('session', selected).state)) throw new Error('Selected workflow is not active')
  const task = workflow.get('task', taskId)
  if (task.sessionId !== selected || !['ready', 'active', 'running'].includes(task.state)) throw new Error('Task must belong to the selected workflow and be ready/active')
  const plan = workflow.get('plan', task.planId)
  if (!['executing', 'running'].includes(plan.state) || Date.parse(plan.bounds.deadline) <= Date.now()) throw new Error('Task plan is not executing or its bounds expired')
  const goal = workflow.get('goal', plan.goalId)
  if (goal.state !== 'active') throw new Error('Task goal must be active')
  if (!['active', 'achieved'].includes(workflow.get('mission', goal.missionId).state)) throw new Error('Task mission must be active before file execution')
  return task
}

function structure(input: Record<string, any>) {
  if (!MODES.includes(String(input.mode))) throw new Error(`mode must be one of ${MODES.join(', ')}`)
  if (typeof input.replacement !== 'string') throw new Error('replacement must be a string')
  if (String(input.mode) === 'string' && (typeof input.text !== 'string' || !input.text)) throw new Error('text is required for string mode')
  if (String(input.mode) === 'regex' && (typeof input.pattern !== 'string' || !input.pattern)) throw new Error('pattern is required for regex mode')
  if (String(input.mode) === 'outline' && (typeof input.id !== 'string' || !input.id)) throw new Error('id is required for outline mode')
  if (['line', 'byte'].includes(String(input.mode))) {
    if (!Number.isSafeInteger(input.start) || input.start < 0 || !Number.isSafeInteger(input.end) || input.end < input.start) throw new Error('start/end must be nonnegative integers with end >= start')
  }
}

export function replaceBinding(binding: AgentBinding, workspace: () => unknown, filesystemPolicy?: () => NativeFilesystemScope | undefined, scope?: (root: string) => string | undefined): ToolDefinition {
  const name = 'attention_manifest_protocol_replace'
  const policyFor = (root: string) => {
    const configured = filesystemPolicy?.()
    if (configured && realpathSync(configured.root) !== root) throw new Error('Filesystem policy belongs to another workspace')
    return configured ?? { root, exclude: [] }
  }
  return {
    name,
    description: 'Host-approved canonical AMP replace inside one selected native workflow task: literal string, regular expression, line range, UTF-8 byte range or outline node, with optional expectedBufferVersion/expectedBaseHash compare-and-swap guards. Uses native lease/CAS flush and a durable idempotency journal. Not a general Action scheduler; no task/goal acceptance.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'mode', 'replacement', 'taskId', 'idempotencyKey'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024 }, mode: { enum: MODES }, replacement: { type: 'string', maxLength: 1048576 },
      text: { type: 'string' }, pattern: { type: 'string', maxLength: 4096 }, flags: { type: 'string', maxLength: 8 }, occurrence: { type: 'integer', minimum: 1 }, all: { type: 'boolean' },
      start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, id: { type: 'string', minLength: 1, maxLength: 1024 },
      expectedBufferVersion: { type: 'integer', minimum: 0 }, expectedBaseHash: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$' },
      taskId: { type: 'string', minLength: 1, maxLength: 200 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    } },
    annotations: { readOnlyHint: false },
    async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, any>
      if (Object.keys(args).some(key => !PARAMETERS.includes(key))) throw new Error('Unknown replace parameter')
      for (const key of ['path', 'taskId', 'idempotencyKey']) if (typeof args[key] !== 'string' || !args[key]) throw new Error(key + ' must be a nonempty string')
      structure(args)
      const parameters = { ...args }; delete parameters.taskId; delete parameters.idempotencyKey
      const { root, store } = openNativeStore(workspace)
      const key = binding.principalId + ':' + args.idempotencyKey
      const history = () => store.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key)
      let selected: string, request: string, policy: NativeFilesystemScope, storage: ScopedReplaceStorage, target: { absolute: string; stat: any; raw: any }
      try {
        const candidate = scope?.(root)
        if (!candidate) throw new Error('Select an active native workflow before replacing')
        selected = candidate
        request = nativeRequest({ ...parameters, taskId: args.taskId, scope: selected })
        policy = JSON.parse(nativeRequest(policyFor(root))) as NativeFilesystemScope
        storage = new ScopedReplaceStorage(policy, binding.tenantId)
        const prior = history().at(-1)
        if (prior) {
          if (prior.request !== request) throw new Error('Idempotency key already used for a different replace')
          if (prior.result) return { ...prior.result, replayed: true }
          throw new Error('Replace outcome is unresolved; host reconciliation is required before retry')
        }
        const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
        const restored = persistence.restoreAll()
        if (restored.skipped.length) throw new Error('Native workflow facts are invalid: ' + restored.skipped.join(', '))
        admission(persistence, selected, String(args.taskId))
        target = storage.checked(String(args.path))
        store.transaction(() => {
          if (history().length) throw new Error('Concurrent replace claimed this idempotency key')
          store.appendEvent(eventKind, { key, request, state: 'approval_pending', beforeRawHash: target.raw.hash, beforeVersion: target.stat.mtimeMs })
        })
      } finally { store.close() }

      const approved = await requestHostApproval('native-workflow:' + selected, name, { ...parameters, taskId: args.taskId, rawHash: target.raw.hash, workspace: root, note: 'Exact native replace; the raw hash pins the pre-edit bytes' })
      const db = openNativeStore(() => root), dbStore = db.store
      try {
        const claim = dbStore.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key).at(-1)
        if (claim?.request !== request || claim.state !== 'approval_pending') throw new Error('Replace claim changed during approval')
        if (!approved) {
          const result = { approved: false, changed: false }
          dbStore.appendEvent(eventKind, { key, request, result })
          return result
        }
        const reservationId = 'replace-budget:' + randomUUID()
        dbStore.transaction(() => {
          const persistence = new WorkflowPersistence({ store: dbStore, workflow: new WorkflowStore() })
          if (persistence.restoreAll().skipped.length) throw new Error('Native workflow facts changed during approval')
          admission(persistence, selected, String(args.taskId))
          const now = storage.checked(String(args.path))
          if (now.raw.hash !== target.raw.hash || now.stat.ino !== target.stat.ino || now.stat.dev !== target.stat.dev || now.stat.mtimeMs !== target.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed during approval')
          nativeIoBudget(dbStore, 'native-read:' + binding.principalId).reserve(reservationId, 'native-read:' + binding.principalId, nativeReadReservation)
          dbStore.appendEvent(eventKind, { key, request, state: 'started', reservationId, beforeRawHash: target.raw.hash })
        })
        let result: Record<string, any> | undefined, failure: unknown
        try {
          const native = new Workspace({ tenantId: binding.tenantId, rootId: storage.bounded.rootId, storage, outline: undefined as any })
          result = createReplaceToolHandler(native)(parameters, { binding: { ...binding, sessionId: selected }, tool: REPLACE_TOOL, idempotencyKey: args.idempotencyKey }) as Record<string, any>
        } catch (error) { failure = error }
        try {
          dbStore.transaction(() => {
            const evidence = failure ? null : { ...result, approved: true, changed: true, path: String(args.path), taskId: String(args.taskId), mode: String(args.mode), workspace: root }
            nativeIoBudget(dbStore, 'native-read:' + binding.principalId).settle(reservationId, { calls: 1, bytes: nativeReadReservation.bytes })
            dbStore.appendEvent(eventKind, failure
              ? { key, request, state: 'unknown_outcome', reservationId, error: String(failure) }
              : { key, request, state: 'succeeded', reservationId, result: evidence })
          })
        } catch { /* the started claim stays unresolved */ }
        if (failure) throw new Error('Replace outcome is unresolved; host reconciliation is required before retry: ' + String(failure))
        return { ...result!, approved: true, changed: true, taskId: String(args.taskId), workspace: root }
      } finally { dbStore.close() }
    },
  }
}
