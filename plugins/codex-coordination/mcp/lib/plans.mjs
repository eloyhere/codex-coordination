/**
 * Plans: bounded task graphs attached to a goal.
 *
 * A plan owns at most {@link MAX_TASKS} tasks, each with an intent, an actor, a
 * list of predecessor tasks (`pre`), an expected observation, a check, and an
 * irreversibility score. Dependencies are declared once — on the task — and the
 * edge list is *derived*, so a plan cannot describe two contradictory graphs.
 *
 * Two structural rules carry most of the value:
 *
 * - the dependency graph must be acyclic (checked with Kahn's algorithm), and
 * - a task may only start, or be declared done, after its predecessors are done.
 *
 * Everything else (whether the work is actually good) stays the caller's
 * responsibility, recorded rather than proven.
 *
 * @module codex-coordination/plans
 */

import {
  AMP_VERSION,
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
  requireStringArray,
} from './amp.mjs'
import { requireRecordId } from './store.mjs'

/** Plan lifecycle states. */
export const PLAN_STATUSES = Object.freeze(['draft', 'committed', 'executing', 'done', 'abandoned'])

/** Plan states after which no further transition is accepted. */
export const TERMINAL_PLAN_STATUSES = Object.freeze(['done', 'abandoned'])

/** Legal plan edges; `done` additionally requires every task to be terminal. */
export const PLAN_EDGES = Object.freeze({
  draft: Object.freeze(['committed', 'abandoned']),
  committed: Object.freeze(['executing', 'abandoned']),
  executing: Object.freeze(['done', 'abandoned']),
  done: Object.freeze([]),
  abandoned: Object.freeze([]),
})

/** Task lifecycle states. */
export const TASK_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped'])

/** Task states that no longer block a successor. */
export const TERMINAL_TASK_STATUSES = Object.freeze(['done', 'failed', 'skipped'])

/** Who performs a task. */
export const TASK_ACTORS = Object.freeze(['self', 'tool', 'other'])

/** Maximum tasks in one plan; a plan larger than this is not bounded. */
export const MAX_TASKS = 12

/** Maximum abandon conditions in one plan. */
export const MAX_ABANDON_IF = 8

/** Legal task edges. */
const TASK_EDGES = Object.freeze({
  pending: Object.freeze(['running', 'done', 'skipped']),
  running: Object.freeze(['done', 'failed', 'skipped']),
  failed: Object.freeze(['running', 'skipped']),
  done: Object.freeze([]),
  skipped: Object.freeze([]),
})

/** Budget counters a task or plan may declare. */
export const BUDGET_KEYS = Object.freeze(['tokens', 'ms', 'calls', 'interrupts', 'money'])

/**
 * Validate an optional budget object.
 * @param {unknown} input - `{ tokens, ms, calls, interrupts, money }` with nonnegative numbers.
 * @param {string} label - path prefix used in error messages.
 * @returns {Record<string, number>|undefined} the clean budget, or `undefined`.
 */
function normaliseBudget(input, label) {
  if (input === undefined) return undefined
  const record = requireRecord(input, label)
  const budget = {}
  for (const key of Object.keys(record)) {
    if (!BUDGET_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.${key} is not a budget counter (${BUDGET_KEYS.join(', ')})`, { field: `${label}.${key}` })
    }
    budget[key] = requireNumber(record[key], 0, Number.MAX_SAFE_INTEGER, `${label}.${key}`)
  }
  return Object.keys(budget).length === 0 ? undefined : budget
}

/**
 * Validate one task.
 * @param {unknown} input - the raw task.
 * @param {number} index - position, for error messages.
 * @returns {Record<string, any>} the clean task.
 */
function normaliseTask(input, index) {
  const label = `tasks[${index}]`
  const record = requireRecord(input, label)
  const id = requireId(record.id, `${label}.id`)
  const pre = record.pre === undefined
    ? []
    : requireStringArray(record.pre, `${label}.pre`, { min: 0, max: MAX_TASKS, itemMax: 64 })
      .map((value, position) => requireId(value, `${label}.pre[${position}]`))
  const uniquePre = [...new Set(pre)]
  if (uniquePre.includes(id)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.pre cannot name the task itself`, { field: `${label}.pre`, id })
  }
  const expect = requireRecord(record.expect, `${label}.expect`)
  const irreversibility = record.irreversibility === undefined ? 0 : record.irreversibility
  if (typeof irreversibility !== 'number' || !Number.isInteger(irreversibility) || irreversibility < 0 || irreversibility > 3) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.irreversibility must be an integer 0-3`, { field: `${label}.irreversibility` })
  }
  if (record.status !== undefined && record.status !== 'pending') {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.status must be omitted or "pending" when a plan is created`, { field: `${label}.status` })
  }
  const budget = normaliseBudget(record.budget, `${label}.budget`)
  return {
    id,
    intent: requireString(record.intent, `${label}.intent`, { max: 2048 }),
    actor: requireEnum(record.actor, TASK_ACTORS, `${label}.actor`),
    pre: uniquePre,
    expect: {
      observation: requireString(expect.observation, `${label}.expect.observation`, { max: 2048 }),
      check: requireString(expect.check, `${label}.expect.check`, { max: 4096 }),
    },
    irreversibility,
    budget,
    status: 'pending',
  }
}

/**
 * Reject a dependency graph with a cycle.
 *
 * Kahn's algorithm peels tasks whose predecessors are all peeled; anything left
 * belongs to a cycle (or depends on one). The error names the residue so the
 * caller can see the loop instead of guessing.
 *
 * @param {Array<Record<string, any>>} tasks - normalised tasks.
 * @returns {void}
 */
function assertAcyclic(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.pre)]))
  const ready = [...remaining.entries()].filter(([, pre]) => pre.size === 0).map(([id]) => id)
  const peeled = []
  while (ready.length > 0) {
    const id = ready.shift()
    peeled.push(id)
    remaining.delete(id)
    for (const [other, pre] of remaining) {
      if (pre.delete(id) && pre.size === 0) ready.push(other)
    }
  }
  if (remaining.size > 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'plan dependencies contain a cycle', { cycle: [...remaining.keys()] })
  }
}

/**
 * Validate the caller-supplied part of a plan.
 * @param {unknown} input - the raw `plan` argument.
 * @returns {Record<string, any>} the normalised, not-yet-stored plan.
 */
export function normalisePlanInput(input) {
  const record = requireRecord(input, 'plan')
  if (record.amp !== undefined && record.amp !== AMP_VERSION) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `plan.amp must be "${AMP_VERSION}"`, { field: 'plan.amp' })
  }
  if (record.kind !== undefined && record.kind !== 'plan') {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'plan.kind must be "plan"', { field: 'plan.kind' })
  }
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'plan.tasks must contain at least one task', { field: 'plan.tasks' })
  }
  if (record.tasks.length > MAX_TASKS) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `plan.tasks may contain at most ${MAX_TASKS} tasks`, { field: 'plan.tasks' })
  }
  const tasks = record.tasks.map((task, index) => normaliseTask(task, index))
  const ids = new Set()
  for (const task of tasks) {
    if (ids.has(task.id)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `plan.tasks repeats id ${task.id}`, { field: 'plan.tasks' })
    }
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dependency of task.pre) {
      if (!ids.has(dependency)) {
        fail(ERROR_CODES.INVALID_ARGUMENT, `task ${task.id} depends on unknown task ${dependency}`, {
          field: 'plan.tasks',
          task: task.id,
          dependency,
        })
      }
    }
  }
  assertAcyclic(tasks)
  let goal
  if (record.goal !== undefined) {
    const reference = requireRecord(record.goal, 'plan.goal')
    if (reference.kind !== undefined && reference.kind !== 'goal') {
      fail(ERROR_CODES.INVALID_ARGUMENT, 'plan.goal.kind must be "goal"', { field: 'plan.goal.kind' })
    }
    goal = { kind: 'goal', id: requireId(reference.id, 'plan.goal.id') }
  }
  const commitmentWindow = record.commitmentWindow === undefined
    ? 3
    : requireNumber(record.commitmentWindow, 1, 5, 'plan.commitmentWindow')
  if (!Number.isInteger(commitmentWindow)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'plan.commitmentWindow must be an integer 1-5', { field: 'plan.commitmentWindow' })
  }
  let abandonIf
  if (record.abandonIf !== undefined) {
    if (!Array.isArray(record.abandonIf) || record.abandonIf.length === 0 || record.abandonIf.length > MAX_ABANDON_IF) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `plan.abandonIf must contain 1-${MAX_ABANDON_IF} conditions`, { field: 'plan.abandonIf' })
    }
    abandonIf = record.abandonIf.map((condition, index) => normaliseCheck(condition, `plan.abandonIf[${index}]`))
  }
  return {
    amp: AMP_VERSION,
    kind: 'plan',
    id: requireId(record.id, 'plan.id'),
    ...(goal === undefined ? {} : { goal }),
    tasks,
    commitmentWindow,
    ...(record.rollback === undefined ? {} : { rollback: requireString(record.rollback, 'plan.rollback', { max: 2048 }) }),
    ...(record.budget === undefined ? {} : { budget: normaliseBudget(record.budget, 'plan.budget') }),
    ...(abandonIf === undefined ? {} : { abandonIf }),
  }
}

/**
 * Create one plan in `draft`.
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} input - the raw `plan` argument.
 * @returns {Record<string, any>} the stored plan.
 */
export function createPlan(context, input) {
  const plan = normalisePlanInput(input)
  if (isRecord(context.state.plans[plan.id])) {
    fail(ERROR_CODES.CONFLICT, `plan ${plan.id} already exists`, { id: plan.id })
  }
  if (plan.goal !== undefined && !isRecord(context.state.goals[plan.goal.id])) {
    fail(ERROR_CODES.NOT_FOUND, `plan.goal ${plan.goal.id} does not exist`, { goal: plan.goal.id })
  }
  const at = nowIso()
  const stored = {
    ...plan,
    edges: derivedEdges(plan),
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'draft' }],
  }
  context.state.plans[plan.id] = stored
  context.record('plan/created', plan.id, {
    tasks: plan.tasks.length,
    ...(plan.goal === undefined ? {} : { goal: plan.goal.id }),
  })
  return stored
}

/**
 * Derive the edge list from task predecessors.
 * @param {{ tasks: Array<{ id: string, pre: string[] }> }} plan - any plan-shaped value.
 * @returns {Array<[string, string]>} `[from, to]` pairs, task order preserved.
 */
export function derivedEdges(plan) {
  const edges = []
  for (const task of plan.tasks) {
    for (const dependency of task.pre) edges.push([dependency, task.id])
  }
  return edges
}

/**
 * Read one plan.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} id - plan id.
 * @returns {Record<string, any>} a defensive clone.
 */
export function getPlan(state, id) {
  const key = requireRecordId(state.plans, id, 'plan')
  return JSON.parse(JSON.stringify(state.plans[key]))
}

/**
 * List plans with optional filters.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ status?: string, goal?: string, limit?: number }} [query] - filters.
 * @returns {Array<Record<string, any>>} compact plan projections.
 */
export function listPlans(state, query = {}) {
  const limit = query.limit ?? 50
  return Object.values(state.plans)
    .filter((plan) => (query.status === undefined ? true : plan.status === query.status))
    .filter((plan) => (query.goal === undefined ? true : isRecord(plan.goal) && plan.goal.id === query.goal))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((plan) => ({
      id: plan.id,
      ...(isRecord(plan.goal) ? { goal: plan.goal.id } : {}),
      status: plan.status,
      tasks: plan.tasks.length,
      edges: Array.isArray(plan.edges) ? plan.edges.length : 0,
      ...progressOf(plan),
    }))
}

/**
 * Structural progress of one plan.
 * @param {Record<string, any>} plan - the plan.
 * @returns {{ byStatus: Record<string, number>, ready: string[], blocked: Array<{ id: string, blockedBy: string[] }> }} progress.
 */
function progressOf(plan) {
  const byStatus = {}
  for (const status of TASK_STATUSES) byStatus[status] = 0
  for (const task of plan.tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
  const statusById = new Map(plan.tasks.map((task) => [task.id, task.status]))
  const ready = []
  const blocked = []
  for (const task of plan.tasks) {
    if (TERMINAL_TASK_STATUSES.includes(task.status)) continue
    const waiting = task.pre.filter((dependency) => statusById.get(dependency) !== 'done')
    if (waiting.length === 0) ready.push(task.id)
    else blocked.push({ id: task.id, blockedBy: waiting })
  }
  return { byStatus, ready, blocked }
}

/**
 * Public progress view for one plan.
 * @param {Record<string, any>} plan - the plan.
 * @returns {Record<string, any>} progress plus task rows.
 */
export function planProgress(plan) {
  return {
    id: plan.id,
    ...(isRecord(plan.goal) ? { goal: plan.goal.id } : {}),
    status: plan.status,
    commitmentWindow: plan.commitmentWindow,
    ...(plan.budget === undefined ? {} : { budget: plan.budget }),
    ...(plan.abandonIf === undefined ? {} : { abandonIf: plan.abandonIf.map((condition) => condition.id) }),
    ...progressOf(plan),
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      intent: task.intent,
      actor: task.actor,
      status: task.status,
      pre: task.pre,
      irreversibility: task.irreversibility,
      expect: task.expect,
    })),
    edges: plan.edges,
  }
}

/**
 * Move a plan along one legal edge.
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} id - plan id.
 * @param {unknown} next - target status.
 * @param {unknown} [note] - optional explanation stored in the history.
 * @returns {Record<string, any>} the updated plan.
 */
export function transitionPlan(context, id, next, note) {
  const key = requireRecordId(context.state.plans, id, 'plan')
  const plan = context.state.plans[key]
  const target = requireEnum(next, PLAN_STATUSES, 'status')
  const allowed = PLAN_EDGES[plan.status] ?? []
  if (!allowed.includes(target)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} cannot move from ${plan.status} to ${target}`, {
      id: key,
      from: plan.status,
      to: target,
      allowed,
    })
  }
  if (target === 'done') {
    const unfinished = plan.tasks.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status)).map((task) => task.id)
    if (unfinished.length > 0) {
      fail(ERROR_CODES.INVALID_STATE, `plan ${key} still has unfinished tasks`, { id: key, tasks: unfinished })
    }
  }
  const text = note === undefined || note === null ? undefined : requireString(note, 'note', { max: 2048 })
  const at = nowIso()
  const from = plan.status
  plan.status = target
  plan.updatedAt = at
  plan.history.push({ at, from, to: target, ...(text === undefined ? {} : { note: text }) })
  context.record('plan/transition', key, { from, to: target, ...(text === undefined ? {} : { note: text }) })
  return plan
}

/**
 * Move one task, enforcing dependencies and the plan's own state.
 *
 * A plan must leave `draft` before any task can move: committing is the point
 * where the caller declares the graph worth executing. Starting the first task
 * of a committed plan promotes the plan to `executing` in the same transaction,
 * so the two records can never disagree about whether work is under way.
 *
 * @param {{ state: Record<string, any>, record: Function }} context - transaction context.
 * @param {unknown} planId - plan id.
 * @param {unknown} taskId - task id inside the plan.
 * @param {unknown} next - target task status.
 * @param {unknown} [note] - optional explanation stored in the task row.
 * @returns {Record<string, any>} the updated plan.
 */
export function updateTask(context, planId, taskId, next, note) {
  const key = requireRecordId(context.state.plans, planId, 'plan')
  const plan = context.state.plans[key]
  if (plan.status === 'draft') {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is a draft; commit it before moving tasks`, { id: key })
  }
  if (TERMINAL_PLAN_STATUSES.includes(plan.status)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is ${plan.status}; its tasks are closed`, { id: key })
  }
  const desired = requireEnum(next, TASK_STATUSES, 'task.status')
  const task = plan.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, `task ${String(taskId)} does not exist in plan ${key}`, { plan: key, task: taskId })
  }
  const allowed = TASK_EDGES[task.status] ?? []
  if (!allowed.includes(desired)) {
    fail(ERROR_CODES.INVALID_STATE, `task ${task.id} cannot move from ${task.status} to ${desired}`, {
      plan: key,
      task: task.id,
      from: task.status,
      to: desired,
      allowed,
    })
  }
  if (desired === 'running' || desired === 'done') {
    const statusById = new Map(plan.tasks.map((candidate) => [candidate.id, candidate.status]))
    const waiting = task.pre.filter((dependency) => statusById.get(dependency) !== 'done')
    if (waiting.length > 0) {
      fail(ERROR_CODES.INVALID_STATE, `task ${task.id} is blocked by unfinished predecessors`, {
        plan: key,
        task: task.id,
        blockedBy: waiting,
      })
    }
  }
  const text = note === undefined || note === null ? undefined : requireString(note, 'note', { max: 1024 })
  const at = nowIso()
  const from = task.status
  task.status = desired
  plan.updatedAt = at
  context.record('plan/task', key, { task: task.id, from, to: desired, ...(text === undefined ? {} : { note: text }) })
  if (desired === 'running' && plan.status === 'committed') {
    plan.status = 'executing'
    plan.history.push({ at, from: 'committed', to: 'executing', note: `task ${task.id} started` })
    context.record('plan/transition', key, { from: 'committed', to: 'executing', cause: `task ${task.id}` })
  }
  return plan
}
