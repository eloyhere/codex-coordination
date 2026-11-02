/**
 * Structural audit of a coordination ledger.
 *
 * The audit answers one question: "is this record internally consistent?" It
 * never asks whether the work was any good. Every violation names the record and
 * the rule it broke, because the point of the tool is to let a model repair its
 * own bookkeeping before it reports a result.
 *
 * Violations are things the protocol forbids (a broken digest chain, a cycle, a
 * verified handoff with no evidence). Warnings are things that are legal but
 * worth a look (an active goal with no plan).
 *
 * @module codex-coordination/check
 */

import { isRecord } from './amp.mjs'
import { GOAL_EDGES, GOAL_STATES, TERMINAL_GOAL_STATES, linkedPlans } from './goals.mjs'
import { PLAN_EDGES, PLAN_STATUSES, TERMINAL_TASK_STATUSES } from './plans.mjs'
import { DUTY_EDGES, DUTY_STATUSES } from './collaboration.mjs'
import { verifyJournal } from './store.mjs'

/**
 * Detect a cycle in a task dependency graph.
 * @param {Array<Record<string, any>>} tasks - tasks with `id` and `pre`.
 * @returns {string[]} ids that belong to a cycle (empty when acyclic).
 */
function cyclicTaskIds(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(Array.isArray(task.pre) ? task.pre : [])]))
  for (const [id, pre] of remaining) {
    for (const dependency of [...pre]) {
      if (!remaining.has(dependency)) pre.delete(dependency)
    }
    if (pre.has(id)) return [id]
  }
  const ready = [...remaining.entries()].filter(([, pre]) => pre.size === 0).map(([id]) => id)
  while (ready.length > 0) {
    const id = ready.shift()
    remaining.delete(id)
    for (const [other, pre] of remaining) {
      if (pre.delete(id) && pre.size === 0) ready.push(other)
    }
  }
  return [...remaining.keys()]
}

/**
 * Audit one ledger.
 * @param {Record<string, any>} state - the ledger document.
 * @returns {{ ok: boolean, violations: Array<Record<string, any>>, warnings: Array<Record<string, any>>, summary: Record<string, any> }} the verdict.
 */
export function auditLedger(state) {
  const violations = []
  const warnings = []

  const journal = verifyJournal(state)
  if (!journal.ok) {
    for (const problem of journal.problems) {
      violations.push({ code: 'LEDGER_CHAIN', id: 'ledger', message: 'journal chain does not verify', details: problem })
    }
  }

  const goalStates = {}
  for (const goal of Object.values(state.goals)) {
    goalStates[goal.state] = (goalStates[goal.state] ?? 0) + 1
    if (!GOAL_STATES.includes(goal.state)) {
      violations.push({ code: 'GOAL_STATE', id: goal.id, message: `unknown goal state ${String(goal.state)}` })
    }
    if (!Array.isArray(goal.success) || goal.success.length === 0) {
      violations.push({ code: 'GOAL_SUCCESS_MISSING', id: goal.id, message: 'goal has no success criteria' })
    } else {
      for (const criterion of goal.success) {
        if (!isRecord(criterion) || typeof criterion.check !== 'string' || criterion.check.trim().length === 0) {
          violations.push({ code: 'GOAL_CHECK_MISSING', id: goal.id, message: `success criterion ${String(criterion?.id)} has no check` })
        }
      }
    }
    const history = Array.isArray(goal.history) ? goal.history : []
    const last = history[history.length - 1]
    if (!isRecord(last) || last.to !== goal.state) {
      violations.push({ code: 'GOAL_HISTORY', id: goal.id, message: 'goal history does not end at its current state' })
    }
    for (const transition of history) {
      if (!isRecord(transition)) continue
      if (transition.from === null) continue
      const allowed = GOAL_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'GOAL_EDGE', id: goal.id, message: `goal moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (goal.state === 'achieved') {
      const unfinished = linkedPlans(state, goal.id).filter((plan) => plan.status !== 'done' && plan.status !== 'abandoned')
      for (const plan of unfinished) {
        violations.push({ code: 'GOAL_ACHIEVED_WITH_PLAN', id: goal.id, message: `achieved goal still has plan ${plan.id} in ${plan.status}` })
      }
    }
    if (goal.state === 'active' && linkedPlans(state, goal.id).length === 0) {
      warnings.push({ code: 'GOAL_ACTIVE_NO_PLAN', id: goal.id, message: 'active goal has no plan recording how it will be reached' })
    }
  }

  for (const plan of Object.values(state.plans)) {
    if (!PLAN_STATUSES.includes(plan.status)) {
      violations.push({ code: 'PLAN_STATE', id: plan.id, message: `unknown plan state ${String(plan.status)}` })
    }
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      violations.push({ code: 'PLAN_EMPTY', id: plan.id, message: 'plan has no tasks' })
      continue
    }
    if (isRecord(plan.goal) && !isRecord(state.goals[plan.goal.id])) {
      violations.push({ code: 'PLAN_GOAL_MISSING', id: plan.id, message: `plan references unknown goal ${String(plan.goal.id)}` })
    }
    const ids = new Set()
    for (const task of plan.tasks) {
      if (ids.has(task.id)) violations.push({ code: 'TASK_DUPLICATE', id: plan.id, message: `task id ${task.id} repeats` })
      ids.add(task.id)
      if (!isRecord(task.expect) || typeof task.expect.check !== 'string' || task.expect.check.trim().length === 0) {
        violations.push({ code: 'TASK_CHECK_MISSING', id: plan.id, message: `task ${task.id} has no expected check` })
      }
      for (const dependency of Array.isArray(task.pre) ? task.pre : []) {
        if (!plan.tasks.some((candidate) => candidate.id === dependency)) {
          violations.push({ code: 'TASK_PRE_MISSING', id: plan.id, message: `task ${task.id} depends on unknown task ${dependency}` })
        }
      }
    }
    for (const id of cyclicTaskIds(plan.tasks)) {
      violations.push({ code: 'PLAN_CYCLE', id: plan.id, message: `task dependencies contain a cycle through ${id}` })
    }
    for (const transition of Array.isArray(plan.history) ? plan.history : []) {
      if (!isRecord(transition) || transition.from === null) continue
      const allowed = PLAN_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'PLAN_EDGE', id: plan.id, message: `plan moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (plan.status === 'done') {
      const unfinished = plan.tasks.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status)).map((task) => task.id)
      if (unfinished.length > 0) {
        violations.push({ code: 'PLAN_DONE_WITH_TASKS', id: plan.id, message: `done plan still has ${unfinished.length} unfinished task(s)` })
      }
    }
    const derived = []
    for (const task of plan.tasks) {
      for (const dependency of Array.isArray(task.pre) ? task.pre : []) derived.push(`${dependency}>${task.id}`)
    }
    const recorded = Array.isArray(plan.edges) ? plan.edges.map((edge) => `${edge[0]}>${edge[1]}`) : derived
    if (derived.length !== recorded.length || derived.some((edge) => !recorded.includes(edge))) {
      violations.push({ code: 'PLAN_EDGES_DRIFT', id: plan.id, message: 'plan.edges no longer match the task predecessors' })
    }
  }

  const dutyStates = {}
  for (const duty of Object.values(state.duties)) {
    dutyStates[duty.status] = (dutyStates[duty.status] ?? 0) + 1
    if (!DUTY_STATUSES.includes(duty.status)) {
      violations.push({ code: 'DUTY_STATE', id: duty.id, message: `unknown duty state ${String(duty.status)}` })
    }
    if (isRecord(duty.reference)) {
      const reference = duty.reference
      if (reference.kind === 'goal' && !isRecord(state.goals[reference.id])) {
        violations.push({ code: 'DUTY_REF_MISSING', id: duty.id, message: `duty references unknown goal ${String(reference.id)}` })
      }
      if (reference.kind === 'plan' && !isRecord(state.plans[reference.id])) {
        violations.push({ code: 'DUTY_REF_MISSING', id: duty.id, message: `duty references unknown plan ${String(reference.id)}` })
      }
      if (reference.kind === 'task') {
        const plan = state.plans[reference.plan]
        if (!isRecord(plan)) {
          violations.push({ code: 'DUTY_REF_MISSING', id: duty.id, message: `duty references unknown plan ${String(reference.plan)}` })
        } else if (!plan.tasks.some((task) => task.id === reference.id)) {
          violations.push({ code: 'DUTY_REF_MISSING', id: duty.id, message: `duty references unknown task ${String(reference.id)}` })
        }
      }
    }
    for (const transition of Array.isArray(duty.history) ? duty.history : []) {
      if (!isRecord(transition) || transition.from === null) continue
      const allowed = DUTY_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'DUTY_EDGE', id: duty.id, message: `duty moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (duty.status === 'submitted') {
      if (typeof duty.summary !== 'string' || duty.summary.trim().length === 0) {
        violations.push({ code: 'DUTY_SUMMARY_MISSING', id: duty.id, message: 'submitted duty has no summary' })
      }
      if (!Array.isArray(duty.evidence) || duty.evidence.length === 0) {
        violations.push({ code: 'DUTY_EVIDENCE_MISSING', id: duty.id, message: 'submitted duty has no evidence' })
      }
    }
    if (duty.status === 'verified') {
      if (typeof duty.review !== 'string' || duty.review.trim().length === 0) {
        violations.push({ code: 'DUTY_REVIEW_MISSING', id: duty.id, message: 'verified duty has no owner review' })
      }
      if (!Array.isArray(duty.evidence) || duty.evidence.length === 0) {
        violations.push({ code: 'DUTY_EVIDENCE_MISSING', id: duty.id, message: 'verified duty has no evidence' })
      }
    }
    if (duty.status === 'rejected' && (typeof duty.review !== 'string' || duty.review.trim().length === 0)) {
      violations.push({ code: 'DUTY_REVIEW_MISSING', id: duty.id, message: 'rejected duty has no reason in review' })
    }
  }

  const summary = {
    goals: Object.keys(state.goals).length,
    plans: Object.keys(state.plans).length,
    duties: Object.keys(state.duties).length,
    goalStates,
    dutyStates,
    journal: {
      entries: journal.entries,
      dropped: journal.dropped,
      head: journal.head,
      verified: journal.ok,
    },
  }
  return { ok: violations.length === 0, violations, warnings, summary }
}
