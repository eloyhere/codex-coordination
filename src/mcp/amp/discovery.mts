/** Bounded discovery providers over the same host-authorized filesystem and observations. */
import { createSessionFileDiscoveryProvider, createSessionOutlineDiscoveryProvider, createConversationDiscoveryProvider } from 'attention-manifest-protocol/agent'
import type { AgentBinding, DiscoveryProvider, SessionDiscoveryFile, SessionDiscoveryOutline } from 'attention-manifest-protocol/agent'
import { NativeReadStorage } from './filesystem.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'
import { opendirSync } from 'node:fs'
import { createFileOutline, detectCharset, decodeText, fileDigest } from 'attention-manifest-protocol/file'
import { createDefaultLanguageRegistry } from 'attention-manifest-protocol/file/language'
import { readCodexThread } from '../codex/events.mjs'

const MAX_FILES = 200
const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 65536
const MAX_CONTENT_CHARS = 32768

export function localDiscoveryProviders(workspace: () => unknown, policy?: () => NativeFilesystemScope | undefined, thread?: () => string | undefined): DiscoveryProvider[] {
  const registry = createDefaultLanguageRegistry()
  const files = (binding: AgentBinding): SessionDiscoveryFile[] => {
    const root = workspace()
    if (typeof root !== 'string') throw new Error('No selected workspace')
    const scope = policy?.() ?? { root, exclude: [] }
    const storage = new NativeReadStorage(scope, binding.tenantId)
    if (storage.root !== new NativeReadStorage({ root, exclude: [] }, binding.tenantId).root) throw new Error('Filesystem policy belongs to another workspace')
    const result: SessionDiscoveryFile[] = []
    let walked = 0, bytes = 0, rawBytes = 0
    const visit = (parent: string, depth: number) => {
      if (!depth || walked >= 1000 || result.length >= MAX_FILES || bytes >= MAX_BYTES || rawBytes >= MAX_BYTES) return
      const directory = opendirSync(storage.path(parent, true))
      try {
        while (true) {
          if (walked >= 1000 || result.length >= MAX_FILES || bytes >= MAX_BYTES || rawBytes >= MAX_BYTES) return
          const entry = directory.readSync()
          if (!entry) return
          walked++
          if (entry.isSymbolicLink()) continue
          const path = parent === '.' ? entry.name : parent + '/' + entry.name
          try {
            storage.path(path, entry.isDirectory())
            if (entry.isDirectory()) { visit(path, depth - 1); continue }
            if (!entry.isFile()) continue
            // Capture one bounded raw snapshot. Its bytes, hash and version are one observation.
            const limit = Math.min(MAX_FILE_BYTES, MAX_BYTES - rawBytes)
            // Reserve before I/O so a failed/changing read cannot evade the total budget.
            rawBytes += limit
            const snapshot = storage.readSnapshot(path, limit)
            rawBytes -= limit - snapshot.bytes.byteLength
            const item: SessionDiscoveryFile = { scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: binding.sessionId }, id: path, path, version: snapshot.hash ?? `native:${snapshot.version}:${snapshot.size}:name-only` }
            if (!snapshot.complete) { result.push(item); continue }
            let content: string
            try {
              const charset = detectCharset(snapshot.bytes)
              if (charset.binary) { result.push(item); continue }
              content = decodeText(snapshot.bytes, charset).slice(0, MAX_CONTENT_CHARS)
            } catch { result.push(item); continue } // Non-text names remain searchable.
            const contentBytes = Buffer.byteLength(content, 'utf8')
            if (bytes + contentBytes > MAX_BYTES) return
            bytes += contentBytes
            result.push({ ...item, content })
          } catch { /* Excluded, changing or unsupported files do not grant a read. */ }
        }
      } finally { directory.closeSync() }
    }
    visit('.', 4)
    return result
  }
  return [createSessionFileDiscoveryProvider(files), createSessionOutlineDiscoveryProvider(binding => {
    const outlines: SessionDiscoveryOutline[] = []
    for (const file of files(binding)) {
      if (file.content === undefined) continue
      const nodes = createFileOutline({ path: file.path, tenantId: binding.tenantId, rootId: 'discovery', hash: fileDigest(file.content), content: file.content, version: 0, updatedAt: new Date().toISOString() }, file.content, { registry }).entries().slice(0, 30)
      outlines.push({ scope: file.scope, id: file.id, path: file.path, version: file.version, nodes: nodes.map(node => ({ id: node.id, name: node.name, summary: node.kind, startLine: node.range.startLine + 1, endLine: node.range.endLine + 1 })) })
    }
    return outlines
  }), createConversationDiscoveryProvider(binding => {
    const id = thread?.()
    if (!id) throw new Error('Select an observed Codex thread for conversation discovery')
    const host = readCodexThread(workspace, id)
    return host.turns.slice(-20).flatMap(turn => turn.messages.slice(-20).map((message: any, index: number) => ({ scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: binding.sessionId }, id: id + ':' + turn.id + ':' + index, turnId: turn.id, role: message.role, content: typeof message.content === 'string' ? message.content.slice(0, 8192) : '' })))
  })]
}
