import { ledger, semantic } from './runtime.mjs'
import type { Database } from 'attention-manifest-protocol/database'
import { SCHEMAS, requireArtifact } from '../lib/protocol.mjs'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
const ledgerArrays: Record<string, string> = { event: 'events', frame: 'frames', receipt: 'receipts', claim: 'claims', hypothesis: 'hypotheses', unknown: 'unknowns', goal: 'goals', plan: 'plans' }
export class HostArtifacts {
  constructor(private readonly database: Database) {}
  call(args: Record<string, any>) {
    if (args.action === 'verify') return { ok: true, verification: this.database.objectService.verify() }
    if (args.action === 'snapshot') {
      const value = new ledger.Ledger()
      for (const [kind, property] of Object.entries(ledgerArrays)) {
        const rows = this.database.objectService.byKind(`amp-artifact.${kind}`, 10001)
        if (rows.length > 10000) fail(ERROR_CODES.INVALID_STATE, 'Artifact snapshot exceeds the host export limit')
        for (const row of rows) (value as any)[property].push(JSON.parse((row as any).body))
      }
      return { ok: true, snapshot: ledger.exportLedger(value, 'codex-coordination') }
    }
    if (args.action === 'list') {
      const kinds = args.kind ? [args.kind] : Object.keys(SCHEMAS)
      const limit = Math.min(100, Math.max(1, args.limit ?? 20))
      const rows = kinds.flatMap((kind: string) => this.database.objectService.byKind(`amp-artifact.${kind}`, limit))
      return { ok: true, artifacts: rows.sort((a: any, b: any) => b.seq - a.seq).slice(0, limit).map((row: any) => ({ id: row.id, kind: row.kind.slice('amp-artifact.'.length), hash: row.hash, artifact: JSON.parse(row.body) })) }
    }
    if (args.action === 'get') {
      const row = this.database.objectService.get(`amp-artifact.${args.kind}`, args.id) as any
      if (!row) fail(ERROR_CODES.NOT_FOUND, 'Unknown recorded AMP artifact')
      return { ok: true, artifact: JSON.parse(row.body), hash: row.hash }
    }
    if (args.action !== 'record') fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown artifact action')
    requireArtifact(args.artifact)
    const artifact = args.artifact
    const id = artifact.id ?? semantic.digestOf(artifact)
    const kind = `amp-artifact.${artifact.kind}`
    return this.database.transaction(() => {
      if (this.database.objectService.get(kind, id)) fail(ERROR_CODES.CONFLICT, 'This immutable artifact kind/id already exists; revisions need a new ID')
      const entry = this.database.objectService.put(kind, id, artifact, new Date().toISOString())
      return { ok: true, id, entry }
    })
  }
}
