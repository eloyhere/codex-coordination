import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { AmpHost } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { database, session, semantic } from '../plugins/codex-coordination/mcp/amp/runtime.mjs'
import { makeWorkspace } from './helpers.mjs'
import { importLegacyControl } from '../plugins/codex-coordination/mcp/amp/control-migration.mjs'

test('control migration isolates project registries, preserves archived retrievals and revokes imported credentials', async t => {
  let host
  t.after(async () => { await host?.close() })
  const root = makeWorkspace(t), other = makeWorkspace(t), old = makeWorkspace(t)
  const path = join(old, 'control.sqlite'), source = new database.Database(path)
  const ids = [root, other].map(value => `workspace.${semantic.digestOf(value).slice(7, 39)}`)
  const sessions = new session.SessionRegistry({ store: source.workspaceSessions })
  const sourceSessions = []
  for (const [index, workspace] of [root, other].entries()) {
    source.controlService.createWorkspace(ids[index], workspace)
    const opened = sessions.open({ agentId: 'test', workspaceId: ids[index], roots: [{ id: 'repo', path: workspace, writable: true }], permissions: { read: true, write: true, create: true, remove: false } })
    sourceSessions.push(opened.credential.sessionId)
    const control = source.controlService.bind({ workspaceId: ids[index], sessionId: opened.credential.sessionId, allowGlobal: true, authenticate: () => { sessions.verify(opened.credential.sessionId, opened.credential.token) } })
    control.call('workspace', 'adjust', { action: 'register', registry: 'knowledge', id: 'project-fact', value: { name: index ? 'other only' : 'first only', description: 'isolated fact' }, expectedVersion: 0 })
    source.objectService.put('context-retrieval', 'archive-' + index, { workspaceId: ids[index], note: 'old context ' + index }, new Date().toISOString())
  }
  source.close()
  const before = readFileSync(path)
  host = new AmpHost({ databasePath: path })
  await host.select(root)
  const first = await host.registry({ action: 'get', registry: 'knowledge', id: 'project-fact' })
  assert.ok(JSON.stringify(first).includes('first only'))
  assert.equal((await host.context({ action: 'detail', id: 'archive-0' })).result.note, 'old context 0')
  await assert.rejects(host.context({ action: 'detail', id: 'archive-1' }), /Unknown archived/)
  await host.registry({ action: 'update', registry: 'knowledge', id: 'project-fact', value: { name: 'local edit', description: 'kept' }, expectedVersion: 1 })
  const target = new DatabaseSync(join(root, '.codex-coordination', 'amp-legacy', 'control.sqlite'), { readOnly: true })
  assert.equal(target.prepare('SELECT status FROM workspace_sessions WHERE session_id=?').get(sourceSessions[0]).status, 'revoked')
  assert.equal(target.prepare('SELECT token_hash FROM workspace_sessions WHERE session_id=?').get(sourceSessions[0]).token_hash, 'legacy-import:no-valid-credential')
  assert.equal(target.prepare('SELECT count(*) AS n FROM workspace_sessions WHERE workspace_id=?').get(ids[1]).n, 0)
  target.close()
  await host.select(other)
  assert.ok(JSON.stringify(await host.registry({ action: 'get', registry: 'knowledge', id: 'project-fact' })).includes('other only'))
  await host.select(root)
  assert.ok(JSON.stringify(await host.registry({ action: 'get', registry: 'knowledge', id: 'project-fact' })).includes('local edit'))
  assert.deepEqual(readFileSync(path), before)
})

test('damaged source object chains cannot produce a partial control migration', t => {
  const root = makeWorkspace(t)
  const path = join(root, 'old.sqlite'), targetPath = join(root, 'new.sqlite')
  const source = new database.Database(path)
  source.objectService.put('context-retrieval', 'broken', { workspaceId: 'owned' }, new Date().toISOString())
  source.db.exec("UPDATE objects SET body='{}'"); source.close()
  const before = readFileSync(path)
  const target = new database.Database(targetPath)
  try {
    assert.throws(() => importLegacyControl(target, path, 'owned'), /chain failed verification/)
    assert.equal(target.db.prepare('SELECT count(*) AS n FROM codex_control_migration').get().n, 0)
    assert.equal(target.db.prepare('SELECT count(*) AS n FROM objects').get().n, 0)
    assert.deepEqual(readFileSync(path), before)
  } finally { target.close() }
})
