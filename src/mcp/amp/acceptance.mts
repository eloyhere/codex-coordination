/** Independent, scoped native workflow acceptance with sealed pre-transition evidence. */
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { Acceptance, WorkflowEntity } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence, bindEvidence } from 'attention-manifest-protocol/persistence'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import type { ReceiptCore, ReceiptIntegrityVerification } from 'attention-manifest-protocol/receipt'
import type { BusinessVerification } from 'attention-manifest-protocol/verification'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import { nativeEnvironment, nativeRequest, openNativeStore } from './native-store.mjs'
import { assertFileFreshness } from './file-freshness.mjs'
import { requestHostApproval } from './host-client.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'
import { createHash, randomUUID } from 'node:crypto'

const requested = 'codex.amp.workflow.acceptance_requested'
const decided = 'codex.amp.workflow.acceptance_host_decision'
const reviewed = 'codex.amp.workflow.acceptance_review'
const sealed = 'codex.amp.workflow.acceptance_proof'
const fields = ['kind', 'id', 'expectedVersion', 'criteriaVersion', 'evidenceIds', 'idempotencyKey', 'reason']
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max
const plain = <T,>(value: T): T => JSON.parse(nativeRequest(value))
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(nativeRequest(value)).digest('hex')
type Command = { kind: 'task' | 'goal'; id: string; expectedVersion: number; criteriaVersion: string; evidenceIds: string[]; idempotencyKey: string; reason: string }

export function workflowAcceptanceReview(binding: AgentBinding, workspace: () => unknown, scope: WorkflowScopeCallback, filesystemPolicy?: () => NativeFilesystemScope | undefined): ToolDefinition {
  const identity = { tenantId: binding.tenantId, principalId: binding.principalId, connection: binding.sessionId }
  const terminal = (store: Store, key: string, request: string) => {
    const prior = store.events({ kind: reviewed }).map(event => event.payload as any).find(value => value.key === key)
    if (!prior) return undefined
    if (prior.request !== request) throw new Error('Idempotency key already used for another acceptance')
    return { ...prior.result, replayed: true }
  }
  const unresolved = (store: Store, args: Command, selected: string) => {
    const completed = new Set(store.events({ kind: reviewed }).map(event => (event.payload as any).result?.reviewId))
    return store.events({ kind: requested }).map(event => event.payload as any).some(value => !completed.has(value.reviewId) && value.snapshot?.selected === selected && value.snapshot?.target?.kind === args.kind && value.snapshot?.target?.id === args.id)
  }
  const read = (store: Store, root: string, args: Command) => {
    // Reuse the caller's open Store so a live thread resolves without a second
    // SQLite connection; a legacy `(root) => string` callback simply ignores it.
    const selected = scope(root, store)
    if (!selected) throw new Error('Select a native workflow first')
    const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    if (persistence.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
    const workflow = persistence.workflow, target = workflow.get(args.kind, args.id)
    if (target.sessionId !== selected) throw new Error('Target is outside the selected workflow scope')
    if (!['active', 'idle'].includes(workflow.get('session', selected).state)) throw new Error('Resume the selected workflow before acceptance')
    if (target.version !== args.expectedVersion) throw new Error('Target version changed; read before acceptance')
    if (target.contractVersion !== args.criteriaVersion) throw new Error('Acceptance criteriaVersion does not match the target contract')
    const environment = nativeEnvironment(store, root)
    const ledger = new EvidenceLedger(), bound = bindEvidence(store, ledger)
    bound.rehydrate()
    if (bound.report.skipped.length) throw new Error('Native evidence contains invalid facts')
    const evidence = args.evidenceIds.map(id => {
      const item = ledger.getConsumable(id, binding.tenantId, new Date().toISOString())
      if (!item) throw new Error('Evidence is absent, expired, revoked or stale')
      if (item.polarity !== 'supports' || item.criteriaVersion !== target.contractVersion || item.environmentVersion !== environment || item.sessionId !== selected) throw new Error('Evidence criteria, environment or selected session does not match the target')
      const receipt = plain(store.refresh<ReceiptCore>('receipt', item.receiptId))
      const verification = plain(store.refresh<BusinessVerification>('verification', item.verificationId))
      const integrity = plain(store.refresh<ReceiptIntegrityVerification>('receipt_integrity', item.integrityVerificationId))
      if (receipt.invocation.context.tenantId !== binding.tenantId || receipt.invocation.context.principalId !== binding.principalId || receipt.invocation.context.sessionId !== selected) throw new Error('Evidence receipt belongs to another principal or session')
      if (receipt.observation.status !== 'success' || !['issued', 'signed', 'anchored', 'verified', 'archived'].includes(receipt.lifecycle ?? '') || receipt.observation.invocationId !== receipt.invocation.id || receipt.hashAlgorithm !== 'sha256-json-execution-facts/2' || executionFactDigest(receipt.invocation, receipt.observation) !== receipt.payloadDigest || receipt.workspaceAnchor?.changeHash !== environment) throw new Error('Evidence receipt is invalid or stale')
      if (integrity.id !== item.integrityVerificationId || integrity.receiptId !== receipt.id || integrity.status !== 'integrity_verified' || !integrity.digestValid) throw new Error('Evidence has no matching receipt integrity verification')
      if (verification.id !== item.verificationId || verification.receiptId !== receipt.id || verification.observationId !== receipt.observation.id || item.observationId !== receipt.observation.id || verification.status !== 'semantic_verified' || verification.criteriaVersion !== target.contractVersion || !verification.claims.includes(item.claim) || verification.verifier !== 'independent-mcp-host-confirmation') throw new Error('Evidence has no matching independent semantic verification')
      assertFileFreshness(receipt, root, binding.tenantId, filesystemPolicy)
      return { evidence: plain(item), receipt, integrity, verification }
    })
    const acceptance: Acceptance = { valid: true, contractVersion: target.contractVersion, verificationId: evidence[0]!.verification.id, evidenceIds: args.evidenceIds }
    return { selected, target, environment, evidence, acceptance, workflow: workflow.snapshot() }
  }
  const options = (snapshot: ReturnType<typeof read>, args: Command) => {
    const workflow = WorkflowStore.restore(snapshot.workflow)
    const chain: WorkflowEntity[] = [snapshot.target, workflow.get('session', snapshot.selected)]
    if (snapshot.target.kind === 'task') {
      const plan = workflow.get('plan', snapshot.target.planId)
      const goal = workflow.get('goal', plan.goalId)
      chain.push(plan, goal, workflow.get('mission', goal.missionId))
    } else chain.push(workflow.get('mission', snapshot.target.missionId))
    return { expectedVersion: args.expectedVersion, actor: 'mcp-host-review', reason: args.reason, cancellationEpoch: Math.max(...chain.map(item => item.cancellationEpoch)), acceptance: snapshot.acceptance }
  }
  return {
    name: 'attention_manifest_protocol_workflow_acceptance_review',
    description: 'Host extension: independently review task completion or goal achievement in the selected native plugin workflow. Requires exact target/criteria versions and 1-20 current verified evidence IDs. Checks native completion guards, scope, environment and file freshness before and after approval. Seals the evidence at its pre-transition applicability point; receipts alone never grant acceptance.',
    inputSchema: { type: 'object', additionalProperties: false, required: fields, properties: {
      kind: { enum: ['task', 'goal'] }, id: { type: 'string', minLength: 1, maxLength: 200 }, expectedVersion: { type: 'integer', minimum: 0 }, criteriaVersion: { type: 'string', minLength: 1, maxLength: 200 }, evidenceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    } }, annotations: { readOnlyHint: false },
    async handler(input) {
      assertModelParameters(input)
      const args = plain(input) as Command
      if (Object.keys(args).some(key => !fields.includes(key)) || !['task', 'goal'].includes(args.kind) || !text(args.id, 200) || !text(args.criteriaVersion, 200) || !text(args.idempotencyKey, 200) || !text(args.reason, 2000) || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0 || !Array.isArray(args.evidenceIds) || !args.evidenceIds.length || args.evidenceIds.length > 20 || new Set(args.evidenceIds).size !== args.evidenceIds.length || !args.evidenceIds.every(id => text(id, 200))) throw new Error('Invalid acceptance parameters: exact target/criteria versions, 1-20 evidence IDs, key and reason are required')
      Object.freeze(args.evidenceIds); Object.freeze(args)
      const opened = openNativeStore(workspace), root = opened.root
      const key = nativeRequest({ ...identity, idempotencyKey: args.idempotencyKey }), request = nativeRequest(args)
      let snapshot: ReturnType<typeof read>, head: string, reviewId: string, approved = false, resumed = false
      try {
        const replay = terminal(opened.store, key, request)
        if (replay) return replay
        const pending = opened.store.events({ kind: requested }).map(event => event.payload as any).find(value => value.key === key)
        if (pending) {
          if (pending.request !== request) throw new Error('Idempotency key already used for another acceptance')
          const decision = opened.store.events({ kind: decided }).map(event => event.payload as any).find(value => value.reviewId === pending.reviewId && value.key === key && value.request === request)
          if (!decision) throw new Error('Acceptance review is unresolved; host reconciliation is required, no repeated approval requested')
          snapshot = pending.snapshot; head = pending.head; reviewId = pending.reviewId; approved = decision.approved === true; resumed = true
        } else {
          snapshot = read(opened.store, root, args)
          if (unresolved(opened.store, args, snapshot.selected)) throw new Error('Acceptance target has an unresolved review; retry its original key')
          WorkflowStore.restore(snapshot.workflow).transition(args.kind, args.id, args.kind === 'task' ? 'completed' : 'achieved', options(snapshot, args))
          head = nativeRequest(snapshot); reviewId = randomUUID()
          opened.store.transaction(() => {
            if (opened.store.events({ kind: requested }).some(event => (event.payload as any).key === key) || unresolved(opened.store, args, snapshot.selected)) throw new Error('Acceptance review is unresolved; retry its original key')
            opened.store.appendEvent(requested, { key, request, reviewId, snapshot, head, ...identity })
          })
        }
      } finally { opened.store.close() }
      if (!resumed) {
        approved = await requestHostApproval('native-workflow:' + snapshot!.selected, 'accept_' + args.kind, { reviewId: reviewId!, ...args, workspace: root, selected: snapshot!.selected, target: snapshot!.target, evidence: snapshot!.evidence, environment: snapshot!.environment })
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
          let result: Record<string, any> = { approved, changed: false, acceptanceGranted: false, reviewId: reviewId!, status: approved ? 'stale_after_approval' : 'rejected' }
          if (valid) {
            const persistence = new WorkflowPersistence({ store: current.store, workflow: WorkflowStore.restore(snapshot!.workflow) })
            const entity = persistence.transition(args.kind, args.id, args.kind === 'task' ? 'completed' : 'achieved', options(snapshot!, args))
            // Environment includes workflow state. Evidence remains immutable and reusable only
            // when current; this proof preserves why it was applicable to the exact old head.
            const proof = { id: reviewId!, ...identity, selected: snapshot!.selected, consumer: { kind: args.kind, id: args.id, version: entity.version }, targetBefore: snapshot!.target, targetAfter: entity, criteriaVersion: args.criteriaVersion, preAcceptanceEnvironment: snapshot!.environment, postAcceptanceEnvironment: nativeEnvironment(current.store, root), workflowHeadDigest: digest(snapshot!.workflow), evidence: snapshot!.evidence, evidenceIds: args.evidenceIds, verificationIds: snapshot!.evidence.map(item => item.verification.id), reviewedAt: new Date().toISOString(), reviewId: reviewId!, reason: args.reason }
            current.store.appendEvent(sealed, { ...proof, digest: digest(proof) }, entity.id)
            result = { ...result, changed: true, acceptanceGranted: true, status: 'accepted', entity, proofId: reviewId! }
          }
          current.store.appendEvent(reviewed, { key, request, ...identity, scope: snapshot!.selected, result })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
