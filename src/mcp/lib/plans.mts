import { validatePlanInput } from 'amp-legacy/goal/plan.js'
import type { Plan, PlanTask, PlanMonitor } from 'amp-legacy/types'
/**
 * Plans: bounded task graphs attached to a goal.
 *
 * A plan is stored as a strict AMP `Plan` artifact plus host history:
 *
 * - `artifact` carries every required schema field — `goal` (a `Ref`), `tasks`,
 *   `edges` derived from the task predecessors, `commitment_window`, `budget`,
 *   `abandon_if`, `status` and `created` — so it validates unchanged;
 * - `history` records the transitions and the free-form notes, which the artifact
 *   has no field for.
 *
 * Every plan mutation appends the *updated* artifact as one `plan` chain entry,
 * because the artifact itself is what changed (status, task status). A goal
 * transition, by contrast, changes no artifact field and is recorded as an
 * `event` instead.
 *
 * Two structural rules carry most of the value:
 *
 * - the dependency graph must be acyclic (checked with Kahn's algorithm), and
 * - a task may only start, or be declared done, after its predecessors are done.
 *
 * Everything else — whether the work is actually good — stays the caller's
 * responsibility, recorded rather than proven.
 *
 * @module codex-coordination/plans
 */

import {
  AMP_VERSION,
  ERROR_CODES,
  fail,
  isRecord,
  normaliseBudget,
  normaliseCriterion,
  normaliseRef,
  nowIso,
  requireEnum,
  requireExactKeys,
  requireId,
  requireInteger,
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
export const PLAN_EDGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
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
export const TASK_ACTORS = Object.freeze(['self', 'tool', 'other'] as const)

/** Monitor actions AMP defines. */
export const MONITOR_ACTIONS = Object.freeze(['retry', 'adjust', 'recompose', 'replan', 'abandon'] as const)

/** Maximum tasks in one plan; a plan larger than this is not bounded. */
export const MAX_TASKS = 12

/** Maximum abandon conditions in one plan. */
export const MAX_ABANDON_IF = 8

/** Maximum monitor triggers in one plan. */
export const MAX_MONITOR_TRIGGERS = 8

/** Default commitment window when the caller omits one: an authored policy. */
export const DEFAULT_COMMITMENT_WINDOW = 3

/** Legal task edges. */
const TASK_EDGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pending: Object.freeze(['running', 'done', 'skipped']),
  running: Object.freeze(['done', 'failed', 'skipped']),
  failed: Object.freeze(['running', 'skipped']),
  done: Object.freeze([]),
  skipped: Object.freeze([]),
})

/**
 * Reject a camelCase spelling of an AMP field with the spelling to use instead.
 *
 * The artifact is the contract, so the input uses AMP's names. A caller that
 * typed `commitmentWindow` gets the field it should have written rather than a
 * silent rename, which teaches the wrong vocabulary for every later call.
 *
 * @param {Record<string, unknown>} record - caller input.
 * @param {string} label - path prefix used in error messages.
 * @returns {void}
 */
function rejectNonAmpSpellings(record: Record<string, unknown>, label: string) {
  const aliases = { commitmentWindow: 'commitment_window', abandonIf: 'abandon_if' }
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (record[alias] !== undefined) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.${alias} is not the AMP spelling; use ${label}.${canonical}`, {
        field: `${label}.${alias}`,
        use: `${label}.${canonical}`,
      })
    }
  }
}

/**
 * Validate one task.
 * @param {unknown} input - the raw task.
 * @param {number} index - position, for error messages.
 * @returns {Record<string, any>} the clean AMP `PlanTask`.
 */
function normaliseTask(input: unknown, index: number): PlanTask {
  const label = `tasks[${index}]`
  const record = requireRecord(input, label)
  requireExactKeys(
    record,
    ['id', 'intent', 'actor', 'ref', 'pre', 'expect', 'irreversibility', 'budget', 'status'],
    ['id', 'intent', 'actor', 'expect'],
    label,
  )
  const id = requireId(record.id, `${label}.id`)
  const pre = record.pre === undefined
    ? []
    : requireStringArray(record.pre, `${label}.pre`, { min: 0, max: MAX_TASKS, itemMax: 64 })
      .map((value: any, position: any) => requireId(value, `${label}.pre[${position}]`))
  const uniquePre = [...new Set(pre)]
  if (uniquePre.includes(id)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.pre cannot name the task itself`, { field: `${label}.pre`, id })
  }
  if (record.status !== undefined && record.status !== 'pending') {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.status must be omitted or "pending" when a plan is created`, { field: `${label}.status` })
  }
  const expect = requireRecord(record.expect, `${label}.expect`)
  requireExactKeys(expect, ['observation', 'check'], ['observation', 'check'], `${label}.expect`)
  return {
    id,
    intent: requireString(record.intent, `${label}.intent`, { max: 2048 }),
    actor: requireEnum(record.actor, TASK_ACTORS, `${label}.actor`),
    ...(record.ref === undefined ? {} : { ref: normaliseRef(record.ref, `${label}.ref`) }),
    pre: uniquePre,
    expect: {
      observation: requireString(expect.observation, `${label}.expect.observation`, { max: 2048 }),
      check: requireString(expect.check, `${label}.expect.check`, { max: 4096 }),
    },
    irreversibility: record.irreversibility === undefined
      ? 0
      : requireInteger(record.irreversibility, 0, 3, `${label}.irreversibility`) as PlanTask['irreversibility'],
    ...(record.budget === undefined ? {} : { budget: normaliseBudget(record.budget, `${label}.budget`) }),
    status: 'pending',
  }
}

/**
 * Validate an optional AMP `plan.monitor`.
 * @param {unknown} input - `{ triggers?: [{ when, action }] }`.
 * @param {string} label - path prefix used in error messages.
 * @returns {Record<string, any>} the clean monitor.
 */
function normaliseMonitor(input: unknown, label: string) {
  const record = requireRecord(input, label)
  requireExactKeys(record, ['triggers'], [], label)
  if (record.triggers === undefined) return {}
  if (!Array.isArray(record.triggers) || record.triggers.length > MAX_MONITOR_TRIGGERS) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.triggers must be an array of at most ${MAX_MONITOR_TRIGGERS} trigger(s)`, {
      field: `${label}.triggers`,
    })
  }
  return {
    triggers: record.triggers.map((trigger: any, index: any) => {
      const row = requireRecord(trigger, `${label}.triggers[${index}]`)
      requireExactKeys(row, ['when', 'action'], ['when', 'action'], `${label}.triggers[${index}]`)
      return {
        when: requireString(row.when, `${label}.triggers[${index}].when`, { max: 1024 }),
        action: requireEnum(row.action, MONITOR_ACTIONS, `${label}.triggers[${index}].action`),
      }
    }),
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
function assertAcyclic(tasks: Array<Record<string, any>>) {
  const remaining = new Map(tasks.map((task: any) => [task.id, new Set(task.pre)]))
  const ready = [...remaining.entries()].filter(([, pre]) => pre.size === 0).map(([id]) => id)
  while (ready.length > 0) {
    const id = ready.shift()
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
 * Validate the caller-supplied part of a plan and return the strict AMP artifact.
 *
 * `goal` and `abandon_if` are required because AMP requires them: a plan without
 * a goal is not planning, and a plan without a condition that would make it stop
 * has no commitment either.
 *
 * @param {unknown} input - the raw `plan` argument.
 * @returns {Record<string, any>} the AMP Plan artifact.
 */
export function normalisePlanArtifact(input: unknown): Plan {
  const record = requireRecord(input, 'plan')
  rejectNonAmpSpellings(record, 'plan')
  for (const computed of ['edges', 'status', 'created']) {
    if (record[computed] !== undefined) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `plan.${computed} is computed by the server and must not be supplied`, {
        field: `plan.${computed}`,
      })
    }
  }
  requireExactKeys(
    record,
    ['amp', 'kind', 'id', 'goal', 'process', 'tasks', 'commitment_window', 'budget', 'abandon_if', 'monitor', 'rollback', 'warrant'],
    ['id', 'goal', 'tasks', 'abandon_if'],
    'plan',
  )
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
  const tasks = record.tasks.map((task: any, index: any) => normaliseTask(task, index))
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
  const goal = normaliseRef(record.goal, 'plan.goal')
  if (goal.kind !== 'goal') fail(ERROR_CODES.INVALID_ARGUMENT, 'plan.goal.kind must be "goal"', { field: 'plan.goal.kind' })
  if (!Array.isArray(record.abandon_if) || record.abandon_if.length === 0 || record.abandon_if.length > MAX_ABANDON_IF) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `plan.abandon_if must contain 1-${MAX_ABANDON_IF} conditions`, { field: 'plan.abandon_if' })
  }
  const abandonIf = record.abandon_if.map((condition: any, index: any) => normaliseCriterion(condition, `plan.abandon_if[${index}]`))
  const abandonIds = new Set()
  for (const condition of abandonIf) {
    if (abandonIds.has(condition.id)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `plan.abandon_if repeats id ${condition.id}`, { field: 'plan.abandon_if' })
    }
    abandonIds.add(condition.id)
  }
  const commitmentWindow = record.commitment_window === undefined
    ? DEFAULT_COMMITMENT_WINDOW
    : requireInteger(record.commitment_window, 1, 5, 'plan.commitment_window')
  const artifact: Plan = {
    amp: AMP_VERSION,
    kind: 'plan',
    id: requireId(record.id, 'plan.id'),
    goal,
    ...(record.process === undefined ? {} : { process: normaliseRef(record.process, 'plan.process') }),
    tasks,
    edges: derivedEdges(tasks),
    commitment_window: commitmentWindow,
    budget: normaliseBudget(record.budget, 'plan.budget') ?? {},
    abandon_if: abandonIf,
    ...(record.monitor === undefined ? {} : { monitor: normaliseMonitor(record.monitor, 'plan.monitor') }),
    ...(record.rollback === undefined ? {} : { rollback: requireString(record.rollback, 'plan.rollback', { max: 2048 }) }),
    ...(record.warrant === undefined ? {} : { warrant: normaliseRef(record.warrant, 'plan.warrant') }),
    status: 'draft',
    created: nowIso(),
  }
  const problems = validatePlanInput({ tasks: artifact.tasks, edges: artifact.edges, abandonIf: artifact.abandon_if })
  if (problems.length) fail(ERROR_CODES.INVALID_ARGUMENT, 'AMP plan preconditions failed', { problems })
  return artifact
}

/**
 * Derive the edge list from task predecessors.
 * @param {Array<{ id: string, pre: string[] }>} tasks - normalised tasks.
 * @returns {Array<[string, string]>} `[from, to]` pairs, task order preserved.
 */
export function derivedEdges(tasks: Array<{ id: string, pre: string[] }>) {
  const edges: Array<[string, string]> = []
  for (const task of tasks) {
    for (const dependency of task.pre) edges.push([dependency, task.id])
  }
  return edges
}

/**
 * Create one plan in `draft`.
 * @param {{ state: Record<string, any>, append: Function }} context - transaction context.
 * @param {unknown} input - the raw `plan` argument.
 * @returns {Record<string, any>} the stored record.
 */
export function createPlan(context: { state: Record<string, any>, append: Function }, input: unknown) {
  const artifact = normalisePlanArtifact(input)
  if (isRecord(context.state.plans[artifact.id])) {
    fail(ERROR_CODES.CONFLICT, `plan ${artifact.id} already exists`, { id: artifact.id })
  }
  if (!isRecord(context.state.goals[artifact.goal.id])) {
    fail(ERROR_CODES.NOT_FOUND, `plan.goal ${artifact.goal.id} does not exist`, { goal: artifact.goal.id })
  }
  const at = nowIso()
  const record = {
    artifact,
    updatedAt: at,
    history: [{ at, from: null, to: 'draft' }],
  }
  context.state.plans[artifact.id] = record
  context.append('plan', artifact)
  return record
}

/**
 * Read one plan record.
 * @param {Record<string, any>} state - the ledger.
 * @param {unknown} id - plan id.
 * @returns {Record<string, any>} a defensive clone of the stored record.
 */
export function getPlan(state: Record<string, any>, id: unknown) {
  const key = requireRecordId(state.plans, id, 'plan')
  return JSON.parse(JSON.stringify(state.plans[key]))
}

/**
 * Structural progress of one plan artifact.
 * @param {Record<string, any>} artifact - an AMP Plan.
 * @returns {{ byStatus: Record<string, number>, ready: string[], blocked: Array<{ id: string, blockedBy: string[] }> }} progress.
 */
function progressOf(artifact: Record<string, any>) {
  const byStatus: Record<string, number> = {}
  for (const status of TASK_STATUSES) byStatus[status] = 0
  for (const task of artifact.tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
  const statusById = new Map(artifact.tasks.map((task: any) => [task.id, task.status]))
  const ready = []
  const blocked = []
  for (const task of artifact.tasks) {
    if (TERMINAL_TASK_STATUSES.includes(task.status)) continue
    const waiting = task.pre.filter((dependency: any) => statusById.get(dependency) !== 'done')
    if (waiting.length === 0) ready.push(task.id)
    else blocked.push({ id: task.id, blockedBy: waiting })
  }
  return { byStatus, ready, blocked }
}

/**
 * Public progress view for one plan record.
 * @param {Record<string, any>} record - the stored plan record.
 * @returns {Record<string, any>} the artifact plus derived progress and history.
 */
export function planView(record: Record<string, any>) {
  const artifact = record.artifact
  return {
    plan: JSON.parse(JSON.stringify(artifact)),
    progress: progressOf(artifact),
    updatedAt: record.updatedAt,
    history: JSON.parse(JSON.stringify(Array.isArray(record.history) ? record.history : [])),
  }
}

/**
 * List plans with optional filters.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ status?: string, goal?: string, limit?: number }} [query] - filters.
 * @returns {Array<Record<string, any>>} compact plan projections.
 */
export function listPlans(state: Record<string, any>, query: { status?: string, goal?: string, limit?: number } = {}) {
  const limit = query.limit ?? 50
  return Object.values(state.plans)
    .filter((record: any) => isRecord(record) && isRecord(record.artifact))
    .filter((record: any) => (query.status === undefined ? true : record.artifact.status === query.status))
    .filter((record: any) => (query.goal === undefined ? true : isRecord(record.artifact.goal) && record.artifact.goal.id === query.goal))
    .sort((left: any, right: any) => String(left.artifact.created).localeCompare(String(right.artifact.created)))
    .slice(-limit)
    .map((record: any) => {
      const artifact = record.artifact
      const progress = progressOf(artifact)
      return {
        id: artifact.id,
        goal: artifact.goal.id,
        status: artifact.status,
        commitment_window: artifact.commitment_window,
        tasks: artifact.tasks.length,
        edges: Array.isArray(artifact.edges) ? artifact.edges.length : 0,
        ...progress,
      }
    })
}

/**
 * Move a plan along one legal edge.
 * @param {{ state: Record<string, any>, append: Function }} context - transaction context.
 * @param {unknown} id - plan id.
 * @param {unknown} next - target status.
 * @param {unknown} [note] - optional explanation stored in the host history.
 * @returns {Record<string, any>} the updated record.
 */
export function transitionPlan(context: { state: Record<string, any>, append: Function }, id: unknown, next: unknown, note?: unknown) {
  const key = requireRecordId(context.state.plans, id, 'plan')
  const record = context.state.plans[key]
  if (!isRecord(record) || !isRecord(record.artifact)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is not a stored plan record`, { id: key })
  }
  if (!Array.isArray(record.history)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} has no history array; run coordination_check`, { id: key })
  }
  const artifact = record.artifact
  const target = requireEnum(next, PLAN_STATUSES, 'status')
  const from = artifact.status
  const allowed = PLAN_EDGES[from] ?? []
  if (!allowed.includes(target)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} cannot move from ${from} to ${target}`, {
      id: key,
      from,
      to: target,
      allowed,
    })
  }
  if (target === 'done') {
    const unfinished = artifact.tasks.filter((task: any) => !TERMINAL_TASK_STATUSES.includes(task.status)).map((task: any) => task.id)
    if (unfinished.length > 0) {
      fail(ERROR_CODES.INVALID_STATE, `plan ${key} still has unfinished tasks`, { id: key, tasks: unfinished })
    }
  }
  const text = note === undefined || note === null ? undefined : requireString(note, 'note', { max: 2048 })
  const at = nowIso()
  artifact.status = target
  record.updatedAt = at
  record.history.push({ at, from, to: target, ...(text === undefined ? {} : { note: text }) })
  context.append('plan', artifact)
  return record
}

/**
 * Move one task, enforcing dependencies and the plan's own state.
 *
 * A plan must leave `draft` before any task can move: committing is the point
 * where the caller declares the graph worth executing. Starting the first task of
 * a committed plan promotes the plan to `executing` in the same transaction, so
 * the two records can never disagree about whether work is under way.
 *
 * @param {{ state: Record<string, any>, append: Function }} context - transaction context.
 * @param {unknown} planId - plan id.
 * @param {unknown} taskId - task id inside the plan.
 * @param {unknown} next - target task status.
 * @param {unknown} [note] - optional explanation stored in the host history.
 * @returns {Record<string, any>} the updated record.
 */
export function updateTask(context: { state: Record<string, any>, append: Function }, planId: unknown, taskId: unknown, next: unknown, note?: unknown) {
  const key = requireRecordId(context.state.plans, planId, 'plan')
  const record = context.state.plans[key]
  if (!isRecord(record) || !isRecord(record.artifact)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is not a stored plan record`, { id: key })
  }
  if (!Array.isArray(record.history)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} has no history array; run coordination_check`, { id: key })
  }
  const artifact = record.artifact
  if (artifact.status === 'draft') {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is a draft; commit it before moving tasks`, { id: key })
  }
  if (TERMINAL_PLAN_STATUSES.includes(artifact.status)) {
    fail(ERROR_CODES.INVALID_STATE, `plan ${key} is ${artifact.status}; its tasks are closed`, { id: key })
  }
  const desired = requireEnum(next, TASK_STATUSES, 'task.status')
  const task = artifact.tasks.find((candidate: any) => candidate.id === taskId)
  if (task === undefined) {
    fail(ERROR_CODES.NOT_FOUND, `task ${String(taskId)} does not exist in plan ${key}`, { plan: key, task: taskId })
  }
  const from = task.status
  const allowed = TASK_EDGES[from] ?? []
  if (!allowed.includes(desired)) {
    fail(ERROR_CODES.INVALID_STATE, `task ${task.id} cannot move from ${from} to ${desired}`, {
      plan: key,
      task: task.id,
      from,
      to: desired,
      allowed,
    })
  }
  if (desired === 'running' || desired === 'done') {
    const statusById = new Map(artifact.tasks.map((candidate: any) => [candidate.id, candidate.status]))
    const waiting = task.pre.filter((dependency: any) => statusById.get(dependency) !== 'done')
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
  task.status = desired
  record.updatedAt = at
  record.history.push({
    at,
    task: task.id,
    from,
    to: desired,
    ...(text === undefined ? {} : { note: text }),
  })
  if (desired === 'running' && artifact.status === 'committed') {
    artifact.status = 'executing'
    record.history.push({ at, from: 'committed', to: 'executing', note: `task ${task.id} started` })
  }
  context.append('plan', artifact)
  return record
}
