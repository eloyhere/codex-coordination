/** Read-only project/session snapshot for the status dialog. Never creates storage. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
let catalog: { modules: { module: string; tier: string }[]; kinds: string[] } = { modules: [], kinds: [] }
export function configureSnapshotCatalog(modules: readonly { module: string; tier: string }[], kinds: string[]) {
  catalog = { modules: modules.map(({ module, tier }) => ({ module, tier })), kinds: [...kinds] }
}

export function sessionSnapshot(workspace: string, threadId?: string) {
  if (!isAbsolute(workspace)) throw new Error('Snapshot workspace must be an absolute path')
  const root = realpathSync(workspace)
  if (!statSync(root).isDirectory()) throw new Error('Snapshot workspace must be a directory')
  const path = join(root, '.codex-coordination', 'amp-07', 'store.sqlite')
  if (!existsSync(path)) return null
  const child = relative(root, realpathSync(path))
  if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('AMP storage escapes the project')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    const mappings = db.prepare('SELECT payload FROM events WHERE kind = ? ORDER BY sequence').all('codex.sync.session_mapping').map(row => JSON.parse(String(row.payload)) as { threadId: string; sessionId: string })
    if (!mappings.length) return null
    const selected = mappings.find(item => item.threadId === threadId)
    if (threadId && !selected) throw new Error('Thread has no session mapping in this project')
    const groups: Record<string, { scope: string; records: unknown[]; total: number }> = {}
    const kinds = new Set([...catalog.kinds, ...db.prepare('SELECT DISTINCT kind FROM entities').all().map(row => String(row.kind))])
    for (const kind of kinds) {
      // No other session's rows enter the snapshot. Unscoped rows are explicitly shared.
      const rows = selected ? db.prepare('SELECT payload FROM entities WHERE kind = ? AND (session_id = ? OR session_id IS NULL) ORDER BY id LIMIT 201').all(kind, selected.sessionId) : []
      const records = rows.slice(0, 200).map(row => JSON.parse(String(row.payload)))
      const total = selected ? Number(db.prepare('SELECT count(*) AS total FROM entities WHERE kind = ? AND (session_id = ? OR session_id IS NULL)').get(kind, selected.sessionId)?.total ?? 0) : 0
      groups[kind] = { scope: 'selected-session-and-explicit-project-shared', records, total }
    }
    if (selected) {
      const condition = "(kind = 'codex.sync.hook' AND json_extract(payload, '$.event.session_id') = ?) OR (kind = 'codex.sync.goal' AND json_extract(payload, '$.threadId') = ?)"
      const records = db.prepare(`SELECT payload FROM events WHERE ${condition} ORDER BY sequence DESC LIMIT 100`).all(selected.threadId, selected.threadId).map(row => JSON.parse(String(row.payload)))
      const total = Number(db.prepare(`SELECT count(*) AS total FROM events WHERE ${condition}`).get(selected.threadId, selected.threadId)?.total ?? 0)
      groups.codex_observations = { scope: 'selected-codex-thread-host-observations', records, total }
    }
    return { sessions: mappings, selected: selected ?? null, modules: catalog.modules, groups, limitations: ['未提供当前聊天 ID 时，请选择会话；不会自动猜测最近聊天。', '无 session_id 的实体属于项目共享数据。', 'profession 等旧运行时模块尚未关联原生会话；无记录不代表该模块未启用。', '每类最多返回 200 条记录；total 为完整数量。'], observedAt: new Date().toISOString() }
  } finally { db.close() }
}
