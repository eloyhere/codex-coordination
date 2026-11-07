/** Verified, non-destructive legacy snapshots imported as suspended native work. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { WorkflowStore, initialWorkflowStates } from 'attention-manifest-protocol/workflow'
import { WorkflowPersistence } from 'attention-manifest-protocol/persistence'
import { readState, ledgerPath, resolveWorkspace } from '../lib/store.mjs'
import { auditLedger } from '../lib/check.mjs'
import { openNativeStore } from './native-store.mjs'
import type { ToolDefinition } from '../lib/tools.mjs'
import type { WorkflowEntity, WorkflowSnapshot, WorkflowEvent } from 'attention-manifest-protocol/workflow'

export function migrationTool(workspace: () => unknown): ToolDefinition {
  return { name: 'attention_manifest_protocol_migration', description: 'Preview or import an existing verified coordination ledger into native AMP workflow entities. Import requires the preview sourceDigest, preserves the original ledger and all source records, and creates a suspended import session with unverified goals, draft plans and pending tasks. It grants no execution or acceptance.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['preview', 'import', 'status'] }, sourceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    async handler(args) {
      const selected = workspace()
      if (typeof selected !== 'string') throw new Error('Select a workspace with coordination_workspace first')
      const root = resolveWorkspace(selected)
      if (args.action === 'status') {
        const { store } = openNativeStore(() => root)
        try { return { imports: store.events({ kind: 'codex.amp.legacy_import' }).map(event => { const { originalText, ...summary } = event.payload as any; return summary }) } }
        finally { store.close() }
      }
      const originalText = readFileSync(ledgerPath(root), 'utf8')
      const sourceDigest = createHash('sha256').update(originalText).digest('hex')
      const source = readState(root)
      // Ensure the audited projection was read from the very same byte snapshot.
      if (readFileSync(ledgerPath(root), 'utf8') !== originalText) throw new Error('Ledger changed during migration preview; retry')
      const audit = auditLedger(source)
      if (!audit.ok) throw new Error('Legacy ledger failed audit: ' + JSON.stringify(audit.violations))
      const prefix = 'legacy:' + sourceDigest + ':'
      const sessionId = prefix + 'session'
      // Native timestamps describe this import, not fabricated historical execution.
      const at = new Date().toISOString()
      const entities: WorkflowEntity[] = []
      const base = (kind: string, id: string, state: string) => ({ kind, id, sessionId, state, version: 0, cancellationEpoch: 0, createdAt: at, updatedAt: at })
      entities.push({ ...base('session', sessionId, 'suspended'), participants: ['codex-coordination:legacy-import'], sessionType: 'autonomous' } as WorkflowEntity)
      const references: Record<string, string> = {}
      for (const [id, record] of Object.entries(source.goals) as [string, any][]) {
        const turn = prefix + 'turn:' + id, intent = prefix + 'intent:' + id, mission = prefix + 'mission:' + id, goal = prefix + 'goal:' + id
        references['goal:' + id] = goal
        entities.push({ ...base('turn', turn, 'received'), classification: 'new_intent' } as WorkflowEntity)
        entities.push({ ...base('intent', intent, 'captured'), originTurnId: turn, text: record.artifact.statement } as WorkflowEntity)
        entities.push({ ...base('mission', mission, 'proposed'), intentId: intent } as WorkflowEntity)
        entities.push({ ...base('goal', goal, 'proposed'), missionId: mission, contractVersion: 'legacy-import/1', validity: 'verification_pending', acceptanceCriteria: record.artifact.success.map((item: any) => item.statement + '\nCheck: ' + item.check) } as WorkflowEntity)
      }
      for (const [id, record] of Object.entries(source.plans) as [string, any][]) {
        const plan = prefix + 'plan:' + id
        references['plan:' + id] = plan
        entities.push({ ...base('plan', plan, 'draft'), goalId: references['goal:' + record.artifact.goal.id], bounds: { maxAttempts: 1, deadline: at, progressMetric: 'Host must review legacy plan bounds before activation', deadLetterOwner: 'codex-coordination:legacy-import' } } as WorkflowEntity)
        for (const task of record.artifact.tasks) {
          const taskId = prefix + 'task:' + id + ':' + task.id
          references['task:' + id + ':' + task.id] = taskId
          entities.push({ ...base('task', taskId, 'pending'), planId: plan, dependsOn: task.pre.map((dependency: string) => prefix + 'task:' + id + ':' + dependency), required: true, contractVersion: 'legacy-import/1', requiredEffects: [] } as WorkflowEntity)
        }
      }
      const events: WorkflowEvent[] = []
      for (const entity of entities) {
        const path = entity.kind === 'session' ? ['created', 'active', 'suspended'] : initialWorkflowStates[entity.kind] === entity.state ? [entity.state] : [initialWorkflowStates[entity.kind], entity.state]
        path.forEach((state, version) => events.push({ sequence: events.length + 1, entityKind: entity.kind, entityId: entity.id, eventType: version === 0 ? 'created' : 'import_normalized', from: version === 0 ? '' : path[version - 1], to: state, expectedVersion: version - 1, version, actor: 'codex-coordination:legacy-import', cancellationEpoch: 0, timestamp: at, reason: 'Administrative import normalization only; no historical execution or verification inferred' }))
        ;(entity as any).version = path.length - 1
      }
      const snapshot: WorkflowSnapshot = { schemaVersion: 1, sequence: events.length, cancellationEpoch: 0, entities, attempts: [], events }
      WorkflowStore.restore(snapshot)
      const summary = { sourceDigest, sessionId, references, entities: entities.length, goals: Object.keys(source.goals).length, plans: Object.keys(source.plans).length, policy: 'suspended-import-needs-host-review', bounds: 'expired placeholders; host review required', sourceSummary: audit.summary }
      if (args.action === 'preview') return summary
      if (args.action !== 'import') throw new Error('Unknown migration action')
      if (args.sourceDigest !== sourceDigest) throw new Error('sourceDigest does not match the current verified ledger; preview again')
      const { store } = openNativeStore(() => root)
      try {
        return store.transaction(() => {
          const existing = store.events({ kind: 'codex.amp.legacy_import' }).find(event => (event.payload as any).sourceDigest === sourceDigest)
          if (existing) return { ...summary, replayed: true }
          const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore() })
          const previousReport = persistence.restoreAll()
          if (previousReport.skipped.length) throw new Error('Existing native workflow contains invalid facts')
          const previous = persistence.workflow.snapshot()
          const appended = events.map(event => ({ ...event, sequence: previous.sequence + event.sequence }))
          WorkflowStore.restore({ ...previous, sequence: previous.sequence + events.length, entities: [...previous.entities, ...entities], events: [...previous.events, ...appended] })
          for (const entity of entities) {
            if (store.list<{ id: string }>(entity.kind).some(value => value.id === entity.id)) throw new Error('Native import identity already exists without its migration record')
            store.save(entity.kind, entity)
          }
          // Prove actual persisted facts rehydrate through the native persistence stack.
          for (const event of appended) persistence.persistEvent(event)
          const restored = persistence.restoreAll()
          if (restored.skipped.length) throw new Error('Native workflow restore skipped imported facts: ' + restored.skipped.join(', '))
          store.appendEvent('codex.amp.legacy_import', { ...summary, originalText })
          return { ...summary, replayed: false }
        })
      } finally { store.close() }
    },
  }
}
