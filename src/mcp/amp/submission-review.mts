/** Consume immutable proposals only after an independent, exact host decision. */
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { focus, mount } from 'attention-manifest-protocol/attention'
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { Store } from 'attention-manifest-protocol/service'
import { ENTITY_REGISTRY } from 'attention-manifest-protocol/entity'
import type { EntityKind } from 'attention-manifest-protocol/entity'
import type { ToolDefinition } from '../lib/tools.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { bindEvidence } from 'attention-manifest-protocol/persistence'
import type { ReceiptCore } from 'attention-manifest-protocol/receipt'
import { assertFileFreshness } from './file-freshness.mjs'
import { createHash } from 'node:crypto'
import { nativeEnvironment, nativeRequest, openNativeStore, sameNativeRequest } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { randomUUID } from 'node:crypto'

const reviewKind = 'codex.amp.submission.review'
const requestKind = 'codex.amp.submission.review_requested'
const plain = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max
function exact(value: unknown, fields: string[]) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid submission payload fields')
}

export function submissionReview(binding: AgentBinding, workspace: () => unknown, workflowScope: (root: string) => string | undefined, filesystemPolicy?: () => NativeFilesystemScope | undefined): ToolDefinition {
  const identity = { tenantId: binding.tenantId, principalId: binding.principalId }
  const terminal = (store: Store, key: string, request: string) => {
    const old = store.events({ kind: reviewKind }).map(event => event.payload as any).find(value => value.key === key)
    if (!old) return undefined
    if (old.request !== request) throw new Error('Idempotency key already used for another submission review')
    return { ...old.result, replayed: true }
  }
  const decisionFor = (store: Store, submissionId: string) => store.events({ kind: reviewKind }).map(event => event.payload as any).find(value => value.submissionId === submissionId)
  const read = (store: Store, root: string, args: Record<string, unknown>) => {
    const submission = store.events({ kind: 'codex.amp.submission' }).map(event => plain(event.payload as any)).find(value => value.id === args.submissionId)
    if (!submission || submission.binding?.principalId !== binding.principalId || submission.binding?.tenantId !== binding.tenantId) throw new Error('Submission is absent or belongs to another principal')
    if (submission.status !== 'pending_host_review' || !record(submission.parameters) || !text(submission.parameters.targetId, 200)) throw new Error('Invalid pending submission')
    if (typeof submission.request !== 'string' || !sameNativeRequest(submission.request, nativeRequest({ tool: submission.tool, parameters: submission.parameters }))) throw new Error('Submission commitment does not match its immutable payload')
    const payload = submission.parameters.submission, targetId = submission.parameters.targetId
    const kind = submission.tool === 'attention_manifest_protocol_attention.request_focus' ? 'attention' : submission.tool === 'attention_manifest_protocol_intent.submit_clarification' ? 'intent' : submission.tool === 'attention_manifest_protocol_goal.submit_evidence' ? 'goal' : undefined
    if (!kind) throw new Error('Only focus, intent clarification and goal evidence submissions can be reviewed')
    const selected = workflowScope(root)
    const rootId = createHash('sha256').update(root).digest('hex')
    let target: any, citations: unknown = null, workflowHead: unknown = null
    if (kind === 'attention') {
      exact(payload, ['reason', 'amount', 'mount'])
      if (!text(payload.reason, 2000) || payload.amount !== undefined && (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 0 || payload.amount > 1) || payload.mount !== undefined && typeof payload.mount !== 'boolean') throw new Error('Focus requires reason, optional amount in [0,1] and optional mount boolean')
      target = plain(store.list<AttentionObject>('attention').find(value => value.id === targetId))
      if (!target || target.scope?.tenantId !== binding.tenantId || target.scope?.principalId !== binding.principalId) throw new Error('Attention is absent or outside the principal scope')
      const observed = store.events({ kind: 'codex.sync.session_mapping' }).some(event => (event.payload as any).sessionId === target.scope.sessionId)
      if (target.scope.sessionId !== selected && !observed) throw new Error('Attention is outside an observed or selected session scope')
      const session = store.list<any>('session').find(value => value.id === target.scope.sessionId)
      if (!session || !['active', 'idle'].includes(session.state)) throw new Error('Attention session is not active')
      if (!Object.hasOwn(ENTITY_REGISTRY, target.pointer.kind)) throw new Error('Attention pointer has no native owner')
      const source = store.list<any>(target.pointer.kind as EntityKind).find(value => value.id === target.pointer.id)
      if (!source || String(source.version) !== target.pointer.version || source.sessionId !== undefined && source.sessionId !== target.scope.sessionId || source.rootId !== undefined && source.rootId !== rootId || source.scope && (source.scope.tenantId !== binding.tenantId || source.scope.principalId !== binding.principalId || source.scope.sessionId !== target.scope.sessionId)) throw new Error('Attention pointer is stale or outside its session scope')
      // Preview executes native validation; it never stores the result.
      focus(target, { expectedVersion: Number(args.expectedVersion), now: new Date().toISOString(), reason: payload.reason }, payload.amount)
    } else {
      if (!selected) throw new Error('Select a native workflow first')
      const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
      if (persistence.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
      target = plain(persistence.workflow.get(kind, targetId))
      if (target.sessionId !== selected) throw new Error('Target is outside the selected workflow scope')
      if (!['active', 'idle'].includes(persistence.workflow.get('session', selected).state)) throw new Error('Resume the selected workflow first')
      workflowHead = persistence.workflow.snapshot()
      if (kind === 'intent') {
        exact(payload, ['text'])
        if (!text(payload.text)) throw new Error('Clarification requires nonempty text of at most 4000 characters')
      } else {
        exact(payload, ['evidenceIds', 'criteriaVersion'])
        if (!Array.isArray(payload.evidenceIds) || !payload.evidenceIds.length || payload.evidenceIds.length > 20 || new Set(payload.evidenceIds).size !== payload.evidenceIds.length || !payload.evidenceIds.every((id: unknown) => text(id, 200)) || !text(payload.criteriaVersion, 200)) throw new Error('Goal evidence requires 1-20 unique evidenceIds and criteriaVersion')
        if (payload.criteriaVersion !== target.contractVersion || !target.acceptanceCriteria?.length) throw new Error('Goal evidence criteria do not match the native goal contract')
        const ledger = new EvidenceLedger(), bound = bindEvidence(store, ledger)
        bound.rehydrate()
        if (bound.report.skipped.length) throw new Error('Native evidence contains invalid facts')
        citations = payload.evidenceIds.map((id: string) => {
          const evidence = ledger.getConsumable(id, binding.tenantId, new Date().toISOString())
          if (!evidence) throw new Error('Evidence is absent, expired, revoked or stale')
          if (evidence.criteriaVersion !== target.contractVersion) throw new Error('Evidence criteria version does not match the goal contract')
          if (evidence.environmentVersion !== nativeEnvironment(store, root)) throw new Error('Evidence environment is stale')
          const receipt = store.list<ReceiptCore>('receipt').find(item => item.id === evidence.receiptId)
          if (!receipt || receipt.invocation.context.tenantId !== binding.tenantId || receipt.invocation.context.principalId !== binding.principalId) throw new Error('Evidence receipt is missing or outside the principal scope')
          assertFileFreshness(plain(receipt), root, binding.tenantId, filesystemPolicy)
          return { id: evidence.id, claim: evidence.claim, receiptId: evidence.receiptId, verificationId: evidence.verificationId, criteriaVersion: evidence.criteriaVersion, environmentVersion: evidence.environmentVersion }
        })
      }
    }
    if (target.version !== args.expectedVersion) throw new Error('Target version changed; read the current target before review')
    return { submission, kind, target, citations, selected: selected ?? null, environment: nativeEnvironment(store, root), workflowHead }
  }
  return { name: 'attention_manifest_protocol_submission_review', description: 'Independently review and consume one immutable focus, clarification or goal-evidence submission. Exact target version, ownership, scope and freshness are checked before and after host approval. Focus may explicitly mount; clarification/evidence attach reviewed references only and never accept intents or achieve goals. Decisions and unresolved requests survive retry.', annotations: { readOnlyHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['submissionId', 'expectedVersion', 'idempotencyKey'], properties: { submissionId: { type: 'string', minLength: 1, maxLength: 200 }, expectedVersion: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 } } },
    async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, unknown>
      exact(args, ['submissionId', 'expectedVersion', 'idempotencyKey'])
      if (!text(args.submissionId, 200) || !text(args.idempotencyKey, 200) || !Number.isSafeInteger(args.expectedVersion) || Number(args.expectedVersion) < 0) throw new Error('Submission ID, target expectedVersion and stable idempotencyKey are required')
      const opened = openNativeStore(workspace), root = opened.root
      const key = nativeRequest({ ...identity, idempotencyKey: args.idempotencyKey }), request = nativeRequest(args)
      let snapshot: ReturnType<typeof read>, head: string, reviewId: string, approved = false, resumedDecision = false
      try {
        const prior = terminal(opened.store, key, request)
        if (prior) return prior
        const consumed = decisionFor(opened.store, String(args.submissionId))
        if (consumed) { if (consumed.tenantId !== binding.tenantId || consumed.principalId !== binding.principalId) throw new Error('Submission decision belongs to another principal'); return { ...consumed.result, replayed: true } }
        const pending = opened.store.events({ kind: requestKind }).map(event => event.payload as any).find(value => value.submissionId === args.submissionId)
        if (pending) {
          if (pending.key !== key || pending.request !== request) throw new Error('Submission review is unresolved; retry its original review key')
          const decision = opened.store.events({ kind: 'codex.amp.submission.host_decision' }).map(event => event.payload as any).find(value => value.reviewId === pending.reviewId)
          if (!decision) throw new Error('Submission review is unresolved; host reconciliation is required, no repeated decision was requested')
          snapshot = pending.snapshot; head = pending.head; reviewId = pending.reviewId; approved = decision.approved; resumedDecision = true
        } else {
          snapshot = read(opened.store, root, args)
          head = nativeRequest(snapshot)
          reviewId = randomUUID()
          opened.store.transaction(() => {
            if (opened.store.events({ kind: requestKind }).some(event => (event.payload as any).submissionId === args.submissionId)) throw new Error('Submission review is unresolved; host reconciliation is required, no repeated decision was requested')
            opened.store.appendEvent(requestKind, { key, request, reviewId, submissionId: args.submissionId, head, snapshot, ...identity })
          })
        }
      } finally { opened.store.close() }
      if (!resumedDecision) {
        approved = await requestHostApproval('native-submission:' + args.submissionId, 'consume_submission', { reviewId: reviewId!, ...args, workspace: root, target: snapshot!.target, submission: snapshot!.submission.parameters.submission, citations: snapshot!.citations, effect: snapshot!.kind === 'attention' ? { focus: true, mount: snapshot!.submission.parameters.submission.mount === true } : { attachmentOnly: true, acceptanceGranted: false } })
        const audit = openNativeStore(() => root).store
        try { audit.appendEvent('codex.amp.submission.host_decision', { reviewId: reviewId!, key, request, approved, ...identity }) } finally { audit.close() }
      }
      // The decision is durable even when the current workspace, target or evidence drifted.
      const current = openNativeStore(() => root)
      try {
        return current.store.transaction(() => {
          const prior = terminal(current.store, key, request)
          if (prior) return prior
          let valid = false
          try {
            const active = openNativeStore(workspace); active.store.close()
            const fresh = approved ? read(current.store, root, args) : null
            valid = active.root === root && workflowScope(root) === (snapshot!.selected ?? undefined) && fresh !== null && nativeRequest(fresh) === head! && nativeEnvironment(current.store, root) === snapshot!.environment
            if (valid) {
              const target = plain(current.store.refresh(snapshot!.kind as EntityKind, snapshot!.target.id))
              valid = nativeRequest(target) === nativeRequest(snapshot!.target)
            }
          } catch { valid = false }
          let result: Record<string, any> = { approved, consumed: false, changed: false, reviewId: reviewId!, submissionId: args.submissionId, acceptanceGranted: false, status: approved ? 'stale_after_approval' : 'rejected' }
          if (approved && valid) {
            const value = snapshot!.submission.parameters.submission
            const attachment = { submissionId: args.submissionId, targetId: snapshot!.target.id, targetVersion: args.expectedVersion, sessionId: snapshot!.kind === 'attention' ? snapshot!.target.scope.sessionId : snapshot!.target.sessionId, ...identity, reviewId: reviewId!, reviewedAt: new Date().toISOString() }
            if (snapshot!.kind === 'attention') {
              let next = focus(snapshot!.target, { expectedVersion: Number(args.expectedVersion), now: new Date().toISOString(), reason: value.reason }, value.amount)
              if (value.mount === true) next = mount(next, { expectedVersion: next.version, now: new Date().toISOString(), reason: value.reason })
              current.store.save('attention', next)
              result = { ...result, consumed: true, changed: true, status: 'consumed', attention: next, mounted: next.mounted, mountRequested: value.mount === true }
            } else {
              const event = snapshot!.kind === 'intent' ? { ...attachment, clarification: value.text, source: 'host-reviewed-agent-proposal', intentAccepted: false } : { ...attachment, evidenceIds: value.evidenceIds, citations: snapshot!.citations, criteriaVersion: value.criteriaVersion, environmentVersion: snapshot!.environment, acceptanceGranted: false }
              current.store.appendEvent(snapshot!.kind === 'intent' ? 'codex.amp.intent.clarification' : 'codex.amp.goal.evidence_attachment', event)
              result = { ...result, consumed: true, changed: true, status: 'consumed', attachment: event }
            }
          }
          current.store.appendEvent(reviewKind, { key, request, submissionId: args.submissionId, ...identity, result })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
