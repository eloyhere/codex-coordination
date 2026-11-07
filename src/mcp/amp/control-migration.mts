/** Filtered legacy control import. Old bearer credentials are never restored. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { database as legacy } from './runtime.mjs'

export function importLegacyControl(target: InstanceType<typeof legacy.Database>, sourcePath: string, workspaceId: string) {
  target.db.exec('CREATE TABLE IF NOT EXISTS codex_control_migration (workspace_id TEXT PRIMARY KEY, report TEXT NOT NULL)')
  const previous = target.db.prepare('SELECT report FROM codex_control_migration WHERE workspace_id=?').get(workspaceId)
  if (previous) return JSON.parse(String(previous.report))
  const source = existsSync(sourcePath) ? new DatabaseSync(realpathSync(sourcePath), { readOnly: true }) : undefined
  try {
    source?.exec('BEGIN')
    if (source && !legacy.verifyObjectChain(source).ok) throw new Error('Legacy control object chain failed verification')
    return target.transaction(() => {
      const repeated = target.db.prepare('SELECT report FROM codex_control_migration WHERE workspace_id=?').get(workspaceId)
      if (repeated) return JSON.parse(String(repeated.report))
      const counts: Record<string, number> = {}
      const tables = new Set(source?.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)) ?? [])
      const copy = (table: string, where: string, args: any[], patch: (row: Record<string, any>) => Record<string, any> = row => row) => {
        if (!source || !tables.has(table)) return
        const rows = source.prepare(`SELECT * FROM "${table}" WHERE ${where}`).all(...args)
        counts[table] = 0
        for (const original of rows) {
          const row = patch(original)
          const columns = Object.keys(row)
          const written = target.db.prepare(`INSERT OR IGNORE INTO "${table}" (${columns.map(key => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]))
          counts[table] += Number(written.changes)
        }
      }
      copy('workspaces', 'workspace_id=?', [workspaceId], row => ({ ...row, is_default: 0 }))
      copy('workspace_sessions', 'workspace_id=?', [workspaceId], row => ({ ...row, status: 'revoked', token_hash: 'legacy-import:no-valid-credential' }))
      copy('control_scopes', "kind='global' OR (workspace_id=? AND kind IN ('workspace','session'))", [workspaceId])
      const scoped = "scope_key IN (SELECT scope_key FROM control_scopes WHERE kind='global' OR workspace_id=?)"
      for (const table of ['control_preferences', 'registry_entries', 'registry_defaults', 'registry_links']) copy(table, scoped, [workspaceId])
      for (const table of ['session_roots', 'session_context', 'file_writes', 'hook_runs']) copy(table, 'session_id IN (SELECT session_id FROM workspace_sessions WHERE workspace_id=?)', [workspaceId])
      if (tables.has('codex_registry_operations')) {
        target.db.exec('CREATE TABLE IF NOT EXISTS codex_registry_operations (workspace_id TEXT NOT NULL, registry TEXT NOT NULL, version INTEGER NOT NULL, operations TEXT NOT NULL, PRIMARY KEY(workspace_id, registry))')
        copy('codex_registry_operations', 'workspace_id=?', [workspaceId])
      }
      // The old object chain mixes projects. Re-home only explicitly owned
      // retrievals, preserving their original chain rows as provenance.
      let retrievals = 0
      for (const row of source?.prepare("SELECT * FROM objects WHERE kind='context-retrieval' ORDER BY seq").all() ?? []) {
        const body = JSON.parse(String(row.body))
        if (body.workspaceId !== workspaceId) continue
        target.objectService.put('context-retrieval', String(row.id), body, String(row.at))
        target.objectService.put('legacy-control-object-origin', String(row.id), row, new Date().toISOString())
        retrievals++
      }
      const report = { workspaceId, sourcePreserved: true, sourcePresent: !!source, counts, retrievals, credentialsRestored: false, sharedDefaults: 'global control scope copied as a project-local initial snapshot', retainedAtSource: ['unscoped file caches/annotations', 'unscoped frames, receipts and contexts', 'scheduler and other unproven ownership records'], migratedAt: new Date().toISOString() }
      target.db.prepare('INSERT INTO codex_control_migration VALUES(?,?)').run(workspaceId, JSON.stringify(report))
      return report
    })
  } finally { source?.close() }
}
