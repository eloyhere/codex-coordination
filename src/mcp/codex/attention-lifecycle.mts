/** Trusted command-hook boundary: reset mounts and deliver bounded summary metadata. */
import { createHash } from 'node:crypto'
import { compileContext } from 'attention-manifest-protocol/context'
import { ENTITY_REGISTRY } from 'attention-manifest-protocol/entity'
import type { AttentionObject } from 'attention-manifest-protocol/attention'
import type { EntityKind } from 'attention-manifest-protocol/entity'
import { readCodexThread } from './events.mjs'
import { openNativeStore } from '../amp/native-store.mjs'

const MAX_BYTES = 8192
const validUntil = (value: string, now: number) => Number.isFinite(Date.parse(value)) && Date.parse(value) > now

/** Never fetches a source, creates a Turn, or controls Codex's native model loop. */
export function prepareHookAttention(workspace: () => unknown, threadId: string, turnId: string | undefined, now = new Date().toISOString()) {
  if (!turnId) return { text: '', delivery: 'no-turn-scope' as const, items: 0 }
  const instant = Date.parse(now)
  if (!Number.isFinite(instant)) throw new Error('Invalid hook attention timestamp')
  const host = readCodexThread(workspace, threadId)
  const current = host.turns.at(-1)
  if (!host.nativeSession || !current || current.id !== turnId || current.status !== 'inProgress' || host.sessionState !== 'active' || !['active', 'idle'].includes(host.nativeSession.state)) return { text: '', delivery: 'no-active-observed-turn' as const, items: 0 }
  const { root, store } = openNativeStore(workspace)
  try { return store.transaction(() => {
    const sessionId = host.nativeSession.id
    const rootId = createHash('sha256').update(root).digest('hex')
    const owned = (object: AttentionObject) => object.scope.sessionId === sessionId && object.scope.tenantId === 'local' && object.scope.principalId === 'codex'
    // AMP stores Attention scope inside its payload, rather than the optional
    // top-level tenant_id/session_id columns. Filter that actual domain scope
    // before applying the cap; filtering those nullable columns loses valid rows.
    const scopedObjects = store.list<AttentionObject>('attention').filter(owned)
    if (scopedObjects.length > 1000) throw new Error('Attention scope exceeds the hook compilation limit')
    const sessionObjects = scopedObjects.map(object => JSON.parse(JSON.stringify(object)) as AttentionObject)
    const boundary = store.events({ kind: 'codex.amp.attention.boundary' }).some(event => (event.payload as any).sessionId === sessionId && (event.payload as any).turnId === turnId)
    for (const object of sessionObjects) {
      const active = validUntil(object.expiresAt, instant) && !object.stale
      const retentionActive = object.retention && validUntil(object.retention.expiresAt, instant)
      const retained = active && retentionActive && object.retention?.across === 'turns'
      // A replay of the same user-input hook preserves new transient mounts.
      const shouldMount = active && (boundary ? object.mounted : !!retained)
      const nextScope = retained && !boundary ? { ...object.scope, turnId } : object.scope
      const clearRetention = object.retention && !retentionActive
      if (object.mounted !== shouldMount || nextScope.turnId !== object.scope.turnId || clearRetention) {
        const updated = { ...object, version: object.version + 1, mounted: shouldMount, scope: nextScope, ...(clearRetention ? { retention: undefined } : {}), updatedAt: now, lastReason: 'Observed Codex turn boundary: expired mounts cleared, only explicit live turn retention restored', assessment: undefined }
        store.save('attention', updated, { expectedVersion: object.version })
        store.appendEvent('codex.amp.attention.lifecycle', { action: shouldMount ? 'retained_mount' : 'unmount', objectId: object.id, fromVersion: object.version, version: updated.version, threadId, sessionId, turnId, at: now })
      }
    }
    if (!boundary) store.appendEvent('codex.amp.attention.boundary', { threadId, sessionId, turnId, at: now, source: 'codex-command-hook' })
    const admitted = store.list<AttentionObject>('attention').filter(object => owned(object) && object.scope.turnId === turnId).map(object => JSON.parse(JSON.stringify(object)) as AttentionObject)
    const compiled = compileContext(admitted, {
      now, scope: { tenantId: 'local', principalId: 'codex', sessionId, turnId }, budget: { bytes: MAX_BYTES },
      currentVersion(pointer) {
        if (!Object.hasOwn(ENTITY_REGISTRY, pointer.kind)) return undefined
        const entity = store.list<any>(pointer.kind as EntityKind).find(candidate => candidate.id === pointer.id)
        if (!entity || entity.sessionId !== undefined && entity.sessionId !== sessionId) return undefined
        if (entity.rootId !== undefined && entity.rootId !== rootId) return undefined
        if (entity.scope && (entity.scope.sessionId !== sessionId || entity.scope.principalId !== 'codex' || entity.scope.tenantId !== 'local')) return undefined
        return entity.version === undefined ? undefined : String(entity.version)
      },
    })
    store.appendEvent('codex.amp.attention.lifecycle', { action: 'compiled', threadId, sessionId, turnId, compiledAt: now, itemIds: compiled.items.map(item => item.id), exclusions: compiled.exclusions.map(item => ({ id: item.id, reason: item.reason })), bytes: compiled.usage.bytes, delivery: 'hook-additionalContext-preview; no native model control' })
    return { text: compiled.text, delivery: 'hook-additionalContext-preview' as const, items: compiled.items.length }
  }) } finally { store.close() }
}
