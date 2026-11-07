/** Discoverable JSON binding to AMP's published computations and domain objects. */
import * as amp from './runtime.mjs'
import catalogData from './catalog.json' with { type: 'json' }
import type { Database } from 'amp-legacy/database'
import type { webcrypto } from 'node:crypto'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
import { requireArtifact } from '../lib/protocol.mjs'

interface Signature { signature: string; parameters: { name: string; type: string; optional: boolean; rest: boolean }[] }
interface Export { name: string; kind: string; source: string; calls: Signature[]; constructorCalls: Signature[]; methods: Record<string, Signature[]>; properties: Record<string, { type: string; readonly: boolean }> }
const catalog = catalogData as unknown as { version: string; modules: { module: string; exports: Export[] }[] }
const aliases: Record<string, string> = { global: 'globalApi', module: 'moduleApi' }
const namespace = (name: string): Record<string, any> => (amp as any)[aliases[name] ?? name]
const pureModules = new Set(['assignment', 'bayes', 'boundary', 'concept', 'cooperation', 'diagnosis', 'discover', 'environment', 'evaluation', 'evidence', 'fingerprint', 'frame', 'goal', 'governance', 'interaction', 'ledger', 'manifest', 'naming', 'outline', 'policy', 'runtime', 'scenario', 'semantic', 'structure', 'syntax', 'types', 'warrant', 'window', 'execution', 'context', 'protocol', 'module', 'concurrency'])
const databaseModules = new Set(['authz', 'process', 'thread', 'progress', 'lock', 'registry', 'concurrency'])
const hostOnly = new Set(['fetchAgentCard', 'fetchTrustedAgent', 'channelFromCard', 'generateSigningKey', 'generateGovernanceSigners', 'createCooperationHandler', 'startCooperationServer', 'buildOutline', 'parseOffice', 'installOfficeOutlineParser', 'loadDefaultEnvironments', 'collectDirectory', 'diffDirectory', 'digestDirectory', 'verifyModuleContent', 'fingerprintFile', 'fingerprintFileMeta', 'fingerprintTree', 'once', 'withBusyRetry', 'assembleAgentContext', 'readDocumentDetail', 'agentContextToAst', 'replayStoredTurn'])
const resourceTypes: Record<string, string[]> = {
  attention: ['Attention'], assignment: ['AssignmentLedger', 'BindingLedger'], bayes: ['BayesianEngine', 'SourceReliability', 'ScopedPriors', 'CalibrationRegistry'],
  evidence: ['EvidenceGraph', 'WarrantRevalidation'],
  boundary: ['RefTable'], context: ['ContextAst', 'ContextIndex', 'MemoryDetailStore', 'MemoryContentStore', 'PathPrefixIndex', 'WorkspaceIndex', 'Context'],
  cooperation: ['TaskBoard', 'TeamSession', 'UnifiedLedger'], delegate: ['TeamRuntime'], discover: ['HostCatalog'],
  governance: ['BehaviorRegistry', 'ContextLayers', 'LegalGate', 'GovernanceBudget', 'Workflow', 'ReplayGuard', 'GovernanceAuditLog', 'GovernanceStore', 'CooperationBus', 'LoopbackTransport'],
  ledger: ['Ledger'], mission: ['MissionQueue'], policy: ['Guard', 'PolicyEngine'],
  runtime: ['RuntimeSession', 'BehaviorRegistry', 'BehaviorTuningController', 'MemorySessionStore', 'MemoryTurnStore', 'MemoryReceiptSink', 'MemoryEscalationSink', 'StaticTelemetry', 'NodeTelemetry', 'SingleActionPlanner'],
  skill: ['SkillRegistry'], knowledge: ['KnowledgeRegistry'], protocol: ['ProtocolRegistry', 'EnvelopeRuntime', 'LoopbackChannel'],
  outline: ['OutlineIndex', 'OutlineRegistry', 'OutlineKeywordRegistry'],
  storage: ['MemoryAppendSink', 'AppendLog'], syntax: ['LineIndex', 'ByteLineIndex', 'SyntaxRegistry'], warrant: ['InquiryLog'], window: ['ContextWindow'],
  process: ['AgentService'], ipc: ['Mailbox'],
  concurrency: ['Mutex', 'NamedLocks'],
  structure: catalog.modules.find(row => row.module === 'structure')!.exports.filter(row => row.kind === 'class').map(row => row.name),
}
const clockTypes = new Set(['attention.Attention', 'assignment.AssignmentLedger', 'assignment.BindingLedger', 'cooperation.TeamSession', 'cooperation.UnifiedLedger', 'delegate.TeamRuntime', 'governance.ContextLayers', 'governance.LegalGate', 'governance.GovernanceBudget', 'governance.CooperationBus', 'manifest.Keyring', 'protocol.EnvelopeRuntime', 'warrant.InquiryLog', 'policy.PolicyEngine'])
const hostMethods: Record<string, string[]> = { 'policy.PolicyEngine': ['approve', 'revoke'], 'protocol.ProtocolRegistry': ['bind', 'implementation', 'resolveImplementation'] }
interface Resource { value: any; module: string; name: string; durable?: boolean }
interface Command { action: string; module?: string; name?: string; resource?: string; method?: string; property?: string; arguments?: unknown[]; at: string }

export class DomainApi {
  private resources = new Map<string, Resource>()
  private currentTime = new Date().toISOString()
  private nextResource = 0
  private loaded = false
  private version = 0
  private sealedFrom: number
  private encodingOrigin?: { module: string; name: string }
  private replaying = false
  readonly now = () => this.currentTime
  constructor(private readonly database: Database, private readonly publicKey?: (kid: string, historical: boolean) => Promise<webcrypto.CryptoKey>) {
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_amp_domain_journal(seq INTEGER PRIMARY KEY,command TEXT NOT NULL)')
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_amp_append_lines(log_id TEXT NOT NULL,seq INTEGER NOT NULL,line TEXT NOT NULL,PRIMARY KEY(log_id,seq))')
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_amp_domain_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL)')
    database.db.prepare("INSERT OR IGNORE INTO codex_amp_domain_meta SELECT 'sealed_from',coalesce(max(seq),0)+1 FROM codex_amp_domain_journal").run()
    this.sealedFrom = (database.db.prepare("SELECT value FROM codex_amp_domain_meta WHERE key='sealed_from'").get() as { value: number }).value
  }
  private entry(module: string, name: string) {
    const entry = catalog.modules.find(row => row.module === module)?.exports.find(row => row.name === name)
    if (!entry) fail(ERROR_CODES.NOT_FOUND, `Unknown published AMP export ${module}.${name}`)
    return entry
  }
  private mode(module: string, entry: Export) {
    if (entry.kind === 'class') return resourceTypes[module]?.includes(entry.name) ? 'resource' : 'host-service'
    if (entry.kind === 'value') return 'constant'
    if (hostOnly.has(entry.name)) return 'host-service'
    if (databaseModules.has(module) && entry.calls.some(call => call.parameters[0]?.type === 'DatabaseSync')) return 'database-function'
    return pureModules.has(module) ? 'function' : 'host-service'
  }
  describe(module?: string, name?: string) {
    if (module && name) { const entry = this.entry(module, name); return { ...entry, binding: this.mode(module, entry) } }
    if (!module) return { version: catalog.version, modules: catalog.modules.map(row => ({ module: row.module, exports: row.exports.length })), next: 'Pass module to list exports, then module + name to read original signatures. Host services use their dedicated tools.' }
    return { version: catalog.version, modules: catalog.modules.filter(row => !module || row.module === module).map(row => ({ module: row.module, exports: row.exports.map(entry => ({ name: entry.name, kind: entry.kind, binding: this.mode(row.module, entry) })) })) }
  }
  private resource(id: unknown) {
    const resource = this.resources.get(String(id))
    if (!resource) fail(ERROR_CODES.NOT_FOUND, 'Unknown AMP resource in this workspace')
    return resource
  }
  private decode(input: any, depth = 0): any {
    if (depth > 50) fail(ERROR_CODES.INVALID_ARGUMENT, 'AMP argument nesting exceeds 50')
    if (input === null || typeof input !== 'object') return input
    if (input instanceof CryptoKey) return input
    if (Array.isArray(input)) return input.map(value => this.decode(value, depth + 1))
    if (Object.keys(input).length === 1) {
      if ('$ampRef' in input) return this.resource(input.$ampRef).value
      if ('$ampFunction' in input) {
        const { module, name } = input.$ampFunction
        const entry = this.entry(module, name)
        if (entry.kind !== 'function' || this.mode(module, entry) !== 'function') fail(ERROR_CODES.INVALID_ARGUMENT, 'Only installed AMP computations can be used as callbacks')
        return namespace(module)[name]
      }
      if ('$ampMethod' in input) {
        const { resource: id, method } = input.$ampMethod
        const resource = this.resource(id)
        if (resource.durable || !this.entry(resource.module, resource.name).methods[method] || hostMethods[`${resource.module}.${resource.name}`]?.includes(method)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown, durable or host-only callback method')
        return resource.value[method].bind(resource.value)
      }
      if ('$property' in input && Array.isArray(input.$property) && input.$property.length <= 8 && input.$property.every((key: unknown) => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key))) {
        const path: string[] = input.$property
        return (value: any) => path.reduce((parent, key) => parent?.[key], value)
      }
      if ('$bigint' in input && typeof input.$bigint === 'string' && /^-?\d{1,100}$/.test(input.$bigint)) return BigInt(input.$bigint)
      if ('$bytes' in input && typeof input.$bytes === 'string') return Uint8Array.from(Buffer.from(input.$bytes, 'base64'))
      if ('$date' in input && typeof input.$date === 'string') return new Date(input.$date)
      if ('$map' in input && Array.isArray(input.$map)) return new Map(this.decode(input.$map, depth + 1))
      if ('$set' in input && Array.isArray(input.$set)) return new Set(this.decode(input.$set, depth + 1))
    }
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, this.decode(value, depth + 1)]))
  }
  private async keyArguments(input: any): Promise<any> {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return Promise.all(input.map(item => this.keyArguments(item)))
    if (Object.keys(input).length === 1 && '$publicKey' in input) {
      if (!this.publicKey || typeof input.$publicKey !== 'string') fail(ERROR_CODES.INVALID_ARGUMENT, 'A host public key ID is required')
      return this.publicKey(input.$publicKey, this.replaying)
    }
    return Object.fromEntries(await Promise.all(Object.entries(input).map(async ([key, value]) => [key, await this.keyArguments(value)])))
  }
  private register(value: any, module: string, name: string, durable = false) {
    const existing = [...this.resources].find(([, resource]) => resource.value === value)
    const id = existing?.[0] ?? `amp-resource.${++this.nextResource}`
    if (!existing) this.resources.set(id, { value, module, name, durable })
    return { $ampRef: id, module, name, methods: typeof value === 'function' ? ['$call'] : Object.keys(this.entry(module, name).methods).filter(method => !hostMethods[`${module}.${name}`]?.includes(method)), properties: Object.keys(this.entry(module, name).properties) }
  }
  private encode(value: any, depth = 0, visited = new Set<any>()): any {
    if (depth > 40) fail(ERROR_CODES.INVALID_STATE, 'AMP result nesting exceeds 40')
    if (value === undefined) return null
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) fail(ERROR_CODES.INVALID_ARGUMENT, 'AMP result contains a noncanonical number')
    if (typeof value === 'bigint') return { $bigint: value.toString() }
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return value
    // Host secrets and executable functions never become ordinary JSON properties.
    if (value instanceof CryptoKey || value.privateKey instanceof CryptoKey) fail(ERROR_CODES.INVALID_ARGUMENT, 'Use coordination_keys for cryptographic key handles')
    for (const [, resource] of this.resources) if (resource.value === value) return this.register(value, resource.module, resource.name, resource.durable)
    if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
    if (value instanceof Date) return { $date: value.toISOString() }
    if (value instanceof Map) return { $map: [...value].map(([key, entry]) => [this.encode(key, depth + 1), this.encode(entry, depth + 1)]) }
    if (value instanceof Set) return { $set: [...value].map(entry => this.encode(entry, depth + 1)) }
    if (typeof value.next === 'function' && typeof value[Symbol.iterator] === 'function') {
      const items = []
      for (const item of value) { if (items.length >= 10000) fail(ERROR_CODES.INVALID_STATE, 'Iterator exceeds the host JSON result bound'); items.push(this.encode(item, depth + 1)) }
      return items
    }
    if (typeof value === 'function') {
      if (!this.encodingOrigin) fail(ERROR_CODES.INVALID_ARGUMENT, 'This callback requires a domain adapter')
      return this.register(value, this.encodingOrigin.module, this.encodingOrigin.name)
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      const found = catalog.modules.flatMap(row => row.exports.filter(entry => resourceTypes[row.module]?.includes(entry.name) && namespace(row.module)?.[entry.name] === value.constructor).map(entry => ({ module: row.module, name: entry.name })))[0]
      if (!found) fail(ERROR_CODES.INVALID_ARGUMENT, 'This AMP result requires a domain-specific host adapter')
      return this.register(value, found.module, found.name)
    }
    if (visited.has(value)) fail(ERROR_CODES.INVALID_STATE, 'Cyclic AMP result')
    visited.add(value)
    const result = Array.isArray(value) ? value.map(entry => this.encode(entry, depth + 1, visited)) : Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, this.encode(entry, depth + 1, visited)]))
    visited.delete(value)
    return result
  }
  private validateArguments(arguments_: unknown[], signatures: Signature[]) {
    if (!Array.isArray(arguments_) || arguments_.length > 32) fail(ERROR_CODES.INVALID_ARGUMENT, 'arguments must be an array of at most 32 positional parameters')
    const matches = signatures.filter(signature => arguments_.length >= signature.parameters.filter(parameter => !parameter.optional && !parameter.rest).length && (signature.parameters.some(parameter => parameter.rest) || arguments_.length <= signature.parameters.length))
    if (!matches.length) fail(ERROR_CODES.INVALID_ARGUMENT, 'Argument count does not match the published AMP signature', { signatures })
    if (!matches.some(signature => arguments_.every((value, index) => {
      const type = signature.parameters[index]?.type
      if (!type || type.includes('|') || type === 'unknown' || type === 'any') return true
      if (['string', 'number', 'boolean', 'bigint'].includes(type)) return typeof value === type && (type !== 'number' || Number.isFinite(value))
      if (type.endsWith('[]')) return Array.isArray(value)
      if (/=>|Handler$|Fn$|Comparator</.test(type)) return typeof value === 'function'
      return true
    }))) fail(ERROR_CODES.INVALID_ARGUMENT, 'Parameter types do not match the published AMP signature', { signatures })
  }
  private sink(logId: string) {
    return {
      readAll: () => (this.database.db.prepare('SELECT line FROM codex_amp_append_lines WHERE log_id=? ORDER BY seq').all(logId) as { line: string }[]).map(row => row.line),
      append: (line: string) => this.database.transaction(() => {
        const row = this.database.db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM codex_amp_append_lines WHERE log_id=?').get(logId) as { seq: number }
        this.database.db.prepare('INSERT INTO codex_amp_append_lines VALUES(?,?,?)').run(logId, row.seq, line)
      }),
    }
  }
  wire(value: unknown) { return this.encode(value) }
  resolve(value: unknown) { return this.decode(value) }
  /** Journal calls made by native host adapters without replaying their external effects. */
  port(reference: { $ampRef: string }) {
    const resource = this.resource(reference?.$ampRef)
    if (resource.durable) return resource.value
    return new Proxy(resource.value, { get: (target, property) => {
      const method = target[property]
      if (typeof method !== 'function') return method
      if (typeof property !== 'string' || !this.entry(resource.module, resource.name).methods[property]) return undefined
      return (...args: unknown[]) => {
        const command: Command = { action: 'invoke', resource: reference.$ampRef, method: property, arguments: this.encode(args), at: new Date().toISOString() }
        this.currentTime = command.at
        const commit = (result: unknown) => {
          this.appendCommand(command)
          return result
        }
        const result = Reflect.apply(method, target, args)
        return result instanceof Promise ? result.then(commit) : commit(result)
      }
    } })
  }
  async service(name: string, method: string, args: unknown[]) {
    const property = `${name[0]?.toLowerCase()}${name.slice(1)}`
    const target = (this.database as any)[property]
    const entry = this.entry('database', name)
    if (!/^\w+Service$/.test(name) || !target || !entry.methods[method]) fail(ERROR_CODES.INVALID_ARGUMENT, 'Select a published database aggregate service and public method')
    if (['where', 'findAll', 'page', 'insert', 'update', 'delete', 'upsert'].includes(method) || method === 'count' && args.length) fail(ERROR_CODES.INVALID_ARGUMENT, 'Trusted SQL fragments and raw repository mutations are host-internal; use aggregate domain operations')
    const decoded = this.decode(args)
    this.validateArguments(decoded, entry.methods[method])
    return { ok: true, result: this.encode(await Reflect.apply(target[method], target, decoded)) }
  }
  private async execute(command: Command) {
    this.currentTime = command.at
    const args = this.decode(await this.keyArguments(command.arguments ?? []))
    if (command.action === 'inspect' || command.action === 'append') {
      const resource = this.resource(command.resource)
      this.encodingOrigin = { module: resource.module, name: resource.name }
      const entry = this.entry(resource.module, resource.name)
      if (!command.property || !Object.hasOwn(entry.properties, command.property)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown public AMP resource property')
      if (command.action === 'append') {
        const kinds: Record<string, string> = { events: 'event', frames: 'frame', receipts: 'receipt', claims: 'claim', hypotheses: 'hypothesis', unknowns: 'unknown', goals: 'goal', plans: 'plan' }
        if (resource.module !== 'ledger' || resource.name !== 'Ledger' || args[0]?.kind !== kinds[command.property]) fail(ERROR_CODES.INVALID_ARGUMENT, 'append supports only matching AMP Ledger artifact arrays')
        requireArtifact(args[0])
        if (resource.value[command.property].some((artifact: any) => artifact.id === args[0].id)) fail(ERROR_CODES.CONFLICT, 'Ledger artifact IDs are immutable')
        if (command.property === 'events') resource.value.appendEvent(args[0]); else resource.value[command.property].push(args[0])
      }
      return this.encode(resource.value[command.property])
    }
    if (command.action === 'invoke') {
      const resource = this.resource(command.resource)
      this.encodingOrigin = { module: resource.module, name: resource.name }
      if (typeof resource.value === 'function' && command.method === '$call') {
        if (!Array.isArray(args) || args.length > 32) fail(ERROR_CODES.INVALID_ARGUMENT, 'Invalid callable arguments')
        return this.encode(await Reflect.apply(resource.value, undefined, args))
      }
      if (hostMethods[`${resource.module}.${resource.name}`]?.includes(command.method!)) fail(ERROR_CODES.INVALID_ARGUMENT, 'This is a host-only AMP method and cannot be called by the governed agent')
      const methods = this.entry(resource.module, resource.name).methods
      const signatures = Object.hasOwn(methods, command.method!) ? methods[command.method!] : undefined
      if (!signatures || ['constructor', '__proto__', 'then'].includes(command.method!)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown public AMP method')
      this.validateArguments(args, signatures)
      if (resource.module === 'bayes' && resource.name === 'CalibrationRegistry' && command.method === 'register') args[2] = { ...args[2], at: args[2]?.at ?? command.at }
      return this.encode(await Reflect.apply(command.method === '$iterator' ? resource.value[Symbol.iterator] : resource.value[command.method!], resource.value, args))
    }
    const module = command.module!
    const entry = this.entry(module, command.name!)
    this.encodingOrigin = { module, name: entry.name }
    const target = namespace(module)[entry.name]
    const mode = this.mode(module, entry)
    if (command.action === 'create') {
      if (mode !== 'resource') fail(ERROR_CODES.INVALID_ARGUMENT, 'This class is owned by a host service; use its domain adapter')
      if (module === 'governance' && entry.name === 'Workflow') { if (args.length !== 1) fail(ERROR_CODES.INVALID_ARGUMENT, 'Workflow host factory takes one StartInput'); return this.register(target.start(args[0]), module, entry.name) }
      const logId = `resource.${this.nextResource + 1}`
      if ((module === 'governance' && ['GovernanceAuditLog', 'GovernanceStore'].includes(entry.name) || module === 'storage' && entry.name === 'AppendLog' || module === 'process' && entry.name === 'AgentService') && args.length) fail(ERROR_CODES.INVALID_ARGUMENT, 'This host factory takes no arguments; its ports and clock are bound by the plugin')
      if (module === 'governance' && entry.name === 'GovernanceAuditLog') return this.register(await target.open({ sink: this.sink(logId), now: () => new Date().toISOString() }), module, entry.name, true)
      if (module === 'governance' && entry.name === 'GovernanceStore' || module === 'storage' && entry.name === 'AppendLog') return this.register(await target.open(this.sink(logId)), module, entry.name, true)
      if (module === 'process' && entry.name === 'AgentService') return this.register(new target(this.database.adapters.agents, this.database.adapters.social, { createProcess: (input: any) => amp.process.createProcess(this.database.db, { id: input.id, name: input.name }, input.at) }), module, entry.name, true)
      if (module === 'ipc' && entry.name === 'Mailbox') return this.register(new target(this.database.db, this.database.messageService, args[0]), module, entry.name, true)
      this.validateArguments(args, entry.constructorCalls)
      if (clockTypes.has(`${module}.${entry.name}`)) args[0] = { ...args[0], now: this.now }
      if (module === 'assignment' && entry.name === 'AssignmentLedger') args[0].onRevoke = (assignment: any) => {
        for (const resource of this.resources.values()) if (resource.module === 'assignment' && resource.name === 'BindingLedger') resource.value.revokeForAssignment(assignment.id, assignment.assigner, this.now(), 'Responsibility assignment revoked')
      }
      if (module === 'mission') args[0] = () => Date.parse(this.now())
      if (module === 'window' && entry.name === 'ContextWindow' || module === 'policy' && entry.name === 'Guard') args[0] = { ...args[0], now: () => Date.parse(this.now()) }
      return this.register(Reflect.construct(target, args), module, entry.name)
    }
    if (mode === 'constant') {
      if (target && typeof target === 'object' && !Array.isArray(target) && !(target instanceof Map) && Object.getPrototypeOf(target) !== Object.prototype && Object.getPrototypeOf(target) !== null) fail(ERROR_CODES.INVALID_ARGUMENT, 'Use the registry/service adapter for this live host instance')
      return this.encode(target)
    }
    if (mode !== 'function' && mode !== 'database-function') fail(ERROR_CODES.INVALID_ARGUMENT, 'Use the host adapter for this operation')
    const nativeArgs = mode === 'database-function' ? [this.database.db, ...args] : args
    this.validateArguments(nativeArgs, entry.calls)
    const result = await Reflect.apply(target, undefined, nativeArgs)
    return typeof result === 'function' ? this.register(result, module, entry.name) : this.encode(result)
  }
  private async load() {
    this.resources.clear(); this.nextResource = 0; this.version = 0
    const rows = this.database.db.prepare('SELECT seq,command FROM codex_amp_domain_journal ORDER BY seq').all() as { seq: number; command: string }[]
    if (!this.database.objectService.verify().ok) fail(ERROR_CODES.INVALID_STATE, 'The native AMP object chain does not verify')
    const sealedCount = this.database.db.prepare("SELECT count(*) AS count FROM objects WHERE kind='amp-domain-command'").get() as { count: number }
    if (sealedCount.count !== rows.filter(row => row.seq >= this.sealedFrom).length) fail(ERROR_CODES.INVALID_STATE, 'The replay journal is missing native AMP command commitments')
    this.replaying = true
    try { for (const row of rows) {
      const command = JSON.parse(row.command)
      if (row.seq >= this.sealedFrom) {
        const sealed = this.database.objectService.get('amp-domain-command', `command.${row.seq}`)
        if (!sealed || amp.semantic.canonicalJson(JSON.parse(sealed.body).command) !== amp.semantic.canonicalJson(command)) fail(ERROR_CODES.INVALID_STATE, 'Domain replay journal does not match its native AMP hash-chain record')
      }
      await this.execute(command); this.version = row.seq
    } } finally { this.replaying = false }
    this.loaded = true
  }
  private appendCommand(command: Command) {
    this.database.transaction(() => {
      const latest = this.database.db.prepare('SELECT coalesce(max(seq),0) AS version FROM codex_amp_domain_journal').get() as { version: number }
      if (latest.version !== this.version) fail(ERROR_CODES.CONFLICT, 'AMP resource journal changed concurrently')
      const seq = this.version + 1
      this.database.objectService.put('amp-domain-command', `command.${seq}`, { seq, command }, command.at)
      this.database.db.prepare('INSERT INTO codex_amp_domain_journal(seq,command) VALUES(?,?)').run(seq, JSON.stringify(command))
    })
    this.version++
  }
  async call(args: Record<string, any>) {
    if (!this.loaded) await this.load()
    if (args.action === 'describe' || !args.action) return { ok: true, version: this.version, api: this.describe(args.module, args.name) }
    if (args.action === 'resources') return { ok: true, version: this.version, resources: [...this.resources].map(([id, resource]) => ({ id, module: resource.module, name: resource.name, methods: Object.keys(this.entry(resource.module, resource.name).methods) })) }
    if (args.action === 'service') return this.service(args.name, args.method, args.arguments ?? [])
    if (!['call', 'create', 'invoke', 'get', 'inspect', 'append'].includes(args.action)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown AMP API action')
    if (args.expectedVersion !== undefined && args.expectedVersion !== this.version) fail(ERROR_CODES.CONFLICT, 'AMP resource journal version changed', { version: this.version })
    const command: Command = { action: args.action, at: new Date().toISOString(), ...(args.module ? { module: args.module } : {}), ...(args.name ? { name: args.name } : {}), ...(args.resource ? { resource: args.resource } : {}), ...(args.method ? { method: args.method } : {}), ...(args.property ? { property: args.property } : {}), arguments: args.arguments ?? [] }
    const entry = args.module && args.name ? this.entry(args.module, args.name) : undefined
    // Database operations are already durable and must never be replayed.
    const journal = ['create', 'append', 'inspect', 'get'].includes(args.action) || args.action === 'invoke' && !this.resource(args.resource).durable || entry && this.mode(args.module, entry) === 'function'
    try {
      const result = await this.execute(command)
      if (journal) this.appendCommand(command)
      return { ok: true, version: this.version, ...(this.sealedFrom > 1 ? { unsealedLegacyCommands: this.sealedFrom - 1 } : {}), result }
    } catch (error) { if (journal) this.loaded = false; throw error }
  }
}
