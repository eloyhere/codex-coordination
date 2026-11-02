/**
 * The model-facing tool surface.
 *
 * Five tools, one per question a collaborating model actually asks:
 *
 * | tool | question |
 * | --- | --- |
 * | `coordination_status` | where does this ledger stand? |
 * | `coordination_goal` | what outcome are we committed to? |
 * | `coordination_plan` | what are the bounded steps, and which may start? |
 * | `coordination_handoff` | who owes what, and has it been accepted? |
 * | `coordination_check` | is the record internally consistent? |
 *
 * Every tool takes `workspace` (an absolute repository root) because the MCP
 * server's own working directory is the installed plugin, not the project the
 * user opened. Descriptions say what the tool cannot do — record truth, run
 * acceptance checks, authenticate identity — because a model that over-trusts a
 * ledger entry is worse than one that never used it.
 *
 * @module codex-coordination/tools
 */

import {
  ERROR_CODES,
  fail,
  isRecord,
  requireEnum,
  requireId,
  requireString,
} from './amp.mjs'
import { DUTY_ACTIONS, assignDuty, getDuty, listDuties, pendingDutyActions, transitionDuty } from './collaboration.mjs'
import { auditLedger } from './check.mjs'
import { GOAL_HORIZONS, GOAL_STATES, createGoal, getGoal, listGoals, transitionGoal } from './goals.mjs'
import { PLAN_STATUSES, TASK_STATUSES, createPlan, getPlan, listPlans, planProgress, transitionPlan, updateTask } from './plans.mjs'
import { buildStatus } from './status.mjs'
import { ledgerPath, peekState, resolveWorkspace, verifyJournal, withLedger } from './store.mjs'

/** Maximum rows one list action returns. */
const MAX_LIMIT = 50

/** Default rows one list action returns. */
const DEFAULT_LIMIT = 10

/** The shared `workspace` property, documented once. */
const WORKSPACE_PROPERTY = {
  type: 'string',
  description:
    'Absolute path to the repository root that owns the ledger. Required: the server does not guess, because its own working directory is the installed plugin.',
}

/**
 * Read an integer limit from raw arguments.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {number} 1-{@link MAX_LIMIT}, defaulting to 10.
 */
function readLimit(args) {
  const raw = args.limit
  if (raw === undefined) return DEFAULT_LIMIT
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `limit must be an integer 1-${MAX_LIMIT}`, { field: 'limit' })
  }
  return raw
}

/**
 * Read and validate the `action` argument.
 * @param {Record<string, unknown>} args - tool arguments.
 * @param {readonly string[]} allowed - accepted actions.
 * @returns {string} the action.
 */
function readAction(args, allowed) {
  return requireEnum(args.action, allowed, 'action')
}

/**
 * Read an optional filter object.
 * @param {unknown} raw - the raw `filter` value.
 * @returns {Record<string, unknown>} the filter (may be empty).
 */
function readFilter(raw) {
  if (raw === undefined) return {}
  if (!isRecord(raw)) fail(ERROR_CODES.INVALID_ARGUMENT, 'filter must be an object', { field: 'filter' })
  return raw
}

/**
 * Wrap a mutation in one ledger transaction and surface the workspace.
 * @template T
 * @param {Record<string, unknown>} args - tool arguments carrying `workspace`.
 * @param {(context: { state: Record<string, any>, record: Function }) => T} mutate - the mutation.
 * @returns {Promise<{ workspace: string, value: T }>} the workspace and result.
 */
async function mutate(args, mutate) {
  const workspace = resolveWorkspace(args.workspace)
  const value = await withLedger(workspace, (context) => mutate(context))
  return { workspace, value }
}

/** The five tool definitions, in prompt order. */
export const TOOLS = [
  {
    name: 'coordination_status',
    description: [
      'Summarise the coordination ledger of one repository: goals, plans, duties, the tasks that can start now, who is waiting on whom, the ledger head digest and the number of open audit violations.',
      'Read this first in any session that is expected to continue earlier work; it is the cheap answer to "what is already agreed".',
      'It never mutates the ledger and never returns the whole journal, so it is safe to call often.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: 'Rows per section (goals, plans, duties, ready tasks).' },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the status projection.
     */
    async handler(args) {
      const workspace = resolveWorkspace(args.workspace)
      const state = peekState(workspace)
      return { ...buildStatus(state, { workspace, limit: readLimit(args) }), ok: true }
    },
  },

  {
    name: 'coordination_goal',
    description: [
      'Create, inspect or advance an AMP goal: an outcome with at least one observable success criterion, a value in [0,1] and a lifecycle of proposed -> committed -> active -> achieved|abandoned.',
      'Use `list`/`get` before creating anything, so an existing goal is reused instead of duplicated.',
      'Transitioning to "achieved" requires every plan linked to the goal to be settled (done or abandoned). It records your assertion that the checks passed; it cannot run them, so perform each success check first and report the result honestly. Marking a goal achieved is never proof that the outcome is true.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'action'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: ['list', 'get', 'create', 'transition'], description: 'list: read goals; get: one goal; create: store a new goal; transition: move a goal along one legal edge.' },
        id: { type: 'string', description: 'Goal id (required for get and transition).' },
        state: { type: 'string', enum: [...GOAL_STATES], description: 'Target state (transition only). Legal edges: proposed->committed|abandoned, committed->active|abandoned, active->achieved|abandoned.' },
        note: { type: 'string', description: 'Optional explanation stored in the goal history (transition only).' },
        goal: {
          type: 'object',
          additionalProperties: true,
          description: 'The AMP Goal to create: {amp:"0.1", kind:"goal", id, statement, success:[{id,statement,check,kind?}], value, priority, horizon?, deadline?}.',
          required: ['id', 'statement', 'success', 'value'],
          properties: {
            amp: { type: 'string', const: '0.1' },
            kind: { type: 'string', const: 'goal' },
            id: { type: 'string', description: 'Id matching ^[a-z][a-z0-9._:-]{0,63}$.' },
            statement: { type: 'string', description: 'One sentence naming the observable outcome.' },
            success: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'statement', 'check'],
                properties: {
                  id: { type: 'string' },
                  statement: { type: 'string' },
                  check: { type: 'string', description: 'How a human or model actually verifies this criterion.' },
                  kind: { type: 'string', enum: ['observe', 'query', 'assert'] },
                },
              },
            },
            value: { type: 'number', minimum: 0, maximum: 1 },
            priority: { type: 'integer', minimum: 0, default: 0 },
            horizon: { type: 'string', enum: [...GOAL_HORIZONS] },
            deadline: { type: 'string', description: 'RFC 3339 timestamp with timezone.' },
          },
        },
        filter: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional filters for action "list".',
          properties: {
            state: { type: 'string', enum: [...GOAL_STATES] },
            horizon: { type: 'string', enum: [...GOAL_HORIZONS] },
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the result.
     */
    async handler(args) {
      const action = readAction(args, ['list', 'get', 'create', 'transition'])
      if (action === 'list') {
        const workspace = resolveWorkspace(args.workspace)
        const filter = readFilter(args.filter)
        const goals = listGoals(peekState(workspace), {
          state: filter.state === undefined ? undefined : requireEnum(filter.state, GOAL_STATES, 'filter.state'),
          horizon: filter.horizon === undefined ? undefined : requireEnum(filter.horizon, GOAL_HORIZONS, 'filter.horizon'),
          limit: readLimit(args),
        })
        return { ok: true, workspace, goals }
      }
      if (action === 'get') {
        const workspace = resolveWorkspace(args.workspace)
        return { ok: true, workspace, goal: getGoal(peekState(workspace), args.id) }
      }
      if (action === 'create') {
        const { workspace, value } = await mutate(args, (context) => createGoal(context, args.goal))
        return { ok: true, workspace, goal: value }
      }
      const { workspace, value } = await mutate(args, (context) => transitionGoal(context, args.id, args.state, args.note))
      return { ok: true, workspace, goal: value }
    },
  },

  {
    name: 'coordination_plan',
    description: [
      'Create, inspect or advance a bounded plan: at most 12 tasks, each with an intent, an actor, predecessor tasks (pre), an expected observation, a check and an irreversibility score 0-3.',
      'Dependencies are declared on the task (pre) and the edge list is derived, so the graph is always acyclic and a task cannot start or be declared done before its predecessors are done.',
      'A new plan is a draft: commit it before moving any task. Starting the first task promotes the plan to "executing"; `transition` to "done" is accepted only when every task is done, failed or skipped.',
      'Write the check as something somebody can actually run or look at. The ledger records that you wrote it; it does not run it for you.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'action'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: ['list', 'get', 'create', 'task', 'transition'], description: 'list: read plans; get: one plan with its tasks; create: store a new draft; task: move one task; transition: move the plan itself.' },
        id: { type: 'string', description: 'Plan id (required for get, task and transition).' },
        status: { type: 'string', enum: [...PLAN_STATUSES], description: 'Target plan status (transition only).' },
        note: { type: 'string', description: 'Optional explanation stored in the history (transition only).' },
        task: {
          type: 'object',
          additionalProperties: false,
          description: 'Task move (action "task"): {id, status, note?}.',
          required: ['id', 'status'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: [...TASK_STATUSES] },
            note: { type: 'string' },
          },
        },
        plan: {
          type: 'object',
          additionalProperties: true,
          description: 'The AMP Plan to create: {amp:"0.1", kind:"plan", id, goal?, tasks:[...], commitmentWindow?, budget?, abandonIf?, rollback?}.',
          required: ['id', 'tasks'],
          properties: {
            amp: { type: 'string', const: '0.1' },
            kind: { type: 'string', const: 'plan' },
            id: { type: 'string', description: 'Id matching ^[a-z][a-z0-9._:-]{0,63}$.' },
            goal: {
              type: 'object',
              additionalProperties: false,
              description: 'Optional goal this plan serves; must already exist.',
              required: ['id'],
              properties: { kind: { type: 'string', const: 'goal' }, id: { type: 'string' } },
            },
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'intent', 'actor', 'expect'],
                properties: {
                  id: { type: 'string' },
                  intent: { type: 'string', description: 'What this task accomplishes, in one sentence.' },
                  actor: { type: 'string', enum: ['self', 'tool', 'other'] },
                  pre: { type: 'array', items: { type: 'string' }, description: 'Predecessor task ids inside this plan.' },
                  expect: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['observation', 'check'],
                    properties: {
                      observation: { type: 'string', description: 'What should be observed when the task has run.' },
                      check: { type: 'string', description: 'How that observation is verified.' },
                    },
                  },
                  irreversibility: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
                  budget: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      tokens: { type: 'number', minimum: 0 },
                      ms: { type: 'number', minimum: 0 },
                      calls: { type: 'number', minimum: 0 },
                      interrupts: { type: 'number', minimum: 0 },
                      money: { type: 'number', minimum: 0 },
                    },
                  },
                },
              },
            },
            commitmentWindow: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
            budget: { type: 'object', additionalProperties: true },
            abandonIf: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'statement', 'check'],
                properties: {
                  id: { type: 'string' },
                  statement: { type: 'string' },
                  check: { type: 'string' },
                  kind: { type: 'string', enum: ['observe', 'query', 'assert'] },
                },
              },
            },
            rollback: { type: 'string' },
          },
        },
        filter: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional filters for action "list".',
          properties: {
            status: { type: 'string', enum: [...PLAN_STATUSES] },
            goal: { type: 'string' },
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the result.
     */
    async handler(args) {
      const action = readAction(args, ['list', 'get', 'create', 'task', 'transition'])
      if (action === 'list') {
        const workspace = resolveWorkspace(args.workspace)
        const filter = readFilter(args.filter)
        const plans = listPlans(peekState(workspace), {
          status: filter.status === undefined ? undefined : requireEnum(filter.status, PLAN_STATUSES, 'filter.status'),
          goal: filter.goal === undefined ? undefined : requireId(filter.goal, 'filter.goal'),
          limit: readLimit(args),
        })
        return { ok: true, workspace, plans }
      }
      if (action === 'get') {
        const workspace = resolveWorkspace(args.workspace)
        return { ok: true, workspace, plan: planProgress(getPlan(peekState(workspace), args.id)) }
      }
      if (action === 'create') {
        const { workspace, value } = await mutate(args, (context) => createPlan(context, args.plan))
        return { ok: true, workspace, plan: planProgress(value) }
      }
      if (action === 'task') {
        const task = isRecord(args.task) ? args.task : fail(ERROR_CODES.INVALID_ARGUMENT, 'task must be an object', { field: 'task' })
        const { workspace, value } = await mutate(args, (context) => updateTask(context, args.id, task.id, task.status, task.note))
        return { ok: true, workspace, plan: planProgress(value) }
      }
      const { workspace, value } = await mutate(args, (context) => transitionPlan(context, args.id, args.status, args.note))
      return { ok: true, workspace, plan: planProgress(value) }
    },
  },

  {
    name: 'coordination_handoff',
    description: [
      'Record an accountable handoff between two declared identities: owner assigns a duty with responsibilities and acceptance criteria, the assignee accepts, starts, and submits a summary plus evidence, and only the owner verifies or rejects it.',
      'Identity is declared, not authenticated: pass `actor` and the server rejects a move by anyone other than the recorded owner or assignee, but it cannot prove who is calling. Treat it as a coordination record, not an access-control boundary.',
      'verify records the owner\'s review of the submitted evidence. It does not run the acceptance criteria, so inspecting the artifacts is still your job. Never submit fabricated evidence or a passing review.',
      'Use a plan task reference (plan + task) when the duty is one step of a plan; the reference is validated against the ledger.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'action'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: [...DUTY_ACTIONS], description: 'assign creates a duty; accept/start/submit are the assignee\'s moves; verify/reject/cancel are the owner\'s.' },
        id: { type: 'string', description: 'Duty id (required for every action except assign and list).' },
        duty: {
          type: 'object',
          additionalProperties: true,
          description: 'The duty to assign: {id, role, owner, assignee, responsibilities:[], acceptance:[], goal?|plan?|task?}.',
          required: ['id', 'role', 'owner', 'assignee', 'responsibilities', 'acceptance'],
          properties: {
            amp: { type: 'string', const: '0.1' },
            kind: { type: 'string', const: 'duty' },
            id: { type: 'string' },
            role: { type: 'string', enum: ['decision', 'outcome', 'resource', 'personnel', 'qualification', 'execution'] },
            owner: { type: 'string', description: 'Identity accountable for accepting the result.' },
            assignee: { type: 'string', description: 'Identity doing the work; must differ from owner.' },
            responsibilities: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
            acceptance: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
            goal: { type: 'string', description: 'Optional goal id this duty serves.' },
            plan: { type: 'string', description: 'Optional plan id this duty belongs to.' },
            task: { type: 'string', description: 'Optional task id inside `plan`.' },
          },
        },
        actor: { type: 'string', description: 'Declared identity performing the move; checked against owner/assignee.' },
        summary: { type: 'string', description: 'What was done (required for submit).' },
        evidence: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Concrete artifacts, commands and observed outcomes (required for submit).' },
        review: { type: 'string', description: 'Owner review naming the acceptance checks actually performed (required for verify and reject).' },
        note: { type: 'string', description: 'Optional note stored in the duty history.' },
        filter: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional filters for action "list".',
          properties: {
            status: { type: 'string', enum: ['assigned', 'accepted', 'started', 'submitted', 'verified', 'rejected', 'cancelled'] },
            owner: { type: 'string' },
            assignee: { type: 'string' },
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the result.
     */
    async handler(args) {
      const action = readAction(args, DUTY_ACTIONS)
      if (action === 'list') {
        const workspace = resolveWorkspace(args.workspace)
        const filter = readFilter(args.filter)
        const state = peekState(workspace)
        const duties = listDuties(state, {
          status: filter.status === undefined ? undefined : requireString(filter.status, 'filter.status', { max: 32 }),
          owner: filter.owner === undefined ? undefined : requireString(filter.owner, 'filter.owner', { max: 256 }),
          assignee: filter.assignee === undefined ? undefined : requireString(filter.assignee, 'filter.assignee', { max: 256 }),
          limit: readLimit(args),
        })
        return { ok: true, workspace, duties, waitingOnPeople: pendingDutyActions(state) }
      }
      if (action === 'get') {
        const workspace = resolveWorkspace(args.workspace)
        return { ok: true, workspace, duty: getDuty(peekState(workspace), args.id) }
      }
      if (action === 'assign') {
        const { workspace, value } = await mutate(args, (context) => assignDuty(context, args.duty))
        return { ok: true, workspace, duty: value }
      }
      const { workspace, value } = await mutate(args, (context) => transitionDuty(context, {
        id: args.id,
        action,
        actor: args.actor,
        summary: args.summary,
        evidence: args.evidence,
        review: args.review,
        note: args.note,
      }))
      return { ok: true, workspace, duty: value }
    },
  },

  {
    name: 'coordination_check',
    description: [
      'Audit the ledger: verify the hash-chained journal, then check every goal, plan and duty against the protocol rules (legal lifecycle edges, acyclic dependencies, checks present, verified handoffs with evidence and review, references that resolve).',
      'Returns {ok, violations, warnings, summary, journal}. A violation is something the protocol forbids and should be repaired before reporting a result; a warning is legal but worth a look.',
      'This audits consistency only. It cannot tell you whether the work described is correct or whether the evidence is true.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 10, description: 'How many recent journal entries to return.' },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the verdict.
     */
    async handler(args) {
      const workspace = resolveWorkspace(args.workspace)
      const state = peekState(workspace)
      const verdict = auditLedger(state)
      const chain = verifyJournal(state)
      const limit = readLimit(args)
      return {
        ...verdict,
        workspace,
        ledger: {
          path: ledgerPath(workspace),
          seq: state.seq,
          head: state.head ?? null,
          entries: chain.entries,
          dropped: chain.dropped,
        },
        journal: chain.ok && Array.isArray(state.journal)
          ? state.journal.slice(-limit).map((entry) => ({
            seq: entry.seq,
            at: entry.at,
            type: entry.type,
            ...(entry.id === undefined ? {} : { id: entry.id }),
            digest: entry.digest,
          }))
          : [],
      }
    },
  },
]

/** Names in registration order, used by the server and the smoke test. */
export const TOOL_NAMES = TOOLS.map((tool) => tool.name)

/**
 * Look up one tool by name.
 * @param {string} name - tool name.
 * @returns {typeof TOOLS[number]|undefined} the definition.
 */
export function toolNamed(name) {
  return TOOLS.find((tool) => tool.name === name)
}
