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

import { AMP_VERSION, isRecord } from './amp.mjs'
import { auditLedger } from './check.mjs'
import { pendingDutyActions, dutySummary } from './collaboration.mjs'
import { GOAL_EDGES, goalSummary } from './goals.mjs'
import { TERMINAL_TASK_STATUSES, planView } from './plans.mjs'
import { ledgerPath, verifyChain } from './store.mjs'

/** Default number of records per section. */
export const DEFAULT_LIMIT = 10

/**
 * Tasks that can be started right now, across every open plan.
 * @param {Record<string, any>} state - the ledger.
 * @returns {Array<{ plan: string, task: string, intent: string }>} ready tasks.
 */
function readyTasksOf(state) {
  const rows = []
  for (const record of Object.values(state.plans)) {
    if (!isRecord(record) || !isRecord(record.artifact)) continue
    const artifact = record.artifact
    if (artifact.status !== 'committed' && artifact.status !== 'executing') continue
    if (!Array.isArray(artifact.tasks)) continue
    const statusById = new Map(artifact.tasks.map((task) => [task.id, task.status]))
    for (const task of artifact.tasks) {
      if (TERMINAL_TASK_STATUSES.includes(task.status) || task.status === 'running') continue
      const waiting = (Array.isArray(task.pre) ? task.pre : []).filter((dependency) => statusById.get(dependency) !== 'done')
      if (waiting.length === 0) rows.push({ plan: artifact.id, task: task.id, intent: task.intent })
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
  for (const record of Object.values(state.goals)) {
    if (!isRecord(record) || !isRecord(record.artifact) || !isRecord(record.lifecycle)) continue
    const id = record.artifact.id
    if (record.lifecycle.state === 'proposed' && (GOAL_EDGES.proposed ?? []).includes('committed')) {
      steps.push(`commit or abandon goal ${id}`)
    }
    if (record.lifecycle.state === 'active') {
      const plan = Object.values(state.plans).find((candidate) => {
        const artifact = isRecord(candidate) ? candidate.artifact : undefined
        return isRecord(artifact) && isRecord(artifact.goal) && artifact.goal.id === id
      })
      if (plan === undefined) steps.push(`create a plan for active goal ${id}`)
    }
  }
  for (const row of readyTasksOf(state)) {
    steps.push(`start task ${row.task} in plan ${row.plan}`)
  }
  for (const record of Object.values(state.plans)) {
    const artifact = isRecord(record) ? record.artifact : undefined
    if (!isRecord(artifact)) continue
    if (artifact.status === 'executing' && Array.isArray(artifact.tasks)
      && artifact.tasks.every((task) => TERMINAL_TASK_STATUSES.includes(task.status))) {
      steps.push(`close plan ${artifact.id}: every task is terminal`)
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
  const chain = verifyChain(state)
  const goals = Object.values(state.goals)
    .filter((record) => isRecord(record) && isRecord(record.artifact) && isRecord(record.lifecycle))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((record) => goalSummary(state, record))
  const plans = Object.values(state.plans)
    .filter((record) => isRecord(record) && isRecord(record.artifact))
    .sort((left, right) => String(left.artifact.created).localeCompare(String(right.artifact.created)))
    .slice(-limit)
    .map((record) => {
      const artifact = record.artifact
      const progress = planView(record).progress
      return {
        id: artifact.id,
        ...(isRecord(artifact.goal) ? { goal: artifact.goal.id } : {}),
        status: artifact.status,
        commitment_window: artifact.commitment_window,
        tasks: artifact.tasks.length,
        done: progress.byStatus.done,
        ready: progress.ready.length,
        blocked: progress.blocked.length,
      }
    })
  const duties = Object.values(state.duties)
    .filter((duty) => isRecord(duty))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(-limit)
    .map((duty) => dutySummary(duty))
  const pending = pendingDutyActions(state)
  return {
    ok: true,
    workspace: options.workspace,
    amp: AMP_VERSION,
    ledger: {
      path: ledgerPath(options.workspace),
      agent: state.agent,
      tip: chain.tip,
      count: chain.count,
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
