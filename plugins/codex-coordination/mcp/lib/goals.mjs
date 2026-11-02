/**
 * Goals: the observable outcomes a coordination ledger tracks.
 *
 * A goal is an AMP Goal object: a statement, at least one observable success
 * criterion with a non-empty `check`, a value in `[0, 1]`, a nonnegative
 * priority and a lifecycle that only moves along the edges declared by
 * {@link GOAL_EDGES}.
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
  CHECK_KINDS,
  ERROR_CODES,
  fail,
  isRecord,
  normaliseCheck,
  nowIso,
  requireEnum,
  requireId,
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

/** How a success criterion is observed. */
export const SUCCESS_KINDS = CHECK_KINDS

/** Planning horizon of the outcome. */
export const GOAL_HORIZONS = Object.freeze(['task', 'session', 'long'])

/** Plan states that satisfy an `achieved` goal. */
const SETTLED_PLAN_STATES = Object.freeze(['done', 'abandoned'])

/**
 * Validate the caller-supplied part of a goal.
 *
 * Unknown fields are ignored rather than echoed into the ledger, so a typo in a
 * field name cannot silently become durable protocol data.
 *
 * @param {unknown} input - the raw `goal` argument.
 * @returns {Record<string, any>} the normalised, not-yet-stored goal.
 */
export function normaliseGoalInput(input) {
  const record = requireRecord(input, 'goal')
  if (record.amp !== undefined && record.amp !== AMP_VERSION) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `goal.amp must be "${AMP_VERSION}"`, { field: 'goal.amp' })
  }
  if (record.kind !== undefined && record.kind !== 'goal') {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'goal.kind must be "goal"', { field: 'goal.kind' })
  }
  if (!Array.isArray(record.success) || record.success.length === 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'goal.success must contain at least one success criterion', { field: 'goal.success' })
  }
  const success = record.success.map((criterion, index) => normaliseCheck(criterion, `success[${index}]`))
  const seen = new Set()
  for (const criterion of success) {
    if (seen.has(criterion.id)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `goal.success repeats id ${criterion.id}`, { field: 'goal.success' })
    }
    seen.add(criterion.id)
  }
  const priority = record.priority === undefined ? 0 : record.priority
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'goal.priority must be a nonnegative integer', { field: 'goal.priority' })
  }
  return {
    amp: AMP_VERSION,
    kind: 'goal',
    id: requireId(record.id, 'goal.id'),
    statement: requireString(record.statement, 'goal.statement', { max: 2048 }),
    success,
    value: requireNumber(record.value, 0, 1, 'goal.value'),
    priority,
    ...(record.horizon === undefined ? {} : { horizon: requireEnum(record.horizon, GOAL_HORIZONS, 'goal.horizon') }),
    ...(record.deadline === undefined ? {} : { deadline: requireTimestamp(record.deadline, 'goal.deadline') }),
  }
}

/**
 * Create one goal in `proposed`.
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} input - the raw `goal` argument.
 * @returns {Record<string, any>} the stored goal.
 */
export function createGoal(context, input) {
  const goal = normaliseGoalInput(input)
  if (isRecord(context.state.goals[goal.id])) {
    fail(ERROR_CODES.CONFLICT, `goal ${goal.id} already exists`, { id: goal.id })
  }
  const at = nowIso()
  const stored = {
    ...goal,
    state: 'proposed',
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'proposed' }],
  }
  context.state.goals[goal.id] = stored
  context.record('goal/created', goal.id, { statement: goal.statement, success: goal.success.length })
  return stored
}

/**
 * Read one goal.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} id - goal id.
 * @returns {Record<string, any>} a defensive clone.
 */
export function getGoal(state, id) {
  const key = requireRecordId(state.goals, id, 'goal')
  return JSON.parse(JSON.stringify(state.goals[key]))
}

/**
 * List goals with optional filters.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ state?: string, horizon?: string, limit?: number }} [query] - filters.
 * @returns {Array<Record<string, any>>} newest-last, filtered clones.
 */
export function listGoals(state, query = {}) {
  const limit = query.limit ?? 50
  const goals = Object.values(state.goals)
    .filter((goal) => (query.state === undefined ? true : goal.state === query.state))
    .filter((goal) => (query.horizon === undefined ? true : goal.horizon === query.horizon))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
  return goals.map((goal) => ({
    id: goal.id,
    statement: goal.statement,
    state: goal.state,
    value: goal.value,
    priority: goal.priority,
    ...(goal.horizon === undefined ? {} : { horizon: goal.horizon }),
    success: goal.success.map((criterion) => criterion.id),
    updatedAt: goal.updatedAt,
  }))
}

/**
 * Plans whose `goal` reference is `id`.
 * @param {Record<string, any>} state - the ledger.
 * @param {string} id - goal id.
 * @returns {Array<Record<string, any>>} matching plan records.
 */
export function linkedPlans(state, id) {
  return Object.values(state.plans).filter((plan) => isRecord(plan.goal) && plan.goal.id === id)
}

/**
 * Move a goal along one legal edge.
 *
 * `achieved` additionally requires every plan linked to the goal to be
 * settled (`done` or `abandoned`). The check is structural: it proves the
 * caller finished its own bookkeeping, not that the outcome is true.
 *
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} id - goal id.
 * @param {unknown} next - target state.
 * @param {unknown} [note] - optional explanation stored in the history.
 * @returns {Record<string, any>} the updated goal.
 */
export function transitionGoal(context, id, next, note) {
  const key = requireRecordId(context.state.goals, id, 'goal')
  const goal = context.state.goals[key]
  const target = requireEnum(next, GOAL_STATES, 'state')
  const allowed = GOAL_EDGES[goal.state] ?? []
  if (!allowed.includes(target)) {
    fail(ERROR_CODES.INVALID_STATE, `goal ${key} cannot move from ${goal.state} to ${target}`, {
      id: key,
      from: goal.state,
      to: target,
      allowed,
    })
  }
  if (target === 'achieved') {
    const unfinished = linkedPlans(context.state, key).filter((plan) => !SETTLED_PLAN_STATES.includes(plan.status))
    if (unfinished.length > 0) {
      fail(ERROR_CODES.INVALID_STATE, `goal ${key} still has unfinished plans`, {
        id: key,
        plans: unfinished.map((plan) => ({ id: plan.id, status: plan.status })),
      })
    }
  }
  const text = note === undefined || note === null ? undefined : requireString(note, 'note', { max: 2048 })
  const at = nowIso()
  const from = goal.state
  goal.state = target
  goal.updatedAt = at
  goal.history.push({ at, from, to: target, ...(text === undefined ? {} : { note: text }) })
  context.record('goal/transition', key, { from, to: target, ...(text === undefined ? {} : { note: text }) })
  return goal
}

/**
 * Compact projection used by the status view.
 * @param {Record<string, any>} state - the ledger.
 * @param {Record<string, any>} goal - one goal.
 * @returns {Record<string, any>} the summary.
 */
export function goalSummary(state, goal) {
  const plans = linkedPlans(state, goal.id)
  const next = GOAL_EDGES[goal.state] ?? []
  return {
    id: goal.id,
    statement: goal.statement,
    state: goal.state,
    value: goal.value,
    priority: goal.priority,
    ...(goal.horizon === undefined ? {} : { horizon: goal.horizon }),
    success: goal.success.length,
    plans: plans.length,
    planStates: plans.map((plan) => `${plan.id}:${plan.status}`),
    ...(next.length === 0 ? {} : { allowedTransitions: [...next] }),
  }
}
