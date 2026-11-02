/**
 * Structural audit of a coordination ledger.
 *
 * The audit answers one question: "is this record internally consistent?" It
 * never asks whether the work was any good. Every violation names the record and
 * the rule it broke, because the point of the tool is to let a model repair its
 * own bookkeeping before it reports a result.
 *
 * Two families are checked:
 *
 * - **The chain.** `verifyChain` recomputes every hash from its four covered
 *   fields and the tip. A mismatch means the file was edited outside the tools;
 *   the audit reports it and never rewrites it.
 * - **The artifacts and projections.** Goal and Plan artifacts must still be
 *   shaped like AMP objects, lifecycle edges must be legal, and a record that
 *   claims a result must carry the record that supports it.
 *
 * Violations are things the protocol forbids; warnings are things that are legal
 * but worth a look (an active goal with no plan).
 *
 * @module codex-coordination/check
 */

import { isRecord } from './amp.mjs'
import { GOAL_EDGES, GOAL_STATES, linkedPlans } from './goals.mjs'
import { PLAN_EDGES, PLAN_STATUSES, TERMINAL_TASK_STATUSES } from './plans.mjs'
import { DUTY_EDGES, DUTY_STATUSES } from './collaboration.mjs'
import { verifyChain } from './store.mjs'

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

  const chain = verifyChain(state)
  for (const problem of chain.problems) {
    violations.push({ code: 'LEDGER_CHAIN', id: 'ledger', message: 'the AMP chain does not verify', details: problem })
  }

  const goalStates = {}
  for (const [key, record] of Object.entries(state.goals)) {
    if (!isRecord(record) || !isRecord(record.artifact) || !isRecord(record.lifecycle)) {
      violations.push({ code: 'GOAL_RECORD', id: key, message: 'goal is not an artifact plus a lifecycle record' })
      continue
    }
    const artifact = record.artifact
    const stateName = record.lifecycle.state
    goalStates[stateName] = (goalStates[stateName] ?? 0) + 1
    if (artifact.kind !== 'goal' || artifact.amp !== '0.1') {
      violations.push({ code: 'GOAL_ARTIFACT', id: key, message: 'goal.artifact is not an AMP Goal' })
    }
    if (artifact.id !== key) {
      violations.push({ code: 'GOAL_ARTIFACT_ID', id: key, message: `goal.artifact.id is ${String(artifact.id)}` })
    }
    if (!GOAL_STATES.includes(stateName)) {
      violations.push({ code: 'GOAL_STATE', id: key, message: `unknown goal state ${String(stateName)}` })
    }
    if (!Array.isArray(artifact.success) || artifact.success.length === 0) {
      violations.push({ code: 'GOAL_SUCCESS_MISSING', id: key, message: 'goal has no success criteria' })
    } else {
      for (const criterion of artifact.success) {
        if (!isRecord(criterion) || typeof criterion.check !== 'string' || criterion.check.trim().length === 0) {
          violations.push({ code: 'GOAL_CHECK_MISSING', id: key, message: `success criterion ${String(criterion?.id)} has no check` })
        }
      }
    }
    if (typeof artifact.value !== 'number' || artifact.value < 0 || artifact.value > 1) {
      violations.push({ code: 'GOAL_VALUE', id: key, message: 'goal.value is outside [0, 1]' })
    }
    const history = Array.isArray(record.history) ? record.history : []
    const last = history[history.length - 1]
    if (!isRecord(last) || last.to !== stateName) {
      violations.push({ code: 'GOAL_HISTORY', id: key, message: 'goal history does not end at its current state' })
    }
    for (const transition of history) {
      if (!isRecord(transition) || transition.from === null) continue
      const allowed = GOAL_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'GOAL_EDGE', id: key, message: `goal moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (stateName === 'achieved') {
      const unfinished = linkedPlans(state, key)
        .filter((plan) => plan.artifact.status !== 'done' && plan.artifact.status !== 'abandoned')
      for (const plan of unfinished) {
        violations.push({
          code: 'GOAL_ACHIEVED_WITH_PLAN',
          id: key,
          message: `achieved goal still has plan ${plan.artifact.id} in ${plan.artifact.status}`,
        })
      }
    }
    if (stateName === 'active' && linkedPlans(state, key).length === 0) {
      warnings.push({ code: 'GOAL_ACTIVE_NO_PLAN', id: key, message: 'active goal has no plan recording how it will be reached' })
    }
  }

  const planStates = {}
  for (const [key, record] of Object.entries(state.plans)) {
    if (!isRecord(record) || !isRecord(record.artifact)) {
      violations.push({ code: 'PLAN_RECORD', id: key, message: 'plan is not an artifact record' })
      continue
    }
    const artifact = record.artifact
    planStates[artifact.status] = (planStates[artifact.status] ?? 0) + 1
    if (artifact.kind !== 'plan' || artifact.amp !== '0.1') {
      violations.push({ code: 'PLAN_ARTIFACT', id: key, message: 'plan.artifact is not an AMP Plan' })
    }
    if (artifact.id !== key) {
      violations.push({ code: 'PLAN_ARTIFACT_ID', id: key, message: `plan.artifact.id is ${String(artifact.id)}` })
    }
    if (!PLAN_STATUSES.includes(artifact.status)) {
      violations.push({ code: 'PLAN_STATE', id: key, message: `unknown plan state ${String(artifact.status)}` })
    }
    if (!Array.isArray(artifact.abandon_if) || artifact.abandon_if.length === 0) {
      violations.push({ code: 'PLAN_ABANDON_IF_MISSING', id: key, message: 'plan has no abandon_if condition' })
    }
    if (!isRecord(artifact.goal) || !isRecord(state.goals[artifact.goal.id])) {
      violations.push({ code: 'PLAN_GOAL_MISSING', id: key, message: `plan references unknown goal ${String(artifact.goal?.id)}` })
    }
    if (typeof artifact.commitment_window !== 'number' || artifact.commitment_window < 1 || artifact.commitment_window > 5) {
      violations.push({ code: 'PLAN_WINDOW', id: key, message: 'plan.commitment_window is outside 1-5' })
    }
    if (!Array.isArray(artifact.tasks) || artifact.tasks.length === 0) {
      violations.push({ code: 'PLAN_EMPTY', id: key, message: 'plan has no tasks' })
      continue
    }
    const ids = new Set()
    for (const task of artifact.tasks) {
      if (ids.has(task.id)) violations.push({ code: 'TASK_DUPLICATE', id: key, message: `task id ${task.id} repeats` })
      ids.add(task.id)
      if (!isRecord(task.expect) || typeof task.expect.check !== 'string' || task.expect.check.trim().length === 0) {
        violations.push({ code: 'TASK_CHECK_MISSING', id: key, message: `task ${task.id} has no expected check` })
      }
      for (const dependency of Array.isArray(task.pre) ? task.pre : []) {
        if (!artifact.tasks.some((candidate) => candidate.id === dependency)) {
          violations.push({ code: 'TASK_PRE_MISSING', id: key, message: `task ${task.id} depends on unknown task ${dependency}` })
        }
      }
    }
    for (const id of cyclicTaskIds(artifact.tasks)) {
      violations.push({ code: 'PLAN_CYCLE', id: key, message: `task dependencies contain a cycle through ${id}` })
    }
    for (const transition of Array.isArray(record.history) ? record.history : []) {
      if (!isRecord(transition) || transition.from === null || transition.task !== undefined) continue
      const allowed = PLAN_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'PLAN_EDGE', id: key, message: `plan moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (artifact.status === 'done') {
      const unfinished = artifact.tasks.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status)).map((task) => task.id)
      if (unfinished.length > 0) {
        violations.push({ code: 'PLAN_DONE_WITH_TASKS', id: key, message: `done plan still has ${unfinished.length} unfinished task(s)` })
      }
    }
    const derived = []
    for (const task of artifact.tasks) {
      for (const dependency of Array.isArray(task.pre) ? task.pre : []) derived.push(`${dependency}>${task.id}`)
    }
    const recorded = Array.isArray(artifact.edges) ? artifact.edges.map((edge) => `${edge[0]}>${edge[1]}`) : derived
    if (derived.length !== recorded.length || derived.some((edge) => !recorded.includes(edge))) {
      violations.push({ code: 'PLAN_EDGES_DRIFT', id: key, message: 'plan.edges no longer match the task predecessors' })
    }
  }

  const dutyStates = {}
  for (const [key, duty] of Object.entries(state.duties)) {
    if (!isRecord(duty)) {
      violations.push({ code: 'DUTY_RECORD', id: key, message: 'duty is not a record' })
      continue
    }
    dutyStates[duty.status] = (dutyStates[duty.status] ?? 0) + 1
    if (!DUTY_STATUSES.includes(duty.status)) {
      violations.push({ code: 'DUTY_STATE', id: key, message: `unknown duty state ${String(duty.status)}` })
    }
    if (duty.id !== key) {
      violations.push({ code: 'DUTY_ID', id: key, message: `duty.id is ${String(duty.id)}` })
    }
    if (isRecord(duty.reference)) {
      const reference = duty.reference
      if (reference.kind === 'goal' && !isRecord(state.goals[reference.id])) {
        violations.push({ code: 'DUTY_REF_MISSING', id: key, message: `duty references unknown goal ${String(reference.id)}` })
      }
      if (reference.kind === 'plan' && !isRecord(state.plans[reference.id])) {
        violations.push({ code: 'DUTY_REF_MISSING', id: key, message: `duty references unknown plan ${String(reference.id)}` })
      }
      if (reference.kind === 'task') {
        const plan = state.plans[reference.plan]
        const tasks = isRecord(plan) && isRecord(plan.artifact) && Array.isArray(plan.artifact.tasks) ? plan.artifact.tasks : []
        if (!isRecord(plan)) {
          violations.push({ code: 'DUTY_REF_MISSING', id: key, message: `duty references unknown plan ${String(reference.plan)}` })
        } else if (!tasks.some((task) => task.id === reference.id)) {
          violations.push({ code: 'DUTY_REF_MISSING', id: key, message: `duty references unknown task ${String(reference.id)}` })
        }
      }
    }
    for (const transition of Array.isArray(duty.history) ? duty.history : []) {
      if (!isRecord(transition) || transition.from === null) continue
      const allowed = DUTY_EDGES[transition.from] ?? []
      if (!allowed.includes(transition.to)) {
        violations.push({ code: 'DUTY_EDGE', id: key, message: `duty moved ${transition.from} -> ${transition.to} off the legal edges` })
      }
    }
    if (duty.status === 'submitted') {
      if (typeof duty.summary !== 'string' || duty.summary.trim().length === 0) {
        violations.push({ code: 'DUTY_SUMMARY_MISSING', id: key, message: 'submitted duty has no summary' })
      }
      if (!Array.isArray(duty.evidence) || duty.evidence.length === 0) {
        violations.push({ code: 'DUTY_EVIDENCE_MISSING', id: key, message: 'submitted duty has no evidence' })
      }
    }
    if (duty.status === 'verified') {
      if (typeof duty.review !== 'string' || duty.review.trim().length === 0) {
        violations.push({ code: 'DUTY_REVIEW_MISSING', id: key, message: 'verified duty has no owner review' })
      }
      if (!Array.isArray(duty.evidence) || duty.evidence.length === 0) {
        violations.push({ code: 'DUTY_EVIDENCE_MISSING', id: key, message: 'verified duty has no evidence' })
      }
    }
    if (duty.status === 'rejected' && (typeof duty.review !== 'string' || duty.review.trim().length === 0)) {
      violations.push({ code: 'DUTY_REVIEW_MISSING', id: key, message: 'rejected duty has no reason in review' })
    }
  }

  const summary = {
    goals: Object.keys(state.goals).length,
    plans: Object.keys(state.plans).length,
    duties: Object.keys(state.duties).length,
    goalStates,
    planStates,
    dutyStates,
    chain: {
      count: chain.count,
      tip: chain.tip,
      verified: chain.ok,
    },
  }
  return { ok: violations.length === 0, violations, warnings, summary }
}
