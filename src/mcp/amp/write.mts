/** Narrow host-approved file effects. This is not a general Action scheduler. */
import { Workspace, WorkspaceError } from 'attention-manifest-protocol/workspace'
import { NodeFileStorage, lockPathOf, fencePathOf } from 'attention-manifest-protocol/file'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { createInvocation, createObservation, createReceiptCore } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { FileRef, StoredFile } from 'attention-manifest-protocol/file'
import type { ToolDefinition } from '../lib/tools.mjs'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { openNativeStore, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { nativeIoBudget, nativeReadReservation } from './read-budget.mjs'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'

export type WriteScope = (root: string) => string | undefined
const digest = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const sha256 = (value: string) => digest(value).slice(7)
const actor = 'mcp-host-file-execution'
const eventKind = 'codex.amp.workspace.write'
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
  const assertContext = (root: string, selected: string) => {
    if (typeof workspace() !== 'string' || realpathSync(String(workspace())) !== root || scope?.(root) !== selected) throw new Error('Workspace or workflow scope changed during write')
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
  return { name, description: 'Host-approved whole-file text CAS in a selected active native workflow Task. Requires path, content, expectedHash, taskId and idempotencyKey. Existing UTF-8 files only; no create/delete/binary/structural targets. Uses a native ActionAttempt and file lease. Unresolved effects require host reconciliation. No task/goal acceptance.', annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content', 'expectedHash', 'taskId', 'idempotencyKey'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 1048576 }, expectedHash: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$' }, taskId: { type: 'string', minLength: 1 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    } },
    async handler(input) {
      assertModelParameters(input)
      // Snapshot before the first await: approval and effects must describe the
      // same immutable request even when a host caller retains the input object.
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, unknown>
      if (Object.keys(args).some(key => !['path', 'content', 'expectedHash', 'taskId', 'idempotencyKey'].includes(key))) throw new Error('Unknown write parameter')
      for (const key of ['path', 'content', 'expectedHash', 'taskId', 'idempotencyKey']) if (typeof args[key] !== 'string' || (key !== 'content' && !args[key])) throw new Error(key + ' must be a string')
      if (!/^(sha256:)?[a-f0-9]{64}$/.test(String(args.expectedHash)) || String(args.idempotencyKey).length > 200 || String(args.path).length > 1024 || Buffer.byteLength(String(args.content)) > 1048576) throw new Error('Write parameter bounds exceeded')
      const { root, store } = openNativeStore(workspace)
      const key = binding.principalId + ':' + args.idempotencyKey
      const history = () => store.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key)
      let selected: string, request: string, policy: NativeFilesystemScope, storage: ScopedWriteStorage, ref: FileRef
      let target: ReturnType<ScopedWriteStorage['checked']>, base: StoredFile
      try {
        const candidate = scope?.(root)
        if (!candidate) throw new Error('Select an active native workflow before writing')
        selected = candidate
        request = nativeRequest({ path: args.path, content: args.content, expectedHash: String(args.expectedHash).replace(/^sha256:/, ''), taskId: args.taskId, scope: selected })
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
        target = storage.checked(ref.path)
        base = storage.read(ref)!
        if (!base || base.charset?.encoding !== 'utf-8') throw new WorkspaceError('invalid_target', 'Only existing UTF-8 text files are writable')
        if (base.hash.replace(/^sha256:/, '') !== String(args.expectedHash).replace(/^sha256:/, '')) throw new WorkspaceError('version_conflict', 'File differs from expectedHash')
        store.transaction(() => {
          if (history().length) throw new Error('Concurrent write claimed this idempotency key')
          store.appendEvent(eventKind, { key, request, state: 'approval_pending', beforeRawHash: target.raw.hash, beforeVersion: target.stat.mtimeMs })
        })
      } finally { store.close() }

      const approved = await requestHostApproval('native-workflow:' + selected, name, { path: args.path, expectedHash: args.expectedHash, rawHash: target.raw.hash, content: args.content, taskId: args.taskId, workspace: root })
      const db = openNativeStore(() => root), dbStore = db.store
      try {
        assertContext(root, selected)
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
          if (now.raw.hash !== target.raw.hash || now.stat.ino !== target.stat.ino || now.stat.dev !== target.stat.dev || now.stat.mtimeMs !== target.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed during approval')
          // The legacy ledger key is retained for existing quotas; direct reads,
          // Executor reads and file effects all debit this same principal account.
          const budgetReservationId = 'write-budget:' + randomUUID()
          nativeIoBudget(dbStore, 'native-read:' + binding.principalId).reserve(budgetReservationId, 'native-read:' + binding.principalId, nativeReadReservation)
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
          dbStore.appendEvent(eventKind, { key, request, state: 'started', ...identity, beforeRawHash: target.raw.hash })
          return identity
        })
        try {
          const value = dbStore.transaction(() => {
            assertContext(root, selected)
            if (nativeRequest(policyFor(root)) !== nativeRequest(policy)) throw new Error('Filesystem policy changed before commit')
            const persistence = restore(dbStore), task = admission(persistence, selected, String(args.taskId), false)
            const workflow = persistence.workflow
            workflow.assertExecutionAllowed(started.actionId, started.cancellationEpoch)
            const attempt = workflow.getAttempt(started.attemptId)
            if (attempt.state !== 'running') throw new Error('Write attempt is no longer running')
            const live = storage.checked(ref.path)
            if (live.raw.hash !== target.raw.hash || live.stat.ino !== target.stat.ino || live.stat.dev !== target.stat.dev || live.stat.mtimeMs !== target.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed before commit')
            const file = new Workspace({ tenantId: binding.tenantId, rootId: ref.rootId, storage }).mount(ref.path, { mode: 'writable', owner: started.attemptId })
            let snapshot
            try {
              file.write(String(args.content), undefined, { expectedBaseHash: base.hash })
              snapshot = file.flush({ idempotencyKey: String(args.idempotencyKey) })
            } finally { file.unmount({ discardDirty: true }) }
            const after = storage.checked(ref.path), action = workflow.get('action', started.actionId), before = workflow.snapshot()
            const settled = workflow.settleAttempt(started.attemptId, { expectedVersion: attempt.version, expectedActionVersion: action.version, outcome: 'succeeded', actor })
            const updatedAction = workflow.get('action', started.actionId)
            dbStore.save('action', updatedAction as any, { expectedVersion: action.version })
            for (const event of workflow.history().slice(before.events.length)) persistence.persistEvent(event)
            persistence.persistAttempt(settled, { actor, reason: 'File CAS committed' })
            const context = { tenantId: binding.tenantId, principalId: binding.principalId, agentId: 'codex-coordination', sessionId: selected, operationId: started.operationId, attemptId: started.attemptId, executionId: started.executionId, policyVersion: binding.policyVersion, cancellationEpoch: started.cancellationEpoch }
            const invocation = createInvocation({ id: started.executionId, context, toolId: name, arguments: { path: String(args.path), expectedHash: String(args.expectedHash), contentDigest: digest(String(args.content)) }, createdAt: new Date().toISOString(), idempotencyKey: String(args.idempotencyKey) })
            const observation = createObservation({ id: randomUUID(), invocationId: invocation.id, status: 'success', value: { path: String(args.path), beforeRawHash: target.raw.hash, rawHash: after.raw.hash, hash: snapshot.hash, bytes: snapshot.size }, observedAt: new Date().toISOString() })
            const receipt = createReceiptCore({ id: 'receipt:' + started.executionId, kind: 'file_flush_receipt', invocation, observation, issuedAt: new Date().toISOString(), hashAlgorithm: 'sha256-json-execution-facts/2', payloadDigest: executionFactDigest(invocation, observation), lifecycle: 'issued', workspaceAnchor: { workspaceId: digest(root), changeHash: nativeEnvironment(dbStore, root), affectedFiles: [String(args.path)], snapshotId: after.raw.hash } })
            dbStore.save('receipt', receipt)
            nativeIoBudget(dbStore, 'native-read:' + binding.principalId).settle(started.budgetReservationId, { calls: 1, bytes: Buffer.byteLength(String(args.content)) + after.raw.bytes.byteLength })
            const result = { approved: true, changed: target.raw.hash !== after.raw.hash, ...started, file: { path: args.path, hash: snapshot.hash, rawHash: after.raw.hash, bytes: snapshot.size }, receipt, businessVerification: 'not_performed' }
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
              dbStore.appendEvent(eventKind, { key, request, state: 'unknown_outcome', ...started, error: String(error) })
            })
          } catch { /* the started claim itself remains unresolved */ }
          throw new Error('Write outcome is unresolved; host reconciliation is required before retry: ' + String(error))
        }
      } finally { dbStore.close() }
    },
  }
}
