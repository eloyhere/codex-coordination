/**
 * Read-only L3 attention routing preview (host extension, not canonical AMP).
 *
 * The canonical `attention` surface exposes `get` and `context` only. This host
 * extension derives the nine-stage attention stage from durable workflow facts
 * and asks the native `AttentionScheduler` to rank persisted attention for the
 * host-selected workflow scope into the current stage focus. Routing is
 * advisory: nothing is mounted, retained, persisted or authorized, and no
 * source is fetched. It deliberately has no mount/switch/suppress verbs.
 */
import { AttentionScheduler, isStageTransitionAllowed } from 'attention-manifest-protocol/attention'
import type { AttentionObject, AttentionStage, AttentionStageSignals } from 'attention-manifest-protocol/attention'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore } from './native-store.mjs'
import type { WorkflowScopeCallback } from './workflow.mjs'

const NAME = 'attention_manifest_protocol_attention_schedule'
const STAGES: readonly AttentionStage[] = ['receive', 'parse', 'strategy', 'plan', 'tactics', 'execute', 'verify', 'diagnose', 'respond']
const MAX_SELECTED = 50
const MAX_BYTES = 32768
/** One scheduling pass validates every in-scope candidate, so cap the input set. */
const MAX_CANDIDATES = 1000
const DELIVERY = 'read-only routing preview; no mount, retention, persistence or hidden context injection'
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Projects durable workflow facts onto the scheduler's stage signals.
 *
 * Every value comes from a persisted native entity in the selected session;
 * model claims and Codex observations are not consulted. A missing fact is
 * simply absent, which lets `detectStage` fall back to the least specific
 * active stage instead of inventing progress.
 */
function signalsFrom(workflow: WorkflowStore, selected: string): AttentionStageSignals {
  const session = workflow.get('session', selected)
  const mission = workflow.list('mission', selected).find(item => !['achieved', 'abandoned', 'failed'].includes(item.state))
  const goals = workflow.list('goal', selected).filter(item => item.state === 'active' && item.validity !== 'invalidated')
  const plans = workflow.list('plan', selected).filter(item => ['approved', 'ready', 'executing', 'running'].includes(item.state))
  const tasks = workflow.list('task', selected)
  const ready = tasks.filter(item => item.state === 'ready' && item.dependsOn.every(id => ['completed', 'succeeded', 'skipped'].includes(workflow.get('task', id).state)))
  const active = tasks.filter(item => item.state === 'active')
  const actions = workflow.list('action', selected)
  const running = actions.find(item => ['ready', 'running', 'active'].includes(item.state) && workflow.get('task', item.taskId).state === 'active')
  const failed = actions.find(item => ['unknown_outcome', 'failed', 'dead_letter'].includes(item.state))
  const pendingVerification = active.length > 0 && actions.length > 0 && !running && !failed
  return {
    inputReceived: session.state === 'active' || session.state === 'idle',
    intentCandidates: workflow.list('intent', selected).filter(item => ['captured', 'confirmed', 'accepted'].includes(item.state)).map(item => item.id).slice(0, 20),
    ...(mission ? { missionId: mission.id } : {}),
    ...(goals.length ? { goalIds: goals.map(item => item.id).slice(0, 20) } : {}),
    ...(plans.length ? { planId: plans[0].id } : {}),
    ...(ready.length ? { readyTaskIds: ready.map(item => item.id).slice(0, 20) } : {}),
    ...(running ? { actionId: running.id } : {}),
    ...(pendingVerification ? { verificationPending: true } : {}),
    ...(failed ? { failure: { unitId: failed.id, category: 'action_outcome' } } : {}),
  }
}

/**
 * Builds the read-only `attention_schedule` host extension.
 *
 * `scope(root, store)` is the host's selection resolver: it must follow the
 * same imported-first/live-thread precedence as the canonical workflow reads.
 * The already-open Store is supplied so a live scope never opens a second
 * SQLite connection; a missing selection is an error, never a silent fallback.
 */
export function attentionScheduleBinding(binding: AgentBinding, workspace: () => unknown, scope: WorkflowScopeCallback): ToolDefinition {
  return {
    name: NAME,
    description: 'Host extension, not canonical AMP. Read-only L3 routing preview: derive the nine-stage attention stage from durable workflow facts (session, mission, goals, plans, tasks, actions and the current Turn), then let the native scheduler rank scoped attention objects into the current stage focus, deferred and suppressed sets. It never mounts, persists, changes retention, fetches sources or grants authorization; the decision log is advisory.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stage: { enum: [...STAGES] },
        maxSelected: { type: 'integer', minimum: 1, maximum: MAX_SELECTED },
        maxBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(input) {
      // Host-bound identity is never a model parameter; reject it at any depth
      // before arguments are interpreted or a Store is opened.
      assertModelParameters(input)
      const allowed = ['stage', 'maxSelected', 'maxBytes']
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown attention schedule parameter')
      const requested = input.stage
      if (requested !== undefined && (typeof requested !== 'string' || !STAGES.includes(requested as AttentionStage))) throw new Error('Unknown attention stage')
      const maxSelected = input.maxSelected ?? 20
      if (typeof maxSelected !== 'number' || !Number.isSafeInteger(maxSelected) || maxSelected < 1 || maxSelected > MAX_SELECTED) throw new Error(`maxSelected must be 1-${MAX_SELECTED}`)
      const maxBytes = input.maxBytes ?? MAX_BYTES
      if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error(`maxBytes must be 1-${MAX_BYTES}`)
      const opened = openNativeStore(workspace)
      try {
        // Resolve the host selection against the open Store: imported selection
        // wins, otherwise the observed live Codex thread is followed. There is no
        // fallback to the other origin and no model-supplied scope.
        const selected = scope(opened.root, opened.store)
        if (!selected) throw new Error('Select a native workflow before routing attention')
        const persistence = new WorkflowPersistence({ store: opened.store, workflow: new WorkflowStore() })
        const restored = persistence.restoreAll()
        if (restored.skipped.length) throw new Error('Native workflow contains invalid facts: ' + restored.skipped.join(', '))
        const workflow = persistence.workflow
        const session = workflow.get('session', selected)
        if (!['active', 'idle'].includes(session.state)) throw new Error('Resume the selected workflow before routing attention')
        const turns = workflow.list('turn', selected).slice().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        if (!turns.length) throw new Error('Routing attention requires a durable turn in the selected workflow')
        const scopeValue = { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: selected, turnId: turns[0].id }
        const candidates = opened.store.list<AttentionObject>('attention')
          .filter(object => object.scope?.tenantId === binding.tenantId && object.scope?.principalId === binding.principalId && object.scope?.sessionId === selected)
          .map(object => plain(object))
        if (candidates.length > MAX_CANDIDATES) throw new Error(`Attention scope exceeds the scheduling candidate limit of ${MAX_CANDIDATES}`)
        const signals = signalsFrom(workflow, selected)
        const scheduler = new AttentionScheduler()
        const now = new Date().toISOString()
        // `calls` admits every candidate the budget allows inspecting; `bytes`
        // records the caller's payload bound. The scheduler never mounts.
        const route = scheduler.route({
          now,
          scope: scopeValue,
          budget: { calls: candidates.length + 1, bytes: maxBytes },
          reason: 'Read-only L3 preview over durable workflow signals',
          ...(requested === undefined ? {} : { stage: requested as AttentionStage }),
          signals,
          maxSelected,
        }, candidates)
        const current = route.previousStage ?? route.stage
        return plain({
          scope: scopeValue,
          stage: route.stage,
          previousStage: route.previousStage ?? null,
          profile: route.profile,
          signals,
          candidates: candidates.length,
          selected: route.selected.map(item => ({ id: item.id, summary: item.summary, pointer: item.pointer, score: item.score, reason: item.reason })),
          deferred: route.deferred.map(item => ({ id: item.id, reason: item.reason })),
          suppressed: route.suppressed.map(item => ({ id: item.id, reason: item.reason })),
          usage: route.usage,
          decision: route.decision,
          decisionLog: scheduler.decisionLog(),
          transitions: STAGES.filter(next => isStageTransitionAllowed(current, next)),
          authorization: 'not_granted',
          delivery: DELIVERY,
          limitations: [
            'Routing is advisory and read-only: no mount, persist, retention or suppression state changes.',
            'Signals derive from durable workflow facts, not model claims; a fresh scheduler has no persisted prior stage, so previousStage is null and transitions start from the detected stage.',
            'Selection is ranked by the native scheduler only; it grants no execution or business authority.',
          ],
        })
      } finally { opened.store.close() }
    },
  }
}
