/** Codex-owned filesystem port for copied workspace modules. */
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const guards = new Map<string, (path: string) => boolean>()
export function bindFiles(root: string, guard?: (path: string) => boolean) {
  const base = resolve(root)
  guards.set(base, guard ?? (() => true))
  return () => guards.delete(base)
}
export function permitted(path: any): boolean {
  if (typeof path === 'number') return true
  const target = resolve(path instanceof URL ? fileURLToPath(path) : String(path))
  for (const [root, guard] of guards) {
    const child = relative(root, target)
    if (child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) { try { return guard(target) } catch { return false } }
  }
  return false
}
export function check(path: any) { if (!permitted(path)) { const error = new Error('File path is outside the selected AMP authorization') as any; error.code = 'permission_denied'; throw error } }
