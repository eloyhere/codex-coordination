/**
 * Duties and handoffs: who owes what, and how the result is accepted.
 *
 * A duty is one accountable unit of work with a declared owner, a declared
 * assignee, concrete responsibilities and observable acceptance criteria. Its
 * lifecycle is `assigned → accepted → started → submitted → verified`, with
 * `rejected` sending work back to `accepted` and `cancelled` closing it early.
 *
 * Two deliberate limitations are recorded here rather than hidden:
 *
 * 1. Identity is *declared*, not authenticated. `actor` is compared against the
 *    recorded owner or assignee, which stops a caller from casually advancing
 *    someone else's duty but cannot prove who is calling. The trust boundary is
 *    the Codex session the server runs under.
 * 2. `verify` records the owner's review; it does not run the acceptance
 *    criteria. The result object therefore says so, and the skills repeat it.
 *
 * @module codex-coordination/collaboration
 */

import {
  AMP_VERSION,
  ERROR_CODES,
  fail,
  isRecord,
  nowIso,
  requireEnum,
  requireId,
  requireRecord,
  requireString,
  requireStringArray,
} from './amp.mjs'
import { requireRecordId } from './store.mjs'

/** Duty roles; metadata only, never a grant of authority. */
export const DUTY_ROLES = Object.freeze(['decision', 'outcome', 'resource', 'personnel', 'qualification', 'execution'])

/** Duty lifecycle states. */
export const DUTY_STATUSES = Object.freeze(['assigned', 'accepted', 'started', 'submitted', 'verified', 'rejected', 'cancelled'])

/** States after which no further transition is accepted. */
export const TERMINAL_DUTY_STATUSES = Object.freeze(['verified', 'cancelled'])

/** Actions accepted by the handoff tool. */
export const DUTY_ACTIONS = Object.freeze(['list', 'get', 'assign', 'accept', 'start', 'submit', 'verify', 'reject', 'cancel'])

/** The lifecycle edge table, shared by every transition path. */
export const DUTY_EDGES = Object.freeze({
  assigned: Object.freeze(['accepted', 'cancelled']),
  accepted: Object.freeze(['started', 'cancelled']),
  started: Object.freeze(['submitted', 'cancelled']),
  submitted: Object.freeze(['verified', 'rejected', 'cancelled']),
  rejected: Object.freeze(['accepted', 'cancelled']),
  verified: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** Which side of the handoff may perform each action. */
const ACTION_AUTHORITY = Object.freeze({
  accept: 'assignee',
  start: 'assignee',
  submit: 'assignee',
  verify: 'owner',
  reject: 'owner',
  cancel: 'owner',
})

/** Maximum evidence entries on one submission. */
export const MAX_EVIDENCE = 32

/**
 * Validate one reference (`goal`, `plan` or `plan` + `task`) against the ledger.
 * @param {Record<string, any>} state - the ledger.
 * @param {Record<string, unknown>} reference - raw reference object.
 * @param {string} label - path prefix used in error messages.
 * @returns {Record<string, any>} the clean reference.
 */
function normaliseReference(state, reference, label) {
  const record = requireRecord(reference, label)
  if (record.goal !== undefined) {
    const goal = requireId(record.goal, `${label}.goal`)
    if (!isRecord(state.goals[goal])) {
      fail(ERROR_CODES.NOT_FOUND, `${label}.goal ${goal} does not exist`, { goal })
    }
    return { kind: 'goal', id: goal }
  }
  if (record.plan !== undefined) {
    const planId = requireId(record.plan, `${label}.plan`)
    const plan = state.plans[planId]
    if (!isRecord(plan)) {
      fail(ERROR_CODES.NOT_FOUND, `${label}.plan ${planId} does not exist`, { plan: planId })
    }
    if (record.task === undefined) return { kind: 'plan', id: planId }
    const taskId = requireId(record.task, `${label}.task`)
    if (!plan.tasks.some((task) => task.id === taskId)) {
      fail(ERROR_CODES.NOT_FOUND, `${label}.task ${taskId} does not exist in plan ${planId}`, { plan: planId, task: taskId })
    }
    return { kind: 'task', plan: planId, id: taskId }
  }
  fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must name a goal, a plan, or a plan task`, { field: label })
}

/**
 * Validate the caller-supplied part of a duty.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} input - the raw `duty` argument.
 * @returns {Record<string, any>} the normalised, not-yet-stored duty.
 */
export function normaliseDutyInput(state, input) {
  const record = requireRecord(input, 'duty')
  if (record.amp !== undefined && record.amp !== AMP_VERSION) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `duty.amp must be "${AMP_VERSION}"`, { field: 'duty.amp' })
  }
  if (record.kind !== undefined && record.kind !== 'duty') {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'duty.kind must be "duty"', { field: 'duty.kind' })
  }
  const owner = requireString(record.owner, 'duty.owner', { max: 256 })
  const assignee = requireString(record.assignee, 'duty.assignee', { max: 256 })
  if (owner === assignee) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'duty.owner and duty.assignee must differ: a handoff needs two sides', {
      field: 'duty.assignee',
    })
  }
  const reference = record.goal !== undefined || record.plan !== undefined
    ? normaliseReference(state, record, 'duty')
    : undefined
  return {
    amp: AMP_VERSION,
    kind: 'duty',
    id: requireId(record.id, 'duty.id'),
    role: requireEnum(record.role, DUTY_ROLES, 'duty.role'),
    owner,
    assignee,
    responsibilities: requireStringArray(record.responsibilities, 'duty.responsibilities', { min: 1, max: 32, itemMax: 2048 }),
    acceptance: requireStringArray(record.acceptance, 'duty.acceptance', { min: 1, max: 32, itemMax: 2048 }),
    ...(reference === undefined ? {} : { reference }),
    status: 'assigned',
  }
}

/**
 * Create one duty in `assigned`.
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} input - the raw `duty` argument.
 * @returns {Record<string, any>} the stored duty.
 */
export function assignDuty(context, input) {
  const duty = normaliseDutyInput(context.state, input)
  if (isRecord(context.state.duties[duty.id])) {
    fail(ERROR_CODES.CONFLICT, `duty ${duty.id} already exists`, { id: duty.id })
  }
  const at = nowIso()
  const stored = {
    ...duty,
    summary: null,
    evidence: [],
    review: null,
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'assigned', actor: duty.owner }],
  }
  context.state.duties[duty.id] = stored
  context.record('duty/assigned', duty.id, {
    owner: duty.owner,
    assignee: duty.assignee,
    role: duty.role,
  })
  return stored
}

/**
 * Read one duty.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} id - duty id.
 * @returns {Record<string, any>} a defensive clone.
 */
export function getDuty(state, id) {
  const key = requireRecordId(state.duties, id, 'duty')
  return JSON.parse(JSON.stringify(state.duties[key]))
}

/**
 * List duties with optional filters.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ status?: string, owner?: string, assignee?: string, limit?: number }} [query] - filters.
 * @returns {Array<Record<string, any>>} compact projections.
 */
export function listDuties(state, query = {}) {
  const limit = query.limit ?? 50
  return Object.values(state.duties)
    .filter((duty) => (query.status === undefined ? true : duty.status === query.status))
    .filter((duty) => (query.owner === undefined ? true : duty.owner === query.owner))
    .filter((duty) => (query.assignee === undefined ? true : duty.assignee === query.assignee))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((duty) => dutySummary(duty))
}

/**
 * Compact projection used by list and status views.
 * @param {Record<string, any>} duty - one duty.
 * @returns {Record<string, any>} the summary.
 */
export function dutySummary(duty) {
  const allowed = DUTY_EDGES[duty.status] ?? []
  return {
    id: duty.id,
    role: duty.role,
    owner: duty.owner,
    assignee: duty.assignee,
    status: duty.status,
    responsibilities: duty.responsibilities.length,
    acceptance: duty.acceptance.length,
    evidence: Array.isArray(duty.evidence) ? duty.evidence.length : 0,
    ...(duty.reference === undefined ? {} : { reference: duty.reference }),
    ...(allowed.length === 0 ? {} : { allowedTransitions: [...allowed] }),
  }
}

/**
 * Move a duty along one legal edge, enforcing the handoff authority split.
 *
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {{ id: unknown, action: unknown, actor?: unknown, summary?: unknown, evidence?: unknown, review?: unknown, note?: unknown }} request - the tool arguments.
 * @returns {Record<string, any>} the updated duty.
 */
export function transitionDuty(context, request) {
  const key = requireRecordId(context.state.duties, request.id, 'duty')
  const duty = context.state.duties[key]
  const action = requireEnum(request.action, DUTY_ACTIONS.filter((value) => value !== 'list' && value !== 'get' && value !== 'assign'), 'action')
  if (TERMINAL_DUTY_STATUSES.includes(duty.status)) {
    fail(ERROR_CODES.INVALID_STATE, `duty ${key} is ${duty.status}; it is closed`, { id: key, status: duty.status })
  }
  const target = action === 'accept' ? 'accepted'
    : action === 'start' ? 'started'
      : action === 'submit' ? 'submitted'
        : action === 'verify' ? 'verified'
          : action === 'reject' ? 'rejected'
            : 'cancelled'
  const allowed = DUTY_EDGES[duty.status] ?? []
  if (!allowed.includes(target)) {
    fail(ERROR_CODES.INVALID_STATE, `duty ${key} cannot move from ${duty.status} to ${target}`, {
      id: key,
      from: duty.status,
      to: target,
      allowed,
    })
  }
  const side = ACTION_AUTHORITY[action]
  const expected = side === 'owner' ? duty.owner : duty.assignee
  const actor = request.actor === undefined
    ? undefined
    : requireString(request.actor, 'actor', { max: 256 })
  if (actor !== undefined && actor !== expected) {
    fail(ERROR_CODES.PERMISSION, `only the ${side} (${expected}) may ${action} duty ${key}`, {
      id: key,
      action,
      side,
      expected,
      actual: actor,
    })
  }
  const note = request.note === undefined || request.note === null
    ? undefined
    : requireString(request.note, 'note', { max: 2048 })
  const at = nowIso()

  if (action === 'submit') {
    duty.summary = requireString(request.summary, 'summary', { max: 4096 })
    duty.evidence = requireStringArray(request.evidence, 'evidence', { min: 1, max: MAX_EVIDENCE, itemMax: 4096 })
    duty.review = null
  }
  if (action === 'verify' || action === 'reject') {
    duty.review = requireString(request.review, 'review', { max: 4096 })
  }
  if (action === 'verify' && (!Array.isArray(duty.evidence) || duty.evidence.length === 0)) {
    fail(ERROR_CODES.INVALID_STATE, `duty ${key} has no recorded evidence to verify`, { id: key })
  }

  const from = duty.status
  duty.status = target
  duty.updatedAt = at
  duty.history.push({
    at,
    from,
    to: target,
    ...(actor === undefined ? {} : { actor }),
    ...(note === undefined ? {} : { note }),
  })
  context.record('duty/transition', key, {
    from,
    to: target,
    ...(actor === undefined ? {} : { actor }),
    ...(action === 'submit' ? { evidence: duty.evidence.length } : {}),
  })
  return duty
}

/**
 * Rows that need somebody to act, derived from the record rather than guessed.
 * @param {Record<string, any>} state - the ledger.
 * @returns {Array<{ duty: string, waitingOn: string, action: string }>} the queue.
 */
export function pendingDutyActions(state) {
  const rows = []
  for (const duty of Object.values(state.duties)) {
    if (duty.status === 'assigned') rows.push({ duty: duty.id, waitingOn: duty.assignee, action: 'accept' })
    if (duty.status === 'accepted') rows.push({ duty: duty.id, waitingOn: duty.assignee, action: 'start' })
    if (duty.status === 'started') rows.push({ duty: duty.id, waitingOn: duty.assignee, action: 'submit' })
    if (duty.status === 'submitted') rows.push({ duty: duty.id, waitingOn: duty.owner, action: 'verify' })
    if (duty.status === 'rejected') rows.push({ duty: duty.id, waitingOn: duty.assignee, action: 'accept' })
  }
  return rows
}
