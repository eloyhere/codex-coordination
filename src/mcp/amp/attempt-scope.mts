/** Resolve execution identity only from host binding or durable workflow facts. */
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { WorkflowStore } from 'attention-manifest-protocol/workflow'

export function scopedAttempt(workflow: WorkflowStore, attemptId: string, sessionId: string) {
  const attempt = workflow.getAttempt(attemptId)
  const action = workflow.get('action', attempt.actionId)
  const task = workflow.get('task', action.taskId)
  if ([attempt, action, task].some(entity => entity.sessionId !== sessionId)) throw new Error('Attempt is outside the selected workflow scope')
  if (attempt.operationId !== action.operationId || !action.attemptIds.includes(attempt.attemptId)) throw new Error('Attempt identity does not match its action')
  return { attempt, action, task }
}

export function currentAttempt(workflow: WorkflowStore, binding: AgentBinding, sessionId: string, taskId: string) {
  // MCP connections have no attempt binding. Never let a model's task selector
  // disambiguate concurrent executions: only one running attempt may be current.
  const running = workflow.snapshot().attempts.filter(attempt => attempt.sessionId === sessionId && attempt.state === 'running')
  if (!binding.attemptId && running.length !== 1) throw new Error(running.length ? 'Selected workflow has ambiguous running attempts' : 'Selected workflow has no current running attempt')
  const resolved = scopedAttempt(workflow, binding.attemptId ?? running[0]!.attemptId, sessionId)
  const { attempt, action, task } = resolved
  if (task.id !== taskId) throw new Error('Task does not match the current host attempt')
  if (attempt.state !== 'running') throw new Error('Current attempt is no longer running')
  if (binding.attemptId && binding.cancellationEpoch !== attempt.cancellationEpoch) throw new Error('Host attempt binding has a stale cancellation epoch')
  // The kernel checks all ancestors, canonical state aliases and epoch fencing.
  workflow.assertExecutionAllowed(action.id, attempt.cancellationEpoch)
  if (!['running', 'executing'].includes(action.state)) throw new Error('Current action is no longer running')
  return resolved
}
