/** Move workspace-owned legacy databases by consistent SQLite backup; retain sources. */
import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, mkdirSync, openSync, closeSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureCacheIgnored } from '../lib/cache-ignore.mjs'

export async function projectLegacyStorage(workspace: string, sources?: { domain: string; coordination: string }) {
  const root = realpathSync(workspace)
  const within = (path: string) => {
    const rel = relative(root, realpathSync(path))
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Legacy AMP storage must remain within its project')
  }
  let directory = root
  for (const name of ['.codex-coordination', 'amp-legacy']) {
    directory = join(directory, name)
    if (!existsSync(directory)) mkdirSync(directory)
    within(directory)
  }
  ensureCacheIgnored(root)
  const paths = { domain: join(directory, 'domain.sqlite'), coordination: join(directory, 'coordination.sqlite'), control: join(directory, 'control.sqlite') }
  if (existsSync(paths.control)) within(paths.control)
  const migrated: string[] = []
  for (const kind of ['domain', 'coordination'] as const) {
    const target = paths[kind]
    if (existsSync(target)) { within(target); continue }
    const source = sources?.[kind]
    if (!source || !existsSync(source)) continue
    const lock = target + '.migration-lock'
    let fd: number | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      try { fd = openSync(lock, 'wx'); break } catch (error: any) {
        if (error.code !== 'EEXIST') throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    if (fd === undefined) throw new Error('Legacy migration is already running; retry selection')
    const temporary = target + '.import-' + randomUUID()
    try {
      if (existsSync(target)) { within(target); continue }
      const db = new DatabaseSync(source, { readOnly: true })
      try { await backup(db, temporary) } finally { db.close() }
      const check = new DatabaseSync(temporary, { readOnly: true })
      try {
        if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Legacy database backup failed integrity validation')
      } finally { check.close() }
      renameSync(temporary, target)
      migrated.push(kind)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
      closeSync(fd); unlinkSync(lock)
    }
  }
  return { ...paths, migrated }
}
