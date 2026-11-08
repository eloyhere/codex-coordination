/** Durable host observations. No agent-facing API accepts raw lifecycle events. */
import { nativeRequest, nativeWorkspaceRoot } from '../amp/native-store.mjs'
import { openCodexStore } from './store.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { syncNativeSession } from './session.mjs'
import { captureNativeWorkflow } from './workflow-capture.mjs'

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreModelRequest', 'PostModelRequest', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt'] as const
const hash = (value: unknown) => createHash('sha256').update(nativeRequest(value)).digest('hex')
export interface HostEvent { session_id: string; cwd: string; hook_event_name: string; turn_id?: string; [key: string]: unknown }

export function ingestHook(event: HostEvent) {
  if (!hookEvents.includes(event.hook_event_name as any) || typeof event.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(event.session_id)) throw new Error('Unsupported or missing Codex hook identity')
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt'].includes(event.hook_event_name) && (typeof event.turn_id !== 'string' || !event.turn_id.trim())) throw new Error('Turn-scoped hook requires the actual Codex turn_id')
  if (event.turn_id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(event.turn_id)) throw new Error('Invalid Codex turn identity')
  event = structuredClone(event)
  if (event.hook_event_name === 'PostToolUse' && String(event.tool_name).includes('codex_sync')) event.tool_response = { omitted: 'self-referential-bridge-output', digest: hash(event.tool_response) }
  const root = nativeWorkspaceRoot(event.cwd)
  const store = openCodexStore(root)
  try {
    return store.transaction(() => {
      const stable = !!event.turn_id && !['PreModelRequest', 'PostModelRequest'].includes(event.hook_event_name)
      const eventId = stable ? hash(event) : randomUUID()
      const previous = store.events({ kind: 'codex.sync.hook' }).find(item => (item.payload as any).eventId === eventId)
      if (previous) return { eventId, duplicate: true }
      syncNativeSession(store, event.session_id, event.hook_event_name)
      store.appendEvent('codex.sync.hook', { eventId, workspaceRoot: root, source: 'codex-command-hook', observedAt: new Date().toISOString(), event })
      // Live workflow capture is best-effort; the observation above must survive its failure.
      try { captureNativeWorkflow(store, event) } catch (error) {
        store.appendEvent('codex.amp.live_workflow.error', { workspaceRoot: root, threadId: event.session_id, turnId: event.turn_id ?? null, hookEventName: event.hook_event_name, message: error instanceof Error ? error.message : String(error), source: 'codex-command-hook', observedAt: new Date().toISOString() })
      }
      return { eventId, duplicate: false }
    })
  } finally { store.close() }
}

export function readCodexThread(workspace: () => unknown, threadId: string) {
  const root = nativeWorkspaceRoot(workspace())
  const store = openCodexStore(root)
  try {
    const events = store.events({ kind: 'codex.sync.hook' }).map(item => item.payload as { event: HostEvent; workspaceRoot: string }).filter(item => item.workspaceRoot === root && item.event.session_id === threadId)
    if (!events.length) throw new Error('Thread has not been observed by this plugin in the selected workspace')
    const turns = new Map<string, any>()
    let sessionState = 'observed'
    for (const { event } of events) {
      if (event.hook_event_name === 'SessionStart') sessionState = 'active'
      if (event.hook_event_name === 'SessionEnd') sessionState = 'ended'
      if (!event.turn_id) continue
      const turn = turns.get(event.turn_id) ?? { id: event.turn_id, status: 'observed', messages: [], calls: Object.create(null) }
      if (event.hook_event_name === 'UserPromptSubmit') { turn.status = 'inProgress'; turn.messages.push({ role: 'user', content: event.prompt }) }
      if (event.hook_event_name === 'Stop') { turn.status = 'completed'; if (event.last_assistant_message) turn.messages.push({ role: 'assistant', content: event.last_assistant_message }) }
      if (event.hook_event_name === 'Interrupt') turn.status = 'interrupted'
      if (['PreToolUse', 'PostToolUse'].includes(event.hook_event_name) && typeof event.tool_use_id === 'string') {
        const call = turn.calls[event.tool_use_id] ?? { id: event.tool_use_id }
        Object.assign(call, { tool: event.tool_name, input: event.tool_input })
        if (event.hook_event_name === 'PostToolUse') Object.assign(call, { output: event.tool_response, status: 'observed-result' })
        else call.status ??= 'started'
        turn.calls[event.tool_use_id] = call
      }
      turns.set(event.turn_id, turn)
    }
    const goals = store.events({ kind: 'codex.sync.goal' }).map(item => item.payload as any).filter(item => item.workspaceRoot === root && item.threadId === threadId)
    const mapping = store.events({ kind: 'codex.sync.session_mapping' }).map(item => item.payload as any).find(item => item.threadId === threadId)
    const nativeSession = mapping ? JSON.parse(JSON.stringify(store.list<any>('session').find(item => item.id === mapping.sessionId) ?? null)) : null
    return { threadId, sessionState, nativeSession, turns: [...turns.values()].map(turn => ({ ...turn, calls: Object.values(turn.calls) })), goal: goals.at(-1)?.goal ?? null, goalObserved: goals.length > 0, goalSource: goals.at(-1)?.source ?? null, source: 'codex-host-observations', limitations: ['Hooks are not a complete message stream; intermediate assistant messages require an app-server event connection.', 'Native turns require host input classification; hook turn observations do not infer it.'] }
  } finally { store.close() }
}

export function mirrorGoal(workspace: () => unknown, threadId: string, goal: unknown, source: 'codex-app-server' | 'codex-readonly-goal-db' = 'codex-app-server') {
  if (goal !== null && (typeof goal !== 'object' || (goal as any).threadId !== threadId)) throw new Error('Codex goal identity mismatch')
  readCodexThread(workspace, threadId)
  const root = nativeWorkspaceRoot(workspace())
  const store = openCodexStore(root)
  try { store.appendEvent('codex.sync.goal', { workspaceRoot: root, threadId, goal, digest: goalDigest(goal), source, observedAt: new Date().toISOString() }); return { goal, digest: goalDigest(goal), source } }
  finally { store.close() }
}

export const goalDigest = (goal: any) => hash(goal === null ? null : { threadId: goal.threadId, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget, createdAt: goal.createdAt })
