/** Host-side orchestration; native AMP still owns search, frames and reads.
 * Compact/full projections and explicit catalog accounting follow the patterns
 * reviewed in deepseek-coordination/src/host/{tools,toolCatalog}.ts.
 */
import { randomUUID } from 'node:crypto'
import { digestOf } from 'amp-legacy/semantic'
import type { Database } from 'amp-legacy/database'
import type { ToolDefinition } from '../lib/tools.mjs'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
import { advertisedSchema } from '../coordination/schema.mjs'

interface RetrievalPorts {
  workspaceId: string
  database: Database
  revision(): string
  tools(): readonly ToolDefinition[]
  call(name: string, args: Record<string, unknown>): Promise<Record<string, any>>
  context(args: Record<string, unknown>): any
}
const clean = (value: any) => JSON.parse(JSON.stringify(value))
const checked = (value: any) => { if (value.ok === false) fail(ERROR_CODES.INVALID_STATE, 'Native AMP operation failed', { native: value }); return value }
const bounded = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail(ERROR_CODES.INVALID_ARGUMENT, `Expected an integer in 1..${max}`)
  return value as number
}
const errorOf = (error: unknown) => ({ code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal_error', message: error instanceof Error ? error.message : String(error) })

export class HostRetrieval {
  private measurements = { calls: 0, fullChars: 0, projectedChars: 0 }
  constructor(private readonly ports: RetrievalPorts) {}
  private catalog() {
    return this.ports.tools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: advertisedSchema(tool), ...(tool.annotations ? { annotations: tool.annotations } : {}) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }
  private project(full: Record<string, any>, compact: Record<string, any>, verbosity: unknown) {
    const result = verbosity === 'full' ? full : compact
    this.measurements.calls++
    this.measurements.fullChars += JSON.stringify(full).length
    this.measurements.projectedChars += JSON.stringify(result).length
    return result
  }
  async call(args: Record<string, any>): Promise<Record<string, any>> {
    if (args.verbosity !== undefined && !['compact', 'full'].includes(args.verbosity)) fail(ERROR_CODES.INVALID_ARGUMENT, 'verbosity must be compact or full')
    if (args.action === 'metrics') {
      const catalog = this.catalog()
      const chars = JSON.stringify(catalog).length
      return { ok: true, catalog: { tools: catalog.length, chars, estimatedTokens: Math.ceil(chars / 4), hash: digestOf(catalog), ...(args.verbosity === 'full' ? { names: catalog.map(tool => tool.name) } : {}) }, projections: { ...this.measurements }, basis: 'JSON UTF-16 characters; estimated tokens = chars/4. Catalog exposure, protocol envelopes, Codex usage and provider cache hits are unknown.' }
    }
    if (args.action === 'detail') {
      if (args.name) {
        const original = this.ports.tools().find(tool => tool.name === args.name)
        const tool = original && { name: original.name, description: original.description, inputSchema: original.inputSchema, ...(original.annotations ? { annotations: original.annotations } : {}) }
        if (!tool) fail(ERROR_CODES.NOT_FOUND, 'Unknown installed tool')
        return { ok: true, tool }
      }
      const row = this.ports.database.objectService.get('context-retrieval', String(args.id))
      if (!row) fail(ERROR_CODES.NOT_FOUND, 'Unknown archived retrieval')
      if (!this.ports.database.objectService.verify().ok) fail(ERROR_CODES.INVALID_STATE, 'Archived retrieval object chain failed verification')
      const result = JSON.parse(row.body)
      if (result.workspaceId !== this.ports.workspaceId) fail(ERROR_CODES.PERMISSION, 'Retrieval belongs to another workspace')
      checked(await this.ports.call('amp_tool_filesystem_session', {}))
      return { ok: true, archived: true, id: row.id, hash: row.hash, result }
    }
    if (args.action === 'search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) fail(ERROR_CODES.INVALID_ARGUMENT, 'query must contain 1..2000 characters')
      const limit = bounded(args.limit, 5, 20)
      const query = args.query.trim()
      // Exact installed names do not depend on Elasticsearch availability.
      const exact = this.catalog().find(tool => tool.name === query)
      if (exact) return { ok: true, revision: this.ports.revision(), hits: [{ id: exact.name, kind: 'tool', label: exact.name, summary: exact.description.slice(0, 240), detail: { action: 'detail', name: exact.name } }], exact: true }
      const full = await this.ports.call('amp_tool_workspace_discover', { revision: this.ports.revision(), queries: query, limit, maxDepth: 1, nodeLimit: 8, ...(args.kinds ? { kinds: args.kinds } : {}) })
      if (full.ok === false) return full
      const hits = (full.data?.trees ?? []).map((item: any) => ({ id: item.tree.id, kind: item.tree.kind, label: item.tree.label, summary: item.tree.summary?.slice(0, 240), ...(item.tree.sourceUri ? { path: item.tree.sourceUri } : {}), score: item.tree.score, truncated: item.truncated }))
      return this.project(full, clean({ ok: true, revision: this.ports.revision(), hits, total: full.data?.trees?.[0]?.total ?? 0, next: 'Select target IDs for action read; tool schemas use action detail with name.' }), args.verbosity)
    }
    if (args.action !== 'read') fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown retrieval action')
    if (!Array.isArray(args.targets) || !args.targets.length || args.targets.length > 9 || args.targets.some((id: unknown) => typeof id !== 'string')) fail(ERROR_CODES.INVALID_ARGUMENT, 'read needs 1..9 target IDs')
    const budgetTokens = bounded(args.budgetTokens, 2000, 32000)
    const startLine = bounded(args.startLine, 1, 10_000_000)
    const maxLines = bounded(args.maxLines, 40, 200)
    const scope = args.scope === 'global' ? 'global' : 'workspace'
    const prefix = scope === 'global' ? 'amp_tool_global_' : 'amp_tool_workspace_'
    const revision = this.ports.revision()
    const allocation = await this.ports.context({ action: 'allocate', scope, targets: args.targets, budgetTokens, reason: args.reason ?? 'Explicit quick-read targets' })
    const frameId = allocation.frame.id
    const reads: any[] = []
    const cleanupErrors: any[] = []
    let materialization: any, contextId: string | undefined, release: any, settlement: any, failure: any
    try {
      materialization = checked(await this.ports.call(`${prefix}materialize`, { revision, frameId, budgetTokens }))
      contextId = materialization.data.contextId
      for (const nodeId of [...new Set(args.targets)]) reads.push(await this.ports.call(`${prefix}read`, { revision, contextId, nodeId, startLine, maxLines }))
    } catch (error) { failure = errorOf(error) }
    finally {
      // A native call may have created a context before reporting an error.
      if (!contextId) contextId = (await this.ports.context({ action: 'pending', scope })).pending.find((item: any) => item.frameId === frameId)?.contextId
      if (contextId) {
        try { release = checked(await this.ports.call(`${prefix}release`, { revision, contextId })) } catch (error) { cleanupErrors.push(errorOf(error)) }
        try { settlement = await this.ports.context({ action: 'settle', scope, contextId }) } catch (error) { cleanupErrors.push(errorOf(error)) }
      }
      try { await this.ports.context({ action: 'revoke', scope, frameId }) } catch (error) { cleanupErrors.push(errorOf(error)) }
    }
    const id = `retrieval.${randomUUID()}`
    const full = clean({ workspaceId: this.ports.workspaceId, revision, scope, allocation, materialization, reads, release, settlement, failure, cleanupErrors })
    const stored = this.ports.database.objectService.put('context-retrieval', id, full, new Date().toISOString())
    const pages = reads.map(read => {
      if (read.ok === false) return { ok: false, error: read.error }
      const d = read.data
      const first = d.source.startLine ?? 1
      const imports = d.importation, dependents = d.exportation
      return clean({ ok: true, id: d.nodeId, source: { path: d.source.uri, revision: d.source.revision, targetLines: [d.startLine, d.endLine], fileLines: [first + d.startLine - 1, first + d.endLine - 1] }, text: d.text, nextStartLine: d.nextStartLine, totalLines: d.totalLines,
        imports: imports && { paths: imports.files.map((item: any) => item.path), external: imports.external, total: imports.total, truncated: imports.truncated, externalTruncated: imports.externalTruncated },
        dependents: dependents && { paths: dependents.files.map((item: any) => item.path), total: dependents.total, truncated: dependents.truncated } })
    })
    const remaining = release?.data?.remainingTokens ?? reads.at(-1)?.data?.remainingTokens ?? materialization?.data?.remainingTokens
    const compact = clean({ ok: !failure && !cleanupErrors.length && reads.length > 0 && reads.every(read => read.ok !== false), revision, pages, omissions: materialization?.data && { deferredIds: materialization.data.deferredIds, missingRefs: materialization.data.missingRefs, omissions: materialization.data.omissions }, budget: { allocated: budgetTokens, remaining, estimatedSpent: remaining === undefined ? undefined : budgetTokens - remaining, basis: 'AMP text estimate, not measured model usage' }, archive: { id, hash: stored.hash, receiptId: settlement?.receipt?.id, settled: Boolean(settlement) }, ...(failure ? { error: failure } : {}), ...(cleanupErrors.length ? { cleanupErrors, recovery: { scope, frameId, contextId } } : {}) })
    return this.project({ ok: compact.ok, archive: compact.archive, result: full }, compact, args.verbosity)
  }
}
