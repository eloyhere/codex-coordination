import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { writeFileSync, mkdirSync, symlinkSync, truncateSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { localDiscoveryProviders } from '../plugins/codex-coordination/mcp/amp/discovery.mjs'
import { NativeReadStorage } from '../plugins/codex-coordination/mcp/amp/filesystem.mjs'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { makeWorkspace } from './helpers.mjs'

test('discovery searches canonical tools and scoped source/outlines without private file leakage', async t => {
  const root = makeWorkspace(t), outside = makeWorkspace(t)
  writeFileSync(join(root, 'public.md'), '# PublicNeedle\nSourceNeedle is searchable\n')
  writeFileSync(join(root, 'hidden.md'), '# PrivateNeedle\n')
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git', 'config'), 'PrivateNeedle')
  writeFileSync(join(outside, 'escape.md'), '# PrivateNeedle\n')
  symlinkSync(outside, join(root, 'linked'), 'junction')
  const tools = withAmpSurface([], () => root, () => ({ root, exclude: ['hidden.md'] }))
  const discover = args => tools.find(tool => tool.name === 'attention_manifest_protocol_discover').handler(args)
  const file = await discover({ query: 'SourceNeedle', sources: ['session_files'], minimumScore: 0 })
  assert.ok(JSON.stringify(file.tree).includes('public.md'))
  assert.ok(!file.unavailableSources.includes('session_files'))
  const outline = await discover({ query: 'PublicNeedle', sources: ['session_outlines'] })
  assert.ok(JSON.stringify(outline.tree).includes('PublicNeedle'))
  const secret = await discover({ query: 'PrivateNeedle', sources: ['session_files', 'session_outlines'] })
  assert.equal(secret.returned, 0)
  const canonical = await discover({ query: 'project rules', sources: ['amp'], limit: 20 })
  assert.ok(JSON.stringify(canonical.tree).includes('attention_manifest_protocol_project.rules'))
  assert.equal(canonical.authorization, 'not_granted')
  const weighted = await discover({ query: ['project', 'rules'], sources: ['amp'], weights: { lexical: 1, semantic: 0, signature: 0, context: 0 }, limit: 20 })
  assert.ok(JSON.stringify(weighted.tree).includes('attention_manifest_protocol_project.rules'))
  const pattern = await discover({ query: 'attention_manifest_protocol_project[.]rules', regex: true, sources: ['amp'] })
  assert.ok(pattern.returned > 0)
  const patternArray = await discover({ query: ['project', 'rules'], regex: true, sources: ['amp'] })
  assert.ok(patternArray.returned > 0, JSON.stringify(patternArray))
  await assert.rejects(discover({ query: ['['], regex: true, sources: ['amp'] }), /invalid regular expression/)
  assert.ok(patternArray.sources.includes('amp'))
  const defaults = await discover({ query: 'rules' })
  assert.ok(defaults.sources.includes('amp'))
  assert.ok(!defaults.sources.includes('network'))
  assert.ok((await discover({ query: 'test', sources: ['network'] })).unavailableSources.includes('network'))
})

test('conversation discovery requires an explicit observed thread and stays project scoped', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  let workspace = root
  const tools = withAmpSurface([], () => workspace)
  const call = (name, args) => tools.find(tool => tool.name === 'attention_manifest_protocol_' + name).handler(args)
  for (const id of ['one', 'two']) {
    ingestHook({ cwd: root, session_id: id, hook_event_name: 'SessionStart' })
    ingestHook({ cwd: root, session_id: id, turn_id: id + '-turn', hook_event_name: 'UserPromptSubmit', prompt: id === 'one' ? 'FirstConversationNeedle' : 'ForeignConversationNeedle' })
  }
  assert.ok((await call('discover', { query: 'Needle', sources: ['conversation'] })).unavailableSources.includes('conversation'))
  await call('session.get', { threadId: 'one' })
  const owned = await call('discover', { query: 'FirstConversationNeedle', sources: ['conversation'] })
  assert.ok(owned.returned > 0)
  const foreign = await call('discover', { query: 'ForeignConversationNeedle', sources: ['conversation'] })
  assert.equal(foreign.returned, 0)
  workspace = other
  assert.ok((await call('discover', { query: 'FirstConversationNeedle', sources: ['conversation'] })).unavailableSources.includes('conversation'))
})

const binding = { tenantId: 'discovery-test', principalId: 'tester', sessionId: 'session' }
const rawHash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const searchSource = (root, source) => localDiscoveryProviders(() => root).find(provider => provider.source === source).search('', binding)

test('discovery content and outline versions bind the same snapshot across a file change', async t => {
  const root = makeWorkspace(t), path = join(root, 'race.md')
  const original = Buffer.from('# OriginalSnapshot\nold content\n')
  const changed = Buffer.from('# ChangedSnapshot\nnew content\n')
  // Deterministically change disk after capture, the boundary that formerly preceded a second read.
  const snapshot = NativeReadStorage.prototype.readSnapshot
  const raw = NativeReadStorage.prototype.raw
  t.after(() => { NativeReadStorage.prototype.readSnapshot = snapshot; NativeReadStorage.prototype.raw = raw })
  NativeReadStorage.prototype.raw = () => { throw new Error('Discovery must not fall back to a second raw/read') }
  NativeReadStorage.prototype.readSnapshot = function (...args) {
    const captured = snapshot.apply(this, args)
    writeFileSync(path, changed)
    return captured
  }
  for (const source of ['session_files', 'session_outlines']) {
    writeFileSync(path, original)
    const candidates = await searchSource(root, source)
    const body = candidates.find(candidate => candidate.kind === (source === 'session_files' ? 'content' : 'outline'))
    assert.ok(body)
    assert.equal(body.target.version, rawHash(original))
    assert.match(source === 'session_files' ? body.summary : body.name, /OriginalSnapshot/)
    assert.ok(!JSON.stringify(candidates).includes('ChangedSnapshot'))
  }
})

test('UTF-16 snapshots use AMP decoding and decoded UTF-8 content stays within 2 MiB', async t => {
  const root = makeWorkspace(t)
  const text = ('界'.repeat(100) + '\n').repeat(200)
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  const be = Buffer.from(le).swap16()
  for (let index = 0; index < 40; index++) writeFileSync(join(root, String(index).padStart(2, '0') + '.txt'), index % 2 ? be : le)
  let capturedBytes = 0
  const snapshot = NativeReadStorage.prototype.readSnapshot
  t.after(() => { NativeReadStorage.prototype.readSnapshot = snapshot })
  NativeReadStorage.prototype.readSnapshot = function (...args) {
    const value = snapshot.apply(this, args)
    capturedBytes += value.bytes.byteLength
    return value
  }
  const candidates = await searchSource(root, 'session_files')
  const content = candidates.filter(candidate => candidate.kind === 'content')
  const contentBytes = content.reduce((total, candidate) => total + Buffer.byteLength(candidate.summary + '\n'), 0)
  assert.ok(content.length > 0)
  assert.ok(content.every(candidate => candidate.summary === '界'.repeat(100)))
  assert.ok(new Set(content.map(candidate => candidate.target.path)).size < 40)
  assert.ok(contentBytes <= 2 * 1024 * 1024, `decoded bytes: ${contentBytes}`)
  assert.ok(capturedBytes <= 2 * 1024 * 1024)
  for (const candidate of content) assert.equal(candidate.target.version, rawHash(Number(candidate.target.path.slice(0, 2)) % 2 ? be : le))
})

test('large files stay name-only without body reads and total raw reads are bounded', async t => {
  const root = makeWorkspace(t)
  writeFileSync(join(root, 'large.bin'), '')
  truncateSync(join(root, 'large.bin'), 32 * 1024 * 1024)
  writeFileSync(join(root, 'large-text.txt'), 'large body'.repeat(400000))
  for (let index = 0; index < 40; index++) writeFileSync(join(root, 'small-' + index + '.txt'), 'a'.repeat(65536))
  const nativeRead = fs.readSync, nativeReaddir = fs.readdirSync
  let readBytes = 0, largestRead = 0
  t.after(() => { fs.readSync = nativeRead; fs.readdirSync = nativeReaddir; syncBuiltinESMExports() })
  fs.readSync = function (fd, buffer, offset, length, position) {
    largestRead = Math.max(largestRead, length)
    const amount = nativeRead(fd, buffer, offset, length, position)
    readBytes += amount
    return amount
  }
  fs.readdirSync = () => { throw new Error('Discovery must not materialize a whole directory') }
  syncBuiltinESMExports()
  const candidates = await searchSource(root, 'session_files')
  const large = candidates.find(candidate => candidate.target.path === 'large.bin')
  assert.ok(large)
  assert.equal(large.kind, 'file')
  assert.match(large.target.version, /:name-only$/)
  assert.equal(candidates.filter(candidate => candidate.target.path === 'large.bin').length, 1)
  assert.equal(candidates.filter(candidate => candidate.target.path === 'large-text.txt').length, 1)
  assert.ok(largestRead <= 65536)
  assert.ok(readBytes <= 2 * 1024 * 1024)
})

test('a file growing during snapshot read is rejected and failed reads stay bounded', async t => {
  const root = makeWorkspace(t)
  for (let index = 0; index < 40; index++) writeFileSync(join(root, index + '.txt'), 'a'.repeat(65536))
  const nativeRead = fs.readSync, nativeOpen = fs.openSync
  const files = new Map()
  let readBytes = 0
  t.after(() => { fs.readSync = nativeRead; fs.openSync = nativeOpen; syncBuiltinESMExports() })
  fs.openSync = function (path, ...args) {
    const fd = nativeOpen(path, ...args)
    files.set(fd, path)
    return fd
  }
  fs.readSync = function (fd, buffer, offset, length, position) {
    const amount = nativeRead(fd, buffer, offset, length, position)
    readBytes += amount
    if (files.has(fd)) truncateSync(files.get(fd), 65537)
    return amount
  }
  syncBuiltinESMExports()
  assert.deepEqual(await searchSource(root, 'session_files'), [])
  assert.ok(readBytes > 0)
  assert.ok(readBytes <= 2 * 1024 * 1024, `failed read bytes: ${readBytes}`)
})

test('directory enumeration stops at the walk limit and closes its handles', async t => {
  const root = makeWorkspace(t)
  const excluded = []
  for (let index = 0; index < 1100; index++) {
    const name = 'excluded-' + index + '.txt'
    excluded.push(name)
    writeFileSync(join(root, name), 'private')
  }
  const nativeOpen = fs.opendirSync
  let reads = 0, closes = 0
  t.after(() => { fs.opendirSync = nativeOpen; syncBuiltinESMExports() })
  fs.opendirSync = function (...args) {
    const directory = nativeOpen(...args)
    return {
      readSync() { reads++; return directory.readSync() },
      closeSync() { closes++; return directory.closeSync() },
    }
  }
  syncBuiltinESMExports()
  const provider = localDiscoveryProviders(() => root, () => ({ root, exclude: excluded }))[0]
  assert.deepEqual(await provider.search('', binding), [])
  assert.ok(reads <= 1000, `directory reads: ${reads}`)
  assert.equal(closes, 1)
})
