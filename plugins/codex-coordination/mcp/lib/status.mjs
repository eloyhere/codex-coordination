/**
 * The status projection: one bounded answer to "where does this ledger stand?".
 *
 * Status is derived, never stored. Every field is computed from the records so
 * it cannot drift from the ledger, and the view stays small — goals, plans and
 * duties are summarised, tasks are listed only where they are actionable, and
 * the audit verdict is a count (run `coordination_check` for the details).
 *
 * @module codex-coordination/status
 */

import { isRecord } from './amp.mjs'
import { auditLedger } from './check.mjs'
import { pendingDutyActions, dutySummary } from './collaboration.mjs'
import { GOAL_EDGES, goalSummary } from './goals.mjs'
import { TERMINAL_TASK_STATUSES } from './plans.mjs'
import { ledgerPath, verifyJournal } from './store.mjs'

/** Default number of records per section. */
export const DEFAULT_LIMIT = 10

/**
 * Tasks that can be started right now, across every open plan.
 * @param {Record<string, any>} state - the ledger.
 * @returns {Array<{ plan: string, task: string, intent: string }>} ready tasks.
 */
function readyTasksOf(state) {
  const rows = []
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== 'committed' && plan.status !== 'executing') continue
    if (!Array.isArray(plan.tasks)) continue
    const statusById = new Map(plan.tasks.map((task) => [task.id, task.status]))
    for (const task of plan.tasks) {
      if (TERMINAL_TASK_STATUSES.includes(task.status) || task.status === 'running') continue
      const waiting = (Array.isArray(task.pre) ? task.pre : []).filter((dependency) => statusById.get(dependency) !== 'done')
      if (waiting.length === 0) rows.push({ plan: plan.id, task: task.id, intent: task.intent })
    }
  }
  return rows
}

/**
 * Ordered, human-readable next steps derived from the records.
 *
 * Ordering encodes the protocol's own priorities: unverified handoffs first
 * (someone is waiting), then proposed goals (nothing has been agreed), then
 * ready work, then plans that could be closed.
 *
 * @param {Record<string, any>} state - the ledger.
 * @param {ReturnType<typeof auditLedger>} audit - the audit verdict.
 * @returns {string[]} at most eight sentences.
 */
function nextStepsOf(state, audit) {
  const steps = []
  for (const row of pendingDutyActions(state)) {
    steps.push(`${row.action} duty ${row.duty} (waiting on ${row.waitingOn})`)
  }
  for (const goal of Object.values(state.goals)) {
    if (goal.state === 'proposed' && (GOAL_EDGES.proposed ?? []).includes('committed')) {
      steps.push(`commit or abandon goal ${goal.id}`)
    }
    if (goal.state === 'active') {
      const plan = Object.values(state.plans).find((candidate) => isRecord(candidate.goal) && candidate.goal.id === goal.id)
      if (plan === undefined) steps.push(`create a plan for active goal ${goal.id}`)
    }
  }
  for (const row of readyTasksOf(state)) {
    steps.push(`start task ${row.task} in plan ${row.plan}`)
  }
  for (const plan of Object.values(state.plans)) {
    if (plan.status === 'executing' && Array.isArray(plan.tasks)
      && plan.tasks.every((task) => TERMINAL_TASK_STATUSES.includes(task.status))) {
      steps.push(`close plan ${plan.id}: every task is terminal`)
    }
  }
  if (!audit.ok) steps.push(`repair ${audit.violations.length} violation(s) with coordination_check`)
  return [...new Set(steps)].slice(0, 8)
}

/**
 * Build the status document.
 * @param {Record<string, any>} state - the ledger.
 * @param {{ workspace: string, limit?: number }} options - workspace root and section size.
 * @returns {Record<string, any>} the projection.
 */
export function buildStatus(state, options) {
  const limit = options.limit ?? DEFAULT_LIMIT
  const audit = auditLedger(state)
  const chain = verifyJournal(state)
  const goals = Object.values(state.goals)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((goal) => goalSummary(state, goal))
  const plans = Object.values(state.plans)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((plan) => {
      const taskRows = Array.isArray(plan.tasks) ? plan.tasks : []
      return {
        id: plan.id,
        ...(isRecord(plan.goal) ? { goal: plan.goal.id } : {}),
        status: plan.status,
        tasks: taskRows.length,
        done: taskRows.filter((task) => task.status === 'done').length,
        blocked: taskRows.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status) && task.status !== 'running').length,
      }
    })
  const duties = Object.values(state.duties)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((duty) => dutySummary(duty))
  const pending = pendingDutyActions(state)
  return {
    ok: true,
    workspace: options.workspace,
    ledger: {
      path: ledgerPath(options.workspace),
      seq: state.seq,
      head: state.head ?? null,
      entries: chain.entries,
      dropped: chain.dropped,
      verified: chain.ok,
    },
    counts: {
      goals: Object.keys(state.goals).length,
      plans: Object.keys(state.plans).length,
      duties: Object.keys(state.duties).length,
    },
    goals,
    plans,
    duties,
    waitingOnPeople: pending,
    readyTasks: readyTasksOf(state).slice(0, limit),
    openViolations: audit.violations.length,
    warnings: audit.warnings.length,
    nextSteps: nextStepsOf(state, audit),
  }
}
