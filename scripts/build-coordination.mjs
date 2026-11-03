import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const ampRoot = dirname(fileURLToPath(import.meta.resolve('attention-manifest-protocol/package.json')))
const ampNamespaces = await Promise.all(readdirSync(join(ampRoot, 'lib'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(ampRoot, 'lib', entry.name, 'index.js'))).map(async entry => ({ name: entry.name === 'global' ? 'globalApi' : entry.name === 'module' ? 'moduleApi' : entry.name, exports: await import(`attention-manifest-protocol/${entry.name}`) })))
ampNamespaces.push({ name: 'goalPlan', exports: await import('attention-manifest-protocol/goal/plan.js') })
const output = resolve(root, 'plugins/codex-coordination/mcp/coordination/runtime.mjs')
execFileSync(process.execPath, [resolve(root, 'scripts/inventory-coordination.mjs')], { stdio: 'inherit' })
mkdirSync(resolve(output, '..'), { recursive: true })
const built = await build({ entryPoints: [resolve(root, 'vendor/coordination-runtime/entry.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, legalComments: 'eof', plugins: [{ name: 'shared-npm-amp', setup(context) {
  context.onResolve({ filter: /^attention-manifest-protocol(?:\/.*)?$/ }, args => ({ path: args.path, namespace: 'shared-amp' }))
  context.onResolve({ filter: /^\.\.\/amp\/runtime\.mjs$/ }, args => args.namespace === 'shared-amp' ? { path: args.path, external: true } : undefined)
  context.onLoad({ filter: /.*/, namespace: 'shared-amp' }, async args => {
    const values = await import(args.path)
    const imports = new Map()
    const exports = Object.keys(values).map(name => {
      const owner = ampNamespaces.find(item => Object.hasOwn(item.exports, name) && item.exports[name] === values[name])
      if (!owner) throw new Error(`No shared AMP namespace for ${args.path}:${name}`)
      if (!imports.has(owner.name)) imports.set(owner.name, `amp${imports.size}`)
      return `export const ${name} = ${imports.get(owner.name)}[${JSON.stringify(name)}];`
    })
    return { loader: 'js', contents: `import { ${[...imports].map(([name, alias]) => `${name} as ${alias}`).join(',')} } from '../amp/runtime.mjs';\n${exports.join('\n')}` }
  })
} }, { name: 'codex-file-authorization', setup(context) {
  context.onResolve({ filter: /^node:fs(?:\/promises)?$/ }, args => {
    if (!/[/\\]src[/\\]host[/\\](?:parseService|graphView|graphIndex|workspaceTools)\.ts$/.test(args.importer)) return
    return { path: resolve(root, `vendor/coordination-runtime/fs-${args.path.endsWith('/promises') ? 'async' : 'sync'}.ts`) }
  })
} }], banner: { js: '// Generated from vendor/coordination-runtime. Do not edit.\nimport {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);' } })
const packages = new Map()
for (const input of Object.keys(built.metafile.inputs)) {
  if (!input.includes('node_modules')) continue
  let directory = dirname(resolve(input))
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) { const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (pkg.name) { packages.set(pkg.name, { pkg, directory }); break } }
    directory = dirname(directory)
  }
}
const notices = ['# Coordination runtime and dependencies\n', readFileSync(resolve(root, 'vendor/coordination-runtime/NOTICE'), 'utf8'), readFileSync(resolve(root, 'vendor/coordination-runtime/LICENSE'), 'utf8')]
for (const [name, { pkg, directory }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices.push(`\n## ${name} ${pkg.version}\nLicense: ${pkg.license ?? 'see below'}\n`)
  for (const file of readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))) notices.push(readFileSync(join(directory, file), 'utf8'))
}
mkdirSync(resolve(root, 'plugins/codex-coordination/assets'), { recursive: true })
writeFileSync(resolve(root, 'plugins/codex-coordination/assets/COORDINATION_THIRD_PARTY_LICENSES.md'), notices.join('\n'))
const { createCoordination } = await import(pathToFileURL(output).href + '?catalog')
const directory = mkdtempSync(join(tmpdir(), 'coordination-catalog-'))
const runtime = createCoordination({ databasePath: join(directory, 'catalog.sqlite'), workspace: directory })
try {
  const expected = JSON.parse(readFileSync(resolve(root, 'vendor/coordination-runtime/SNAPSHOT.json'), 'utf8')).tools.sort()
  if (JSON.stringify(runtime.definitions.map(tool => tool.name).sort()) !== JSON.stringify(expected)) throw new Error('Copied agent registration inventory changed')
  writeFileSync(resolve(root, 'src/mcp/coordination/catalog.json'), JSON.stringify(runtime.definitions, null, 2) + '\n')
  console.log(`built ${runtime.definitions.length} coordination agent tools`)
} finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }) }
