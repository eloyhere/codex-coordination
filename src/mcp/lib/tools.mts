/**
 * The model-facing tool surface.
 *
 * Coordination tools plus the protocol and interactive dashboard entrypoints:
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
 * user opened.
 *
 * The result shapes separate the protocol from the host:
 *
 * - `goal` and `plan` are **AMP artifacts** and validate unchanged against the
 *   published schemas; lifecycle, history and progress travel beside them;
 * - `duty` is a host projection, and the tool says so;
 * - `coordination_check` can return the `ledger-snapshot` itself, which is the
 *   artifact AMP defines for an append-only chain.
 *
 * Descriptions say what the tools cannot do — record truth, run acceptance
 * checks, authenticate identity — because a model that over-trusts a ledger entry
 * is worse than one that never used it.
 *
 * @module codex-coordination/tools
 */

import {
  AMP_VERSION,
  ERROR_CODES,
  REF_KINDS,
  fail,
  isRecord,
  requireEnum,
  requireId,
  requireString,
} from './amp.mjs'
import { DUTY_ACTIONS, assignDuty, getDuty, listDuties, pendingDutyActions, transitionDuty } from './collaboration.mjs'
import { auditLedger } from './check.mjs'
import { GOAL_HORIZONS, GOAL_STATES, createGoal, getGoal, goalView, listGoals, transitionGoal } from './goals.mjs'
import { PLAN_STATUSES, TASK_STATUSES, createPlan, getPlan, listPlans, planView, transitionPlan, updateTask } from './plans.mjs'
import { buildStatus } from './status.mjs'
import { chainEntries, ledgerPath, peekState, resolveWorkspace, snapshotOf, verifyChain, withLedger } from './store.mjs'
import { SCHEMAS, schemaFor, requireArtifact, validateArtifact } from './protocol.mjs'
import { DASHBOARD_URI, dashboardData, protocolInfo } from './dashboard.mjs'
import { AMP_TOOLS, ampHost } from '../amp/host.mjs'
import { withCoordinationTools } from '../coordination/tools.mjs'

export interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, any>
  _meta?: Record<string, unknown>
  annotations?: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<Record<string, any>>
}

/** Maximum rows one list action returns. */
const MAX_LIMIT = 50

/** Default rows one list action returns. */
const DEFAULT_LIMIT = 10

/** The `coordination_check` actions. */
const CHECK_ACTIONS = Object.freeze(['audit', 'snapshot'])

/** The shared `workspace` property, documented once. */
const WORKSPACE_PROPERTY = {
  type: 'string',
  description:
    'Absolute path to the repository root that owns the ledger. Required: the server does not guess, because its own working directory is the installed plugin.',
}

/** The shared AMP `Ref` shape. */
const REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: [...REF_KINDS] },
    id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
    label: { type: 'string' },
  },
}

/** The shared AMP `Budget` shape. */
const BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tokens: { type: 'integer', minimum: 0 },
    ms: { type: 'integer', minimum: 0 },
    calls: { type: 'integer', minimum: 0 },
    interrupts: { type: 'integer', minimum: 0 },
    money: { type: 'number', minimum: 0 },
  },
}

/** The shared AMP `Criterion` shape. */
const CRITERION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'statement', 'check'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
    statement: { type: 'string' },
    check: { type: 'string', description: 'How a human or model actually verifies this criterion.' },
    kind: { type: 'string', enum: ['observe', 'query', 'assert'] },
  },
}

/**
 * Read an integer limit from raw arguments.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {number} 1-{@link MAX_LIMIT}, defaulting to 10.
 */
function readLimit(args: Record<string, unknown>) {
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
 * @param {string} [fallback] - value used when the argument is absent.
 * @returns {string} the action.
 */
function readAction<T extends string>(args: Record<string, unknown>, allowed: readonly string[], fallback?: string) {
  if (args.action === undefined && fallback !== undefined) return fallback
  return requireEnum(args.action, allowed, 'action')
}

/**
 * Read an optional filter object.
 * @param {unknown} raw - the raw `filter` value.
 * @returns {Record<string, unknown>} the filter (may be empty).
 */
function readFilter(raw: unknown) {
  if (raw === undefined) return {}
  if (!isRecord(raw)) fail(ERROR_CODES.INVALID_ARGUMENT, 'filter must be an object', { field: 'filter' })
  return raw
}

/**
 * Wrap a mutation in one ledger transaction and surface the workspace.
 * @template T
 * @param {Record<string, unknown>} args - tool arguments carrying `workspace`.
 * @param {(context: { state: Record<string, any>, append: Function }) => T} mutate - the mutation.
 * @returns {Promise<{ workspace: string, value: T }>} the workspace and result.
 */
async function mutate<T>(args: Record<string, unknown>, mutate: (context: { state: Record<string, any>, append: Function }) => T) {
  const workspace = resolveWorkspace(args.workspace)
  const value = await withLedger(workspace, (context: any) => mutate(context))
  return { workspace, value }
}

/** Tool definitions, in prompt order. */
const BASE_TOOLS: ToolDefinition[] = [
  ...AMP_TOOLS,
  {
    name: 'coordination_status',
    description: [
      'Summarise the coordination ledger of one repository: goals, plans, duties, the tasks that can start now, who is waiting on whom, the AMP chain tip and the number of open audit violations.',
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
    async handler(args: Record<string, unknown>) {
      const workspace = resolveWorkspace(args.workspace)
      const state = peekState(workspace)
      return buildStatus(state, { workspace, limit: readLimit(args) })
    },
  },

  {
    name: 'coordination_goal',
    description: [
      'Create, inspect or advance an AMP Goal: an outcome with at least one observable success criterion, a value in [0,1], a nonnegative priority and a lifecycle of proposed -> committed -> active -> achieved|abandoned.',
      'The result carries `goal` (the strict AMP Goal artifact) beside `lifecycle` (state, startedAt, achievedAt), `createdAt`, `updatedAt` and `history`.',
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
        note: { type: 'string', description: 'Optional explanation stored in the goal history and the chained event (transition only).' },
        goal: {
          type: 'object',
          additionalProperties: false,
          description: 'The AMP Goal to create: {amp:"0.1", kind:"goal", id, statement, success:[{id,statement,check,kind?}], value, priority, horizon?, deadline?}. Unknown fields are rejected.',
          required: ['id', 'statement', 'success', 'value'],
          properties: {
            amp: { type: 'string', const: AMP_VERSION },
            kind: { type: 'string', const: 'goal' },
            id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
            statement: { type: 'string', description: 'One sentence naming the observable outcome.' },
            success: {
              type: 'array',
              minItems: 1,
              maxItems: 32,
              items: CRITERION_SCHEMA,
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
    async handler(args: Record<string, unknown>) {
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
        return { ok: true, workspace, ...goalView(getGoal(peekState(workspace), args.id)) }
      }
      if (action === 'create') {
        const { workspace, value } = await mutate(args, (context: any) => createGoal(context, args.goal))
        return { ok: true, workspace, ...goalView(value) }
      }
      const { workspace, value } = await mutate(args, (context: any) => transitionGoal(context, args.id, args.state, args.note))
      return { ok: true, workspace, ...goalView(value) }
    },
  },

  {
    name: 'coordination_plan',
    description: [
      'Create, inspect or advance a bounded AMP Plan: at most 12 tasks, each with an intent, an actor, predecessor tasks (pre), an expected observation, a check and an irreversibility score 0-3.',
      'A plan is a strict AMP artifact, so `goal` and `abandon_if` are required: a plan serves a goal, and a plan without a condition that would make it stop has no commitment. `edges` are derived from `pre`, `commitment_window` is 1-5 and `budget` defaults to {}.',
      'The result carries `plan` (the artifact) plus `progress` (ready and blocked tasks) and `history`. Every mutation appends the updated artifact as a `plan` chain entry.',
      'Write the check as something somebody can actually run or look at. The ledger records that you wrote it; it does not run it for you.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'action'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: ['list', 'get', 'create', 'task', 'transition'], description: 'list: read plans; get: one plan with progress; create: store a new draft; task: move one task; transition: move the plan itself.' },
        id: { type: 'string', description: 'Plan id (required for get, task and transition).' },
        status: { type: 'string', enum: [...PLAN_STATUSES], description: 'Target plan status (transition only).' },
        note: { type: 'string', description: 'Optional explanation stored in the host history (transition and task only).' },
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
          additionalProperties: false,
          description: 'The AMP Plan to create: {amp:"0.1", kind:"plan", id, goal, tasks:[...], commitment_window, budget?, abandon_if:[...], monitor?, rollback?, warrant?}. Unknown fields are rejected; edges, status and created are computed by the server.',
          required: ['id', 'goal', 'tasks', 'abandon_if'],
          properties: {
            amp: { type: 'string', const: AMP_VERSION },
            kind: { type: 'string', const: 'plan' },
            id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
            goal: { ...REF_SCHEMA, description: 'Goal this plan serves; must already exist. kind must be "goal".' },
            process: { ...REF_SCHEMA, description: 'Optional process reference.' },
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'intent', 'actor', 'expect'],
                properties: {
                  id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
                  intent: { type: 'string', description: 'What this task accomplishes, in one sentence.' },
                  actor: { type: 'string', enum: ['self', 'tool', 'other'] },
                  ref: { ...REF_SCHEMA, description: 'Optional reference the task operates on.' },
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
                  budget: BUDGET_SCHEMA,
                  status: { type: 'string', enum: ['pending'], description: 'An AMP PlanTask carries a status; a new task may only be pending.' },
                },
              },
            },
            commitment_window: { type: 'integer', minimum: 1, maximum: 5, default: 3, description: 'How many steps to run before deliberating again (AMP spelling; camelCase is rejected).' },
            budget: BUDGET_SCHEMA,
            abandon_if: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              description: 'Conditions that would make this plan stop (AMP spelling; camelCase is rejected).',
              items: CRITERION_SCHEMA,
            },
            monitor: {
              type: 'object',
              additionalProperties: false,
              properties: {
                triggers: {
                  type: 'array',
                  maxItems: 8,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['when', 'action'],
                    properties: {
                      when: { type: 'string' },
                      action: { type: 'string', enum: ['retry', 'adjust', 'recompose', 'replan', 'abandon'] },
                    },
                  },
                },
              },
            },
            rollback: { type: 'string' },
            warrant: { ...REF_SCHEMA, description: 'Optional warrant reference.' },
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
    async handler(args: Record<string, unknown>) {
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
        return { ok: true, workspace, ...planView(getPlan(peekState(workspace), args.id)) }
      }
      if (action === 'create') {
        const { workspace, value } = await mutate(args, (context: any) => createPlan(context, args.plan))
        return { ok: true, workspace, ...planView(value) }
      }
      if (action === 'task') {
        const task = isRecord(args.task) ? args.task : fail(ERROR_CODES.INVALID_ARGUMENT, 'task must be an object', { field: 'task' })
        const { workspace, value } = await mutate(args, (context: any) => updateTask(context, args.id, task.id, task.status, task.note))
        return { ok: true, workspace, ...planView(value) }
      }
      const { workspace, value } = await mutate(args, (context: any) => transitionPlan(context, args.id, args.status, args.note))
      return { ok: true, workspace, ...planView(value) }
    },
  },

  {
    name: 'coordination_handoff',
    description: [
      'Record an accountable handoff between two declared identities: owner assigns a duty with responsibilities and acceptance criteria, the assignee accepts, starts, and submits a summary plus evidence, and only the owner verifies or rejects it.',
      'A duty is a host projection, not an AMP artifact kind: it travels as bounded `event` entries in the AMP chain, because a Codex session cannot honestly supply an AMP responsibility-assignment window or authority list.',
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
          additionalProperties: false,
          description: 'The duty to assign: {id, role, owner, assignee, responsibilities:[], acceptance:[], goal?|plan?|task?}. A duty is not an AMP object, so amp/kind are rejected.',
          required: ['id', 'role', 'owner', 'assignee', 'responsibilities', 'acceptance'],
          properties: {
            id: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,63}$' },
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
    async handler(args: Record<string, unknown>) {
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
        const { workspace, value } = await mutate(args, (context: any) => assignDuty(context, args.duty))
        return { ok: true, workspace, duty: value }
      }
      const { workspace, value } = await mutate(args, (context: any) => transitionDuty(context, {
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
      'Audit the ledger, or export its AMP artifact. `audit` (the default) verifies the hash-chained journal and checks every goal, plan and duty against the protocol rules: legal lifecycle edges, acyclic dependencies, checks present, verified handoffs with evidence and review, references that resolve.',
      '`snapshot` returns the strict AMP `ledger-snapshot` — {amp, kind:"ledger-snapshot", agent, tip, count, entries} — which verifies under the reference implementation. It refuses to export a chain that does not verify.',
      'An audit result is {ok, violations, warnings, summary, ledger, journal}. A violation is something the protocol forbids and should be repaired before reporting a result; a warning is legal but worth a look.',
      'This audits consistency only. It cannot tell you whether the work described is correct or whether the evidence is true.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: [...CHECK_ACTIONS], default: 'audit', description: 'audit: verify the chain and the records; snapshot: return the strict AMP ledger-snapshot.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 10, description: 'How many recent chain entries the audit returns.' },
      },
    },
    /**
     * @param {Record<string, unknown>} args - tool arguments.
     * @returns {Promise<Record<string, unknown>>} the verdict.
     */
    async handler(args: Record<string, unknown>) {
      const action = readAction(args, CHECK_ACTIONS, 'audit')
      const workspace = resolveWorkspace(args.workspace)
      const state = peekState(workspace)
      if (action === 'snapshot') {
        const chain = verifyChain(state)
        if (!chain.ok) {
          fail(ERROR_CODES.INVALID_STATE, 'the ledger chain does not verify; refusing to export a snapshot', {
            problems: chain.problems,
          })
        }
        return { ok: true, workspace, snapshot: snapshotOf(state) }
      }
      const verdict = auditLedger(state)
      const limit = readLimit(args)
      return {
        ...verdict,
        workspace,
        ledger: {
          path: ledgerPath(workspace),
          agent: state.agent,
          tip: verdict.summary.chain.tip,
          count: verdict.summary.chain.count,
          verified: verdict.summary.chain.verified,
        },
        journal: verdict.summary.chain.verified ? chainEntries(state).slice(-limit) : [],
      }
    },
  },
  {
    name: 'coordination_protocol',
    description: 'Discover the pinned AMP package and supported schemas, validate an AMP artifact, record an immutable attention frame or receipt, or list those records. Goal and Plan mutations still use their lifecycle tools. Schema validation and a hash bind recorded assertions; they do not prove evidence or execute work.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['workspace'],
      properties: {
        workspace: WORKSPACE_PROPERTY,
        action: { type: 'string', enum: ['describe', 'validate', 'record', 'list'], default: 'describe' },
        kind: { type: 'string', enum: Object.keys(SCHEMAS) },
        artifact: { type: 'object', description: 'A complete AMP v0.1 artifact, including its kind.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
    async handler(args) {
      const workspace = resolveWorkspace(args.workspace)
      const action = readAction(args, ['describe', 'validate', 'record', 'list'], 'describe')
      if (action === 'describe') return { ok: true, workspace, protocol: protocolInfo(), ...(args.kind === undefined ? {} : { schema: schemaFor(args.kind) }) }
      if (action === 'validate') return { workspace, ...validateArtifact(args.artifact) }
      if (action === 'list') {
        if (args.kind !== undefined) requireEnum(args.kind, ['frame', 'receipt'], 'kind')
        const rows = peekState(workspace).journal.filter((entry: any) => ['frame', 'receipt'].includes(entry.kind) && (args.kind === undefined || args.kind === entry.kind))
        return { ok: true, workspace, total: rows.length, records: rows.slice(-readLimit(args)).reverse() }
      }
      requireArtifact(args.artifact)
      const artifact = args.artifact as Record<string, any>
      requireEnum(artifact.kind, ['frame', 'receipt'], 'artifact.kind')
      const entry = await withLedger(workspace, (context: any) => {
        if (context.state.journal.some((row: any) => row.kind === artifact.kind && row.payload.id === artifact.id)) fail(ERROR_CODES.CONFLICT, `immutable ${artifact.kind} ${artifact.id} already exists`)
        return context.append(artifact.kind, artifact)
      })
      return { ok: true, workspace, entry }
    },
  },
  {
    name: 'coordination_dashboard',
    title: 'Coordination',
    description: 'Open the interactive coordination dashboard to inspect goals, plans, handoffs, AMP attention frames, receipts and the audit. With no workspace it opens a workspace selector; with an absolute workspace it returns the current repository view. This tool is read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { workspace: WORKSPACE_PROPERTY } },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: DASHBOARD_URI },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
    async handler(args) { return dashboardData(args.workspace) },
  },
]

export const TOOLS: ToolDefinition[] = withCoordinationTools(BASE_TOOLS, ampHost)

/** Names in registration order, used by the server and the smoke test. */
export const TOOL_NAMES = TOOLS.map((tool: any) => tool.name)
ampHost.setToolCatalog(TOOLS)

/**
 * Look up one tool by name.
 * @param {string} name - tool name.
 * @returns {typeof TOOLS[number]|undefined} the definition.
 */
export function toolNamed(name: string) {
  return TOOLS.find((tool: any) => tool.name === name)
}
