import { search as searchApi, control as controlApi } from './runtime.mjs'
const { CatalogSearch, projectSearchRecords } = searchApi
const { applyControlRegistry } = controlApi
import { digestOf } from 'amp-legacy/semantic'
import type { Database } from 'amp-legacy/database/service'
import type { WorkspaceSnapshot } from 'amp-legacy/context/workspace.js'
import type { DiscoverySearch } from 'amp-legacy/discover'
import type { HostComponent } from 'amp-legacy/discover'
import { SearchProcess } from './search-process.mjs'
import type { SearchProcessConfig } from './config.mjs'
import { readFileSync } from 'node:fs'
import type { KnowledgeEntry } from 'amp-legacy/knowledge'

function connectionOptions(node: string, configured: Record<string, any> = {}) {
  const options: Record<string, any> = { requestTimeout: 10_000, ...configured, ...(configured.cloud ? {} : { node: configured.node ?? node }) }
  if (configured.auth) {
    const env = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing configured search environment variable ${name}`); return value }
    options.auth = configured.auth.apiKeyEnv ? { apiKey: env(configured.auth.apiKeyEnv) } : configured.auth.bearerEnv ? { bearer: env(configured.auth.bearerEnv) } : configured.auth.passwordEnv ? { username: configured.auth.username, password: env(configured.auth.passwordEnv) } : configured.auth
  }
  if (configured.tls) {
    const { caFile, certFile, keyFile, ...tls } = configured.tls
    options.tls = { ...tls, ...(caFile ? { ca: readFileSync(caFile) } : {}), ...(certFile ? { cert: readFileSync(certFile) } : {}), ...(keyFile ? { key: readFileSync(keyFile) } : {}) }
  }
  return options
}

/** AMP owns indexing, synchronization, scoped retrieval and failure semantics. */
export class HostSearch implements DiscoverySearch {
  private readonly search: InstanceType<typeof CatalogSearch>
  private digest?: string
  private process: SearchProcess
  constructor(private readonly database: Database, private readonly workspaceId: string, private readonly snapshot: WorkspaceSnapshot, node: string, private readonly components: () => HostComponent[] = () => [], processConfig?: SearchProcessConfig, connection?: Record<string, any>, private readonly knowledge: () => KnowledgeEntry[] = () => []) {
    this.process = new SearchProcess(node, processConfig)
    this.search = CatalogSearch.create({ namespace: workspaceId, catalog: database.catalogService, cache: database.catalogStore,
      elasticsearch: { connection: connectionOptions(node, connection), index: 'codex-amp' } })
  }
  async discover(...args: Parameters<DiscoverySearch['discover']>) {
    await this.process.ensure()
    const base = projectSearchRecords({ namespace: this.workspaceId, revision: this.snapshot.revision, workspace: this.snapshot.entities, relations: this.snapshot.relations, host: this.components(), knowledge: this.knowledge() })
    const records = applyControlRegistry(this.database.controlService, this.workspaceId, this.workspaceId, base, this.snapshot.revision, 'project:.')
    const digest = digestOf(records)
    if (this.digest !== digest) { this.search.replaceSnapshot(records); this.digest = digest }
    const state = this.database.catalogService.state(this.workspaceId)
    if (state.generation === 0 || state.generation !== state.syncedGeneration) await this.search.sync({ timeoutMs: 15_000 })
    return this.search.discover(...args)
  }
  async close() { await this.search.close(); await this.process.close() }
}
