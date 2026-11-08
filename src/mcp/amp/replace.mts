/** Canonical AMP replace port: host-reviewed, workflow-admitted, journaled pattern edits. */
import { Workspace, WorkspaceError } from 'attention-manifest-protocol/workspace'
import { NodeFileStorage, createOutlineProvider, fencePathOf, lockPathOf, normalizeToLf } from 'attention-manifest-protocol/file'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { createInvocation, createObservation, createReceiptCore } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { EditOptions, EditPlan, FileRef, FileStoragePort, ReplaceTarget, StoredFile } from 'attention-manifest-protocol/file'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { openNativeStore, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import { nativeIoBudget, nativeReadReservation } from './read-budget.mjs'

const eventKind = 'codex.amp.workspace.replace'
const actor = 'mcp-host-file-execution'
const MODES = ['string', 'regex', 'line', 'byte', 'outline']
const PARAMETERS = ['path', 'mode', 'replacement', 'text', 'pattern', 'flags', 'occurrence', 'all', 'start', 'end', 'id', 'expectedBufferVersion', 'expectedBaseHash', 'taskId', 'idempotencyKey']
const digest = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const hashKey = (value: string) => value.replace(/^sha256:/, '')
/** The provider is a pure function of the current buffer, so it also covers outline targets. */
const outlineProvider = createOutlineProvider()

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
    for (const sidecar of [lockPathOf(absolute), fencePathOf(absolute)]) if (existsSync(sidecar) && (!lstatSync(sidecar).isFile() || lstatSync(sidecar).isSymbolicLink())) throw new WorkspaceError('invalid_scope', 'Unsafe file lock metadata')
    return { absolute, stat, raw: this.bounded.raw(path) }
  }
  override read(ref: FileRef): StoredFile | undefined { this.checked(ref.path); return super.read(ref) }
  override acquireLease(ref: FileRef, owner: string, ttlMilliseconds?: number) { this.checked(ref.path); return super.acquireLease(ref, owner, ttlMilliseconds) }
  override compareAndSwap(ref: FileRef, expectedHash: string, content: string, fence: number) { this.checked(ref.path); return super.compareAndSwap(ref, expectedHash, content, fence) }
}

/** A plan-only storage port over the exact base snapshot; it never takes the real lease. */
function previewStorage(base: StoredFile): FileStoragePort {
  return {
    read(ref: FileRef) { return { ...base, ...ref } },
    acquireLease(ref: FileRef, owner: string) { return { ...ref, owner, fence: 1, token: 'replace-preflight' } },
    releaseLease() {},
    compareAndSwap() { throw new WorkspaceError('read_only', 'Preflight storage cannot commit') },
  }
}

function restore(store: ReturnType<typeof openNativeStore>['store']) {
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  if (persistence.restoreAll().skipped.length) throw new Error('Native workflow facts are invalid')
  return persistence
}

function admission(persistence: WorkflowPersistence, selected: string, taskId: string, allowReady: boolean) {
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

/** Validate the replace target shape exactly as AMP's own handler will, before approval. */
function structure(input: Record<string, any>) {
  const mode = String(input.mode)
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
  if (typeof input.replacement !== 'string') throw new Error('replacement must be a string')
  // AMP's file API accepts any nonempty target text, including a single space;
  // trimming here would reject a valid literal/pattern before preflight.
  if (mode === 'string' && (typeof input.text !== 'string' || !input.text)) throw new Error('text is required for string mode')
  if (mode === 'regex' && (typeof input.pattern !== 'string' || !input.pattern)) throw new Error('pattern is required for regex mode')
  if (mode === 'outline' && (typeof input.id !== 'string' || !input.id.trim())) throw new Error('id is required for outline mode')
  if (['line', 'byte'].includes(mode)) {
    if (!Number.isSafeInteger(input.start) || input.start < 0 || !Number.isSafeInteger(input.end) || input.end < input.start) throw new Error('start/end must be nonnegative integers with end >= start')
  }
  if (input.flags !== undefined && (typeof input.flags !== 'string' || !input.flags.trim())) throw new Error('flags must be a nonempty string')
  if (input.occurrence !== undefined && (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1)) throw new Error('occurrence must be a positive safe integer')
  if (input.all !== undefined && typeof input.all !== 'boolean') throw new Error('all must be a boolean')
  if (input.expectedBufferVersion !== undefined && (!Number.isSafeInteger(input.expectedBufferVersion) || input.expectedBufferVersion < 0)) throw new Error('expectedBufferVersion must be a nonnegative safe integer')
}

function replaceTarget(input: Record<string, any>): ReplaceTarget {
  const mode = String(input.mode)
  if (mode === 'string') return Object.freeze({ mode, text: String(input.text), ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }), ...(input.all === undefined ? {} : { all: input.all }) })
  if (mode === 'regex') return Object.freeze({ mode, pattern: String(input.pattern), ...(input.flags === undefined ? {} : { flags: input.flags }), ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }), ...(input.all === undefined ? {} : { all: input.all }) })
  if (mode === 'outline') return Object.freeze({ mode, id: String(input.id) })
  return Object.freeze({ mode: mode as 'line' | 'byte', start: input.start, end: input.end })
}

export function replaceBinding(binding: AgentBinding, workspace: () => unknown, filesystemPolicy?: () => NativeFilesystemScope | undefined, scope?: WorkflowScopeCallback): ToolDefinition {
  const name = 'attention_manifest_protocol_replace'
  const policyFor = (root: string) => {
    const configured = filesystemPolicy?.()
    if (configured && realpathSync(configured.root) !== root) throw new Error('Filesystem policy belongs to another workspace')
    return configured ?? { root, exclude: [] }
  }
  const assertContext = (root: string, selected: string, store: Store) => {
    if (typeof workspace() !== 'string' || realpathSync(String(workspace())) !== root || scope?.(root, store) !== selected) throw new Error('Workspace or workflow scope changed during replace')
  }
  return {
    name,
    description: 'Host-approved canonical AMP replace inside one selected native workflow task: literal string, regular expression, line range, UTF-8 byte range or outline node, with optional expectedBufferVersion/expectedBaseHash compare-and-swap guards. Uses a native ActionAttempt, native lease/CAS flush and a durable idempotency journal. Unresolved effects require host reconciliation. No task/goal acceptance.',
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
      let selected: string, request: string, policy: NativeFilesystemScope, storage: ScopedReplaceStorage, ref: FileRef
      let preflight: ReturnType<ScopedReplaceStorage['checked']>, base: StoredFile, planned: EditPlan, plannedContentDigest: string, editOptions: EditOptions
      try {
        // The already-open Store is reused so a live scope lookup never opens a
        // nested SQLite connection inside the preflight.
        const candidate = scope?.(root, store)
        if (!candidate) throw new Error('Select an active native workflow before replacing')
        selected = candidate
        request = nativeRequest({ ...parameters, taskId: args.taskId, scope: selected })
        policy = JSON.parse(nativeRequest(policyFor(root))) as NativeFilesystemScope
        storage = new ScopedReplaceStorage(policy, binding.tenantId)
        ref = { tenantId: binding.tenantId, rootId: storage.bounded.rootId, path: String(args.path) }
        const prior = history().at(-1)
        if (prior) {
          if (prior.request !== request) throw new Error('Idempotency key already used for a different replace')
          if (prior.result) return { ...prior.result, replayed: true }
          throw new Error('Replace outcome is unresolved; host reconciliation is required before retry')
        }
        admission(restore(store), selected, String(args.taskId), true)
        preflight = storage.checked(ref.path)
        base = storage.read(ref)!
        if (!base) throw new WorkspaceError('not_found', 'File is not readable')
        // Guards are resolved against the pre-approval buffer, not only inside the
        // native handler: a stale hash/version must not become an approved attempt.
        if (args.expectedBaseHash !== undefined && hashKey(String(args.expectedBaseHash)) !== hashKey(base.hash)) throw new WorkspaceError('version_conflict', 'File differs from expectedBaseHash')
        editOptions = Object.freeze({ expectedBaseHash: base.hash, ...(args.expectedBufferVersion === undefined ? {} : { expectedBufferVersion: Number(args.expectedBufferVersion) }) })
        const target = replaceTarget(args)
        const preview = new Workspace({ tenantId: binding.tenantId, rootId: ref.rootId, storage: previewStorage(base), outline: outlineProvider })
        const previewFile = preview.mount(ref.path, { mode: 'writable' })
        try { planned = previewFile.planReplace(target, String(args.replacement), editOptions) } finally { previewFile.unmount({ discardDirty: true }) }
        // The exact post-edit buffer the native commit will produce, hashed with
        // AMP's normalized-LF convention so reconciliation can prove it later.
        plannedContentDigest = digest(normalizeToLf(planned.text))
        store.transaction(() => {
          if (history().length) throw new Error('Concurrent replace claimed this idempotency key')
          store.appendEvent(eventKind, { key, request, state: 'approval_pending', beforeRawHash: preflight.raw.hash, beforeVersion: preflight.stat.mtimeMs })
        })
      } finally { store.close() }

      const approved = await requestHostApproval('native-workflow:' + selected, name, { ...parameters, taskId: args.taskId, rawHash: preflight.raw.hash, workspace: root, note: 'Exact native replace; the raw hash pins the pre-edit bytes' })
      const db = openNativeStore(() => root), dbStore = db.store
      try {
        assertContext(root, selected, dbStore)
        const claim = dbStore.events({ kind: eventKind }).map(event => event.payload as any).filter(value => value.key === key).at(-1)
        if (claim?.request !== request || claim.state !== 'approval_pending') throw new Error('Replace claim changed during approval')
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
          // expectedBaseHash/expectedBufferVersion were resolved against the
          // pre-approval buffer. A fresh mount is buffer version 0 (validated by
          // the preflight planner), and the committed base must still be the same.
          const guarded = storage.read(ref)
          if (!guarded || hashKey(guarded.hash) !== hashKey(base.hash)) throw new WorkspaceError('stale', 'File base changed during approval')
          const budgetReservationId = 'replace-budget:' + randomUUID()
          // A successful flush settles the replacement bytes plus the resulting
          // file bytes, so reserve that upper bound before any side effect rather
          // than the fixed read reservation that would under-cover large edits.
          const reservationBytes = Math.max(nativeReadReservation.bytes, preflight.raw.bytes.byteLength + Buffer.byteLength(String(args.replacement)) + 65536)
          nativeIoBudget(dbStore, 'native-read:' + binding.principalId).reserve(budgetReservationId, 'native-read:' + binding.principalId, { ...nativeReadReservation, bytes: reservationBytes })
          if (task.state === 'ready') persistence.transition('task', task.id, 'active', { expectedVersion: task.version, actor, cancellationEpoch: task.cancellationEpoch })
          const action = persistence.create('action', { id: 'workspace-replace:' + randomUUID(), sessionId: selected, taskId: task.id, operationId: randomUUID(), effect: 'workspace:file.write', required: false, sideEffect: true, recovery: 'reconcile' }, actor)
          const pending = persistence.transition('action', action.id, 'pending', { expectedVersion: action.version, actor, cancellationEpoch: action.cancellationEpoch })
          const ready = persistence.transition('action', pending.id, 'ready', { expectedVersion: pending.version, actor, cancellationEpoch: pending.cancellationEpoch })
          const attemptId = randomUUID(), executionId = randomUUID()
          const before = persistence.workflow.snapshot(), attempt = persistence.workflow.startAttempt(ready.id, { expectedVersion: ready.version, cancellationEpoch: ready.cancellationEpoch, executionId, attemptId, actor })
          const liveAction = persistence.workflow.get('action', ready.id)
          dbStore.save('action', liveAction as any, { expectedVersion: ready.version })
          for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
          persistence.persistAttempt(attempt, { actor, reason: 'Host-approved file replace' })
          const identity = { actionId: ready.id, attemptId, executionId, operationId: ready.operationId, cancellationEpoch: attempt.cancellationEpoch, budgetReservationId }
          dbStore.appendEvent(eventKind, { key, request, state: 'started', ...identity, beforeRawHash: preflight.raw.hash, plannedContentDigest })
          return identity
        })
        try {
          const value = dbStore.transaction(() => {
            assertContext(root, selected, dbStore)
            if (nativeRequest(policyFor(root)) !== nativeRequest(policy)) throw new Error('Filesystem policy changed before commit')
            const persistence = restore(dbStore)
            admission(persistence, selected, String(args.taskId), false)
            const workflow = persistence.workflow
            workflow.assertExecutionAllowed(started.actionId, started.cancellationEpoch)
            const attempt = workflow.getAttempt(started.attemptId)
            if (attempt.state !== 'running') throw new Error('Replace attempt is no longer running')
            const live = storage.checked(ref.path)
            if (live.raw.hash !== preflight.raw.hash || live.stat.ino !== preflight.stat.ino || live.stat.dev !== preflight.stat.dev || live.stat.mtimeMs !== preflight.stat.mtimeMs) throw new WorkspaceError('stale', 'File changed before commit')
            // The preflight planner and the commit use the same file-level API:
            // mounting, replacing and flushing here keeps the literal-target
            // semantics the planner accepted (the agent wrapper trims targets,
            // which would reject a whitespace-only string/regex target).
            const native = new Workspace({ tenantId: binding.tenantId, rootId: ref.rootId, storage, outline: outlineProvider })
            const mount = native.mount(ref.path, { mode: 'writable', ...(String(args.mode) === 'outline' ? { outline: outlineProvider } : {}) })
            let replaced: Record<string, any>
            try {
              mount.replace(replaceTarget(args), String(args.replacement), editOptions)
              const snapshot = mount.flush()
              replaced = Object.freeze({ path: snapshot.path, mode: String(args.mode), state: snapshot.state, version: snapshot.version, bufferVersion: snapshot.bufferVersion, dirty: snapshot.dirty, stale: snapshot.stale, hash: snapshot.hash, baseHash: snapshot.baseHash })
            } finally {
              // The commit already happened; a failing unmount must not mask it.
              try { mount.unmount() } catch { /* keep the replace result */ }
            }
            const after = storage.checked(ref.path), action = workflow.get('action', started.actionId), before = workflow.snapshot()
            const settled = workflow.settleAttempt(started.attemptId, { expectedVersion: attempt.version, expectedActionVersion: action.version, outcome: 'succeeded', actor })
            const updatedAction = workflow.get('action', started.actionId)
            dbStore.save('action', updatedAction as any, { expectedVersion: action.version })
            for (const event of workflow.history().slice(before.events.length)) persistence.persistEvent(event)
            persistence.persistAttempt(settled, { actor, reason: 'File replace committed' })
            const context = { tenantId: binding.tenantId, principalId: binding.principalId, agentId: 'codex-coordination', sessionId: selected, operationId: started.operationId, attemptId: started.attemptId, executionId: started.executionId, policyVersion: binding.policyVersion, cancellationEpoch: started.cancellationEpoch }
            const invocation = createInvocation({ id: started.executionId, context, toolId: name, arguments: JSON.parse(nativeRequest(parameters)), createdAt: new Date().toISOString(), idempotencyKey: String(args.idempotencyKey) })
            const observationValue = JSON.parse(nativeRequest({ path: String(args.path), mode: String(args.mode), beforeRawHash: preflight.raw.hash, rawHash: after.raw.hash, hash: replaced.hash, baseHash: base.hash, version: replaced.version, bufferVersion: replaced.bufferVersion, bytes: after.raw.bytes.byteLength }))
            const observation = createObservation({ id: randomUUID(), invocationId: invocation.id, status: 'success', value: observationValue, observedAt: new Date().toISOString() })
            const receipt = createReceiptCore({ id: 'receipt:' + started.executionId, kind: 'file_flush_receipt', invocation, observation, issuedAt: new Date().toISOString(), hashAlgorithm: 'sha256-json-execution-facts/2', payloadDigest: executionFactDigest(invocation, observation), lifecycle: 'issued', workspaceAnchor: { workspaceId: digest(root), changeHash: nativeEnvironment(dbStore, root), affectedFiles: [String(args.path)], snapshotId: after.raw.hash } })
            dbStore.save('receipt', receipt)
            nativeIoBudget(dbStore, 'native-read:' + binding.principalId).settle(started.budgetReservationId, { calls: 1, bytes: Buffer.byteLength(String(args.replacement)) + after.raw.bytes.byteLength })
            const result = { approved: true, changed: preflight.raw.hash !== after.raw.hash, ...started, plannedContentDigest, ...replaced, receipt, businessVerification: 'not_performed', taskId: String(args.taskId), workspace: root, file: { path: String(args.path), hash: replaced.hash, rawHash: after.raw.hash, bytes: after.raw.bytes.byteLength } }
            dbStore.appendEvent(eventKind, { key, request, state: 'succeeded', result })
            return result
          })
          return value
        } catch (error) {
          // The inner SQLite transaction rolls back if replace, settlement or
          // receipt creation throws. Record unresolved uncertainty; never rerun.
          try {
            dbStore.transaction(() => {
              const persistence = restore(dbStore), attempt = persistence.workflow.getAttempt(started.attemptId), action = persistence.workflow.get('action', started.actionId)
              if (attempt.state === 'running') {
                const before = persistence.workflow.snapshot()
                const uncertain = persistence.workflow.settleAttempt(attempt.attemptId, { expectedVersion: attempt.version, expectedActionVersion: action.version, outcome: 'unknown_outcome', actor })
                const updatedAction = persistence.workflow.get('action', action.id)
                dbStore.save('action', updatedAction as any, { expectedVersion: action.version })
                for (const event of persistence.workflow.history().slice(before.events.length)) persistence.persistEvent(event)
                persistence.persistAttempt(uncertain, { actor, from: 'running', reason: 'Replace outcome uncertain' })
              }
              dbStore.appendEvent(eventKind, { key, request, state: 'unknown_outcome', ...started, plannedContentDigest, error: String(error) })
            })
          } catch { /* the started claim itself remains unresolved */ }
          throw new Error('Replace outcome is unresolved; host reconciliation is required before retry: ' + String(error))
        }
      } finally { dbStore.close() }
    },
  }
}
