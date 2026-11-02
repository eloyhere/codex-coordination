/**
 * Goals: the observable outcomes a coordination ledger tracks.
 *
 * A goal is stored as two objects, because AMP separates them:
 *
 * - `artifact` is a strict AMP `Goal` (`amp`, `kind`, `id`, `statement`,
 *   `success[]`, `value`, `priority`, optional `horizon`/`deadline`) and is the
 *   only part that enters the chain or is returned as a goal;
 * - `lifecycle` mirrors AMP's `GoalLifecycle` (`state`, `startedAt`,
 *   `achievedAt`), which the protocol keeps outside the artifact on purpose: a
 *   goal object says what outcome was promised, not how far along it is.
 *
 * The server enforces the *structure* of a transition, never the truth of it.
 * Marking a goal `achieved` records the caller's assertion that the checks were
 * run and passed; it cannot run them. That distinction is deliberate and is
 * repeated in the skills so a model does not mistake a recorded assertion for
 * independent proof.
 *
 * @module codex-coordination/goals
 */

import {
  AMP_VERSION,
  ERROR_CODES,
  fail,
  isRecord,
  normaliseCriterion,
  nowIso,
  requireEnum,
  requireExactKeys,
  requireId,
  requireInteger,
  requireNumber,
  requireRecord,
  requireString,
  requireTimestamp,
} from './amp.mjs'
import { requireRecordId } from './store.mjs'

/** The five lifecycle states, in narrative order. */
export const GOAL_STATES = Object.freeze(['proposed', 'committed', 'active', 'achieved', 'abandoned'])

/** States after which no further transition is accepted. */
export const TERMINAL_GOAL_STATES = Object.freeze(['achieved', 'abandoned'])

/** The only legal edges; every other move is `INVALID_STATE`. */
export const GOAL_EDGES = Object.freeze({
  proposed: Object.freeze(['committed', 'abandoned']),
  committed: Object.freeze(['active', 'abandoned']),
  active: Object.freeze(['achieved', 'abandoned']),
  achieved: Object.freeze([]),
  abandoned: Object.freeze([]),
})

/** Planning horizon of the outcome. */
export const GOAL_HORIZONS = Object.freeze(['task', 'session', 'long'])

/** Maximum success criteria in one goal. */
export const MAX_SUCCESS_CRITERIA = 32

/** Plan states that satisfy an `achieved` goal. */
const SETTLED_PLAN_STATES = Object.freeze(['done', 'abandoned'])

/**
 * Validate the caller-supplied part of a goal and return the strict AMP artifact.
 *
 * Accepted fields are exactly the Goal schema's; `amp` and `kind` may be omitted
 * and are then written, but a supplied value must already be correct.
 *
 * @param {unknown} input - the raw `goal` argument.
 * @returns {Record<string, any>} the AMP Goal artifact.
 */
export function normaliseGoalArtifact(input) {
  const record = requireRecord(input, 'goal')
  requireExactKeys(
    record,
    ['amp', 'kind', 'id', 'statement', 'success', 'value', 'priority', 'horizon', 'deadline'],
    ['id', 'statement', 'success', 'value'],
    'goal',
  )
  if (record.amp !== undefined && record.amp !== AMP_VERSION) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `goal.amp must be "${AMP_VERSION}"`, { field: 'goal.amp' })
  }
  if (record.kind !== undefined && record.kind !== 'goal') {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'goal.kind must be "goal"', { field: 'goal.kind' })
  }
  if (!Array.isArray(record.success) || record.success.length === 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'goal.success must contain at least one success criterion', { field: 'goal.success' })
  }
  if (record.success.length > MAX_SUCCESS_CRITERIA) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `goal.success may contain at most ${MAX_SUCCESS_CRITERIA} criteria`, { field: 'goal.success' })
  }
  const success = record.success.map((criterion, index) => normaliseCriterion(criterion, `success[${index}]`))
  const seen = new Set()
  for (const criterion of success) {
    if (seen.has(criterion.id)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `goal.success repeats id ${criterion.id}`, { field: 'goal.success' })
    }
    seen.add(criterion.id)
  }
  return {
    amp: AMP_VERSION,
    kind: 'goal',
    id: requireId(record.id, 'goal.id'),
    statement: requireString(record.statement, 'goal.statement', { max: 2048 }),
    success,
    value: requireNumber(record.value, 0, 1, 'goal.value'),
    priority: record.priority === undefined ? 0 : requireInteger(record.priority, 0, Number.MAX_SAFE_INTEGER, 'goal.priority'),
    ...(record.horizon === undefined ? {} : { horizon: requireEnum(record.horizon, GOAL_HORIZONS, 'goal.horizon') }),
    ...(record.deadline === undefined ? {} : { deadline: requireTimestamp(record.deadline, 'goal.deadline') }),
  }
}

/**
 * Create one goal in `proposed`.
 *
 * The chain gets one `goal` entry carrying the artifact; later transitions are
 * `event` entries, because the artifact itself does not change when the
 * lifecycle advances.
 *
 * @param {{ state: Record<string, any>, append: Function }} context - transaction context.
 * @param {unknown} input - the raw `goal` argument.
 * @returns {Record<string, any>} the stored record.
 */
export function createGoal(context, input) {
  const artifact = normaliseGoalArtifact(input)
  if (isRecord(context.state.goals[artifact.id])) {
    fail(ERROR_CODES.CONFLICT, `goal ${artifact.id} already exists`, { id: artifact.id })
  }
  const at = nowIso()
  const record = {
    artifact,
    lifecycle: { state: 'proposed' },
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'proposed' }],
  }
  context.state.goals[artifact.id] = record
  context.append('goal', artifact)
  return record
}

/**
 * Read one goal record.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} id - goal id.
 * @returns {Record<string, any>} a defensive clone of the stored record.
 */
export function getGoal(state, id) {
  const key = requireRecordId(state.goals, id, 'goal')
  return JSON.parse(JSON.stringify(state.goals[key]))
}

/**
 * Plans whose `goal` reference is `id`.
 * @param {Record<string, any>} state - the ledger.
 * @param {string} id - goal id.
 * @returns {Array<Record<string, any>>} matching plan records.
 */
export function linkedPlans(state, id) {
  return Object.values(state.plans).filter((record) => {
    const artifact = isRecord(record) ? record.artifact : undefined
    return isRecord(artifact) && isRecord(artifact.goal) && artifact.goal.id === id
  })
}

/**
 * List goals with optional filters.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ state?: string, horizon?: string, limit?: number }} [query] - filters.
 * @returns {Array<Record<string, any>>} oldest-first, filtered summaries.
 */
export function listGoals(state, query = {}) {
  const limit = query.limit ?? 50
  return Object.values(state.goals)
    .filter((record) => isRecord(record) && isRecord(record.artifact))
    .filter((record) => (query.state === undefined ? true : record.lifecycle?.state === query.state))
    .filter((record) => (query.horizon === undefined ? true : record.artifact.horizon === query.horizon))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((record) => goalSummary(state, record))
}

/**
 * Move a goal along one legal edge.
 *
 * `achieved` additionally requires every plan linked to the goal to be settled
 * (`done` or `abandoned`). The check is structural: it proves the caller finished
 * its own bookkeeping, not that the outcome is true.
 *
 * @param {{ state: Record<string, any>, append: Function }} context - transaction context.
 * @param {unknown} id - goal id.
 * @param {unknown} next - target state.
 * @param {unknown} [note] - optional explanation stored in the history.
 * @returns {Record<string, any>} the updated record.
 */
export function transitionGoal(context, id, next, note) {
  const key = requireRecordId(context.state.goals, id, 'goal')
  const record = context.state.goals[key]
  if (!isRecord(record) || !isRecord(record.artifact) || !isRecord(record.lifecycle)) {
    fail(ERROR_CODES.INVALID_STATE, `goal ${key} is not a stored goal record`, { id: key })
  }
  if (!Array.isArray(record.history)) {
    fail(ERROR_CODES.INVALID_STATE, `goal ${key} has no history array; run coordination_check`, { id: key })
  }
  const target = requireEnum(next, GOAL_STATES, 'state')
  const from = record.lifecycle.state
  const allowed = GOAL_EDGES[from] ?? []
  if (!allowed.includes(target)) {
    fail(ERROR_CODES.INVALID_STATE, `goal ${key} cannot move from ${from} to ${target}`, {
      id: key,
      from,
      to: target,
      allowed,
    })
  }
  if (target === 'achieved') {
    const unfinished = linkedPlans(context.state, key)
      .filter((plan) => !SETTLED_PLAN_STATES.includes(plan.artifact.status))
    if (unfinished.length > 0) {
      fail(ERROR_CODES.INVALID_STATE, `goal ${key} still has unfinished plans`, {
        id: key,
        plans: unfinished.map((plan) => ({ id: plan.artifact.id, status: plan.artifact.status })),
      })
    }
  }
  const text = note === undefined || note === null ? undefined : requireString(note, 'note', { max: 2048 })
  const at = nowIso()
  record.lifecycle.state = target
  if (target === 'active' && record.lifecycle.startedAt === undefined) record.lifecycle.startedAt = at
  if (target === 'achieved') record.lifecycle.achievedAt = at
  record.updatedAt = at
  record.history.push({ at, from, to: target, ...(text === undefined ? {} : { note: text }) })
  context.append('event', {
    type: 'goal.transitioned',
    goal: key,
    from,
    to: target,
    ...(text === undefined ? {} : { note: text }),
  })
  return record
}

/**
 * Compact projection used by list and status views.
 * @param {Record<string, any>} state - the ledger.
 * @param {Record<string, any>} record - one goal record.
 * @returns {Record<string, any>} the summary.
 */
export function goalSummary(state, record) {
  const artifact = record.artifact
  const plans = linkedPlans(state, artifact.id)
  const next = GOAL_EDGES[record.lifecycle.state] ?? []
  return {
    id: artifact.id,
    statement: artifact.statement,
    state: record.lifecycle.state,
    value: artifact.value,
    priority: artifact.priority,
    ...(artifact.horizon === undefined ? {} : { horizon: artifact.horizon }),
    success: artifact.success.length,
    plans: plans.length,
    planStates: plans.map((plan) => `${plan.artifact.id}:${plan.artifact.status}`),
    ...(next.length === 0 ? {} : { allowedTransitions: [...next] }),
  }
}

/**
 * The tool-facing view: the artifact, the lifecycle and the host history.
 *
 * Keeping `goal` exactly the AMP artifact means a consumer can validate it
 * without stripping host fields first.
 *
 * @param {Record<string, any>} record - one goal record.
 * @returns {{ goal: Record<string, any>, lifecycle: Record<string, any>, createdAt: string, updatedAt: string, history: Array<Record<string, any>> }} the view.
 */
export function goalView(record) {
  return {
    goal: JSON.parse(JSON.stringify(record.artifact)),
    lifecycle: JSON.parse(JSON.stringify(record.lifecycle)),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    history: JSON.parse(JSON.stringify(Array.isArray(record.history) ? record.history : [])),
  }
}
