/** Host-reviewed recovery of one recorded uncertain file effect; never retries the write. */
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { createInvocation, createObservation, createReceiptCore } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { detectCharset, decodeText, normalizeToLf, fileDigest } from 'attention-manifest-protocol/file'
import type { ToolDefinition } from '../lib/tools.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { openNativeStore, nativeWorkspaceRoot, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { nativeIoBudget } from './read-budget.mjs'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'

const eventKind = 'codex.amp.workflow.reconciliation'
const writeKind = 'codex.amp.workspace.write'
const replaceKind = 'codex.amp.workspace.replace'
const writeTool = 'attention_manifest_protocol_workspace.write'
const replaceTool = 'attention_manifest_protocol_replace'
const replaceModes = ['string', 'regex', 'line', 'byte', 'outline']
const replaceToolParameters = ['path', 'mode', 'replacement', 'text', 'pattern', 'flags', 'occurrence', 'all', 'start', 'end', 'id', 'expectedBufferVersion', 'expectedBaseHash']
const terminalStates = ['succeeded', 'failed', 'cancelled']
const digestPattern = /^sha256:[a-f0-9]{64}$/
const actor = 'mcp-host-reconciliation'
const hash = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const copy = <T,>(value: T): T => JSON.parse(nativeRequest(value))
type NativeStore = ReturnType<typeof openNativeStore>['store']
type JournalCandidate = { journalKind: string, sourceTool: string, events: any[], uncertain: any }
const identityOf = (proof: any) => ({ actionId: proof?.actionId, attemptId: proof?.attemptId, operationId: proof?.operationId, executionId: proof?.executionId, cancellationEpoch: proof?.cancellationEpoch })

/** A revalidation failure after the host decision; the decision stays durable but no state may move. */
class StaleAfterApproval extends Error {
  constructor(message: string) { super(message); this.name = 'StaleAfterApproval' }
}

function restore(store: NativeStore) {
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  if (persistence.restoreAll().skipped.length) throw new Error('Native workflow has invalid facts')
  return persistence
}

/** Validate the journaled request of one whole-file or targeted native write (legacy journals have no planned digest). */
function validateWriteRequest(original: any) {
  if (typeof original.content !== 'string' || Buffer.byteLength(original.content) > 1048576 || !/^(sha256:)?[a-f0-9]{64}$/.test(original.expectedHash)) throw new Error('Original native write request is invalid or outside scope')
  if (original.target !== undefined) {
    const target = original.target
    if (typeof target !== 'object' || target === null || Array.isArray(target)) throw new Error('Original native write target is invalid')
    if (target.mode === 'line' || target.mode === 'byte') {
      if (!Number.isSafeInteger(target.start) || target.start < 0 || !Number.isSafeInteger(target.end) || target.end < target.start) throw new Error('Original native write target is invalid')
    } else if (target.mode === 'outline') {
      if (typeof target.id !== 'string' || !target.id.trim() || target.id.length > 1024) throw new Error('Original native write target is invalid')
    } else throw new Error('Original native write target is invalid')
  }
  if (original.expectedBufferVersion !== undefined && (!Number.isSafeInteger(original.expectedBufferVersion) || original.expectedBufferVersion < 0)) throw new Error('Original native write request is invalid or outside scope')
}

/** Validate the journaled request of one canonical replace. */
function validateReplaceRequest(original: any) {
  const mode = original.mode
  if (typeof mode !== 'string' || !replaceModes.includes(mode) || typeof original.replacement !== 'string' || Buffer.byteLength(original.replacement) > 1048576) throw new Error('Original native replace request is invalid or outside scope')
  if (mode === 'string' && (typeof original.text !== 'string' || !original.text)) throw new Error('Original native replace request is invalid or outside scope')
  if (mode === 'regex' && (typeof original.pattern !== 'string' || !original.pattern)) throw new Error('Original native replace request is invalid or outside scope')
  if (mode === 'outline' && (typeof original.id !== 'string' || !original.id.trim() || original.id.length > 1024)) throw new Error('Original native replace request is invalid or outside scope')
  if ((mode === 'line' || mode === 'byte') && (!Number.isSafeInteger(original.start) || original.start < 0 || !Number.isSafeInteger(original.end) || original.end < original.start)) throw new Error('Original native replace request is invalid or outside scope')
  if (original.flags !== undefined && (typeof original.flags !== 'string' || !original.flags.trim())) throw new Error('Original native replace request is invalid or outside scope')
  if (original.occurrence !== undefined && (!Number.isSafeInteger(original.occurrence) || original.occurrence < 1)) throw new Error('Original native replace request is invalid or outside scope')
  if (original.all !== undefined && typeof original.all !== 'boolean') throw new Error('Original native replace request is invalid or outside scope')
  if (original.expectedBufferVersion !== undefined && (!Number.isSafeInteger(original.expectedBufferVersion) || original.expectedBufferVersion < 0)) throw new Error('Original native replace request is invalid or outside scope')
  if (original.expectedBaseHash !== undefined && (typeof original.expectedBaseHash !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(original.expectedBaseHash))) throw new Error('Original native replace request is invalid or outside scope')
}

/**
 * Resolve the digest that pins the planned post-effect content. A planned digest
 * is the only proof for targeted/replace effects; a legacy whole-file write
 * journal (no planned digest) may still fall back to its requested full content.
 */
function expectedDigestOf(journalKind: string, started: any, uncertain: any, original: any) {
  const planned = started.plannedContentDigest
  if (planned !== undefined) {
    if (typeof planned !== 'string' || !digestPattern.test(planned)) throw new Error('Journaled planned content digest is invalid')
    if (uncertain.plannedContentDigest !== undefined && uncertain.plannedContentDigest !== planned) throw new Error('Uncertain file-effect journal changed the planned content digest')
    return { plannedContentDigest: planned as string, expectedDigest: planned as string }
  }
  if (uncertain.plannedContentDigest !== undefined) throw new Error('Uncertain file-effect journal changed the planned content digest')
  if (journalKind === writeKind && original.target === undefined) return { plannedContentDigest: undefined, expectedDigest: hash(normalizeToLf(original.content)) }
  throw new Error('Uncertain file-effect journal has no planned content digest; host reconciliation cannot prove this effect')
}

/** Only this principal's existing unknown-outcome native file effects are supported. */
export function reconciliationReview(binding: AgentBinding, workspace: () => unknown, filesystemPolicy: (() => NativeFilesystemScope | undefined) | undefined, scope: WorkflowScopeCallback): ToolDefinition {
  const fields = ['actionId', 'expectedAttemptId', 'expectedActionVersion', 'expectedAttemptVersion', 'outcome', 'reconciliationRef', 'observedRawHash', 'expectedContentDigest', 'idempotencyKey', 'reason']
  const policyFor = (root: string) => {
    const provided = filesystemPolicy?.()
    if (provided && realpathSync(provided.root) !== root) throw new Error('Reconciliation filesystem policy belongs to another workspace')
    return copy(provided ?? { root, exclude: [] })
  }
  return { name: 'attention_manifest_protocol_workflow_reconciliation_review', description: 'Request independent host reconciliation of one unknown-outcome native file-effect ActionAttempt (workspace.write including targeted line/byte/outline writes, or replace). Requires exact versions, an explicit manual:/query: reference and host-observed raw hash. Success compares the current normalized file content with the journaled planned content digest (legacy whole-file write journals fall back to their requested content); the optional expected content digest is a model constraint, never proof. Persists the host decision, resumes a recorded decision without asking twice, reports stale_after_approval without changing workflow/file/journal/receipt/budget state, and never rewrites files or accepts tasks/goals.', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', additionalProperties: false, required: fields.filter(field => field !== 'expectedContentDigest'), properties: {
      actionId: { type: 'string', minLength: 1, maxLength: 200 }, expectedAttemptId: { type: 'string', minLength: 1, maxLength: 200 }, expectedActionVersion: { type: 'integer', minimum: 0 }, expectedAttemptVersion: { type: 'integer', minimum: 0 }, outcome: { enum: ['succeeded', 'failed', 'cancelled'] }, reconciliationRef: { type: 'string', minLength: 1, maxLength: 2000 }, observedRawHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, expectedContentDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    } }, async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(copy(input)) as Record<string, any>
      if (Object.keys(args).some(field => !fields.includes(field)) || !['actionId', 'expectedAttemptId', 'reconciliationRef', 'idempotencyKey', 'reason'].every(field => typeof args[field] === 'string' && args[field].trim() && args[field].length <= (['reason', 'reconciliationRef'].includes(field) ? 2000 : 200)) || !['expectedActionVersion', 'expectedAttemptVersion'].every(field => Number.isSafeInteger(args[field]) && args[field] >= 0) || !['succeeded', 'failed', 'cancelled'].includes(args.outcome) || !/^sha256:[a-f0-9]{64}$/.test(args.observedRawHash) || (args.expectedContentDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(args.expectedContentDigest))) throw new Error('Invalid reconciliation review parameters')
      // An explicitly supplied undefined digest is malformed when a success is
      // claimed: JSON never carries undefined, so only true omission means "no
      // model constraint". Failure/cancellation decisions ignore the digest.
      if (args.outcome === 'succeeded' && Object.prototype.hasOwnProperty.call(input, 'expectedContentDigest') && input.expectedContentDigest === undefined) throw new Error('Supplied expected content digest must be a sha256 digest')
      if (!/^(manual|query):\S/.test(args.reconciliationRef)) throw new Error('Reconciliation requires an explicit manual: or query: reference')
      const opened = openNativeStore(workspace), { root, store } = opened
      const key = binding.principalId + ':' + args.idempotencyKey
      const finalFor = (db: NativeStore) => db.events({ kind: eventKind }).map(event => copy(event.payload as any)).filter(item => item.key === key).at(-1)
      const requestedFor = (db: NativeStore) => db.events({ kind: eventKind + '.requested' }).map(event => copy(event.payload as any)).filter(item => item.key === key).at(-1)
      const decisionFor = (db: NativeStore, id: string) => db.events({ kind: eventKind + '.host_decision' }).map(event => copy(event.payload as any)).filter(item => item.key === key && item.reviewId === id).at(-1)
      let selected: string, request: string, policy: NativeFilesystemScope, requestedPolicy: NativeFilesystemScope | undefined, head = '', proof: any, reviewId = '', approved = false, resumed = false
      function inspect(db: NativeStore) {
        const persistence = restore(db), workflow = persistence.workflow
        const action = workflow.get('action', args.actionId), attempt = workflow.getAttempt(args.expectedAttemptId)
        if (action.sessionId !== selected || attempt.sessionId !== selected || attempt.actionId !== action.id || action.attemptIds.at(-1) !== attempt.attemptId || attempt.operationId !== action.operationId) throw new Error('Native reconciliation identity escaped the selected workflow')
        if (action.version !== args.expectedActionVersion || attempt.version !== args.expectedAttemptVersion) throw new Error('Native reconciliation version changed')
        if (!['unknown_outcome', 'reconciling'].includes(action.state) || attempt.state !== 'unknown_outcome') throw new Error('Only an unknown-outcome native attempt may be reconciled')
        if (action.effect !== 'workspace:file.write' || action.recovery !== 'reconcile' || !action.sideEffect) throw new Error('This reconciliation port only supports uncertain native file effects')
        const writes = db.events({ kind: writeKind }).map(event => copy(event.payload as any))
        const replaces = db.events({ kind: replaceKind }).map(event => copy(event.payload as any))
        // Scan both journal kinds: an effect is ambiguous unless exactly one kind
        // holds this action's latest unknown-outcome claim.
        const claimOf = (events: any[]) => events.filter(item => item.actionId === action.id).at(-1)
        const lastWrite = claimOf(writes), lastReplace = claimOf(replaces)
        for (const last of [lastWrite, lastReplace]) if (last && (last.result !== undefined || terminalStates.includes(last.state))) throw new Error('File-effect journal already has a terminal result; reconciliation is not permitted')
        const candidates: JournalCandidate[] = []
        if (lastWrite?.state === 'unknown_outcome') candidates.push({ journalKind: writeKind, sourceTool: writeTool, events: writes, uncertain: lastWrite })
        if (lastReplace?.state === 'unknown_outcome') candidates.push({ journalKind: replaceKind, sourceTool: replaceTool, events: replaces, uncertain: lastReplace })
        if (candidates.length !== 1) throw new Error(candidates.length ? 'Ambiguous uncertain file-effect journals; exactly one claim is required' : 'No unknown file-effect claim owned by this principal')
        const { journalKind, sourceTool, events: journalEvents, uncertain } = candidates[0]
        if (typeof uncertain.key !== 'string' || !uncertain.key.startsWith(binding.principalId + ':')) throw new Error('No unknown file-effect claim owned by this principal')
        const claims = journalEvents.filter(item => item.key === uncertain.key)
        if (claims.some(item => item.result !== undefined || terminalStates.includes(item.state))) throw new Error('File-effect journal already has a terminal result; reconciliation is not permitted')
        const starts = claims.filter(item => item.state === 'started')
        if (starts.length !== 1 || claims.at(-1) !== uncertain) throw new Error('Uncertain file-effect journal has no single started claim')
        const started = starts[0]
        if (!started || started.request !== uncertain.request || started.actionId !== action.id || started.attemptId !== attempt.attemptId || started.executionId !== attempt.executionId || started.operationId !== attempt.operationId || started.cancellationEpoch !== attempt.cancellationEpoch || uncertain.attemptId !== started.attemptId || uncertain.executionId !== started.executionId || uncertain.operationId !== started.operationId || uncertain.cancellationEpoch !== started.cancellationEpoch || !digestPattern.test(started.beforeRawHash)) throw new Error('Uncertain file-effect journal has no exact native attempt identity')
        const original = JSON.parse(started.request)
        if (original.scope !== selected || original.taskId !== action.taskId || typeof original.path !== 'string' || !original.path) throw new Error('Original native file-effect request is invalid or outside scope')
        if (journalKind === writeKind) validateWriteRequest(original)
        else validateReplaceRequest(original)
        const { plannedContentDigest, expectedDigest } = expectedDigestOf(journalKind, started, uncertain, original)
        const task = workflow.get('task', action.taskId), plan = workflow.get('plan', task.planId), goal = workflow.get('goal', plan.goalId), mission = workflow.get('mission', goal.missionId), intent = workflow.get('intent', mission.intentId), session = workflow.get('session', selected)
        const chain = [action, task, plan, goal, mission, intent, session]
        const cancelled = attempt.cancellationEpoch !== Math.max(...chain.map(item => item.cancellationEpoch)) || chain.some(item => ['cancel_requested', 'draining', 'cancelled', 'completed_after_cancel'].includes(item.state)) || intent.state === 'superseded'
        const storage = new NativeReadStorage(policy, binding.tenantId)
        const absolute = storage.path(original.path), before = lstatSync(absolute)
        if (before.nlink !== 1) throw new Error('Linked files cannot establish reconciliation proof')
        const snapshot = storage.readSnapshot(original.path, 16 * 1024 * 1024)
        const after = lstatSync(absolute)
        if (after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.size !== snapshot.bytes.byteLength) throw new Error('File changed during reconciliation proof')
        if (!snapshot.complete || !snapshot.hash) throw new Error('Current reconciliation file snapshot is unavailable')
        const charset = detectCharset(snapshot.bytes)
        if (charset.binary || charset.encoding !== 'utf-8') throw new Error('Reconciliation requires an existing UTF-8 text file')
        const normalized = decodeText(snapshot.bytes, charset), currentContentDigest = hash(normalized)
        if (snapshot.hash !== args.observedRawHash) throw new Error('Host-observed raw file hash differs from the review constraint')
        if (args.expectedContentDigest !== undefined && args.expectedContentDigest !== expectedDigest) throw new Error('Expected content digest differs from the journaled planned content')
        if (args.outcome === 'succeeded' && (cancelled || currentContentDigest !== expectedDigest)) throw new Error('Successful reconciliation requires the journaled planned content (original requested content) to be the current file content and an uncancelled native attempt')
        const reservationId = started.budgetReservationId
        let reservation
        if (reservationId !== undefined) {
          if (typeof reservationId !== 'string' || !reservationId || uncertain.budgetReservationId !== reservationId) throw new Error('File-effect budget reservation identity changed')
          reservation = nativeIoBudget(db, 'native-read:' + binding.principalId).getReservation(reservationId)
          if (!reservation || reservation.state !== 'reserved' || reservation.budgetKey !== 'native-read:' + binding.principalId || !reservation.amount || !Number.isSafeInteger(reservation.amount.calls) || !Number.isSafeInteger(reservation.amount.bytes)) throw new Error('Uncertain file-effect budget reservation is not open for this principal')
        } else if (uncertain.budgetReservationId !== undefined) throw new Error('File-effect budget reservation identity changed')
        const file = { path: original.path, rawHash: snapshot.hash, hash: fileDigest(normalized), bytes: snapshot.bytes.byteLength, contentDigest: currentContentDigest, inode: after.ino, device: after.dev, modified: after.mtimeMs, changed: after.ctimeMs }
        const observed = { actionId: action.id, attemptId: attempt.attemptId, operationId: attempt.operationId, executionId: attempt.executionId, cancellationEpoch: attempt.cancellationEpoch, journalKind, sourceTool, beforeRawHash: started.beforeRawHash, expectedDigest, plannedContentDigest, expectedContentDigest: expectedDigest, originalRequestDigest: hash(started.request), file, cancelled, budget: reservation ? { reservationId, reservation: copy(reservation) } : { legacyWithoutReservation: true } }
        const head = nativeRequest({ workflow: workflow.snapshot(), writes, replaces, environment: nativeEnvironment(db, root), receipts: db.list<any>('receipt').map(item => copy(item)), reservation: reservation ? copy(reservation) : null, policy, proof: observed })
        return { persistence, action, attempt, original, started, uncertain, journalKind, sourceTool, plannedContentDigest, expectedDigest, proof: observed, head, reservation }
      }
      try {
        // Reuse the already-open Store: imported selection wins, otherwise the
        // selected live Codex thread's native Session is used.
        const candidate = scope(root, store)
        if (!candidate) throw new Error('Select a native workflow before reconciliation')
        selected = candidate
        request = nativeRequest({ args, scope: selected })
        policy = policyFor(root)
        requestedPolicy = copy(policy)
        const prior = store.transaction(() => {
          const done = finalFor(store)
          if (done) {
            if (done.request !== request) throw new Error('Idempotency key already used for another reconciliation')
            return { ...done.result, replayed: true } as Record<string, any>
          }
          const pending = requestedFor(store)
          if (pending) {
            if (pending.request !== request) throw new Error('Idempotency key already used for another reconciliation')
            if (pending.principalId !== binding.principalId || pending.scope !== selected) throw new Error('Pending reconciliation belongs to another principal or scope')
            const storedProof = pending.proof
            if (typeof pending.reviewId !== 'string' || !pending.reviewId || typeof pending.head !== 'string' || !storedProof || typeof storedProof.actionId !== 'string' || typeof storedProof.attemptId !== 'string' || typeof storedProof.operationId !== 'string' || typeof storedProof.executionId !== 'string' || !Number.isSafeInteger(storedProof.cancellationEpoch)) throw new Error('Reconciliation review is unresolved; host reconciliation is required, no repeated approval requested')
            reviewId = pending.reviewId
            head = pending.head
            proof = copy(storedProof)
            requestedPolicy = pending.policy ? copy(pending.policy) : undefined
            const decision = decisionFor(store, reviewId)
            if (!decision) throw new Error('Reconciliation review is unresolved; host reconciliation is required, no repeated approval requested')
            if (decision.request !== request || decision.principalId !== binding.principalId || decision.scope !== selected || decision.head !== head || typeof decision.approved !== 'boolean') throw new Error('Reconciliation decision does not match the recorded request')
            approved = decision.approved
            resumed = true
            return undefined
          }
          const inspected = inspect(store)
          head = inspected.head
          proof = inspected.proof
          reviewId = randomUUID()
          requestedPolicy = copy(policy)
          store.appendEvent(eventKind + '.requested', { key, request, reviewId, head, scope: selected, principalId: binding.principalId, proof: inspected.proof, policy: requestedPolicy })
          return undefined
        })
        if (prior) return prior
      } finally { store.close() }
      if (!reviewId || typeof head !== 'string' || !head || !proof) throw new Error('Reconciliation review was not recorded')
      if (!resumed) {
        approved = await requestHostApproval('native-reconciliation:' + selected, 'confirm_observed_outcome', { reviewId, ...args, workspace: root, principalId: binding.principalId, proof, referenceStatus: 'unverified proposal; host must independently check the manual/query reference and confirm this observed outcome', failureSemantics: 'Failure or cancellation does not assert absence of a prior file effect', retryAuthorized: false, businessAcceptance: false })
        // Persist even rejected decisions separately from the state mutation.
        const audit = openNativeStore(() => root)
        try {
          audit.store.transaction(() => {
            const done = finalFor(audit.store)
            if (done) {
              if (done.request !== request) throw new Error('Idempotency key already used for another reconciliation')
              return
            }
            audit.store.appendEvent(eventKind + '.host_decision', { key, request, reviewId, approved, head, proof, policy: requestedPolicy, reconciliationRef: args.reconciliationRef, principalId: binding.principalId, scope: selected })
          })
        } finally { audit.store.close() }
      }
      const current = openNativeStore(() => root)
      try {
        if (nativeWorkspaceRoot(workspace()) !== root) throw new Error('Workspace changed during reconciliation review')
        if (scope(root, current.store) !== selected) throw new Error('Workflow scope changed during reconciliation review')
        return current.store.transaction(() => {
          const done = finalFor(current.store)
          if (done) {
            if (done.request !== request) throw new Error('Idempotency key already used for another reconciliation')
            return { ...done.result, replayed: true }
          }
          const stale = (reason: unknown) => {
            const result = { approved: true, reconciled: false, changed: false, status: 'stale_after_approval', reviewId, ...identityOf(proof), staleReason: reason instanceof Error ? reason.message : String(reason), retryAuthorized: false, acceptanceGranted: false }
            current.store.appendEvent(eventKind, { key, request, result, head, proof, scope: selected, principalId: binding.principalId })
            return result
          }
          if (!approved) {
            const result = { approved: false, reconciled: false, changed: false, status: 'rejected', reviewId, ...identityOf(proof), retryAuthorized: false, acceptanceGranted: false }
            current.store.appendEvent(eventKind, { key, request, result, head, proof, scope: selected, principalId: binding.principalId })
            return result
          }
          const policyNow = policyFor(root)
          if (requestedPolicy && nativeRequest(policyNow) !== nativeRequest(requestedPolicy)) return stale('Filesystem policy changed during reconciliation review')
          let live: ReturnType<typeof inspect>
          try {
            policy = policyNow
            live = inspect(current.store)
            if (live.head !== head!) throw new StaleAfterApproval('Workflow, file-effect journal, file, attempt, receipt, budget or environment changed during reconciliation review')
          } catch (error) { return stale(error) }
          const p = live.persistence, workflow = p.workflow
          let action = live.action
          if (action.state === 'unknown_outcome') action = p.transition('action', action.id, 'reconciling', { expectedVersion: action.version, actor, reason: args.reason })
          const before = workflow.snapshot()
          const reconciled = workflow.reconcileAction(action.id, { expectedVersion: action.version, expectedAttemptVersion: live.attempt.version, outcome: args.outcome, actor, reconciliationRef: reviewId + ':' + args.reconciliationRef })
          if (args.outcome === 'succeeded' && reconciled.state !== 'succeeded') throw new Error('A fenced action cannot produce a successful recovery receipt')
          const settled = workflow.getAttempt(live.attempt.attemptId)
          current.store.save('action', reconciled as any, { expectedVersion: action.version })
          for (const event of workflow.history().slice(before.events.length)) p.persistEvent(event)
          p.persistAttempt(settled, { actor, from: 'unknown_outcome', reason: 'Independent host reconciliation ' + reviewId })
          let receipt: any
          if (args.outcome === 'succeeded') {
            const context = { tenantId: binding.tenantId, principalId: binding.principalId, agentId: 'codex-coordination', sessionId: selected, operationId: settled.operationId, attemptId: settled.attemptId, executionId: settled.executionId, policyVersion: binding.policyVersion, cancellationEpoch: settled.cancellationEpoch }
            const at = new Date().toISOString()
            // Mirror the canonical effect receipt: write keeps its WP1 argument
            // shape; replace mirrors exactly the model parameters WP2 journaled.
            let invocationArguments: any
            if (live.journalKind === writeKind) {
              invocationArguments = { path: live.original.path, expectedHash: live.original.expectedHash, contentDigest: hash(live.original.content) }
              if (live.original.target !== undefined) invocationArguments.target = live.original.target
              if (live.original.expectedBufferVersion !== undefined) invocationArguments.expectedBufferVersion = live.original.expectedBufferVersion
            } else {
              const parameters: Record<string, unknown> = {}
              for (const field of replaceToolParameters) if (live.original[field] !== undefined) parameters[field] = live.original[field]
              invocationArguments = parameters
            }
            const invocation = createInvocation({ id: settled.executionId, context, toolId: live.sourceTool, arguments: JSON.parse(nativeRequest(invocationArguments)), createdAt: live.attempt.startedAt, idempotencyKey: live.started.key.slice(binding.principalId.length + 1) })
            const observationValue: any = { path: live.original.path, beforeRawHash: live.started.beforeRawHash, rawHash: live.proof.file.rawHash, hash: live.proof.file.hash, bytes: live.proof.file.bytes, reconciled: true, reviewId, reconciliationRef: args.reconciliationRef, proof: live.plannedContentDigest === undefined ? 'host-confirmed-current-file-and-original-request' : 'host-confirmed-current-file-and-journaled-planned-content' }
            if (live.journalKind === replaceKind) observationValue.mode = live.original.mode
            if (live.journalKind === writeKind && live.original.target !== undefined) observationValue.target = live.original.target
            if (live.journalKind === writeKind && live.original.expectedBufferVersion !== undefined) observationValue.expectedBufferVersion = live.original.expectedBufferVersion
            const observation = createObservation({ id: randomUUID(), invocationId: invocation.id, status: 'success', value: observationValue, observedAt: at })
            receipt = createReceiptCore({ id: 'receipt:' + settled.executionId, kind: 'file_flush_receipt', invocation, observation, issuedAt: at, hashAlgorithm: 'sha256-json-execution-facts/2', payloadDigest: executionFactDigest(invocation, observation), lifecycle: 'issued', workspaceAnchor: { workspaceId: hash(root), changeHash: nativeEnvironment(current.store, root), affectedFiles: [live.original.path], snapshotId: live.proof.file.rawHash } })
            if (current.store.list<any>('receipt').some(item => item.id === receipt!.id)) throw new Error('Original execution already has a receipt; host conflict reconciliation is required')
            current.store.save('receipt', receipt)
          }
          let budget: Record<string, any> = { legacyWithoutReservation: true, settlementPerformed: false }
          if (live.reservation) {
            // The interrupted effect has no trustworthy final I/O telemetry. Charge
            // its entire original reservation; never refund inferred no-effect work.
            const actual = { calls: live.reservation.amount.calls, bytes: live.reservation.amount.bytes }
            nativeIoBudget(current.store, 'native-read:' + binding.principalId).settle(live.reservation.id, actual)
            budget = { reservationId: live.reservation.id, settlementPerformed: true, actual, conservative: true }
          }
          const identity = { actionId: reconciled.id, attemptId: settled.attemptId, operationId: settled.operationId, executionId: settled.executionId, cancellationEpoch: settled.cancellationEpoch }
          const result = { approved: true, reconciled: true, changed: true, status: 'reconciled', reviewId, ...identity, state: reconciled.state, file: live.proof.file, ...(receipt ? { receipt } : {}), budget, journalKind: live.journalKind, reconciliationRef: args.reconciliationRef, observedEffect: args.outcome === 'succeeded' ? 'host-confirmed-requested-content' : 'manual-host-decision-no-absence-claim', retryAuthorized: false, businessVerification: 'not_performed', acceptanceGranted: false }
          // The terminal event belongs to the same journal kind that recorded the
          // uncertain effect, so replays and audits read one coherent history.
          const terminal: Record<string, unknown> = { key: live.started.key, request: live.started.request, state: args.outcome, ...identity, budgetReservationId: live.started.budgetReservationId, result, reconciliationReviewId: reviewId }
          if (live.plannedContentDigest !== undefined) terminal.plannedContentDigest = live.plannedContentDigest
          current.store.appendEvent(live.journalKind, terminal)
          current.store.appendEvent(eventKind, { key, request, result, head: head!, proof: live.proof, scope: selected, principalId: binding.principalId })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
