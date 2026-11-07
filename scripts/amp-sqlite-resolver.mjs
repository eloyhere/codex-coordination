/** Build-only adaptation: copied AMP storage bytes are never rewritten. */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const ampSqliteRoot = resolve(root, 'vendor/amp-sqlite')
const require = createRequire(import.meta.url)
const nativeRoot = dirname(require.resolve('attention-manifest-protocol/package.json'))
const storageLayers = new Set(['entity', 'cache', 'service', 'repository', 'sql', 'connection'])
const within = (base, path) => {
  const child = relative(base, path)
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep)
}

/** Also used by source tests, which must not rely on generated server bundles. */
export function verifyAmpSqliteSnapshot() {
  const snapshot = JSON.parse(readFileSync(resolve(ampSqliteRoot, 'SNAPSHOT.json'), 'utf8'))
  for (const file of snapshot.files) {
    const path = resolve(ampSqliteRoot, file.path)
    if (!within(ampSqliteRoot, path)) throw new Error(`Invalid AMP snapshot path: ${file.path}`)
    const bytes = readFileSync(path)
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`Copied AMP SQLite source changed: ${file.path}; adapt outside vendor/amp-sqlite`)
    }
  }
  return snapshot
}

/** Canonicalize direct package exports AND native transitive relative imports. */
export function ampSqliteResolver() {
  return {
    name: 'exact-reference-amp-sqlite',
    setup(build) {
      verifyAmpSqliteSnapshot()
      build.onResolve({ filter: /^(?:attention-manifest-protocol(?:\/.*)?|\.{1,2}\/.*|[A-Za-z]:[\\/].*|\/.*)$/ }, args => {
        let candidate
        if (args.path === 'attention-manifest-protocol' || args.path.startsWith('attention-manifest-protocol/')) {
          // Let Node resolve package exports, without loading the upper module.
          candidate = require.resolve(args.path)
        } else if (args.path.startsWith('.')) {
          if (!args.importer || !within(nativeRoot, args.importer)) return
          candidate = resolve(dirname(args.importer), args.path)
        } else if (isAbsolute(args.path)) {
          candidate = args.path
        }
        if (!candidate || !within(nativeRoot, candidate)) return
        const subpath = relative(resolve(nativeRoot, 'lib'), candidate).split(sep)
        if (!storageLayers.has(subpath[0])) return
        const copied = resolve(ampSqliteRoot, 'lib', ...subpath)
        if (!existsSync(copied)) throw new Error(`Missing exact AMP SQLite module: ${subpath.join('/')}`)
        return { path: copied }
      })
    },
  }
}
