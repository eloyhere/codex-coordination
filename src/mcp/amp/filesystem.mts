/** Native Workspace reads over a bounded, scoped Node filesystem port. */
import { Workspace, WorkspaceError } from 'attention-manifest-protocol/workspace'
import { InMemoryFileStorage, fileDigest, detectCharset, decodeText, createFileOutline } from 'attention-manifest-protocol/file'
import { createDefaultLanguageRegistry } from 'attention-manifest-protocol/file/language'
import type { FileRef, FileStoragePort, StoredFile } from 'attention-manifest-protocol/file'
import { AgentGateway, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { openNativeStore, nativeWorkspaceRoot } from './native-store.mjs'

export interface NativeFilesystemScope { root: string; exclude: readonly string[] }
const maxBytes = 16 * 1024 * 1024
const sha = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')

export class NativeReadStorage implements FileStoragePort {
  readonly root: string
  readonly rootId: string
  constructor(readonly scope: NativeFilesystemScope, readonly tenantId: string) { this.root = nativeWorkspaceRoot(scope.root); this.rootId = sha(this.root) }
  path(path: string, directory = false): string {
    if (path !== '.' && (!path || isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)))) throw new WorkspaceError('invalid_path', 'Use a canonical workspace-relative POSIX path')
    const lowered = path.toLowerCase()
    const excluded = ['.git', 'node_modules', '.codex-coordination', ...this.scope.exclude]
    if (path !== '.' && (path.split('/').some(part => ['.git', 'node_modules', '.codex-coordination'].includes(part.toLowerCase())) || excluded.some(value => lowered === value.toLowerCase() || lowered.startsWith(value.toLowerCase() + '/')))) throw new WorkspaceError('invalid_scope', 'Path is excluded by the host workspace scope')
    let current = this.root
    if (path !== '.') for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new WorkspaceError('invalid_path', 'Symbolic links and junctions are not followed') }
    const actual = realpathSync(current), child = relative(this.root, actual)
    if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new WorkspaceError('invalid_scope', 'Path leaves the workspace')
    const stat = lstatSync(actual)
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new WorkspaceError('invalid_target', directory ? 'Expected directory' : 'Expected regular file')
    return actual
  }
  raw(path: string) {
    const absolute = this.path(path), before = lstatSync(absolute)
    if (before.size > maxBytes) throw new WorkspaceError('file_too_large', 'File exceeds 16 MiB host limit')
    const fd = openSync(absolute, 'r')
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new WorkspaceError('stale', 'File changed while opening')
      const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1))
      let size = 0, amount = 0
      while (size < buffer.length && (amount = readSync(fd, buffer, size, buffer.length - size, size))) size += amount
      const after = fstatSync(fd)
      if (size > maxBytes) throw new WorkspaceError('file_too_large', 'File exceeds 16 MiB host limit')
      if (after.size !== size || after.mtimeMs !== opened.mtimeMs) throw new WorkspaceError('stale', 'File changed during bounded read')
      this.path(path)
      const bytes = buffer.subarray(0, size)
      return { bytes, hash: sha(bytes), version: Math.trunc(after.mtimeMs * 1000), updatedAt: after.mtime.toISOString() }
    } finally { closeSync(fd) }
  }
  /** Discovery-only snapshot: large files return metadata without reading their bodies. */
  readSnapshot(path: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > maxBytes) throw new WorkspaceError('invalid_target', 'Invalid snapshot byte limit')
    const absolute = this.path(path), before = lstatSync(absolute)
    const metadata = { size: before.size, version: Math.trunc(before.mtimeMs * 1000), updatedAt: before.mtime.toISOString() }
    if (before.size > limit) return { ...metadata, complete: false as const, bytes: new Uint8Array(), hash: undefined }
    const fd = openSync(absolute, 'r')
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new WorkspaceError('stale', 'File changed while opening snapshot')
      const buffer = Buffer.alloc(opened.size)
      let size = 0, amount = 0
      while (size < buffer.length && (amount = readSync(fd, buffer, size, buffer.length - size, size))) size += amount
      const after = fstatSync(fd)
      const current = lstatSync(this.path(path))
      if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new WorkspaceError('stale', 'File changed during snapshot read')
      return { ...metadata, complete: true as const, bytes: buffer, hash: sha(buffer) }
    } finally { closeSync(fd) }
  }
  private assert(ref: FileRef) { if (ref.tenantId !== this.tenantId || ref.rootId !== this.rootId) throw new WorkspaceError('invalid_scope', 'File scope mismatch') }
  read(ref: FileRef): StoredFile {
    this.assert(ref)
    const raw = this.raw(ref.path), charset = detectCharset(raw.bytes)
    if (charset.binary) throw new WorkspaceError('binary_file', 'Use document_outline for binary files')
    const content = decodeText(raw.bytes, charset)
    return { ...ref, content, hash: fileDigest(content), charset, size: raw.bytes.length, version: raw.version, updatedAt: raw.updatedAt }
  }
  readBytes(ref: FileRef) { this.assert(ref); const raw = this.raw(ref.path); return { ...ref, ...raw, size: raw.bytes.length } }
  compareAndSwap(): never { throw new WorkspaceError('read_only', 'Side-effect storage port is not connected') }
  acquireLease(): never { throw new WorkspaceError('read_only', 'Side-effect storage port is not connected') }
  releaseLease(): void {}
}

export function filesystemBindings(binding: AgentBinding, workspace: () => unknown, policy?: () => NativeFilesystemScope | undefined): ToolDefinition[] {
  const standard = createAgentSurface(), registry = createDefaultLanguageRegistry()
  const descriptors = standard.tools.filter(tool => tool.module === 'workspace' && tool.verb !== 'write')
  const handlers: Record<string, GatewayHandler> = {}
  for (const descriptor of descriptors) handlers[descriptor.name] = parameters => {
    const root = workspace()
    if (typeof root !== 'string') throw new Error('Select a workspace first')
    const provided = policy?.()
    if (provided && realpathSync(provided.root) !== realpathSync(root)) throw new Error('Filesystem policy belongs to a different workspace')
    const storage = new NativeReadStorage(provided ?? { root, exclude: [] }, binding.tenantId)
    const path = String(parameters.path ?? '.')
    if (descriptor.verb === 'list') {
      const depth = Number(parameters.depth ?? 2), limit = Number(parameters.limit ?? 200)
      if (!Number.isInteger(depth) || depth < 1 || depth > 4 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('List bounds: depth 1-4, limit 1-500')
      const entries: Record<string, string>[] = []; let truncated = false
      const visit = (parent: string, remaining: number) => {
        for (const entry of readdirSync(storage.path(parent, true), { withFileTypes: true })) {
          if (entries.length >= limit) { truncated = true; return }
          if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue
          const child = parent === '.' ? entry.name : parent + '/' + entry.name
          try { storage.path(child, entry.isDirectory()) } catch { continue }
          entries.push({ path: child, type: entry.isDirectory() ? 'directory' : 'file' })
          if (entry.isDirectory() && remaining > 1) visit(child, remaining - 1)
        }
      }
      visit(path, depth); return { entries, truncated }
    }
    const ref = { tenantId: binding.tenantId, rootId: storage.rootId, path }
    const initialRawHash = storage.raw(path).hash
    const checkedHash = () => { const hash = storage.raw(path).hash; if (hash !== initialRawHash) throw new WorkspaceError('stale', 'File bytes changed during the operation'); return hash }
    if (descriptor.verb === 'outline') {
      const source = storage.read(ref)
      const limit = Number(parameters.limit ?? 200)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Outline limit must be 1-500')
      const nodes = createFileOutline(source, source.content, { registry }).entries()
      return { nodes: nodes.slice(0, limit), truncated: nodes.length > limit, snapshot: { hash: source.hash, rawHash: checkedHash() } }
    }
    if (descriptor.verb === 'diff') {
      const source = storage.read(ref)
      if (source.hash !== parameters.expectedHash) throw new WorkspaceError('version_conflict', 'File differs from expectedHash')
      const memory = new InMemoryFileStorage(); memory.put(ref, source.content)
      const file = new Workspace({ tenantId: binding.tenantId, rootId: storage.rootId, storage: memory }).mount(path, { mode: 'writable' })
      try { file.write(String(parameters.content)); return { diff: file.diffStructured('disk', { maxHunks: 100 }), expectedHash: source.hash, previewOnly: true, rawHash: checkedHash() } } finally { file.unmount({ discardDirty: true }) }
    }
    const file = new Workspace({ tenantId: binding.tenantId, rootId: storage.rootId, storage }).mount(path, { binary: descriptor.verb === 'document_outline' ? true : undefined })
    try {
      if (descriptor.verb === 'document_outline') { const outline = file.documentOutline(); return { outline: { ...outline, entries: outline.entries.slice(0, 500), text: outline.text.slice(0, 65536), truncated: outline.truncated || outline.entries.length > 500 || outline.text.length > 65536 }, snapshot: file.snapshot(), rawHash: checkedHash() } }
      if (parameters.mode === 'byte') {
        const start = Number(parameters.startByte), end = Number(parameters.endByte)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 262144) throw new Error('Provide a UTF-8 byte window of at most 256 KiB')
        return { text: file.read({ kind: 'byte', start, end }), snapshot: file.snapshot(), rawHash: checkedHash() }
      }
      const start = Number(parameters.startLine ?? 1), count = Number(parameters.maxLines ?? 200)
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 2000) throw new Error('Read bounds: 1-based startLine, maxLines 1-2000')
      const value = file.readLines(start - 1, count)
      if (Buffer.byteLength(value.text) > 262144) throw new Error('Line window exceeds 256 KiB; request fewer lines or a byte window')
      return { ...value, snapshot: file.snapshot(), rawHash: checkedHash() }
    } finally { file.unmount() }
  }
  const allowed = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...standard, tools: descriptors }, authorize: values => values.every(value => allowed.has(value)), onCall(record) { if (typeof workspace() !== 'string') return; const { store } = openNativeStore(workspace); try { store.appendEvent('codex.amp.filesystem.call', { ...record, principalId: binding.principalId }) } finally { store.close() } } })
  return descriptors.map(descriptor => ({ name: descriptor.name, description: descriptor.description + ' Native AMP filesystem read port. Paths are workspace-relative, symlinks/excluded paths are refused, files are capped at 16 MiB. diff compares an explicit proposed buffer without writing disk.',
    inputSchema: { type: 'object', additionalProperties: false, required: descriptor.verb === 'list' ? [] : descriptor.verb === 'diff' ? ['path', 'content', 'expectedHash'] : ['path'], properties: { path: { type: 'string' }, ...(descriptor.verb === 'list' ? { depth: { type: 'integer', minimum: 1, maximum: 4 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } : descriptor.verb === 'read' ? { mode: { enum: ['line', 'byte'] }, startByte: { type: 'integer', minimum: 0 }, endByte: { type: 'integer', minimum: 1 }, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 2000 } } : descriptor.verb === 'outline' ? { limit: { type: 'integer', minimum: 1, maximum: 500 } } : descriptor.verb === 'diff' ? { content: { type: 'string', maxLength: 1048576 }, expectedHash: { type: 'string' } } : {}) } }, annotations: { readOnlyHint: true }, async handler(args) { return await gateway.call(descriptor.name, args, { binding }) as Record<string, any> },
  }))
}
