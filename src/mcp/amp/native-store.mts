/** One workspace boundary and stable request format for all native AMP domains. */
import { Store } from './storage.mjs'
import { safeStringify } from 'attention-manifest-protocol/serialization'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Store as NativeStore } from 'attention-manifest-protocol/service'
import { ensureCacheIgnored } from '../lib/cache-ignore.mjs'

export function nativeWorkspaceRoot(selected: unknown): string {
  if (typeof selected !== 'string') throw new Error('Select a workspace with coordination_workspace first')
  if (!isAbsolute(selected)) throw new Error('Native workspace root must be an absolute path')
  const root = realpathSync(selected)
  if (!statSync(root).isDirectory()) throw new Error('Native workspace root must be a directory')
  return root
}

export function openNativeStore(workspace: () => unknown) {
  const root = nativeWorkspaceRoot(workspace())
  const within = (path: string) => {
    const child = relative(root, realpathSync(path))
    if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('Native AMP storage must remain inside its selected workspace')
  }
  let directory = root
  for (const segment of ['.codex-coordination', 'amp-07']) {
    directory = join(directory, segment)
    if (!existsSync(directory)) mkdirSync(directory)
    within(directory)
    if (segment === '.codex-coordination') {
      ensureCacheIgnored(root)
      const ignore = join(directory, '.gitignore')
      // Create only our own new rule file; preserve existing user rules.
      try { writeFileSync(ignore, '*\n', { flag: 'wx' }) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
    }
  }
  const path = join(directory, 'store.sqlite')
  // Refuse a pre-existing database link outside the workspace as well.
  if (existsSync(path)) within(path)
  return { root, store: Store.open({ path }) }
}

export const nativeRequest = (value: unknown) => safeStringify(value, { stableKeys: true })
export function nativeEnvironment(store: NativeStore, root: string): string {
  const rootId = createHash('sha256').update(root).digest('hex')
  const facts = ['project_environment', 'project_rule', 'project_metadata', 'session', 'turn', 'intent', 'mission', 'goal', 'plan', 'task', 'action'].map(kind => ({ kind, rows: store.list<any>(kind as any).filter(row => row.rootId === undefined || row.rootId === rootId).map(row => JSON.parse(JSON.stringify(row))).sort((left, right) => nativeRequest(left).localeCompare(nativeRequest(right))) }))
  return 'sha256:' + createHash('sha256').update(nativeRequest({ rootId, facts })).digest('hex')
}
/** Old submissions used JSON.stringify; compare their parsed meaning without rewriting history. */
export function sameNativeRequest(stored: string, current: string): boolean {
  return stored === current || nativeRequest(JSON.parse(stored)) === current
}
