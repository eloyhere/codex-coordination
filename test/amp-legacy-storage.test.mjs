import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { projectLegacyStorage } from '../plugins/codex-coordination/mcp/amp/legacy-storage.mjs'
import { makeWorkspace } from './helpers.mjs'

test('legacy workspace database backup preserves source bytes, WAL content, target edits and project isolation', async t => {
  const source = makeWorkspace(t), first = makeWorkspace(t), second = makeWorkspace(t)
  const path = join(source, 'domain.sqlite'), coordination = join(source, 'coordination.sqlite')
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(id TEXT PRIMARY KEY, body TEXT); INSERT INTO facts VALUES('real-id','durable source')")
  const coord = new DatabaseSync(coordination)
  coord.exec("CREATE TABLE missions(id TEXT); INSERT INTO missions VALUES('original-mission')"); coord.close()
  const before = readFileSync(path), wal = readFileSync(path + '-wal'), beforeCoord = readFileSync(coordination)
  try {
    const [one, duplicate] = await Promise.all([projectLegacyStorage(first, { domain: path, coordination }), projectLegacyStorage(first, { domain: path, coordination })])
    assert.equal(one.domain, duplicate.domain)
    assert.equal(one.migrated.length + duplicate.migrated.length, 2)
    const target = new DatabaseSync(one.domain)
    assert.equal(target.prepare('SELECT body FROM facts').get().body, 'durable source')
    target.exec("UPDATE facts SET body='project edit'"); target.close()
    assert.deepEqual((await projectLegacyStorage(first, { domain: path, coordination })).migrated, [])
    const reopened = new DatabaseSync(one.domain, { readOnly: true })
    assert.equal(reopened.prepare('SELECT body FROM facts').get().body, 'project edit'); reopened.close()
    const copiedCoord = new DatabaseSync(one.coordination, { readOnly: true })
    assert.equal(copiedCoord.prepare('SELECT id FROM missions').get().id, 'original-mission'); copiedCoord.close()
    const other = await projectLegacyStorage(second)
    assert.notEqual(other.domain, one.domain)
    assert.equal(existsSync(other.domain), false)
    assert.deepEqual(readFileSync(path), before)
    assert.deepEqual(readFileSync(path + '-wal'), wal)
    assert.deepEqual(readFileSync(coordination), beforeCoord)
  } finally { db.close() }
})

test('legacy storage refuses project directory links escaping the workspace', async t => {
  const root = makeWorkspace(t), outside = makeWorkspace(t)
  symlinkSync(outside, join(root, '.codex-coordination'), 'junction')
  await assert.rejects(projectLegacyStorage(root), /remain within its project/)
})
