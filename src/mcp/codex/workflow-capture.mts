/** Host-owned live AMP workflow capture for observed Codex hooks. No agent-facing API accepts these observations. */
import { createHash } from 'node:crypto'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import type { Store } from 'attention-manifest-protocol/service'
import type { TurnState } from 'attention-manifest-protocol/turn'

/** Host-only input-classification policy recorded with every captured prompt. */
export const LIVE_WORKFLOW_POLICY_VERSION = 'codex-hook/live-v1'
/** Maximum UTF-8 bytes of prompt text copied into one native Intent. */
export const LIVE_WORKFLOW_PROMPT_BYTES = 8192

const HOST_ACTOR = 'codex:host-hook'
const ACTIVE_TURN_STATES = new Set<TurnState>(['received', 'interpreting', 'clarifying', 'acting', 'responding', 'resumed'])
const TERMINAL_TURN_STATES = new Set<TurnState>(['completed', 'failed', 'abandoned', 'interrupted'])
/**
 * Legal AMP Turn transitions from each observed state to `completed`. AMP has no
 * direct `clarifying -> responding` edge, so that path re-enters `interpreting`
 * first instead of inventing a state transition.
 */
const STOP_PATH: Partial<Record<TurnState, readonly TurnState[]>> = {
  received: ['interpreting', 'responding', 'completed'],
  interpreting: ['responding', 'completed'],
  clarifying: ['interpreting', 'responding', 'completed'],
  acting: ['responding', 'completed'],
  responding: ['completed'],
  resumed: ['acting', 'responding', 'completed'],
}
const CAPTURE_REASON = 'Observed Codex UserPromptSubmit input; the host records an observed hook event, not model classification or Intent acceptance'
const STOP_REASON = 'Observed Codex Stop hook; the host records an observed turn boundary, not business completion or acceptance'

/** Minimal structural view of the command-hook input; only observed fields are read. */
export interface LiveWorkflowHookEvent {
  readonly session_id?: string
  readonly hook_event_name?: string
  readonly turn_id?: string
  readonly prompt?: unknown
}

const turnKey = (threadId: string, turnId: string) => createHash('sha256').update(threadId + '\0' + turnId).digest('hex')

/** Caps one prompt to the documented byte bound without splitting a UTF-8 code point. */
export function boundLivePrompt(prompt: string) {
  if (Buffer.byteLength(prompt, 'utf8') <= LIVE_WORKFLOW_PROMPT_BYTES) return { text: prompt, truncated: false }
  let bytes = 0
  let text = ''
  for (const character of prompt) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > LIVE_WORKFLOW_PROMPT_BYTES) break
    bytes += size
    text += character
  }
  return { text, truncated: true }
}

/**
 * Captures `UserPromptSubmit` and `Stop` into the project-local native workflow.
 *
 * Both events are host observations: a prompt creates one Turn plus one captured
 * Intent, and Stop only closes a Turn this host already observed. Interrupt is
 * deliberately out of scope, so an interruption snapshot is never fabricated.
 * Missing session mappings and repeated deliveries are silent no-ops; unexpected
 * failures throw so `ingestHook` can journal them without losing the observation.
 */
export function captureNativeWorkflow(store: Store, event: LiveWorkflowHookEvent) {
  if (event.hook_event_name !== 'UserPromptSubmit' && event.hook_event_name !== 'Stop') return
  const threadId = event.session_id
  const codexTurnId = event.turn_id
  if (typeof threadId !== 'string' || !threadId) return
  if (typeof codexTurnId !== 'string' || !codexTurnId.trim()) return
  // One savepoint keeps Turn/Intent creation and the live-workflow fact atomic
  // even when the caller already opened the wider hook transaction.
  store.transaction(() => capture(store, event.hook_event_name as 'UserPromptSubmit' | 'Stop', threadId, codexTurnId, event.prompt))
}

function capture(store: Store, hook: 'UserPromptSubmit' | 'Stop', threadId: string, codexTurnId: string, prompt: unknown) {
  const mapping = store.events({ kind: 'codex.sync.session_mapping' })
    .map(item => item.payload as { threadId?: unknown; sessionId?: unknown })
    .find(item => item.threadId === threadId)
  // No mapping means this project never observed a native Session for the thread.
  if (!mapping || typeof mapping.sessionId !== 'string' || !mapping.sessionId) return
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  const restored = persistence.restoreAll()
  if (restored.skipped.length) throw new Error('Native workflow contains invalid facts')
  const session = persistence.workflow.list('session').find(item => item.id === mapping.sessionId)
  if (!session) throw new Error(`Native session ${mapping.sessionId} is missing for Codex thread ${threadId}`)
  // A prompt only becomes input for a session the host still considers live.
  // After SessionEnd (suspended) or a closed/aborted session, capture is a
  // silent no-op instead of inventing work for a non-active session.
  if (hook === 'UserPromptSubmit' && !['active', 'idle'].includes(session.state)) return
  const key = turnKey(threadId, codexTurnId)
  const turnId = 'codex:turn:' + key
  const intentId = 'codex:intent:' + key

  if (hook === 'UserPromptSubmit') {
    // A real turn_id identifies the capture: a repeated delivery must not add a
    // second Turn, Intent or transition.
    if (persistence.workflow.find('turn', turnId).isPresent()) return
    const text = typeof prompt === 'string' ? prompt : ''
    if (!text.trim()) return
    const classification = persistence.workflow.list('turn', session.id).some(turn => ACTIVE_TURN_STATES.has(turn.state)) ? 'steering' as const : 'new_intent' as const
    const bounded = boundLivePrompt(text)
    let turn = persistence.create('turn', { id: turnId, sessionId: session.id, classification }, HOST_ACTOR)
    turn = persistence.transition('turn', turnId, 'interpreting', { expectedVersion: turn.version, actor: HOST_ACTOR, reason: CAPTURE_REASON })
    // `captured` is the host capture state; accepting or confirming stays host-only.
    persistence.create('intent', { id: intentId, sessionId: session.id, originTurnId: turnId, text: bounded.text }, HOST_ACTOR)
    store.appendEvent('codex.amp.live_workflow', {
      threadId,
      sessionId: session.id,
      turnId,
      intentId,
      classification,
      classificationPolicyVersion: LIVE_WORKFLOW_POLICY_VERSION,
      truncated: bounded.truncated,
      source: 'codex-user-prompt-hook',
    })
    return
  }

  const found = persistence.workflow.find('turn', turnId)
  // A Stop for an unknown Turn or an already terminal Turn is a no-op.
  if (!found.isPresent()) return
  let turn = found.get()
  if (TERMINAL_TURN_STATES.has(turn.state)) return
  const path = STOP_PATH[turn.state]
  if (!path) throw new Error(`Observed Stop cannot complete a native Turn in state ${turn.state}`)
  const from = turn.state
  for (const to of path) turn = persistence.transition('turn', turnId, to, { expectedVersion: turn.version, actor: HOST_ACTOR, reason: STOP_REASON })
  store.appendEvent('codex.amp.live_workflow', {
    event: 'Stop',
    turnId,
    from,
    to: turn.state,
    source: 'codex-stop-hook',
  })
}
