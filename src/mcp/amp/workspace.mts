/** Filesystem scanning and execution are host ports; protocol logic stays in AMP. */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { file as fileApi } from './runtime.mjs'
const { PathSandbox } = fileApi
import { rawTextDigest } from 'attention-manifest-protocol/fingerprint'
import { digestOf } from 'attention-manifest-protocol/semantic'
import type { ContentStore } from 'attention-manifest-protocol/context/contentStore.js'
import type { WorkspaceSnapshot } from 'attention-manifest-protocol/context/workspace.js'
import type { WorkspaceWriter, WorkspaceRunner } from 'attention-manifest-protocol/context/workspaceService.js'
import type { SessionDescriptor } from 'attention-manifest-protocol/session'
import type { FilesystemSession } from 'attention-manifest-protocol/file'
import { scan } from './runtime.mjs'

export function scanWorkspace(descriptor: SessionDescriptor, store: ContentStore, files: FilesystemSession): WorkspaceSnapshot {
  const started = performance.now()
  const trace = (stage: string) => { if (process.env.CODEX_COORDINATION_DEBUG) process.stderr.write(`[codex-coordination] scan ${stage}: ${Math.round(performance.now() - started)}ms\n`) }
  const sandbox = new PathSandbox(descriptor.roots)
  const root = sandbox.defaultRoot()
  const inputs: { path: string; content: string | Uint8Array }[] = []
  const diagnostics: WorkspaceSnapshot['diagnostics'] = []
  let bytes = 0
  function walk(path: string) {
    if (inputs.length >= 5000) { diagnostics.push({ uri: path, code: 'scan_limit', message: 'Host scan file limit reached' }); return }
    const absolute = sandbox.resolve(path, 'list').absolute
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path === '.' ? entry.name : `${path}/${entry.name}`
      if (sandbox.isExcluded(root, child) || entry.isSymbolicLink()) continue
      if (child === 'vendor/coordination-runtime' && existsSync(`${absolute}/${entry.name}/SNAPSHOT.json`)) { diagnostics.push({ uri: child, code: 'vendored_source', message: 'Copied dependency source omitted from semantic indexing; its tools remain registered and files remain readable' }); continue }
      const resolved = sandbox.resolve(child, 'read')
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        const stat = lstatSync(resolved.absolute)
        const office = /\.(?:docx|xlsx|pptx)$/i.test(child)
        if (stat.size > (office ? 16 : 1) * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024) { diagnostics.push({ uri: child, code: 'scan_limit', message: 'File is outside the host snapshot byte budget; use paged filesystem tools' }); continue }
        const buffer = readFileSync(resolved.absolute)
        if (buffer.subarray(0, 80).toString('utf8').startsWith('// Generated from src/mcp by npm run build:server.')) {
          diagnostics.push({ uri: child, code: 'generated_artifact', message: 'Generated server bundle omitted from semantic scanning; inspect its TypeScript source or use paged filesystem tools' })
          continue
        }
        if (buffer.includes(0) && !office) continue
        bytes += buffer.length
        inputs.push({ path: child, content: office ? buffer : buffer.toString('utf8') })
      }
      if (inputs.length >= 5000) break
    }
  }
  walk('.')
  trace(`gathered ${inputs.length} files`)
  const snapshot = scan.scanStructuredWorkspace(inputs, store)
  trace('native semantic projection completed')
  snapshot.diagnostics.push(...diagnostics)
  // The published scanner owns compiler/document/TeX extraction. Other text
  // languages use AMP's actual outline registry as an additional source of facts.
  for (const input of inputs) {
    if (typeof input.content !== 'string') continue
    const file = snapshot.entities.find(entity => entity.kind === 'file' && entity.source.uri === input.path)
    if (!file) continue
    if (!file.detailRef) { file.detailRef = store.put(input.content); file.source.revision = rawTextDigest(input.content) }
    if (!/\.(?:[cm]?[jt]sx?|md|txt|tex|ltx|sty|cls|bib|json)$/i.test(input.path)) {
      try {
        const outline = files.outline({ path: input.path, maxNodes: 200, maxDepth: 8 })
        const add = (nodes: typeof outline.nodes, parentId: string) => {
          for (const node of nodes) {
            if (node.isFile || node.isDirectory) { add(node.children, parentId); continue }
            const id = `symbol:${node.path}:${node.range.startByte}`
            const start = Number(node.range.startLine), end = Number(node.range.endLine)
            const text = input.content as string
            snapshot.entities.push({ id, kind: 'symbol', projectId: file.projectId, parentId, label: node.label, summary: node.detail ?? `${node.type} ${node.label}`, source: { ...file.source, startLine: start, endLine: end }, detailRef: store.put(text.split('\n').slice(start - 1, end).join('\n')), tags: [node.type, outline.language] })
            add(node.children, id)
          }
        }
        add(outline.nodes, file.id)
      } catch { snapshot.diagnostics.push({ uri: input.path, code: 'outline_unavailable', message: 'AMP outline parser could not project this file' }) }
    }
  }
  // Wire references use AMP's ID grammar; original parser locations remain in source.
  const ids = new Map(snapshot.entities.map(entity => [entity.id, entity.id === 'project:.' ? entity.id : `${entity.kind}.${digestOf(entity.id).slice(7, 39)}`]))
  snapshot.entities.forEach(entity => {
    entity.id = ids.get(entity.id)!
    entity.projectId = ids.get(entity.projectId)!
    if (entity.parentId) entity.parentId = ids.get(entity.parentId)!
    if (entity.summaryProvenance) entity.summaryProvenance.children = entity.summaryProvenance.children.map(id => ids.get(id)!)
  })
  snapshot.relations.forEach(relation => { relation.from = ids.get(relation.from)!; relation.to = ids.get(relation.to)! })
  trace(`completed ${snapshot.entities.length} entities and ${snapshot.relations.length} relations`)
  return snapshot
}

export function workspacePorts(descriptor: SessionDescriptor): { writer: WorkspaceWriter; runner: WorkspaceRunner } {
  const sandbox = new PathSandbox(descriptor.roots)
  return {
    writer: { write(request) {
      let temporary: string | undefined
      try {
        const target = sandbox.resolve(request.uri, 'write')
        const current = rawTextDigest(readFileSync(target.absolute, 'utf8'))
        if (current !== request.previousRevision && current.slice(7) !== request.previousRevision) return { ok: false, code: 'revision_mismatch' }
        temporary = `${target.absolute}.amp-${randomUUID()}.tmp`
        writeFileSync(temporary, request.content, 'utf8')
        sandbox.resolve(request.uri, 'write')
        if (rawTextDigest(readFileSync(target.absolute, 'utf8')) !== current) return { ok: false, code: 'revision_mismatch' }
        renameSync(temporary, target.absolute)
        return { ok: true, revision: rawTextDigest(request.content), bytes: Buffer.byteLength(request.content) }
      } catch { return { ok: false, code: 'write_unavailable' } }
      finally { if (temporary) try { unlinkSync(temporary) } catch {} }
    } },
    runner: { run(request) {
      try {
        const cwd = sandbox.resolve(posix.normalize(request.cwd), 'read').absolute
        const started = Date.now()
        // command originates in AMP's fixed project-brand table, never in tool arguments.
        const result = process.platform === 'win32'
          ? spawnSync('cmd.exe', ['/d', '/s', '/c', request.command], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
          : spawnSync('/bin/sh', ['-c', request.command], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
        if (result.error) return { ok: false, code: 'run_unavailable' }
        return { ok: true, exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - started }
      } catch { return { ok: false, code: 'permission_denied' } }
    } },
  }
}
