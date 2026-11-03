/** Record or verify the exact source snapshot copied at the user's request. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../vendor/coordination-runtime/', import.meta.url))
const sha = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
const manifest = join(root, 'SNAPSHOT.json')
if (process.argv.includes('--record')) {
  const paths = ['LICENSE', 'NOTICE', 'package.json', ...['src/host', 'src/shared', 'src/protocol', 'locale'].flatMap(directory => readdirSync(join(root, directory), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length).replaceAll('\\', '/')))].sort()
  const definitions = JSON.parse(readFileSync(new URL('../src/mcp/coordination/catalog.json', import.meta.url), 'utf8'))
  writeFileSync(manifest, JSON.stringify({ repository: 'https://github.com/eloyhere/deepseek-coordination', version: '0.23.2', sourceCommit: '9c97d6e7d97fac92c620cc8b6f18b38374436f9a', note: 'Copied from the local working tree; file hashes, not the commit alone, identify this snapshot. Codex entry/fs ports are separate files.', tools: definitions.map(tool => tool.name), files: paths.map(path => ({ path, sha256: sha(path) })) }, null, 2) + '\n')
}
const snapshot = JSON.parse(readFileSync(manifest, 'utf8'))
for (const file of snapshot.files) if (sha(file.path) !== file.sha256) throw new Error(`Copied source changed: ${file.path}`)
console.log(`verified ${snapshot.files.length} verbatim upstream source files and ${snapshot.tools.length} agent registrations`)
