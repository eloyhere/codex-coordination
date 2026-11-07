/** Native local cooperation queues. Delegation authority comes from exact host review. */
import { CooperationCoordinator } from 'attention-manifest-protocol/cooperation'
import type { CooperationSnapshot, ProvenanceRecord } from 'attention-manifest-protocol/cooperation'
import { AgentGateway, createAgentSurface, assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import type { Store } from 'attention-manifest-protocol/service'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { randomUUID } from 'node:crypto'
import Ajv from 'ajv'

const eventKind = 'codex.amp.cooperation.commit'
const hostAgent = 'mcp-host-review'
const text = { type: 'string', minLength: 1, maxLength: 200 }
const idem = { idempotencyKey: text }
const now = () => new Date().toISOString()
type NativeFence = { taskId: string; planId: string; goalId: string; missionId: string; epoch: number }
type Commit = { scope: string; principalId: string; key: string; request: string; result: Record<string, any>; snapshot: CooperationSnapshot; nativeFences?: Record<string, NativeFence> }

export function cooperationBindings(binding: AgentBinding, workspace: () => unknown, scope: (root: string) => string | undefined): ToolDefinition[] {
  if (binding.principalId !== 'codex') throw new Error('Native cooperation requires the host-bound codex principal')
  const standard = createAgentSurface()
  const descriptors = standard.tools.filter(tool => tool.module === 'cooperation')
  const nativeFor = (workflow: WorkflowStore, selected: string, taskId: string) => {
    const task = workflow.get('task', taskId), plan = workflow.get('plan', task.planId), goal = workflow.get('goal', plan.goalId), mission = workflow.get('mission', goal.missionId), session = workflow.get('session', selected)
    if ([task, plan, goal, mission].some(item => item.sessionId !== selected)) throw new Error('Native delegation escaped the selected workflow')
    if (!['ready', 'active', 'running', 'executing'].includes(task.state)) throw new Error('Native task is no longer dispatchable')
    if (!['approved', 'ready', 'running', 'executing'].includes(plan.state) || Date.parse(plan.bounds.deadline) <= Date.now()) throw new Error('Native parent plan is no longer dispatchable')
    if (goal.state !== 'active' || goal.validity === 'invalidated') throw new Error('Native parent goal is no longer active')
    if (!['active', 'achieved'].includes(mission.state) || !['active', 'idle'].includes(session.state)) throw new Error('Native parent workflow is no longer active')
    if (workflow.get('intent', mission.intentId).state !== 'accepted') throw new Error('Native parent intent is no longer accepted')
    const fence: NativeFence = { taskId, planId: plan.id, goalId: goal.id, missionId: mission.id, epoch: Math.max(...[task, plan, goal, mission, session].map(item => item.cancellationEpoch)) }
    return fence
  }
  const read = (store: Store, selected: string) => {
    const workflow = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
    if (workflow.restoreAll().skipped.length) throw new Error('Native workflow contains invalid facts')
    workflow.workflow.get('session', selected)
    const commits = store.events({ kind: eventKind }).map(event => event.payload as Commit).filter(item => item.scope === selected)
    if (commits.some(item => item.principalId !== binding.principalId)) throw new Error('Cooperation journal belongs to another principal')
    const coordinator = commits.length ? CooperationCoordinator.restore(commits.at(-1)!.snapshot) : new CooperationCoordinator()
    for (const cooperation of coordinator.listCooperations()) {
      if (coordinator.getBinding(cooperation.id)?.sessionId !== selected) throw new Error('Cooperation snapshot escaped workflow scope')
    }
    // Synchronize native cancellation/fences before any command transaction. This
    // durable host fact must survive a subsequent rejected send/result rollback.
    const nativeFences: Record<string, NativeFence> = { ...(commits.at(-1)?.nativeFences ?? {}) }
    let synchronized = false
    for (const cooperation of coordinator.listCooperations()) for (const task of coordinator.tasksFor(cooperation.id)) {
      if (!['delegated', 'running'].includes(task.state)) continue
      let reason: string | undefined
      try {
        if (!nativeFences[task.taskId] || nativeRequest(nativeFor(workflow.workflow, selected, task.taskId)) !== nativeRequest(nativeFences[task.taskId])) reason = 'Native workflow cancellation fence changed'
      } catch (error) { reason = String(error) }
      if (reason) {
        coordinator.cancel(task.taskId, task.ownerAgentId, task.ownerEpoch, task.fence, reason)
        synchronized = true
      }
    }
    if (synchronized) store.appendEvent(eventKind, { scope: selected, principalId: binding.principalId, key: 'native-sync:' + randomUUID(), request: 'native-workflow-sync', result: { synchronized: true }, snapshot: coordinator.snapshot(), nativeFences }, randomUUID())
    return { coordinator, commits, nativeFences, workflow: workflow.workflow, head: nativeRequest({ snapshot: coordinator.snapshot(), nativeFences, workflow: workflow.workflow.snapshot() }) }
  }
  const open = () => {
    const opened = openNativeStore(workspace)
    try {
      const selected = scope(opened.root)
      if (!selected) throw new Error('Select a native workflow scope first')
      return { ...opened, selected }
    } catch (error) { opened.store.close(); throw error }
  }
  const provenance = (selected: string, taskId: string): ProvenanceRecord[] => [{ sourceId: binding.principalId, sourceType: 'agent', chain: [selected, taskId], taint: ['untrusted-agent-claim', 'not-business-verified'] }]
  const taskFor = (coordinator: CooperationCoordinator, workflow: WorkflowStore, selected: string, taskId: unknown) => {
    const task = coordinator.get(String(taskId))
    if (!task || task.ownerAgentId !== binding.principalId || coordinator.getBinding(task.cooperationId)?.sessionId !== selected) throw new Error('No host-approved delegation owned by this principal in the selected scope')
    const cooperation = coordinator.getCooperation(task.cooperationId)!
    if (!['formed', 'active'].includes(cooperation.status)) throw new Error('Cooperation is not active')
    const native = workflow.get('task', String(taskId))
    const fence = nativeFor(workflow, selected, String(taskId))
    if (!['delegated', 'running'].includes(task.state)) throw new Error('Delegation is already settled or cancelled')
    return { task, cooperation, native, fence }
  }
  const prior = (commits: Commit[], key: string, request: string) => {
    const previous = commits.find(item => item.key === key)
    if (!previous) return undefined
    if (previous.request !== request) throw new Error('Idempotency key already used for another cooperation command')
    return { ...previous.result, replayed: true }
  }
  const persist = (store: Store, selected: string, key: string, request: string, coordinator: CooperationCoordinator, result: Record<string, any>, nativeFences: Record<string, NativeFence>) => {
    // Restore before committing also validates the detached snapshot and references.
    const snapshot = coordinator.snapshot(); CooperationCoordinator.restore(snapshot)
    store.appendEvent(eventKind, { scope: selected, principalId: binding.principalId, key, request, snapshot, result, nativeFences }, randomUUID())
    return { ...result, replayed: false }
  }
  const properties: Record<string, Record<string, any>> = {
    inbox: { cooperationId: text, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    send: { ...idem, taskId: text, recipientAgentId: text, payload: {} },
    report_result: { ...idem, taskId: text, outcome: { enum: ['success', 'failure', 'unknown_outcome'] }, value: {} },
  }
  const required: Record<string, string[]> = { inbox: [], send: ['idempotencyKey', 'taskId', 'recipientAgentId', 'payload'], report_result: ['idempotencyKey', 'taskId', 'outcome', 'value'] }
  const tools: ToolDefinition[] = descriptors.map(descriptor => {
    const schema = { type: 'object', additionalProperties: false, properties: properties[descriptor.verb], required: required[descriptor.verb] }
    const validate = new (Ajv as any)({ strict: false }).compile(schema)
    const gateway = new AgentGateway({ surface: { ...standard, tools: [descriptor] }, authorize: values => values.every(value => descriptor.authority.includes(value)), handlers: {
      [descriptor.name](parameters, context) {
        const { store, selected } = open()
        try {
          store.transaction(() => read(store, selected))
          return store.transaction(() => {
          const state = read(store, selected), coordinator = state.coordinator
          if (descriptor.verb === 'inbox') {
            const cooperations = coordinator.listCooperations().filter(item => item.participants.some(participant => participant.agentId === binding.principalId))
            if (parameters.cooperationId !== undefined && !cooperations.some(item => item.id === parameters.cooperationId)) throw new Error('Cooperation is not visible in the selected scope')
            const messages = cooperations.filter(item => parameters.cooperationId === undefined || item.id === parameters.cooperationId).flatMap(item => coordinator.messagesFor(item.id)).filter(message => message.recipientAgentId === binding.principalId)
            return { messages: messages.slice(-Number(parameters.limit ?? 20)), transport: 'local-durable-queue', remoteDelivery: false }
          }
          const key = binding.principalId + ':' + context.idempotencyKey
          const request = nativeRequest({ tool: descriptor.name, parameters, scope: selected })
          const replay = prior(state.commits, key, request); if (replay) return replay
          const { task, cooperation } = taskFor(coordinator, state.workflow, selected, parameters.taskId)
          if (Buffer.byteLength(nativeRequest(parameters)) > 32768) throw new Error('Cooperation payload exceeds 32 KiB')
          const source = provenance(selected, task.taskId)
          let result: Record<string, any>
          if (descriptor.verb === 'send') {
            if (!cooperation.participants.some(participant => participant.agentId === parameters.recipientAgentId)) throw new Error('Recipient is not a cooperation participant')
            const message = coordinator.storeMessage({ messageId: randomUUID(), taskId: task.taskId, cooperationId: cooperation.id, senderAgentId: binding.principalId, recipientAgentId: String(parameters.recipientAgentId), kind: 'untrustedData', payload: parameters.payload as any, provenance: source, sentAt: now() })
            result = { message, transport: 'local-durable-queue', remoteDelivery: false }
          } else {
            const acceptance = coordinator.submitResult({ taskId: task.taskId, ownerAgentId: binding.principalId, ownerEpoch: task.ownerEpoch, fence: task.fence, outcome: parameters.outcome as any, value: parameters.value as any, provenance: source })
            if (!acceptance.accepted) throw new Error('Cooperation result rejected: ' + acceptance.reason)
            result = { accepted: true, taskId: task.taskId, state: acceptance.task!.state, value: parameters.value, provenance: source, verified: false, businessAcceptance: false }
          }
          return persist(store, selected, key, request, coordinator, result, state.nativeFences)
        }) } finally { store.close() }
      },
    }, onCall(record) {
      if (typeof workspace() !== 'string') return
      const { store } = openNativeStore(workspace)
      try { store.appendEvent('codex.amp.cooperation.call', { ...record, principalId: binding.principalId }) } finally { store.close() }
    } })
    return { name: descriptor.name, description: descriptor.description + ' Native local durable queue in an existing host-approved delegation. Identity, epoch, fence and unverified provenance are host-bound. No remote transport or business verification.', inputSchema: schema, annotations: { readOnlyHint: !descriptor.mutating }, async handler(input) {
      const args = JSON.parse(nativeRequest(input)) as Record<string, any>
      assertModelParameters(args)
      if (!validate(args)) throw new Error('Invalid cooperation parameters: ' + JSON.stringify(validate.errors))
      const { idempotencyKey, ...parameters } = args
      return await gateway.call(descriptor.name, parameters, { binding, idempotencyKey: idempotencyKey as string }) as Record<string, any>
    } }
  })
  const reviewSchema = { type: 'object', additionalProperties: false, required: ['cooperationId', 'taskId', 'expectedVersion', 'idempotencyKey', 'reason'], properties: {
    ...idem, cooperationId: text, taskId: text, expectedVersion: { type: 'integer', minimum: 0 }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    participants: { type: 'array', maxItems: 20, uniqueItems: true, items: text }, objective: { type: 'string', minLength: 1, maxLength: 2000 },
  } }
  const validateReview = new (Ajv as any)({ strict: false }).compile(reviewSchema)
  const propose = (coordinator: CooperationCoordinator, workflow: WorkflowStore, selected: string, args: Record<string, any>) => {
    nativeFor(workflow, selected, args.taskId)
    const existing = coordinator.getCooperation(args.cooperationId)
    if ((existing?.version ?? 0) !== args.expectedVersion) throw new Error('Cooperation version changed')
    if (!existing) {
      if (!args.objective || !Array.isArray(args.participants)) throw new Error('New cooperation requires objective and participants')
      const participants = [...new Set([hostAgent, binding.principalId, ...args.participants])]
      coordinator.create({ id: args.cooperationId, name: args.objective, goal: { objective: args.objective, successCriteria: ['Report an unverified delegated result for host evaluation'] }, participants: participants.map(agentId => ({ agentId })), topology: 'star', status: 'active', protocol: {
        goal: { alignment: 'single', revisionPolicy: 'locked' }, roles: { assignments: participants.map(agentId => ({ agentId, role: agentId === hostAgent ? 'coordinator' : 'worker', responsibilities: ['Local cooperation queue only'] })), requireDistinctArbiter: false },
        messages: { format: 'json', channel: 'local-durable-queue', timeoutMs: 30000, retries: 0, ordering: 'fifo', idempotent: true }, timing: { sequencing: 'parallel', maxParallelism: 1 }, conflicts: { arbiterAgentId: hostAgent, escalation: ['human'], requireReason: true }, sharing: { isolation: 'isolated', mergeStrategy: 'none' }, convergence: { strategy: 'owner_decision', partialCompletion: 'report' },
      } })
      coordinator.bindCooperation({ cooperationId: args.cooperationId, sessionId: selected })
    } else {
      if (args.objective !== undefined || args.participants !== undefined) throw new Error('Existing cooperation participants and objective cannot be changed')
      if (coordinator.getBinding(existing.id)?.sessionId !== selected) throw new Error('Cooperation is outside the selected scope')
    }
    const permission = { capabilityIds: [], operations: ['cooperation:send', 'cooperation:report_result'], resources: [args.taskId], allowWrite: false }
    const delegated = coordinator.delegate({ taskId: args.taskId, cooperationId: args.cooperationId, delegatorAgentId: hostAgent, ownerAgentId: binding.principalId, parentScope: permission, requestedScope: permission })
    return { approved: true, cooperationId: delegated.cooperationId, version: coordinator.getCooperation(delegated.cooperationId)!.version, taskId: delegated.taskId, state: delegated.state, transport: 'local-durable-queue', remoteAgentStarted: false, executionAuthorized: false }
  }
  tools.push({ name: 'attention_manifest_protocol_cooperation_review', description: 'Request independent MCP host approval to create a local cooperation and/or delegate a ready native workflow task to this codex principal. expectedVersion=0 creates; existing cooperations use their current version. Does not start another Codex agent or deliver remotely.', inputSchema: reviewSchema, annotations: { readOnlyHint: false }, async handler(input) {
    const args = JSON.parse(nativeRequest(input)) as Record<string, any>
    assertModelParameters(args)
    if (!validateReview(args)) throw new Error('Invalid cooperation review parameters: ' + JSON.stringify(validateReview.errors))
    const opened = open(), root = opened.root, selected = opened.selected
    const key = binding.principalId + ':' + args.idempotencyKey, request = nativeRequest({ tool: 'cooperation_review', args, scope: selected })
    let head: string
    try {
      const state = read(opened.store, selected)
      const replay = prior(state.commits, key, request); if (replay) return replay
      head = state.head
      propose(state.coordinator, state.workflow, selected, args)
    } finally { opened.store.close() }
    const reviewId = randomUUID()
    const approved = await requestHostApproval('native-cooperation:' + selected, 'delegate', { reviewId, ...args, workspace: root, principal: binding.principalId, transport: 'local-durable-queue' })
    const current = openNativeStore(workspace)
    try {
      if (current.root !== root || scope(root) !== selected) throw new Error('Workspace or workflow scope changed during cooperation review')
      return current.store.transaction(() => {
        const state = read(current.store, selected)
        const replay = prior(state.commits, key, request); if (replay) return replay
        if (state.head !== head) throw new Error('Workflow or cooperation changed during host review')
        const result = approved ? { ...propose(state.coordinator, state.workflow, selected, args), reviewId } : { approved: false, changed: false, reviewId }
        if (approved) state.nativeFences[args.taskId] = nativeFor(state.workflow, selected, args.taskId)
        return persist(current.store, selected, key, request, state.coordinator, result, state.nativeFences)
      })
    } finally { current.store.close() }
  } })
  return tools
}
