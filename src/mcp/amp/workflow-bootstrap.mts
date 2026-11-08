/**
 * Host-approved Mission/Goal bootstrap for one live Codex thread.
 *
 * This is a host extension, not a canonical AMP verb. It consumes the live
 * Session/Intent the host already observed, creates the native Mission/Goal
 * chain under an independent, exact approval and never claims acceptance or
 * achievement. Plan and Task creation stay out of scope.
 */
import { randomUUID } from 'node:crypto'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { WorkflowKind } from 'attention-manifest-protocol/workflow'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import { nativeRequest, openNativeStore } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { resolveWorkflowScope } from './workflow.mjs'

const requestedKind = 'codex.amp.workflow.bootstrap_requested'
const decisionKind = 'codex.amp.workflow.bootstrap_host_decision'
const reviewedKind = 'codex.amp.workflow.bootstrap'
const HOST_ACTOR = 'mcp-host-bootstrap'
const ACTIONS = ['accept_intent', 'create_mission', 'activate_mission', 'create_goal', 'activate_goal'] as const
type BootstrapAction = (typeof ACTIONS)[number]
type BootstrapIds = { readonly targetId?: string; readonly intentId?: string; readonly missionId?: string; readonly goalId?: string }
interface BootstrapArgs {
  readonly action: BootstrapAction
  readonly idempotencyKey: string
  readonly expectedVersion: number
  readonly targetId?: string
  readonly intentId?: string
  readonly missionId?: string
  readonly contractVersion?: string
  readonly acceptanceCriteria?: readonly string[]
}
interface Prepared {
  readonly scope: string
  readonly threadId: string
  readonly head: string
  readonly ids: BootstrapIds
}
interface Applied {
  readonly status: string
  readonly changed: boolean
  readonly intent?: unknown
  readonly mission?: unknown
  readonly goal?: unknown
}

const FIELDS: Record<BootstrapAction, readonly string[]> = {
  accept_intent: ['targetId'],
  create_mission: ['intentId'],
  activate_mission: ['targetId'],
  create_goal: ['missionId', 'contractVersion', 'acceptanceCriteria'],
  activate_goal: ['targetId'],
}

const ACCEPT_REASON = 'Host-approved live workflow bootstrap: confirm and accept the observed Intent; this establishes no Goal achievement or Task completion'
const MISSION_CREATE_REASON = 'Host-approved live workflow bootstrap: create a proposed Mission from the accepted Intent'
const MISSION_ACTIVATE_REASON = 'Host-approved live workflow bootstrap: activate the proposed Mission; activation is a host decision, not achievement'
const GOAL_CREATE_REASON = 'Host-approved live workflow bootstrap: create a proposed Goal with verification-pending validity'
const GOAL_ACTIVATE_REASON = 'Host-approved live workflow bootstrap: activate the proposed Goal; activation is a host decision, not acceptance or achievement'

const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max

/** Normalize, freeze and validate the exact command before any Store is opened. */
function validate(input: Record<string, unknown>): BootstrapArgs {
  assertModelParameters(input)
  const value = JSON.parse(nativeRequest(input)) as Record<string, unknown>
  if (typeof value.action !== 'string' || !(ACTIONS as readonly string[]).includes(value.action)) throw new Error('Unknown workflow bootstrap action')
  const action = value.action as BootstrapAction
  const allowed = new Set(['action', 'idempotencyKey', 'expectedVersion', ...FIELDS[action]])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Workflow bootstrap ${action} does not accept parameter ${key}`)
  if (!text(value.idempotencyKey, 200)) throw new Error('A stable idempotencyKey of at most 200 characters is required')
  if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0) throw new Error('expectedVersion must be a nonnegative safe integer')
  for (const key of FIELDS[action]) {
    if (key === 'acceptanceCriteria') continue
    if (!text(value[key], 200)) throw new Error(`${key} is required and must be a nonempty string of at most 200 characters`)
  }
  if (action === 'create_goal') {
    const criteria = value.acceptanceCriteria
    if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 20) throw new Error('acceptanceCriteria must contain 1-20 nonempty criteria')
    if (!criteria.every(item => text(item, 2000))) throw new Error('Each acceptance criterion must be a nonempty string of at most 2000 characters')
    return Object.freeze({ ...value, action, acceptanceCriteria: Object.freeze(criteria.slice()) } as unknown as BootstrapArgs)
  }
  return Object.freeze({ ...value, action } as unknown as BootstrapArgs)
}

/**
 * Resolves the selected live scope and proves the exact native command on a
 * disposable restored snapshot. Nothing durable is written here.
 */
function prepare(store: Store, root: string, args: BootstrapArgs, selected: Map<string, string>, threadForRoot?: (root: string) => string | undefined): Prepared {
  const resolution = resolveWorkflowScope(store, root, selected, threadForRoot)
  if (resolution.origin !== 'codex-live' || !resolution.threadId) throw new Error('Workflow bootstrap requires a live Codex thread; an imported workflow snapshot is selected for this workspace. Select an observed live thread with attention_manifest_protocol_session.get.')
  const scope = resolution.scope, threadId = resolution.threadId
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  const report = persistence.restoreAll()
  if (report.skipped.length) throw new Error('Native workflow contains invalid facts: ' + report.skipped.join(', '))
  const workflow = persistence.workflow
  const session = workflow.get('session', scope)
  if (!['active', 'idle'].includes(session.state)) throw new Error('Workflow bootstrap requires an active or idle live native session')
  const head = nativeRequest(workflow.snapshot())
  const candidate = WorkflowStore.restore(workflow.snapshot())
  const owned = <K extends WorkflowKind>(kind: K, id: string | undefined) => {
    if (!id) throw new Error(`${kind} id is required`)
    const entity = candidate.get(kind, id)
    if (entity.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
    return entity
  }
  let ids: BootstrapIds
  switch (args.action) {
    case 'accept_intent': {
      const intent = owned('intent', args.targetId)
      if (!['captured', 'confirmed', 'accepted'].includes(intent.state)) throw new Error(`Intent state ${intent.state} cannot be accepted by workflow bootstrap; only captured or confirmed Intents (or an already accepted no-op) are eligible`)
      if (intent.version !== args.expectedVersion) throw new Error(`Intent version changed: expected ${args.expectedVersion}, current ${intent.version}`)
      if (intent.state !== 'accepted') {
        let next = intent
        if (next.state === 'captured') next = candidate.transition('intent', intent.id, 'confirmed', { expectedVersion: next.version, actor: HOST_ACTOR, reason: ACCEPT_REASON })
        candidate.transition('intent', intent.id, 'accepted', { expectedVersion: next.version, actor: HOST_ACTOR, reason: ACCEPT_REASON })
      }
      ids = { targetId: intent.id }
      break
    }
    case 'create_mission': {
      const intent = owned('intent', args.intentId)
      if (intent.state !== 'accepted') throw new Error('Workflow bootstrap requires an accepted Intent before creating a Mission')
      if (intent.version !== args.expectedVersion) throw new Error(`Intent version changed: expected ${args.expectedVersion}, current ${intent.version}`)
      if (candidate.list('mission', scope).some(item => item.intentId === intent.id)) throw new Error('Intent already has a Mission')
      const missionId = randomUUID()
      const mission = candidate.create('mission', { id: missionId, sessionId: scope, intentId: intent.id }, HOST_ACTOR)
      candidate.transition('mission', mission.id, 'proposed', { expectedVersion: mission.version, actor: HOST_ACTOR, reason: MISSION_CREATE_REASON })
      ids = { intentId: intent.id, missionId }
      break
    }
    case 'activate_mission': {
      const mission = owned('mission', args.targetId)
      if (mission.state !== 'proposed') throw new Error('Mission activation requires a proposed Mission')
      if (mission.version !== args.expectedVersion) throw new Error(`Mission version changed: expected ${args.expectedVersion}, current ${mission.version}`)
      candidate.transition('mission', mission.id, 'active', { expectedVersion: mission.version, actor: HOST_ACTOR, reason: MISSION_ACTIVATE_REASON })
      ids = { targetId: mission.id }
      break
    }
    case 'create_goal': {
      const mission = owned('mission', args.missionId)
      if (mission.state !== 'active') throw new Error('Goal creation requires an active Mission')
      if (mission.version !== args.expectedVersion) throw new Error(`Mission version changed: expected ${args.expectedVersion}, current ${mission.version}`)
      const goalId = randomUUID()
      const goal = candidate.create('goal', { id: goalId, sessionId: scope, missionId: mission.id, contractVersion: args.contractVersion!, acceptanceCriteria: args.acceptanceCriteria! }, HOST_ACTOR)
      candidate.transition('goal', goal.id, 'proposed', { expectedVersion: goal.version, actor: HOST_ACTOR, reason: GOAL_CREATE_REASON })
      ids = { missionId: mission.id, goalId }
      break
    }
    case 'activate_goal': {
      const goal = owned('goal', args.targetId)
      if (goal.state !== 'proposed') throw new Error('Goal activation requires a proposed Goal')
      if (goal.version !== args.expectedVersion) throw new Error(`Goal version changed: expected ${args.expectedVersion}, current ${goal.version}`)
      candidate.transition('goal', goal.id, 'active', { expectedVersion: goal.version, actor: HOST_ACTOR, reason: GOAL_ACTIVATE_REASON })
      ids = { targetId: goal.id }
      break
    }
    default: throw new Error('Unknown workflow bootstrap action')
  }
  return { scope, threadId, head, ids: Object.freeze(ids) }
}

/** Applies the already-approved command through the native persistence writer. */
function apply(persistence: WorkflowPersistence, args: BootstrapArgs, ids: BootstrapIds, scope: string): Applied {
  const workflow = persistence.workflow
  switch (args.action) {
    case 'accept_intent': {
      const intent = workflow.get('intent', ids.targetId!)
      if (intent.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
      if (intent.state === 'accepted') return { status: 'already_accepted', changed: false, intent }
      if (!['captured', 'confirmed'].includes(intent.state)) throw new Error('Only a captured or confirmed Intent can be accepted')
      if (intent.version !== args.expectedVersion) throw new Error('Intent version changed after approval')
      let next = intent
      if (next.state === 'captured') next = persistence.transition('intent', intent.id, 'confirmed', { expectedVersion: next.version, actor: HOST_ACTOR, reason: ACCEPT_REASON })
      const accepted = persistence.transition('intent', intent.id, 'accepted', { expectedVersion: next.version, actor: HOST_ACTOR, reason: ACCEPT_REASON })
      return { status: 'intent_accepted', changed: true, intent: accepted }
    }
    case 'create_mission': {
      const intent = workflow.get('intent', ids.intentId!)
      if (intent.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
      if (intent.state !== 'accepted') throw new Error('Mission creation requires an accepted Intent')
      if (intent.version !== args.expectedVersion) throw new Error('Intent version changed after approval')
      const mission = persistence.create('mission', { id: ids.missionId!, sessionId: scope, intentId: intent.id }, HOST_ACTOR)
      return { status: 'mission_proposed', changed: true, mission: persistence.transition('mission', mission.id, 'proposed', { expectedVersion: mission.version, actor: HOST_ACTOR, reason: MISSION_CREATE_REASON }) }
    }
    case 'activate_mission': {
      const mission = workflow.get('mission', ids.targetId!)
      if (mission.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
      if (mission.state !== 'proposed' || mission.version !== args.expectedVersion) throw new Error('Mission is not a proposed Mission at the reviewed version')
      return { status: 'mission_active', changed: true, mission: persistence.transition('mission', mission.id, 'active', { expectedVersion: mission.version, actor: HOST_ACTOR, reason: MISSION_ACTIVATE_REASON }) }
    }
    case 'create_goal': {
      const mission = workflow.get('mission', ids.missionId!)
      if (mission.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
      if (mission.state !== 'active' || mission.version !== args.expectedVersion) throw new Error('Goal creation requires an active Mission at the reviewed version')
      const goal = persistence.create('goal', { id: ids.goalId!, sessionId: scope, missionId: mission.id, contractVersion: args.contractVersion!, acceptanceCriteria: args.acceptanceCriteria! }, HOST_ACTOR)
      return { status: 'goal_proposed', changed: true, goal: persistence.transition('goal', goal.id, 'proposed', { expectedVersion: goal.version, actor: HOST_ACTOR, reason: GOAL_CREATE_REASON }) }
    }
    case 'activate_goal': {
      const goal = workflow.get('goal', ids.targetId!)
      if (goal.sessionId !== scope) throw new Error('Target entity is outside the selected live thread')
      if (goal.state !== 'proposed' || goal.version !== args.expectedVersion) throw new Error('Goal is not a proposed Goal at the reviewed version')
      return { status: 'goal_active', changed: true, goal: persistence.transition('goal', goal.id, 'active', { expectedVersion: goal.version, actor: HOST_ACTOR, reason: GOAL_ACTIVATE_REASON }) }
    }
    default: throw new Error('Unknown workflow bootstrap action')
  }
}

export function bootstrapTool(binding: AgentBinding, workspace: () => unknown, selectedWorkflows: Map<string, string>, threadForRoot?: (root: string) => string | undefined): ToolDefinition {
  const terminal = (store: Store, key: string, request: string) => {
    const prior = store.events({ kind: reviewedKind }).map(event => event.payload as any).find(value => value.key === key)
    if (!prior) return undefined
    if (prior.request !== request) throw new Error('Idempotency key already used for another workflow bootstrap request')
    return { ...prior.result, replayed: true }
  }
  const requestedFor = (store: Store, key: string) => store.events({ kind: requestedKind }).map(event => event.payload as any).find(value => value.key === key)
  const decisionFor = (store: Store, reviewId: string, key: string, request: string) => store.events({ kind: decisionKind }).map(event => event.payload as any).find(value => value.reviewId === reviewId && value.key === key && value.request === request)
  return {
    name: 'attention_manifest_protocol_workflow_bootstrap',
    description: 'Host extension (not a canonical AMP verb): create and activate the native Mission/Goal chain for the selected live Codex thread under independent, exact host approval. The host may accept a captured/confirmed live Intent, create a proposed Mission from an accepted Intent, activate a proposed Mission, create a proposed Goal with 1-20 acceptance criteria and verification-pending validity, and activate a proposed Goal. It never supplies session/identity fields, never accepts or achieves a Goal, never marks a Mission achieved and never creates a Plan or Task. Every action is version-checked, scope-checked before and after approval, journaled for idempotent replay, and a changed workflow head returns stale_after_approval without changing state.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'idempotencyKey', 'expectedVersion'], properties: {
      action: { enum: [...ACTIONS] },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
      expectedVersion: { type: 'integer', minimum: 0 },
      targetId: { type: 'string', minLength: 1, maxLength: 200 },
      intentId: { type: 'string', minLength: 1, maxLength: 200 },
      missionId: { type: 'string', minLength: 1, maxLength: 200 },
      contractVersion: { type: 'string', minLength: 1, maxLength: 200 },
      acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } },
    } }, annotations: { readOnlyHint: false },
    async handler(input) {
      const args = validate(input)
      const opened = openNativeStore(workspace), root = opened.root
      const key = binding.principalId + ':' + args.idempotencyKey
      const request = nativeRequest(args)
      let scope = '', threadId = '', head = '', reviewId = ''
      let ids: BootstrapIds = {}
      let approved = false, resumed = false
      try {
        const replay = terminal(opened.store, key, request)
        if (replay) return replay
        const pending = requestedFor(opened.store, key)
        if (pending) {
          if (pending.request !== request) throw new Error('Idempotency key already used for another workflow bootstrap request')
          const decision = decisionFor(opened.store, pending.reviewId, key, request)
          if (!decision) throw new Error('Workflow bootstrap review is unresolved; host reconciliation is required, no repeated approval was requested')
          scope = pending.scope; threadId = pending.threadId; head = pending.head; ids = pending.ids; reviewId = pending.reviewId
          approved = decision.approved === true; resumed = true
        } else {
          const prepared = prepare(opened.store, root, args, selectedWorkflows, threadForRoot)
          scope = prepared.scope; threadId = prepared.threadId; head = prepared.head; ids = prepared.ids
          reviewId = randomUUID()
          opened.store.transaction(() => {
            if (terminal(opened.store, key, request)) throw new Error('Workflow bootstrap was committed concurrently; retry its original key')
            if (requestedFor(opened.store, key)) throw new Error('Workflow bootstrap review is unresolved; retry its original review key')
            opened.store.appendEvent(requestedKind, { reviewId, key, request, head, scope, threadId, action: args.action, args, ids, principalId: binding.principalId })
          })
        }
      } finally { opened.store.close() }
      if (!resumed) {
        // The approval payload is immutable and names the exact reviewed command,
        // including the host-generated ids, never a model-supplied identity.
        const payload = { reviewId, action: args.action, ids, expectedVersion: args.expectedVersion,
          ...(args.action === 'create_goal' ? { contractVersion: args.contractVersion, acceptanceCriteria: args.acceptanceCriteria } : {}),
          workspace: root, threadId }
        approved = await requestHostApproval('native-workflow-bootstrap:' + scope, args.action, payload)
        const audit = openNativeStore(() => root)
        try { audit.store.appendEvent(decisionKind, { reviewId, key, request, approved, principalId: binding.principalId }) } finally { audit.store.close() }
      }
      const current = openNativeStore(() => root)
      try {
        return current.store.transaction(() => {
          const replay = terminal(current.store, key, request)
          if (replay) return replay
          const base = { reviewId, action: args.action, ids, expectedVersion: args.expectedVersion, origin: 'codex-live' as const, scope, threadId,
            acceptanceGranted: false, achievementDeclared: false, planCreated: false, taskCreated: false }
          let result: Record<string, any>
          if (!approved) {
            result = { ...base, approved: false, changed: false, status: 'rejected' }
          } else {
            let persistence: WorkflowPersistence | undefined
            let valid = false
            try {
              const active = openNativeStore(workspace)
              try { valid = active.root === root } finally { active.store.close() }
              if (valid) {
                const resolution = resolveWorkflowScope(current.store, root, selectedWorkflows, threadForRoot)
                valid = resolution.origin === 'codex-live' && resolution.scope === scope && resolution.threadId === threadId
              }
              if (valid) {
                persistence = new WorkflowPersistence({ store: current.store, workflow: new WorkflowStore() })
                const report = persistence.restoreAll()
                valid = report.skipped.length === 0 && nativeRequest(persistence.workflow.snapshot()) === head
              }
            } catch { valid = false }
            if (!valid) {
              result = { ...base, approved: true, changed: false, status: 'stale_after_approval' }
            } else {
              const applied = apply(persistence!, args, ids, scope)
              result = { ...base, approved: true, changed: applied.changed, status: applied.status,
                ...(applied.intent === undefined ? {} : { intent: applied.intent }),
                ...(applied.mission === undefined ? {} : { mission: applied.mission }),
                ...(applied.goal === undefined ? {} : { goal: applied.goal }) }
            }
          }
          current.store.appendEvent(reviewedKind, { key, request, principalId: binding.principalId, action: args.action, scope, threadId, approved: result.approved, result })
          return result
        })
      } finally { current.store.close() }
    },
  }
}
