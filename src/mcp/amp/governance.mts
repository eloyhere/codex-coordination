/** Host extension over native AMP governance. It grants no canonical agent authority. */
import { ProfessionRegistry } from 'attention-manifest-protocol/profession'
import type { ProfessionEvaluation, ProfessionProfile } from 'attention-manifest-protocol/profession'
import { CapabilityLifecycleRegistry, propagateSkillImpacts } from 'attention-manifest-protocol/capability'
import type { CapabilityLifecycleState, CapabilityLifecycleSignal, CapabilityLifecycleRegistration } from 'attention-manifest-protocol/capability'
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { bindEvidence } from 'attention-manifest-protocol/persistence'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { openNativeStore, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { assertFileFreshness, fileReceiptTools } from './file-freshness.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'

const eventKind = 'codex.amp.governance.command'
const pendingKind = 'codex.amp.governance.review_requested'
const decisionKind = 'codex.amp.governance.host_decision'
const resultKind = 'codex.amp.governance.review'
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(nativeRequest(value)).digest('hex')
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200
function exact(value: any, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid governance command fields')
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
type Command = { operation: string; profile?: ProfessionProfile; registration?: CapabilityLifecycleRegistration; profileId?: string; evaluationId?: string; evidenceIds?: string[]; capabilityId?: string; version?: string; next?: CapabilityLifecycleState; reason?: string }
/** This callback is supplied in host code only; model arguments cannot create it. */
export interface NativeGovernanceHost {
  evaluateProfession?: (input: Readonly<{ evaluationId: string; profile: ProfessionProfile; evidence: readonly unknown[] }>) => ProfessionEvaluation
}
function validate(command: Command) {
  if (!command || typeof command.operation !== 'string') throw new Error('Governance operation required')
  if (command.operation === 'profession.register') {
    exact(command, ['operation', 'profile'])
    const profile = command.profile
    exact(profile, ['id', 'name', 'summary', 'version', 'permissionScope', 'deniedCapabilityIds', 'requirements'])
    if (!text(profile?.id) || !text(profile.version) || !text(profile.name)) throw new Error('Profession ID, version and name are required')
    command.profile = { ...profile, scores: { taskSuccessRate: 0, averageTokens: 0, sideEffectRate: 0, sampleSize: 0 }, certificationStatus: 'uncertified', lifecycle: [] }
  } else if (command.operation === 'profession.certify' || command.operation === 'profession.recertify') {
    exact(command, ['operation', 'profileId', 'evaluationId', 'evidenceIds'])
    if (!text(command.profileId) || !text(command.evaluationId) || !Array.isArray(command.evidenceIds) || command.evidenceIds.length < 1 || command.evidenceIds.length > 20 || !command.evidenceIds.every(text) || new Set(command.evidenceIds).size !== command.evidenceIds.length) throw new Error('Certification requires profile, host evaluation ID and 1-20 unique stored evidence IDs')
  } else if (command.operation === 'capability.register') {
    exact(command, ['operation', 'registration'])
    exact(command.registration, ['capabilityId', 'version', 'kind', 'references', 'reason'])
  } else if (command.operation === 'capability.transition') {
    exact(command, ['operation', 'capabilityId', 'version', 'next', 'reason'])
    if (!text(command.capabilityId) || !text(command.version) || !text(command.next) || command.reason !== undefined && (typeof command.reason !== 'string' || command.reason.length > 2000)) throw new Error('Capability ID, exact version and next state required')
  } else throw new Error('Unsupported governance operation; behavior evaluation/publishing is not connected')
}
function registries() { return { professions: new ProfessionRegistry(), capabilities: new CapabilityLifecycleRegistry() } }
type Registries = ReturnType<typeof registries>
function apply(state: Registries, command: Command, evaluation?: ProfessionEvaluation) {
  const { professions, capabilities } = state
  // Native registry clocks are replayed per event, not wall-clock time.
  if (command.operation === 'profession.register') return { profile: professions.register(command.profile!) }
  if (command.operation === 'profession.certify') return { profile: professions.certify(command.profileId!, evaluation!) }
  if (command.operation === 'profession.recertify') return { profile: professions.recertify(command.profileId!, evaluation!) }
  if (command.operation === 'capability.register') return { capability: capabilities.register(command.registration!) }
  const capability = capabilities.transition(command.capabilityId!, command.version!, command.next!, command.reason)
  let signal: CapabilityLifecycleSignal | undefined
  if (capability.kind === 'tool' && (capability.state === 'degraded' || capability.state === 'unavailable')) signal = { kind: 'tool', id: capability.capabilityId, version: capability.version, state: capability.state }
  if (capability.kind === 'cognition' && capability.state === 'demoted') signal = { kind: 'cognition', id: capability.capabilityId, version: capability.version, state: 'demoted' }
  const impacts = signal ? propagateSkillImpacts(signal, capabilities.list({ kind: 'skill' })) : []
  for (const impact of impacts) if (impact.to) capabilities.transition(impact.skillId, impact.version, impact.to, impact.reason)
  return { capability, impacts: impacts.map(impact => ({ ...impact, applied: impact.to !== undefined, ...(impact.action === 'weight_reduced' ? { selectionEffect: 'audit_only_no_selector_connected' } : {}) })) }
}

export function governanceBindings(binding: AgentBinding, workspace: () => unknown, host: NativeGovernanceHost = {}, filesystemPolicy?: () => NativeFilesystemScope | undefined): ToolDefinition[] {
  // Capture host collaborators; later mutation of the options object cannot grant authority.
  const evaluate = typeof host.evaluateProfession === 'function' ? host.evaluateProfession : undefined
  const identity = { tenantId: binding.tenantId, principalId: binding.principalId }
  const owns = (value: any) => value.tenantId === identity.tenantId && value.principalId === identity.principalId
  function restore(store: Store) {
    let clock = ''
    const state = registries(); state.capabilities = new CapabilityLifecycleRegistry(() => clock)
    const events = store.events({ kind: eventKind }).map(event => plain(event.payload as any)).filter(owns)
    let expected = 0
    for (const event of events) {
      if (event.sequence !== ++expected || event.previous !== digest(events.slice(0, expected - 1))) throw new Error('Governance journal sequence or commitment is invalid')
      clock = event.at
      const actual = plain(apply(state, event.command, event.evaluation))
      if (nativeRequest(actual) !== nativeRequest(event.result)) throw new Error('Governance journal native replay differs from stored result')
    }
    return { state, events, head: digest(events), version: events.length, setClock: (at: string) => { clock = at } }
  }
  function evidence(store: Store, root: string, command: Command) {
    if (!command.evidenceIds) return []
    const ledger = new EvidenceLedger(), bound = bindEvidence(store, ledger)
    bound.rehydrate()
    if (bound.report.skipped.length) throw new Error('Stored evidence cannot be rehydrated')
    return command.evidenceIds.map(id => {
      const value = ledger.getConsumable(id, binding.tenantId, new Date().toISOString())
      if (!value || value.environmentVersion !== nativeEnvironment(store, root)) throw new Error('Evaluation evidence is absent, stale or expired')
      const receipt = store.list<any>('receipt').find(row => row.id === value.receiptId)
      const context = receipt?.invocation?.context
      if (!receipt || context?.principalId !== binding.principalId || context?.tenantId !== binding.tenantId) throw new Error('Evaluation evidence receipt belongs to another principal')
      // Execution receipts scope the connection session to this workspace; file-write
      // receipts carry the selected workflow session, which must exist in this store.
      const scopedSession = binding.sessionId + ':' + digest(root)
      if (context?.sessionId !== scopedSession && !store.list<any>('session').some(row => row.id === context?.sessionId)) throw new Error('Evaluation evidence receipt belongs to another session or workspace')
      const snapshot = plain(receipt)
      const verification = store.list<any>('verification').find(row => row.id === value.verificationId)
      const integrity = store.list<any>('receipt_integrity').find(row => row.id === value.integrityVerificationId)
      if (!verification || verification.status !== 'semantic_verified' || verification.receiptId !== value.receiptId || verification.observationId !== value.observationId || verification.criteriaVersion !== value.criteriaVersion || !verification.claims?.includes(value.claim)) throw new Error('Evaluation evidence semantic verification is missing or mismatched')
      if (!integrity || integrity.receiptId !== value.receiptId || integrity.status !== 'integrity_verified' || integrity.digestValid !== true) throw new Error('Evaluation evidence integrity verification is missing or mismatched')
      if (snapshot.observation.id !== value.observationId || snapshot.observation.status !== 'success' || snapshot.lifecycle !== 'issued' || snapshot.hashAlgorithm !== 'sha256-json-execution-facts/2' || snapshot.payloadDigest !== executionFactDigest(snapshot.invocation, snapshot.observation)) throw new Error('Evaluation receipt execution facts are invalid')
      if (!/^attention_manifest_protocol_(project|goal|plan|task|mission|intent|action)\./.test(snapshot.invocation.toolId) && !fileReceiptTools.has(snapshot.invocation.toolId)) throw new Error('Evaluation receipt source freshness is not integrated')
      if (snapshot.workspaceAnchor?.changeHash !== value.environmentVersion) throw new Error('Evaluation receipt environment anchor is stale')
      assertFileFreshness(snapshot, root, binding.tenantId, filesystemPolicy)
      return plain({ evidence: value, receipt: snapshot, verification, integrity })
    })
  }
  const terminal = (store: Store, key: string, request: string) => {
    const old = store.events({ kind: resultKind }).map(event => event.payload as any).find(value => owns(value) && value.key === key)
    if (!old) return
    if (old.request !== request) throw new Error('Idempotency key already used for a different governance command')
    return { ...plain(old.result), replayed: true }
  }
  const schema = { type: 'object', additionalProperties: false, required: ['command', 'expectedHead', 'idempotencyKey'], properties: {
    expectedHead: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
    command: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['operation', 'profile'], properties: { operation: { const: 'profession.register' }, profile: { type: 'object', additionalProperties: false, required: ['id', 'name', 'version', 'permissionScope', 'deniedCapabilityIds'], properties: { id: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, summary: { type: 'string' }, permissionScope: { type: 'object' }, deniedCapabilityIds: { type: 'array', items: { type: 'string' } }, requirements: { type: 'object' } } } } },
      { type: 'object', additionalProperties: false, required: ['operation', 'profileId', 'evaluationId', 'evidenceIds'], properties: { operation: { enum: ['profession.certify', 'profession.recertify'] }, profileId: { type: 'string' }, evaluationId: { type: 'string' }, evidenceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string' } } } },
      { type: 'object', additionalProperties: false, required: ['operation', 'registration'], properties: { operation: { const: 'capability.register' }, registration: { type: 'object', additionalProperties: false, required: ['capabilityId', 'version', 'kind'], properties: { capabilityId: { type: 'string' }, version: { type: 'string' }, kind: { enum: ['tool', 'skill', 'protocol', 'cognition'] }, references: { type: 'object' }, reason: { type: 'string' } } } } },
      { type: 'object', additionalProperties: false, required: ['operation', 'capabilityId', 'version', 'next'], properties: { operation: { const: 'capability.transition' }, capabilityId: { type: 'string' }, version: { type: 'string' }, next: { type: 'string' }, reason: { type: 'string', maxLength: 2000 } } },
    ] },
  } }
  return [{ name: 'attention_manifest_protocol_governance', description: 'Read native profession/capability registry state and durable governance requests. Host extension; it grants no canonical model mutation authority. Behavior publishing is not connected.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['describe', 'list'] } } },
    async handler(input) {
      assertModelParameters(input); exact(input, ['action'])
      if (input.action !== undefined && !['describe', 'list'].includes(String(input.action))) throw new Error('Unknown governance read action')
      const { store } = openNativeStore(workspace)
      try { const restored = restore(store); return plain({ ...identity, version: restored.version, head: restored.head, professions: restored.state.professions.list(), capabilities: restored.state.capabilities.list(), certification: evaluate ? 'host_evaluator_connected' : 'unsupported_without_host_evaluator', behavior: 'not_connected', requests: store.events({ kind: pendingKind }).map(event => event.payload as any).filter(owns), reviews: store.events({ kind: resultKind }).map(event => event.payload as any).filter(owns) }) } finally { store.close() }
    },
  }, { name: 'attention_manifest_protocol_governance_review', description: 'Request independent host approval for one immutable native profession/capability command at the exact registry head. Persists decisions, rejects stale heads, and replays retries once. Certification needs a host-injected evaluator and current stored evidence; model scores/approval/registration state are forbidden.', annotations: { readOnlyHint: false }, inputSchema: schema,
    async handler(input) {
      assertModelParameters(input)
      const args = plain(input) as any
      exact(args, ['command', 'expectedHead', 'idempotencyKey'])
      if (!text(args.idempotencyKey) || typeof args.expectedHead !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.expectedHead)) throw new Error('Exact expectedHead and idempotencyKey required')
      // Keep the original request commitment separate from normalized registration defaults.
      const request = nativeRequest(args), command = plain(args.command) as Command
      validate(command)
      const key = digest({ ...identity, idempotencyKey: args.idempotencyKey })
      const opened = openNativeStore(workspace), root = opened.root
      let pending: any, approved = false, resumed = false
      try {
        const old = terminal(opened.store, key, request); if (old) return old
        pending = opened.store.events({ kind: pendingKind }).map(event => plain(event.payload as any)).find(value => owns(value) && value.key === key)
        if (pending) {
          if (pending.request !== request) throw new Error('Idempotency key already used for a different governance command')
          const decision = opened.store.events({ kind: decisionKind }).map(event => event.payload as any).find(value => owns(value) && value.reviewId === pending.reviewId)
          if (!decision) throw new Error('Governance review unresolved; host reconciliation required, approval is not requested again')
          if (decision.key !== pending.key || decision.request !== pending.request) throw new Error('Governance host decision does not match the pending review')
          // Only a literal boolean approval can authorize the commit.
          approved = decision.approved === true; resumed = true
        } else {
          const current = restore(opened.store)
          if (current.head !== args.expectedHead) throw new Error('Governance head changed; read before review')
          const reviews = opened.store.events({ kind: resultKind }).map(event => event.payload as any).filter(owns)
          const unresolved = opened.store.events({ kind: pendingKind }).map(event => event.payload as any).filter(owns).find(value => value.head === current.head && !reviews.some(review => review.result?.reviewId === value.reviewId))
          if (unresolved) throw new Error('Governance head already has an unresolved review; retry its original key or reconcile with the host')
          if ((command.operation === 'profession.certify' || command.operation === 'profession.recertify') && !evaluate) throw new Error('Profession certification unsupported without a trusted host evaluator')
          const citations = evidence(opened.store, root, command)
          let evaluation: ProfessionEvaluation | undefined
          if (command.operation === 'profession.certify' || command.operation === 'profession.recertify') {
            if (!evaluate) throw new Error('Profession certification unsupported without a trusted host evaluator')
            const profile = current.state.professions.get(command.profileId!)
            if (!profile) throw new Error('Unknown profession profile')
            evaluation = plain(evaluate(freeze({ evaluationId: command.evaluationId!, profile: plain(profile), evidence: plain(citations) })))
            if (evaluation.evaluationId !== command.evaluationId) throw new Error('Host evaluation ID does not match requested evaluation')
          }
          const at = new Date().toISOString(); current.setClock(at)
          const preview = plain(apply(current.state, command, evaluation))
          pending = { ...identity, key, request, root, reviewId: randomUUID(), command, evaluation: evaluation ?? null, at, head: current.head, citations, preview }
          opened.store.appendEvent(pendingKind, pending)
        }
      } finally { opened.store.close() }
      freeze(pending)
      if (!resumed) {
        approved = await requestHostApproval('native-governance:' + pending.reviewId, pending.command.operation, plain({ reviewId: pending.reviewId, workspace: root, ...identity, expectedHead: pending.head, command: pending.command, citations: pending.citations, evaluation: pending.evaluation, exactResult: pending.preview }))
        const audit = openNativeStore(() => root).store
        try { audit.appendEvent(decisionKind, { ...identity, reviewId: pending.reviewId, key, request, approved }) } finally { audit.close() }
      }
      const { store } = openNativeStore(() => root)
      try { return store.transaction(() => {
        const old = terminal(store, key, request); if (old) return old
        let sameWorkspace = false
        try { const selected = openNativeStore(workspace); try { sameWorkspace = selected.root === root } finally { selected.store.close() } } catch { sameWorkspace = false }
        // A corrupt journal must reject the commit; it cannot masquerade as a stale approval.
        const current = restore(store)
        let valid = false
        if (sameWorkspace && current.head === pending.head) {
          try { valid = nativeRequest(evidence(store, root, command)) === nativeRequest(pending.citations) } catch { valid = false }
        }
        let result: any = { reviewId: pending.reviewId, approved, changed: false, status: approved ? 'stale_after_approval' : 'rejected' }
        if (approved && valid && current) {
          current.setClock(pending.at)
          const changed = plain(apply(current.state, pending.command, pending.evaluation ?? undefined))
          if (nativeRequest(changed) !== nativeRequest(pending.preview)) throw new Error('Native command result changed after approval')
          const event = { ...identity, sequence: current.version + 1, previous: current.head, command: pending.command, evaluation: pending.evaluation, at: pending.at, result: changed, reviewId: pending.reviewId }
          store.appendEvent(eventKind, event)
          result = { ...result, status: 'applied', changed: true, result: changed, head: digest([...current.events, event]), version: current.version + 1 }
        }
        store.appendEvent(resultKind, { ...identity, key, request, result })
        return result
      }) } finally { store.close() }
    },
  }]
}
