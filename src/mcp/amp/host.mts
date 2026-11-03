/** Trusted local host for AMP's own services. Wire contracts are imported unchanged. */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute, sep, resolve } from 'node:path'
import { database as databaseApi, session as sessionApi, control as controlApi, environment as environmentApi } from './runtime.mjs'
const { Database } = databaseApi
const { SessionRegistry } = sessionApi
const { SessionControlService } = controlApi
const { getDefaultEnvironments } = environmentApi
import { file as fileApi, globalApi, context as contextApi } from './runtime.mjs'
const { FilesystemService } = fileApi
const { GlobalFilesystemSession, GlobalAgentService } = globalApi
const { WorkspaceAgentService, MemoryContentStore } = contextApi
const { SqliteFilesystemStore } = databaseApi
import { scanWorkspace, workspacePorts } from './workspace.mjs'
import { HostSearch } from './search.mjs'
import { HostRegistries, RegistryNames } from './registries.mjs'
import { DomainApi } from './api.mjs'
import { HostKeys } from './keys.mjs'
import { HostConnections } from './connections.mjs'
import { HostCognitiveRuntime } from './cognitive.mjs'
import { HostHooks } from './hooks.mjs'
import { HostArtifacts } from './artifacts.mjs'
import { HostRetrieval } from './retrieval.mjs'
import { HostCoordination } from '../coordination/host.mjs'
import { requestHostApproval } from './host-client.mjs'
import { readHostConfiguration } from './config.mjs'
import type { LlmClient } from 'attention-manifest-protocol/module'
import { controlToolDefinitions } from 'attention-manifest-protocol/protocol/control.js'
import { workspaceToolDefinitions } from 'attention-manifest-protocol/protocol/workspace.js'
import { globalToolDefinitions } from 'attention-manifest-protocol/protocol/global.js'
import { filesystemToolDefinitions } from 'attention-manifest-protocol/protocol/filesystem.js'
import { globalFilesystemToolDefinitions } from 'attention-manifest-protocol/protocol/globalFilesystem.js'
import { digestOf } from 'attention-manifest-protocol/semantic'
import { selectFocus } from 'attention-manifest-protocol/attention/attention.js'
import { randomUUID } from 'node:crypto'
import type { Frame, Receipt } from 'attention-manifest-protocol/types'
import type { ControlPort } from 'attention-manifest-protocol/control'
import type { WorkspaceSnapshot } from 'attention-manifest-protocol/context/workspace.js'
import type { FilesystemSession } from 'attention-manifest-protocol/file'
import { resolveWorkspace } from '../lib/store.mjs'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
import type { ToolDefinition } from '../lib/tools.mjs'

export const AMP_DEFINITIONS = [
  ...workspaceToolDefinitions(), ...globalToolDefinitions(),
  ...filesystemToolDefinitions(), ...globalFilesystemToolDefinitions(),
  ...controlToolDefinitions('session'),
]

export interface HostOptions { databasePath?: string; searchNode?: string; llm?: LlmClient }
interface Binding {
  workspace: string
  workspaceId: string
  snapshot: WorkspaceSnapshot
  registries: HostRegistries
  api: DomainApi
  keys: HostKeys
  connections: HostConnections
  cognitive: HostCognitiveRuntime
  hooks: HostHooks
  artifacts: HostArtifacts
  retrieval: HostRetrieval
  coordination(): HostCoordination
  control: ControlPort
  files: FilesystemSession
  globalFiles: InstanceType<typeof GlobalFilesystemSession>
  workspaceService: InstanceType<typeof WorkspaceAgentService>
  globalService: InstanceType<typeof GlobalAgentService>
  sessionService: InstanceType<typeof SessionControlService>
  refresh(): Promise<void>
  close(): Promise<void>
}

export class AmpHost {
  private database?: InstanceType<typeof Database>
  private sessions?: InstanceType<typeof SessionRegistry>
  private filesystem?: InstanceType<typeof FilesystemService>
  private binding?: Binding
  private databasePath?: string
  private toolCatalog?: readonly ToolDefinition[]
  constructor(private readonly options: HostOptions = {}) {}
  setToolCatalog(tools: readonly ToolDefinition[]) { this.toolCatalog = tools }
  private toolDefinitions() { return this.toolCatalog ?? AMP_TOOLS }

  /** Selecting a repository is a host operation; canonical tool args never contain credentials. */
  async select(root: unknown) {
    const workspace = realpathSync(resolveWorkspace(root))
    if (this.binding?.workspace === workspace) return this.status()
    if (this.binding && (this.binding.workspaceService.pendingSettlements().length || this.binding.globalService.pendingSettlements().length)) fail(ERROR_CODES.INVALID_STATE, 'Settle pending contexts before switching repositories')
    this.initialize()
    const config = readHostConfiguration()
    const within = (base: string, target: string) => { const child = relative(base, target); return child === '' || !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child) }
    const privateDirectories = [join(homedir(), '.codex'), ...(this.databasePath !== ':memory:' ? [join(dirname(this.databasePath!), 'workspaces')] : [])].map(path => resolve(path))
    if (privateDirectories.some(path => within(path, workspace))) fail(ERROR_CODES.PERMISSION, 'AMP host credentials and private state cannot be selected as an agent filesystem root')
    const excluded = ['.git', 'node_modules', '.codex-coordination']
    const privateFiles = this.databasePath !== ':memory:' ? [this.databasePath!, ...['-wal', '-shm', '-journal'].map(suffix => this.databasePath! + suffix)] : []
    if (process.env.CODEX_AMP_HOST_CONFIG) privateFiles.push(resolve(process.env.CODEX_AMP_HOST_CONFIG))
    if (config.searchConnection?.tls?.keyFile) privateFiles.push(resolve(config.searchConnection.tls.keyFile))
    for (const path of [...privateDirectories, ...privateFiles]) if (within(workspace, path)) excluded.push(relative(workspace, path).split(sep).join('/'))
    const database = this.database!
    const sessions = this.sessions!
    const workspaceId = `workspace.${digestOf(workspace).slice(7, 39)}`
    const existing = database.db.prepare('SELECT workspace_id FROM workspaces WHERE workspace_id=?').get(workspaceId)
    if (!existing) database.controlService.createWorkspace(workspaceId, workspace)
    const opened = sessions.open({
      agentId: 'codex-coordination', workspaceId, label: 'Codex MCP connection',
      roots: [{ id: 'repo', path: workspace, writable: true, exclude: excluded }],
      permissions: { read: true, write: true, create: true, remove: false },
    })
    const { sessionId, token } = opened.credential
    const control = database.controlService.bind({ workspaceId, sessionId, allowGlobal: true,
      authenticate: () => { sessions.verify(sessionId, token) },
    })
    this.seedDefaults(control)
    const files = this.filesystem!.bind(sessionId, token)
    const registries = new HostRegistries(database, workspaceId)
    registries.activateStored()
    let store = new MemoryContentStore()
    let snapshot = scanWorkspace(opened.descriptor, store, files)
    const ports = workspacePorts(opened.descriptor)
    for (const endpoint of config.endpoints ?? []) {
      const existing = database.controlService.listRegistry(workspaceId, 'protocols', true).find(entry => entry.id === endpoint.id)
      if (!existing) control.call('workspace', 'adjust', { action: 'register', registry: 'protocols', id: endpoint.id, value: { name: endpoint.name ?? endpoint.id, family: endpoint.family, version: endpoint.family === 'mcp' ? '2026-07-28' : endpoint.family === 'a2a' ? '1.0' : '0.1', description: 'Host-configured protocol implementation', ...(endpoint.url ? { endpoint: endpoint.url } : {}) }, expectedVersion: 0 })
    }
    const searchNode = this.options.searchNode ?? process.env.CODEX_AMP_SEARCH_NODE ?? config.searchNode ?? 'http://127.0.0.1:9200'
    let copied: HostCoordination | undefined
    const copiedKnowledge = () => copied?.knowledge() ?? (this.databasePath !== ':memory:' && existsSync(join(dirname(this.databasePath!), 'workspaces', `${workspaceId}.coordination.sqlite`)) ? this.binding!.coordination().knowledge() : [])
    const components = () => [
      { id: 'codex-coordination', kind: 'plugin' as const, name: 'Codex Coordination', description: 'AMP host integration for Codex', projectId: 'project:.' },
      ...this.toolDefinitions().map(tool => ({ id: tool.name, kind: 'tool' as const, name: tool.name, description: tool.description, projectId: 'project:.' })),
      ...registries.components(),
    ]
    let search = new HostSearch(database, workspaceId, snapshot, searchNode, components, config.searchProcess, config.searchConnection, copiedKnowledge)
    let workspaceService = new WorkspaceAgentService({ agentId: 'codex-coordination', snapshot, store, projectIds: ['project:.'], control, search, ...ports })
    let globalService = new GlobalAgentService({ agentId: 'codex-coordination', snapshot, store, projectIds: snapshot.entities.filter(entity => entity.kind === 'project').map(entity => entity.id), control, search, ...ports })
    const previous = this.binding
    const domainPath = this.databasePath === ':memory:' ? ':memory:' : join(dirname(this.databasePath!), 'workspaces', `${workspaceId}.sqlite`)
    if (domainPath !== ':memory:') mkdirSync(dirname(domainPath), { recursive: true })
    const domainDatabase = new Database(domainPath)
    const keys = new HostKeys(domainDatabase)
    const api = new DomainApi(domainDatabase, (kid, historical) => keys.verificationKey(kid, historical))
    const connections = new HostConnections(config.endpoints ?? [], domainDatabase, () => database.controlService.listRegistry(workspaceId, 'protocols', true), keys, api, config.listeners ?? [])
    const cognitive = new HostCognitiveRuntime(domainDatabase, control, registries, connections, api, config, AMP_DEFINITIONS, (name, args) => this.call(name, args), this.options.llm)
    this.binding = { workspace, workspaceId, snapshot, registries, api, keys, connections, cognitive, hooks: new HostHooks(files, domainDatabase, api), artifacts: new HostArtifacts(domainDatabase), retrieval: new HostRetrieval({ workspaceId, database, revision: () => snapshot.revision, tools: () => this.toolDefinitions(), call: (name, args) => this.call(name, args), context: args => this.context(args) }), control, files, globalFiles: new GlobalFilesystemSession(files), workspaceService, globalService,
      coordination: () => copied ??= new HostCoordination({ workspace, sessionId: `${workspaceId}.coordination`, databasePath: domainPath === ':memory:' ? ':memory:' : domainPath.replace(/\.sqlite$/, '.coordination.sqlite'), descriptor: opened.descriptor, revision: () => snapshot.revision, call: (name, args) => this.call(name, args) }),
      sessionService: new SessionControlService({ control }),
      refresh: async () => {
        if (workspaceService.pendingSettlements().length || globalService.pendingSettlements().length) fail(ERROR_CODES.INVALID_STATE, 'Settle pending contexts before refreshing the snapshot')
        const nextStore = new MemoryContentStore()
        const nextSnapshot = scanWorkspace(opened.descriptor, nextStore, files)
        await search.close()
        store = nextStore; snapshot = nextSnapshot
        search = new HostSearch(database, workspaceId, snapshot, searchNode, components, config.searchProcess, config.searchConnection, copiedKnowledge)
        workspaceService = new WorkspaceAgentService({ agentId: 'codex-coordination', snapshot, store, projectIds: ['project:.'], control, search, ...ports })
        globalService = new GlobalAgentService({ agentId: 'codex-coordination', snapshot, store, projectIds: snapshot.entities.filter(entity => entity.kind === 'project').map(entity => entity.id), control, search, ...ports })
        Object.assign(this.binding!, { snapshot, workspaceService, globalService })
      },
      close: async () => { await copied?.close(); await search.close(); cognitive.close(); await connections.close(); domainDatabase.close(); this.filesystem!.dispose(sessionId); sessions.close(sessionId) },
    }
    await previous?.close()
    return this.status()
  }

  status() {
    return { ok: true, workspace: this.binding?.workspace ?? null, workspaceId: this.binding?.workspaceId ?? null,
      sessionId: this.binding?.files.sessionId ?? null, revision: this.binding?.snapshot.revision ?? null, diagnostics: this.binding?.snapshot.diagnostics ?? [], tools: AMP_DEFINITIONS.map(tool => tool.name) }
  }
  workspaceView(value: Record<string, any>, verbosity: unknown) {
    if (verbosity === 'full') return value
    const counts: Record<string, number> = {}
    for (const diagnostic of value.diagnostics ?? []) counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1
    return { ok: value.ok, workspace: value.workspace, workspaceId: value.workspaceId, revision: value.revision, tools: this.toolDefinitions().length, canonicalTools: AMP_DEFINITIONS.length, diagnostics: { total: value.diagnostics?.length ?? 0, byCode: counts }, next: 'Use coordination_context search/read/detail; verbosity full expands binding diagnostics.' }
  }
  async coordination(name: string, args: Record<string, unknown>) {
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first with coordination_workspace')
    return this.binding.api.wire(await this.binding.coordination().call(name, args)) as Record<string, any>
  }
  async project(args: Record<string, unknown>) {
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first')
    const parameters = { revision: this.binding.snapshot.revision, projectId: 'project:.', action: 'detect', ...args }
    if (parameters.action !== 'detect' && !args.dryRun && !await requestHostApproval('coordination', 'coordination_project', parameters)) fail(ERROR_CODES.PERMISSION, 'The host did not approve this project action')
    return this.call('amp_tool_workspace_project', parameters)
  }
  async refresh() { if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first'); await this.binding.refresh(); return this.status() }

  async domain(args: Record<string, unknown>) {
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first')
    return this.binding.api.call(args)
  }
  async adapter(name: 'keys' | 'connections' | 'cognitive' | 'hooks' | 'artifacts', args: Record<string, unknown>) {
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first')
    return this.binding.api.wire(await this.binding[name].call(args)) as Record<string, unknown>
  }

  async registry(args: Record<string, unknown>) {
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first')
    if (['skills', 'knowledge', 'protocols', 'modules', 'environments', 'concepts'].includes(String(args.registry))) {
      const { scope, ...parameters } = args
      if (args.action === 'clear') {
        if (args.expectedVersion !== undefined) fail(ERROR_CODES.INVALID_ARGUMENT, 'Scoped bulk clear uses per-entry native versions; expectedVersion is not a registry-wide version')
        const name = scope === 'global' ? 'amp_tool_global_adjust' : 'amp_tool_workspace_adjust'
        const listed = await this.call(name, { action: 'list', registry: args.registry })
        if (listed.ok === false) return listed
        const entries = (listed.data as any).entries as { id: string }[]
        const results = []
        for (const entry of entries) {
          const row = this.database!.db.prepare('SELECT version FROM registry_entries WHERE scope_key=? AND registry=? AND entry_id=?').get(scope === 'global' ? 'global' : `workspace:${this.binding.workspaceId}`, String(args.registry), entry.id) as { version: number } | undefined
          results.push(await this.call(name, { action: 'remove', registry: args.registry, id: entry.id, expectedVersion: row?.version ?? 0, ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}) }))
        }
        return { ok: results.every(result => result.ok !== false), registry: args.registry, dryRun: args.dryRun === true, results }
      }
      return this.call(scope === 'global' ? 'amp_tool_global_adjust' : 'amp_tool_workspace_adjust', parameters)
    }
    if (args.scope === 'global') fail(ERROR_CODES.INVALID_ARGUMENT, 'Specialized parser/runtime registries are workspace-scoped')
    const result = await this.binding.registries.call(args, (name, parameters) => this.call(name, parameters))
    if (!args.dryRun && ['register', 'update', 'remove', 'clear'].includes(String(args.action)) && ['languages', 'tokenKinds', 'nodeKinds', 'outlines', 'outlineKeywords', 'sqlDialects'].includes(String(args.registry))) {
      // Native outline keys track file bytes, not parser configuration. These
      // derived caches must be invalidated when the host changes that configuration.
      this.database!.db.exec('DELETE FROM file_outlines')
      this.filesystem!.dispose(this.binding.files.sessionId)
    }
    return result
  }

  context(args: Record<string, unknown>): any {
    const binding = this.binding
    if (!binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository first')
    if (['search', 'read', 'detail', 'metrics'].includes(String(args.action))) return binding.retrieval.call(args)
    const scope = args.scope === 'global' ? 'global' : 'workspace'
    const service = scope === 'global' ? binding.globalService : binding.workspaceService
    if (args.action === 'pending') return { ok: true, scope, pending: service.pendingSettlements() }
    if (args.action === 'settle') {
      const contextId = String(args.contextId)
      if (!service.pendingSettlements().some(item => item.contextId === contextId)) fail(ERROR_CODES.NOT_FOUND, 'Unknown context')
      const at = new Date().toISOString()
      const receipt: Receipt = { amp: '0.1', kind: 'receipt', id: `receipt.${randomUUID()}`, op: 'read', at, usage: {}, outcome: 'success', note: 'Host archived the materialized context; no model token usage is claimed.' }
      // AMP's in-memory view has optional undefined properties; persist its JSON wire form.
      const snapshot = JSON.parse(JSON.stringify(service.settle(contextId, receipt))) as Record<string, unknown>
      this.database!.objectService.put('receipt', receipt.id, receipt, at)
      this.database!.objectService.put('context', contextId, snapshot, at)
      return { ok: true, scope, snapshot, receipt }
    }
    if (args.action === 'revoke') { service.revokeFrame(String(args.frameId)); return { ok: true, scope } }
    const targets = args.targets
    const budgetTokens = args.budgetTokens
    if (!Array.isArray(targets) || !targets.length || targets.length > 100 || targets.some(id => typeof id !== 'string') || !Number.isSafeInteger(budgetTokens) || (budgetTokens as number) < 1 || (budgetTokens as number) > 100_000) fail(ERROR_CODES.INVALID_ARGUMENT, 'allocate needs 1–100 target IDs and a token budget of 1–100000')
    const candidates = [...new Set(targets as string[])].map(id => {
      const entity = binding.snapshot.entities.find(entity => entity.id === id)
      if (!entity) fail(ERROR_CODES.NOT_FOUND, `Unknown workspace target ${id}`)
      return { target: { kind: 'other' as const, id }, role: 'artifact' as const, tier: 'T2' as const, voi: 1, goalFit: 1, uncertainty: 0.5, novelty: 0.5, costTokens: Math.ceil(entity.summary.length / 4) + 16, risk: 0, trustCap: 1, why: typeof args.reason === 'string' ? args.reason : 'Explicitly requested workspace target' }
    })
    const selection = selectFocus(candidates, { budgetTokens: budgetTokens as number, cap: 9 })
    const frame: Frame = { amp: '0.1', kind: 'frame', id: `frame.${randomUUID()}`, agent: 'codex-coordination', cycle: 0, ts: new Date().toISOString(), mode: 'exploit', slots: selection.slots, ignored: selection.ignored, budget: { allocated: { tokens: budgetTokens as number }, spent: {} }, digest: '' }
    const { digest: ignoredDigest, ...body } = frame
    frame.digest = digestOf(body)
    service.registerFrame(frame, binding.snapshot.revision)
    this.database!.objectService.put('frame', frame.id, frame, frame.ts)
    return { ok: true, scope, revision: binding.snapshot.revision, frame }
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.binding && process.env.CODEX_COORDINATION_WORKSPACE) await this.select(process.env.CODEX_COORDINATION_WORKSPACE)
    if (!this.binding) fail(ERROR_CODES.INVALID_STATE, 'Select a repository with coordination_workspace before using the AMP services')
    if (name.startsWith('amp_tool_filesystem_')) return this.filesystem!.call(this.binding.files, name, args)
    if (name.startsWith('amp_tool_globalfs_')) {
      try { return await this.binding.globalFiles.call(name, args) }
      catch (error) { return { ...this.binding.files.errorResponse(this.filesystem!.mapError(error)), protocol: 'amp_protocol_globalfs' } }
    }
    if (name.startsWith('amp_tool_workspace_') || name.startsWith('amp_tool_global_')) {
      const result = name.startsWith('amp_tool_workspace_') ? await this.binding.workspaceService.callAsync(name, args) : await this.binding.globalService.callAsync(name, args)
      if (name.endsWith('_adjust')) this.binding.connections.reconcile()
      return result
    }
    return this.binding.sessionService.call(name, args)
  }

  async close() { await this.binding?.close(); this.binding = undefined; this.database?.close(); this.database = undefined; this.sessions = undefined; this.filesystem = undefined }

  private seedDefaults(control: ControlPort) {
    const add = (registry: string, id: string, value: Record<string, unknown>) => {
      const existing = this.database!.db.prepare("SELECT 1 FROM registry_entries WHERE scope_key='global' AND registry=? AND entry_id=?").get(registry, id)
      if (existing) return // Preserve both agent edits and deliberate deletion tombstones.
      control.call('global', 'adjust', { action: 'register', registry, id, value, expectedVersion: 0 })
    }
    for (const entry of getDefaultEnvironments()) add('environments', entry.id, { ...entry })
    const skillRoot = new URL('../../skills/', import.meta.url)
    if (existsSync(skillRoot)) for (const directory of readdirSync(skillRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const file = new URL(`${directory.name}/SKILL.md`, skillRoot)
      if (existsSync(file)) add('skills', directory.name, { name: directory.name, description: `Codex coordination workflow ${directory.name}`, instructions: readFileSync(file, 'utf8'), version: '1' })
    }
  }

  private initialize() {
    if (this.database) return
    const path = this.options.databasePath ?? process.env.CODEX_AMP_DATABASE ?? join(homedir(), '.codex', 'coordination', 'amp.sqlite')
    if (path !== ':memory:' && !isAbsolute(path)) fail(ERROR_CODES.INVALID_ARGUMENT, 'AMP database path must be absolute')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new Database(path)
    this.databasePath = path
    this.sessions = new SessionRegistry({ store: this.database.workspaceSessions })
    this.filesystem = new FilesystemService({ registry: this.sessions, store: new SqliteFilesystemStore(this.database.db), timeZone: 'utc' })
  }
}

export const ampHost = new AmpHost()
// Explicit item alternatives keep MCP hosts from treating positional JSON
// arguments as string-only arrays when producing model-facing tool types.
const jsonArgumentItems = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object', additionalProperties: true }, { type: 'array', items: {} }] }

export const AMP_TOOLS: ToolDefinition[] = [
  { name: 'coordination_artifacts', description: 'Validate and durably record every artifact kind in the published AMP JSON Schemas, including manifests, warrants, evidence hypotheses/unknowns, federation, delegation, social/team objects, messages and compaction checkpoints. Uses native AMP object-chain storage and strict schema/warrant validators. Records are immutable by kind/id. snapshot exports the eight core ledger kinds with native exportLedger; verify checks the backing object chain. Governance objects use the native GovernanceStore resource.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['record', 'get', 'list', 'snapshot', 'verify'] }, artifact: { type: 'object' }, kind: { type: 'string' }, id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['action'] },
    async handler(args) { return ampHost.adapter('artifacts', args) } },
  { name: 'coordination_keys', description: 'Manage workspace host signing keys and invoke native AMP manifest/card, federation, governance signature, envelope and checkpoint operations. Private keys never leave the host. describe lists operations; call accepts positional arguments with {$key:kid}, {$publicKey:kid}, {$signer:{kid,signer}}, {$keyRegistry:true}, {$keyring:true}, {$governanceKeyring:true}. Revoked or retired keys cannot sign.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['describe', 'list', 'generate', 'rotate', 'import_public', 'revoke', 'retire', 'keyring', 'call'] }, kid: { type: 'string' }, previousKid: { type: 'string' }, signer: { type: 'string' }, publicJwk: { type: 'object' }, method: { enum: ['verifyWindow', 'revocations', 'isRevoked'] }, at: { type: 'string' }, reason: { type: 'string' }, overlapMs: { type: 'number', minimum: 0 }, validFrom: { type: 'string' }, validTo: { type: 'string' }, module: { enum: ['manifest', 'governance', 'protocol', 'ledger'] }, operation: { type: 'string' }, arguments: { type: 'array', items: jsonArgumentItems, maxItems: 32 } }, required: ['action'] },
    async handler(args) { return ampHost.adapter('keys', args) } },
  { name: 'coordination_connections', description: 'Use host-configured MCP HTTP/stdio and A2A endpoints. MCP negotiation, ProtocolRegistry binding/resolution, tool mirroring/withdrawal, digest pinning, argument validation, warrants, budgets and receipts use AMP implementations. A metadata URL never opens a connection. Endpoints and credentials come only from the host configuration. This tool cannot issue host approvals.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['list', 'connect', 'disconnect', 'sync', 'verify', 'call', 'card', 'delegate', 'handle', 'deliver', 'listen', 'stop_listener'] }, id: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' }, delegation: { type: 'object' }, message: { type: 'object' }, bus: { type: 'object', required: ['$ampRef'], additionalProperties: false, properties: { $ampRef: { type: 'string' } } }, claim: { type: 'object' }, approval: { type: 'string' }, handle: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, limitTokens: { type: 'integer', minimum: 1, maximum: 32000 } }, required: ['action'] },
    async handler(args) { return ampHost.adapter('connections', args) } },
  { name: 'coordination_runtime', description: 'Run AMP CognitiveRuntime, KernelRuntime or GovernedTask with real host-configured model usage, SQLite agent/session/turn/outbox adapters, scoped settings, live behavior registry and native tool execution. create_agent creates a durable agent; turn/run_task/governed_turn perform actual model calls. session/turns/replay/feedback/rest/archive/delete_session use native AMP state. Governance references are {$ampRef:resourceId} handles created with coordination_amp.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['create_agent', 'turn', 'run_task', 'governed_turn', 'session', 'turns', 'replay', 'feedback', 'rest', 'archive', 'delete_session'] }, pid: { type: 'integer', minimum: 1 }, tid: { type: 'integer', minimum: 1 }, input: { anyOf: [{ type: 'string' }, { type: 'object' }] }, override: { type: 'object' }, endpoints: { type: 'array', items: { type: 'string' }, maxItems: 20 }, turnId: { type: 'string' }, feedback: { type: 'object' }, cycles: { type: 'number' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, manifest: { type: 'object' }, credential: { type: 'object' }, budget: { type: 'object' }, legal: { type: 'object' }, context: { type: 'object' }, audit: { type: 'object' } }, required: ['action'] },
    async handler(args) { return ampHost.adapter('cognitive', args) } },
  { name: 'coordination_hooks', description: 'Invoke the original AMP read/write/diff/outline/import/export/dependency/AST/code/project hooks on the authenticated filesystem session. Supports run, state, reset, typed parse helpers and persisted run history. Bigints and byte arrays use the coordination_amp typed JSON encoding. Host-owned recorders are injected; callers cannot supply executable callbacks.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['describe', 'run', 'state', 'reset', 'parse', 'history', 'file_operation', 'context_package'] }, name: { type: 'string' }, request: { type: 'object' }, arguments: { type: 'array', items: jsonArgumentItems, maxItems: 8 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, operation: { enum: ['fingerprintFile', 'fingerprintFileMeta', 'fingerprintTree', 'parseOffice', 'collectDirectory', 'digestDirectory', 'diffDirectory', 'verifyModuleContent'] }, path: { type: 'string' }, options: { type: 'object' }, expected: { type: 'array' }, budgetTokens: { type: 'integer', minimum: 1, maximum: 32000 }, items: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: ['method', 'arguments'], properties: { method: { type: 'string' }, arguments: { type: 'array', items: jsonArgumentItems, maxItems: 8 } } } } }, required: ['action'] },
    async handler(args) { return ampHost.adapter('hooks', args) } },
  { name: 'coordination_amp',
    description: 'Discover and call the published AMP domain API. Use describe(module,name) to obtain the original positional parameter signatures and available binding; call invokes native computations, create/invoke manage durable workspace-owned domain resources. Database parameters and clocks are host-bound. JSON typed values use {$bigint:string}, {$bytes:base64}, {$map:entries}, {$set:values}, {$date:ISO}, and {$ampRef:resourceId}. No source code or arbitrary method lookup is accepted. Host-service exports use their dedicated adapters.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['describe', 'call', 'get', 'create', 'invoke', 'resources', 'service', 'inspect', 'append'] }, module: { type: 'string' }, name: { type: 'string' }, resource: { type: 'string' }, method: { type: 'string' }, property: { type: 'string' }, arguments: { type: 'array', items: jsonArgumentItems, maxItems: 32 }, expectedVersion: { type: 'integer', minimum: 0 } }, required: ['action'] },
    async handler(args) { return ampHost.domain(args) },
  },
  { name: 'coordination_workspace',
    description: 'Select the repository bound to the AMP services for this MCP connection, or inspect that binding. Creates a host-owned session and durable registry workspace. Session credentials are held by the host and never accepted in canonical AMP tool arguments.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { enum: ['select', 'status', 'refresh'] }, verbosity: { enum: ['compact', 'full'] }, workspace: { type: 'string', description: 'Absolute repository root. Omit to inspect the current binding.' } } },
    async handler(args) { const value = await (args.action === 'refresh' ? ampHost.refresh() : args.workspace === undefined ? ampHost.status() : ampHost.select(args.workspace)); return ampHost.workspaceView(value, args.verbosity) },
  },
  { name: 'coordination_registry',
    description: 'Read and edit AMP registries through the host. The six scoped data registries delegate to the original AMP adjust tools. Specialized syntax, outline, dialect, calibration, behavior, entity and tool registries call their upstream implementations, persist operations with versions and dry-run, and bind executable implementations only to installed templates. Parser registry edits affect the actual filesystem tools.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['registry', 'action'], properties: {
      registry: { type: 'string', enum: [...RegistryNames] }, action: { type: 'string', enum: ['list', 'get', 'register', 'update', 'remove', 'clear', 'invoke'] },
      scope: { type: 'string', enum: ['workspace', 'global'] }, id: { type: 'string' }, value: { type: 'object' }, arguments: { type: 'object' }, expectedVersion: { type: 'integer', minimum: 0 }, dryRun: { type: 'boolean' },
    } },
    async handler(args) { return ampHost.registry(args) },
  },
  { name: 'coordination_context',
    description: 'Search capabilities/source with action search and query. Select target IDs, then action read performs bounded native allocation, materialization, reads and settlement in one call. Compact results include source lines, dependencies, estimated budget and an archive ID; detail(id) expands the original record, detail(name) returns an installed tool schema. metrics reports static catalog and projection sizes, never actual Codex usage. Raw allocate/pending/settle/revoke remain available.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['search', 'read', 'detail', 'metrics', 'allocate', 'pending', 'settle', 'revoke'] }, scope: { type: 'string', enum: ['workspace', 'global'] },
      query: { type: 'string', minLength: 1, maxLength: 2000 }, kinds: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 20 }, verbosity: { enum: ['compact', 'full'] }, id: { type: 'string' }, name: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 },
      targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }, budgetTokens: { type: 'integer', minimum: 1, maximum: 100000 }, reason: { type: 'string' }, contextId: { type: 'string' }, frameId: { type: 'string' },
    } },
    async handler(args) { return ampHost.context(args) },
  },
  ...AMP_DEFINITIONS.map(definition => ({
    name: definition.name, description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: { readOnlyHint: definition.risk === 'read' },
    async handler(args: Record<string, unknown>) { return ampHost.call(definition.name, args) },
  })),
]
