/** Host-owned lifecycle mapping; no business state or input classification inferred. */
import { createHash } from 'node:crypto'
import { WorkflowStore } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import type { Store } from 'attention-manifest-protocol/service'
import type { SessionState } from 'attention-manifest-protocol/session'

export function syncNativeSession(store: Store, threadId: string, event: string) {
  if (!['SessionStart', 'SessionEnd'].includes(event)) return
  const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
  const report = persistence.restoreAll()
  if (report.skipped.length) throw new Error('Native workflow contains invalid facts')
  const id = 'codex:session:' + createHash('sha256').update(threadId).digest('hex')
  let session = persistence.workflow.list('session').find(item => item.id === id)
  // An end without an observed start must not invent a historical start.
  if (!session && event === 'SessionEnd') return
  if (!session) session = persistence.create('session', { id, sessionId: id, participants: ['codex:host'] }, 'codex:host-hook')
  const move = (state: SessionState) => {
    session = persistence.transition('session', id, state, { expectedVersion: session!.version, actor: 'codex:host-hook', reason: `Observed ${event} for Codex thread ${threadId}; synchronization grants no business authority` })
  }
  if (event === 'SessionStart') {
    if (session.state === 'suspended') move('resumed')
    if (['created', 'resumed', 'idle'].includes(session.state)) move('active')
  } else if (['active', 'idle'].includes(session.state)) move('suspended')
  const previous = store.events({ kind: 'codex.sync.session_mapping' }).some(item => (item.payload as any).threadId === threadId)
  if (!previous) store.appendEvent('codex.sync.session_mapping', { threadId, sessionId: id, source: 'codex-command-hook' })
}
