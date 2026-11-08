/** Narrow host-approved file effects. This is not a general Action scheduler. */
import { Workspace, WorkspaceError } from 'attention-manifest-protocol/workspace'
import { NodeFileStorage, lockPathOf, fencePathOf, createOutlineProvider, normalizeToLf } from 'attention-manifest-protocol/file'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { createInvocation, createObservation, createReceiptCore } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { EditPlan, FileLease, FileRef, FileStoragePort, StoredFile, WriteTarget } from 'attention-manifest-protocol/file'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { openNativeStore, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { nativeIoBudget, nativeReadReservation } from './read-budget.mjs'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'

/** Kept as an alias so existing callers see the shared live-aware callback shape. */
export type WriteScope = WorkflowScopeCallback
const digest = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const sha256 = (value: string) => digest(value).slice(7)
const actor = 'mcp-host-file-execution'
const eventKind = 'codex.amp.workspace.write'
const parameterNames = ['path', 'content', 'expectedHash', 'target', 'expectedBufferVersion', 'taskId', 'idempotencyKey']
/** The provider is a pure function of the current buffer, so it also covers unsaved edit plans. */
const outlineProvider = createOutlineProvider()

/**
 * Normalize a `WriteTarget` before anything durable happens. Unknown fields, an
 * unknown mode, non-integer/negative bounds or a missing outline id are rejected
 * here, so a malformed target can never reach an approval prompt or a claim.
 */
function normalizeWriteTarget(value: unknown): WriteTarget | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('target must be an object with a mode')
  const target = value as Record<string, unknown>
  if (target.mode === 'line' || target.mode === 'byte') {
    if (Object.keys(target).some(key => !['mode', 'start', 'end'].includes(key))) throw new Error('Unknown target parameter')
    for (const key of ['start', 'end'] as const) if (!Number.isSafeInteger(target[key]) || (target[key] as number) < 0) throw new Error('target ' + key + ' must be a nonnegative integer')
    if ((target.end as number) < (target.start as number)) throw new Error('target end must be greater than or equal to start')
    const start = target.start as number, end = target.end as number
    return Object.freeze(target.mode === 'line' ? { mode: 'line', start, end } : { mode: 'byte', start, end })
  }
  if (target.mode === 'outline') {
    if (Object.keys(target).some(key => !['mode', 'id'].includes(key))) throw new Error('Unknown target parameter')
    if (typeof target.id !== 'string' || !target.id.trim() || target.id.length > 1024) throw new Error('target id must be a nonempty string of at most 1024 characters')
    return Object.freeze({ mode: 'outline', id: target.id })
  }
  throw new Error('target mode must be one of line, byte, outline')
}

/**
 * A plan-only storage port over the exact base snapshot. `planWrite` needs a
 * writable mount, but a preflight must not take the real lease or touch disk.
 */
function previewStorage(base: StoredFile): FileStoragePort {
  return {
    read(ref: FileRef) { return { ...base, ...ref } },
    acquireLease(ref: FileRef, owner: string): FileLease { return { ...ref, owner, fence: 1, token: 'write-preflight' } },
    releaseLease() {},
    compareAndSwap() { throw new WorkspaceError('read_only', 'Preflight storage cannot commit') },
  }
}

function restore(store: ReturnType<typeof openNativeStore>['store']) {
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  const report = persistence.restoreAll()
  if (report.skipped.length) throw new Error('Native workflow facts are invalid: ' + report.skipped.join(', '))
  return persistence
}

class ScopedWriteStorage extends NodeFileStorage {
  readonly bounded: NativeReadStorage
  readonly policy: NativeFilesystemScope
  constructor(policy: NativeFilesystemScope, tenantId: string) {
    super({ root: policy.root, createRoot: false, maxFileBytes: 16 * 1024 * 1024, fsync: true })
    this.policy = policy
    this.bounded = new NativeReadStorage(policy, tenantId)
  }
  checked(path: string) {
    const absolute = this.bounded.path(path)
    const stat = lstatSync(absolute)
    if (stat.nlink !== 1) throw new WorkspaceError('invalid_scope', 'Hard-linked files are not writable')
    for (const sidecar of [lockPathOf(absolute), fencePathOf(absolute)]) if (existsSync(sidecar) && (!lstatSync(sidecar).isFile() || lstatSync(sidecar).isSymbolicLink())) throw new WorkspaceError('invalid_scope', 'Unsafe file lock metadata')
    return { absolute, stat, raw: this.bounded.raw(path) }
  }
  override read(ref: FileRef): StoredFile | undefined { this.checked(ref.path); return super.read(ref) }
  override acquireLease(ref: FileRef, owner: string, ttlMilliseconds?: number) { this.checked(ref.path); return super.acquireLease(ref, owner, ttlMilliseconds) }
  override compareAndSwap(ref: FileRef, expectedHash: string, content: string, fence: number) { this.checked(ref.path); return super.compareAndSwap(ref, expectedHash, content, fence) }
}

/** The scope callback must return the independently selected workflow session id. */
export function writeBinding(binding: AgentBinding, workspace: () => unknown, filesystemPolicy?: () => NativeFilesystemScope | undefined, scope?: WriteScope): ToolDefinition {
  const name = 'attention_manifest_protocol_workspace.write'
  const policyFor = (root: string): NativeFilesystemScope => {
    const configured = filesystemPolicy?.()
    if (configured && realpathSync(configured.root) !== root) throw new Error('Filesystem policy belongs to another workspace')
    return configured ?? { root, exclude: [] }
  }
  const assertContext = (root: string, selected: string, store: Store) => {
    if (typeof workspace() !== 'string' || realpathSync(String(workspace())) !== root || scope?.(root, store) !== selected) throw new Error('Workspace or workflow scope changed during write')
  }
  const admission = (persistence: WorkflowPersistence, selected: string, taskId: string, allowReady: boolean) => {
    const workflow = persistence.workflow
    if (!['active', 'idle'].includes(workflow.get('session', selected).state)) throw new Error('Selected workflow is not active')
    const task = workflow.get('task', taskId)
    if (task.sessionId !== selected || !(allowReady ? ['ready', 'active', 'running'] : ['active', 'running']).includes(task.state)) throw new Error('Task must belong to selected workflow and be ready/active')
    const plan = workflow.get('plan', task.planId)
    if (!['executing', 'running'].includes(plan.state) || Date.parse(plan.bounds.deadline) <= Date.now()) throw new Error('Task plan is not executing or its bounds expired')
    const goal = workflow.get('goal', plan.goalId)
    if (goal.state !== 'active') throw new Error('Task goal must be active')
    if (!['active', 'achieved'].includes(workflow.get('mission', goal.missionId).state)) throw new Error('Task mission must be active before file execution')
    return task
  }
  return { name, description: 'Host-approved UTF-8 text CAS in a selected active native workflow Task. Requires path, content, expectedHash, taskId and idempotencyKey. Without target the whole buffer is replaced; with target only the addressed line range, UTF-8 byte range or outline node is replaced. Optional expectedBufferVersion is enforced by the native edit guard. Existing UTF-8 files only; no create/delete/binary writes. Uses a native ActionAttempt and file lease. Unresolved effects require host reconciliation. No task/goal acceptance.', annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content', 'expectedHash', 'taskId', 'idempotencyKey'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 1048576 }, expectedHash: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$' },
      target: {
        description: 'Optional native edit target; omit to replace the whole buffer. line uses 0-based end-exclusive lines, byte uses UTF-8 byte offsets, outline uses a node id from the current buffer outline.',
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode', 'start', 'end'], properties: { mode: { const: 'line' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'start', 'end'], properties: { mode: { const: 'byte' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'id'], properties: { mode: { const: 'outline' }, id: { type: 'string', minLength: 1, maxLength: 1024 } } },
        ],
      },
      expectedBufferVersion: { type: 'integer', minimum: 0 },
      taskId: { type: 'string', minLength: 1 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    } },
    async handler(input) {
      assertModelParameters(input)
      // Snapshot before the first await: approval and effects must describe the
      // same immutable request even when a host caller retains the input object.
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, unknown>
      if (Object.keys(args).some(key => !parameterNames.includes(key))) throw new Error('Unknown write parameter')
      for (const key of ['path', 'content', 'expectedHash', 'taskId', 'idempotencyKey']) if (typeof args[key] !== 'string' || (key !== 'content' && !args[key])) throw new Error(key + ' must be a string')
      if (!/^(sha256:)?[a-f0-9]{64}$/.test(String(args.expectedHash)) || String(args.idempotencyKey).length > 200 || String(args.path).length > 1024 || Buffer.byteLength(String(args.content)) > 1048576) throw new Error('Write parameter bounds exceeded')
      // Shape validation precedes the Store: a malformed target must not become
      // an approval request, a claim or an ActionAttempt.
      const writeTarget = normalizeWriteTarget(args.target)
      if (args.expectedBufferVersion !== undefined && (!Number.isSafeInteger(args.expectedBufferVersion) || (args.expectedBufferVersion as number) < 0)) throw new Error('expectedBufferVersion must be a nonnegative integer')
      const bufferVersion = args.expectedBufferVersion as number | undefined
      const { root, store } = openNativeStore(workspace)
      const key = binding.principalId + ':' + args.idempotencyKey
      const history = () => store.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key)
      let selected: string, request: string, policy: NativeFilesystemScope, storage: ScopedWriteStorage, ref: FileRef
      let preflight: ReturnType<ScopedWriteStorage['checked']>, base: StoredFile, planned: EditPlan, plannedContentDigest: string
      let editOptions: { expectedBaseHash: string; expectedBufferVersion?: number }
      try {
        // The already-open Store is reused so a live scope lookup never opens a
        // nested SQLite connection inside the preflight.
        const candidate = scope?.(root, store)
        if (!candidate) throw new Error('Select an active native workflow before writing')
        selected = candidate
        request = nativeRequest({ path: args.path, content: args.content, expectedHash: String(args.expectedHash).replace(/^sha256:/, ''), target: writeTarget, expectedBufferVersion: bufferVersion, taskId: args.taskId, scope: selected })
        policy = JSON.parse(nativeRequest(policyFor(root))) as NativeFilesystemScope
        storage = new ScopedWriteStorage(policy, binding.tenantId)
        ref = { tenantId: binding.tenantId, rootId: storage.bounded.rootId, path: String(args.path) }
        const prior = history().at(-1)
        if (prior) {
          if (prior.request !== request) throw new Error('Idempotency key already used for a different write')
          if (prior.result) return { ...prior.result, replayed: true }
          throw new Error('Write outcome is unresolved; host reconciliation is required before retry')
        }
        admission(restore(store), selected, String(args.taskId), true)
        preflight = storage.checked(ref.path)
        base = storage.read(ref)!
        if (!base || base.charset?.encoding !== 'utf-8') throw new WorkspaceError('invalid_target', 'Only existing UTF-8 text files are writable')
        if (base.hash.replace(/^sha256:/, '') !== String(args.expectedHash).replace(/^sha256:/, '')) throw new WorkspaceError('version_conflict', 'File differs from expectedHash')
        editOptions = { expectedBaseHash: base.hash, ...(bufferVersion === undefined ? {} : { expectedBufferVersion: bufferVersion }) }
        // Resolve the target with AMP's own planner before approval: an
        // out-of-range line/byte range, a missing outline node or a stale
        // expectedBufferVersion is rejected here, not after the file lease.
        const preview = new Workspace({ tenantId: binding.tenantId, rootId: ref.rootId, storage: previewStorage(base), outline: outlineProvider })
        const previewFile = preview.mount(ref.path, { mode: 'writable' })
        try { planned = previewFile.planWrite(String(args.content), writeTarget, editOptions) } finally { previewFile.unmount({ discardDirty: true }) }
        // The exact post-edit buffer the native commit will produce, hashed with
        // AMP's normalized-LF convention so reconciliation can prove it later.
        plannedContentDigest = digest(normalizeToLf(planned.text))
        store.transaction(() => {
          if (history().length) throw new Error('Concurrent write claimed this idempotency key')
          store.appendEvent(eventKind, { key, request, state: 'approval_pending', beforeRawHash: preflight.raw.hash, beforeVersion: preflight.stat.mtimeMs })
        })
      } finally { store.close() }

      // Approval sees the exact frozen target, the same replacement bytes and the
      // ranges the native planner resolved from the pre-approval buffer.
      const resolvedTarget = writeTarget === undefined ? undefined : { mode: planned.mode, ranges: planned.matches.map(match => ({ startLine: match.startLine, endLine: match.endLine, startByte: match.startByte, endByte: match.endByte })), ...(planned.outline === undefined ? {} : { outline: planned.outline }) }
      const approved = await requestHostApproval('native-workflow:' + selected, name, Object.freeze({
        path: String(args.path), expectedHash: String(args.expectedHash),
        ...(bufferVersion === undefined ? {} : { expectedBufferVersion: bufferVersion }),
        ...(writeTarget === undefined ? {} : { target: writeTarget, resolved: resolvedTarget }),
        rawHash: preflight.raw.hash, content: String(args.content), taskId: String(args.taskId), workspace: root,
      }))
      const db = openNativeStore(() => root), dbStore = db.store
      try {
        assertContext(root, selected, dbStore)
        const claim = dbStore.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key).at(-1)
        if (claim?.request !== request || claim.state !== 'approval_pending') throw new Error('Write claim changed during approval')
        if (!approved) {
          const result = { approved: false, changed: false }
          dbStore.appendEvent(eventKind, { key, request, result })
          return result
        }
        const started = dbStore.transaction(() => {
          const persistence = restore(dbStore), task = admission(persistence, selected, String(args.taskId), true)
          if (nativeRequest(policyFor(root)) !== nativeRequest(policy)) throw new Error('Filesystem policy changed during approval')
          const now = storage.checked(ref.path)
          if (now.raw.hash !== preflight.raw.hash || now.stat.ino !== preflight.stat.ino || now.stat.dev !== preflight.stat.dev || now.stat.mtimeMs !== preflight.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed during approval')
          // The legacy ledger key is retained for existing quotas; direct reads,
          // Executor reads and file effects all debit this same principal account.
          const budgetReservationId = 'write-budget:' + randomUUID()
          // The fixed read reservation predates targeted edits: a successful flush
          // settles the replacement bytes plus the resulting file bytes, so reserve
          // that upper bound (with slack for encoding growth) before any side effect.
          const reservationBytes = Math.max(nativeReadReservation.bytes, preflight.raw.bytes.byteLength + Buffer.byteLength(String(args.content)) + 65536)
          nativeIoBudget(dbStore, 'native-read:' + binding.principalId).reserve(budgetReservationId, 'native-read:' + binding.principalId, { ...nativeReadReservation, bytes: reservationBytes })
          if (task.state === 'ready') persistence.transition('task', task.id, 'active', { expectedVersion: task.version, actor, cancellationEpoch: task.cancellationEpoch })
          const action = persistence.create('action', { id: 'workspace-write:' + randomUUID(), sessionId: selected, taskId: task.id, operationId: randomUUID(), effect: 'workspace:file.write', required: false, sideEffect: true, recovery: 'reconcile' }, actor)
          const pending = persistence.transition('action', action.id, 'pending', { expectedVersion: action.version, actor, cancellationEpoch: action.cancellationEpoch })
          const ready = persistence.transition('action', pending.id, 'ready', { expectedVersion: pending.version, actor, cancellationEpoch: pending.cancellationEpoch })
          const attemptId = randomUUID(), executionId = randomUUID()
          const before = persistence.workflow.snapshot(), attempt = persistence.workflow.startAttempt(ready.id, { expectedVersion: ready.version, cancellationEpoch: ready.cancellationEpoch, executionId, attemptId, actor })
          const liveAction = persistence.workflow.get('action', ready.id)
          dbStore.save('action', liveAction as any, { expectedVersion: ready.version })
          for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
          persistence.persistAttempt(attempt, { actor, reason: 'Host-approved file write' })
          const identity = { actionId: ready.id, attemptId, executionId, operationId: ready.operationId, cancellationEpoch: attempt.cancellationEpoch, budgetReservationId }
          dbStore.appendEvent(eventKind, { key, request, state: 'started', ...identity, beforeRawHash: preflight.raw.hash, plannedContentDigest })
          return identity
        })
        try {
          const value = dbStore.transaction(() => {
            assertContext(root, selected, dbStore)
            if (nativeRequest(policyFor(root)) !== nativeRequest(policy)) throw new Error('Filesystem policy changed before commit')
            const persistence = restore(dbStore), task = admission(persistence, selected, String(args.taskId), false)
            const workflow = persistence.workflow
            workflow.assertExecutionAllowed(started.actionId, started.cancellationEpoch)
            const attempt = workflow.getAttempt(started.attemptId)
            if (attempt.state !== 'running') throw new Error('Write attempt is no longer running')
            const live = storage.checked(ref.path)
            if (live.raw.hash !== preflight.raw.hash || live.stat.ino !== preflight.stat.ino || live.stat.dev !== preflight.stat.dev || live.stat.mtimeMs !== preflight.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed before commit')
            const file = new Workspace({ tenantId: binding.tenantId, rootId: ref.rootId, storage, outline: outlineProvider }).mount(ref.path, { mode: 'writable', owner: started.attemptId })
            let snapshot
            try {
              file.write(String(args.content), writeTarget, editOptions)
              snapshot = file.flush({ idempotencyKey: String(args.idempotencyKey) })
            } finally { file.unmount({ discardDirty: true }) }
            const after = storage.checked(ref.path), action = workflow.get('action', started.actionId), before = workflow.snapshot()
            const settled = workflow.settleAttempt(started.attemptId, { expectedVersion: attempt.version, expectedActionVersion: action.version, outcome: 'succeeded', actor })
            const updatedAction = workflow.get('action', started.actionId)
            dbStore.save('action', updatedAction as any, { expectedVersion: action.version })
            for (const event of workflow.history().slice(before.events.length)) persistence.persistEvent(event)
            persistence.persistAttempt(settled, { actor, reason: 'File CAS committed' })
            const context = { tenantId: binding.tenantId, principalId: binding.principalId, agentId: 'codex-coordination', sessionId: selected, operationId: started.operationId, attemptId: started.attemptId, executionId: started.executionId, policyVersion: binding.policyVersion, cancellationEpoch: started.cancellationEpoch }
            // The target and buffer-version guard are JSON-normalized into the
            // execution facts so the receipt pins the exact edited region.
            const invocationArguments = JSON.parse(nativeRequest({ path: String(args.path), expectedHash: String(args.expectedHash), contentDigest: digest(String(args.content)), target: writeTarget, expectedBufferVersion: bufferVersion }))
            const invocation = createInvocation({ id: started.executionId, context, toolId: name, arguments: invocationArguments, createdAt: new Date().toISOString(), idempotencyKey: String(args.idempotencyKey) })
            const observationValue = JSON.parse(nativeRequest({ path: String(args.path), target: writeTarget, expectedBufferVersion: bufferVersion, beforeRawHash: preflight.raw.hash, rawHash: after.raw.hash, hash: snapshot.hash, bytes: snapshot.size }))
            const observation = createObservation({ id: randomUUID(), invocationId: invocation.id, status: 'success', value: observationValue, observedAt: new Date().toISOString() })
            const receipt = createReceiptCore({ id: 'receipt:' + started.executionId, kind: 'file_flush_receipt', invocation, observation, issuedAt: new Date().toISOString(), hashAlgorithm: 'sha256-json-execution-facts/2', payloadDigest: executionFactDigest(invocation, observation), lifecycle: 'issued', workspaceAnchor: { workspaceId: digest(root), changeHash: nativeEnvironment(dbStore, root), affectedFiles: [String(args.path)], snapshotId: after.raw.hash } })
            dbStore.save('receipt', receipt)
            nativeIoBudget(dbStore, 'native-read:' + binding.principalId).settle(started.budgetReservationId, { calls: 1, bytes: Buffer.byteLength(String(args.content)) + after.raw.bytes.byteLength })
            const result = { approved: true, changed: preflight.raw.hash !== after.raw.hash, ...started, plannedContentDigest, file: { path: args.path, hash: snapshot.hash, rawHash: after.raw.hash, bytes: snapshot.size }, receipt, businessVerification: 'not_performed' }
            dbStore.appendEvent(eventKind, { key, request, state: 'succeeded', result })
            return result
          })
          return value
        } catch (error) {
          // The inner SQLite transaction rolls back if CAS or settlement throws.
          // Record unresolved uncertainty in a fresh transaction; never rerun it.
          try {
            dbStore.transaction(() => {
              const persistence = restore(dbStore), attempt = persistence.workflow.getAttempt(started.attemptId), action = persistence.workflow.get('action', started.actionId)
              if (attempt.state === 'running') {
                const before = persistence.workflow.snapshot()
                const uncertain = persistence.workflow.settleAttempt(attempt.attemptId, { expectedVersion: attempt.version, expectedActionVersion: action.version, outcome: 'unknown_outcome', actor })
                const updatedAction = persistence.workflow.get('action', action.id)
                dbStore.save('action', updatedAction as any, { expectedVersion: action.version })
                for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
                persistence.persistAttempt(uncertain, { actor, from: 'running', reason: 'Write outcome uncertain' })
              }
              dbStore.appendEvent(eventKind, { key, request, state: 'unknown_outcome', ...started, plannedContentDigest, error: String(error) })
            })
          } catch { /* the started claim itself remains unresolved */ }
          throw new Error('Write outcome is unresolved; host reconciliation is required before retry: ' + String(error))
        }
      } finally { dbStore.close() }
    },
  }
}
