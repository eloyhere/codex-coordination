/** Project cache exclusion adapters. No repository history or tracked files are changed. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export function ensureCacheIgnored(workspace: string) {
  const root = realpathSync(workspace)
  const within = (path: string) => {
    const rel = relative(root, realpathSync(path))
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Cache ignore configuration must remain within the project')
  }
  const append = (name: string, rules: string[]) => {
    const path = join(root, name)
    within(dirname(path))
    if (existsSync(path)) within(path)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim())
    const missing = rules.filter(rule => rule.includes('\n') ? !text.replaceAll('\r\n', '\n').includes(rule) : !lines.includes(rule))
    if (!missing.length) return
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    appendFileSync(path, (text && !text.endsWith('\n') ? eol : '') + missing.join('\n').replaceAll('\n', eol) + eol)
  }
  // Git, Git-backed Jujutsu, and tools honoring the gitignore convention.
  // Keep this baseline even before a version-control repository is initialized.
  append('.gitignore', ['/.codex-coordination/'])
  if (existsSync(join(root, '.hg')) || existsSync(join(root, '.hgignore'))) append('.hgignore', ['syntax: regexp\n^\\.codex-coordination(?:/|$)'])
  if (existsSync(join(root, '.bzr')) || existsSync(join(root, '.bzrignore'))) append('.bzrignore', ['./.codex-coordination'])
  if (existsSync(join(root, '.fslckout')) || existsSync(join(root, '_FOSSIL_')) || existsSync(join(root, '.fossil-settings'))) {
    const settings = join(root, '.fossil-settings')
    if (!existsSync(settings)) mkdirSync(settings)
    within(settings)
    append('.fossil-settings/ignore-glob', ['.codex-coordination', '.codex-coordination/*'])
  }
  // Do not invent .svnignore or pretend all VCS tools share a file format.
  const unsupported = ['.svn', '.pijul', '_darcs', '.p4config'].filter(marker => existsSync(join(root, marker)))
  if (unsupported.length) process.stderr.write(`AMP cache: automatic VCS exclusion needs a native adapter for ${unsupported.join(', ')}; configure .codex-coordination explicitly.\n`)
}
