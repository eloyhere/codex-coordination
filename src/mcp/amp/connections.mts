/** Only host-configured endpoints become native AMP protocol implementations. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { moduleApi, protocol, manifest, execution, mcpClient, mcpHttp, governance } from './runtime.mjs'
import type { EndpointConfig, ListenerConfig } from './config.mjs'
import { processEnvironment } from './config.mjs'
import type { HostKeys } from './keys.mjs'
import type { DomainApi } from './api.mjs'
import type { Database } from 'attention-manifest-protocol/database'
import type { Transport } from 'attention-manifest-protocol/module/mcp/transport.js'
import type { JsonRpcRequest, JsonRpcResponse } from 'attention-manifest-protocol/module/mcp/protocol.js'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
import { requestHostApproval } from './host-client.mjs'

class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<any, { resolve(value: JsonRpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  constructor(config: EndpointConfig) {
    this.child = spawn(config.command!, config.args ?? [], { cwd: config.cwd, env: processEnvironment(config.env, config.envVars), windowsHide: true, shell: false, stdio: 'pipe' })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) return this.fail(new Error('MCP response exceeds host size bound'))
        const message = JSON.parse(line)
        const pending = this.pending.get(message.id)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); pending.resolve(message) }
      } catch { this.fail(new Error('Invalid JSON from configured MCP endpoint')) }
    })
    this.child.stderr.resume()
    this.child.on('error', () => this.fail(new Error('Configured MCP process could not start')))
    this.child.on('exit', () => this.fail(new Error('Configured MCP process exited')))
  }
  private fail(error: Error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }; this.pending.clear() }
  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.id === undefined) { this.child.stdin.write(`${JSON.stringify(request)}\n`); return { jsonrpc: '2.0', id: null, result: {} } as any }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new Error('Configured MCP request timed out')) }, 30_000)
      this.pending.set(request.id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) { clearTimeout(timer); this.pending.delete(request.id); reject(new Error('Configured MCP write failed')) } })
    })
  }
  close() { this.fail(new Error('MCP connection closed')); this.child.stdin.end(); this.child.kill() }
}
interface McpBinding { protocol: moduleApi.McpProtocol; tools: InstanceType<typeof moduleApi.ToolRegistry>; profile: InstanceType<typeof execution.ExecProfile>; handles: InstanceType<typeof execution.HandleStore>; transport: Transport & { close?(): void } }
export class HostConnections {
  readonly protocols = new protocol.ProtocolRegistry()
  private bindings = new Map<string, McpBinding>()
  private listeners = new Map<string, governance.RunningCooperationServer>()
  constructor(private readonly configs: EndpointConfig[], private readonly database: Database, private readonly metadata?: () => Record<string, any>[], private readonly keys?: HostKeys, private readonly api?: DomainApi, private readonly listenerConfigs: ListenerConfig[] = []) {
    database.db.exec('CREATE TABLE IF NOT EXISTS codex_amp_endpoint_state(id TEXT PRIMARY KEY,state TEXT NOT NULL)')
  }
  private loadState(id: string) {
    const row = this.database.db.prepare('SELECT state FROM codex_amp_endpoint_state WHERE id=?').get(id) as { state: string } | undefined
    return row ? JSON.parse(row.state) : undefined
  }
  private saveState(id: string, state: unknown) {
    this.database.transaction(() => {
      this.database.db.prepare('INSERT INTO codex_amp_endpoint_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(id, JSON.stringify(state))
      this.database.objectService.put('endpoint-state-change', crypto.randomUUID(), { id, state }, new Date().toISOString())
    })
  }
  reconcile() {
    if (!this.metadata) return
    const metadata = this.metadata()
    for (const entry of this.protocols.list({ includeDisabled: true })) {
      const current = metadata.find(item => item.id === entry.id)
      if (!current || current.status === 'removed' || current.value?.status === 'disabled' || current.value?.family !== entry.family) {
        const binding = this.bindings.get(entry.id)
        if (binding) { moduleApi.mcpWithdrawTools(binding.protocol, binding.tools); binding.transport.close?.(); this.bindings.delete(entry.id) }
        this.protocols.remove(entry.id)
      }
    }
  }
  private config(id: unknown) {
    const config = this.configs.find(item => item.id === id)
    if (!config) fail(ERROR_CODES.NOT_FOUND, 'Endpoint is not in the host configuration')
    if (this.metadata) {
      const entry = this.metadata().find(entry => entry.id === id)
      if (!entry || entry.status === 'removed' || entry.value?.status === 'disabled') fail(ERROR_CODES.INVALID_STATE, 'Configured protocol metadata is removed or disabled')
      if (entry.value?.family !== config.family) fail(ERROR_CODES.INVALID_STATE, 'Protocol metadata family does not match its configured implementation')
    }
    return config
  }
  private headers(config: EndpointConfig) {
    const headers = { ...config.headers }
    for (const [header, variable] of Object.entries(config.headerEnv ?? {})) {
      const value = process.env[variable]
      if (!value) fail(ERROR_CODES.INVALID_STATE, `Missing configured header environment variable ${variable}`)
      headers[header] = value
    }
    return headers
  }
  async connect(id: string) {
    const config = this.config(id)
    if (config.family !== 'mcp') fail(ERROR_CODES.INVALID_ARGUMENT, 'Endpoint is not an MCP service')
    const existing = this.bindings.get(id)
    if (existing) return { ok: true, id, tools: existing.tools.list(), bound: true }
    if (!config.command && !config.url) fail(ERROR_CODES.INVALID_STATE, 'Configured MCP endpoint needs url or command')
    const transport = config.command ? new StdioTransport(config) : new mcpHttp.HttpTransport({ url: config.url!, headers: this.headers(config), timeoutMs: config.timeoutMs })
    const client = new mcpClient.McpClient(transport, 'codex-coordination')
    try {
      const handles = new execution.HandleStore()
      const receiptNamespace = `endpoint-receipt.${id}.${crypto.randomUUID()}`
      const profile = new execution.ExecProfile(client, { budget: config.budget ?? { tokens: 32_000, calls: 100 }, handles, now: () => new Date().toISOString(), maxResultTokens: config.maxResultTokens,
        onReceipt: receipt => this.database.objectService.put(receiptNamespace, receipt.id, JSON.parse(JSON.stringify(receipt)), receipt.at),
      })
      const snapshot = await profile.connect()
      const state = this.loadState(id)
      if (state?.pins && state.catalogVersion === (config.catalogVersion ?? 0)) {
        const verdict = execution.verifyToolPins({ catalog: state.pins.catalog, tools: new Map(state.pins.tools) }, snapshot.tools)
        if (!verdict.ok) throw new execution.DriftDetected(`Configured endpoint catalog changed: ${verdict.reasons.join('; ')}`)
      }
      if (state?.usage) profile.dispatcher.run(() => undefined, state.usage)
      const tools = new moduleApi.ToolRegistry()
      const unlisted: moduleApi.McpProtocol = { family: moduleApi.McpProtocolFamily, client, transport }
      await moduleApi.mcpSyncTools(unlisted, tools)
      const implementation = { ...unlisted, tools: tools.list().map(tool => tool.name) }
      this.saveState(id, { pins: { catalog: snapshot.pins.catalog, tools: [...snapshot.pins.tools] }, usage: profile.dispatcher.usage(), catalogVersion: config.catalogVersion ?? 0 })
      const entry = moduleApi.mcpProtocolEntry(id, config.name ?? id, { endpoint: config.url, version: client.protocolVersion })
      if (this.protocols.has(id)) this.protocols.update(entry); else this.protocols.register(entry)
      this.protocols.bind(id, implementation)
      this.bindings.set(id, { protocol: implementation, tools, profile, handles, transport })
      return { ok: true, id, negotiated: { mode: client.legacy ? 'legacy' : 'stateless' }, tools: tools.list(), bound: this.protocols.bound().includes(id) }
    } catch (error) { if (transport instanceof StdioTransport) transport.close(); throw error }
  }
  async execute(id: string, name: string, args: Record<string, unknown>, options?: Record<string, any>) {
    await this.connect(id)
    const implementation = this.protocols.resolveImplementation(id, moduleApi.isMcpProtocol, 'mcp')
    if (!implementation) fail(ERROR_CODES.INVALID_STATE, 'MCP protocol implementation is unbound')
    const binding = this.bindings.get(id)!
    try { return await binding.profile.call(name, args, options) }
    catch (error) {
      if (!(error instanceof execution.ApprovalRequired) || !await requestHostApproval(id, name, args)) throw error
      const approval = binding.profile.approveTool(name, args, 'mcp-host-user', 60_000)
      return await binding.profile.call(name, args, { ...options, approval })
    }
    finally {
      const saved = this.loadState(id)
      if (saved) this.saveState(id, { ...saved, usage: binding.profile.dispatcher.usage() })
    }
  }
  async call(args: Record<string, any>) {
    this.reconcile()
    if (args.action === 'list') return { ok: true, endpoints: this.configs.map(config => ({ id: config.id, family: config.family, name: config.name ?? config.id, bound: this.protocols.bound().includes(config.id) })), listeners: this.listenerConfigs.map(config => ({ id: config.id, running: this.listeners.has(config.id) })) }
    if (args.action === 'listen' || args.action === 'stop_listener') {
      const config = this.listenerConfigs.find(item => item.id === args.id)
      if (!config || !this.api || !this.keys) fail(ERROR_CODES.INVALID_ARGUMENT, 'Listener must be defined in host configuration')
      if (args.action === 'stop_listener') { await this.listeners.get(config.id)?.close(); this.listeners.delete(config.id); return { ok: true } }
      if (!this.listeners.has(config.id)) {
        await this.api.call({ action: 'resources' })
        if (!(this.api.resolve(args.bus) instanceof governance.CooperationBus)) fail(ERROR_CODES.INVALID_ARGUMENT, 'Listener requires a native CooperationBus resource')
        const bus = this.api.port(args.bus)
        const keyring = await this.keys.decode({ $governanceKeyring: true }, true)
        const { id, ...options } = config
        this.listeners.set(config.id, await governance.startCooperationServer(bus, { ...options, host: options.host ?? '127.0.0.1', keyring }))
      }
      const listener = this.listeners.get(config.id)!
      return { ok: true, id: config.id, url: listener.url, port: listener.port }
    }
    const config = this.config(args.id)
    if (args.action === 'connect') return this.connect(config.id)
    if (args.action === 'disconnect') { const binding = this.bindings.get(config.id); if (binding) { moduleApi.mcpWithdrawTools(binding.protocol, binding.tools); binding.transport.close?.(); this.bindings.delete(config.id) }; this.protocols.remove(config.id); return { ok: true, id: config.id } }
    if (args.action === 'deliver') {
      if (config.family !== 'cooperation' || !config.url || !governance.verifyAgentMessage(args.message)) fail(ERROR_CODES.INVALID_ARGUMENT, 'A configured cooperation endpoint and a sealed native agent message are required')
      const auth = config.signingKid && this.keys ? { signer: config.signer ?? config.id, key: await this.keys.pair(config.signingKid) } : undefined
      const transport = new governance.HttpCooperationTransport({ endpoint: config.url, timeoutMs: config.timeoutMs, auth })
      const entry = { id: config.id, name: config.name ?? config.id, family: 'cooperation', version: '0.1', description: 'Host-configured AMP cooperation endpoint', endpoint: config.url }
      if (this.protocols.has(config.id)) this.protocols.update(entry); else this.protocols.register(entry)
      this.protocols.bind(config.id, transport)
      const delivery = await transport.deliver(args.message)
      this.database.objectService.put('cooperation-delivery', crypto.randomUUID(), delivery, new Date().toISOString())
      return { ok: delivery.ok, result: delivery }
    }
    if (args.action === 'delegate' && config.family === 'amp-team') {
      if (!config.url) fail(ERROR_CODES.INVALID_STATE, 'Configured AMP team endpoint needs a URL')
      const channel = new protocol.HttpTeamChannel({ url: config.url, headers: this.headers(config), timeoutMs: config.timeoutMs })
      const entry = { id: config.id, name: config.name ?? config.id, family: 'amp-team', version: '0.1', description: 'Host-configured AMP team endpoint', endpoint: config.url }
      if (this.protocols.has(config.id)) this.protocols.update(entry); else this.protocols.register(entry)
      this.protocols.bind(config.id, channel)
      const result = await protocol.delegateOver(channel, args.delegation)
      this.database.objectService.put('delegation-dispatch', crypto.randomUUID(), result, new Date().toISOString())
      return { ok: true, result }
    }
    if (args.action === 'card' || args.action === 'delegate') {
      if (config.family !== 'a2a' || !config.url) fail(ERROR_CODES.INVALID_ARGUMENT, 'Endpoint is not an A2A service')
      const card = await manifest.fetchAgentCard(config.url, { timeoutMs: config.timeoutMs })
      if (args.action === 'card') return { ok: card.ok, result: card }
      // The advertised endpoint must stay on the origin approved in host configuration.
      if (!card.endpoint || new URL(card.endpoint).origin !== new URL(config.url).origin) fail(ERROR_CODES.INVALID_STATE, 'Agent Card redirects outside the configured origin')
      const channel = protocol.channelFromCard(card, { headers: this.headers(config), timeoutMs: config.timeoutMs })
      const entry = { id: config.id, name: config.name ?? config.id, family: 'a2a', version: '1.0', description: card.card?.description ?? 'Configured A2A agent', endpoint: card.endpoint }
      if (this.protocols.has(config.id)) this.protocols.update(entry); else this.protocols.register(entry)
      this.protocols.bind(config.id, channel)
      const result = await protocol.delegateOver(channel, args.delegation)
      this.database.objectService.put('delegation-dispatch', crypto.randomUUID(), result, new Date().toISOString())
      return { ok: true, result }
    }
    await this.connect(config.id)
    const binding = this.bindings.get(config.id)!
    if (args.action === 'sync') {
      const changes = await moduleApi.mcpSyncTools(binding.protocol, binding.tools)
      binding.protocol = { ...binding.protocol, tools: binding.tools.list().map(tool => tool.name) }
      this.protocols.bind(config.id, binding.protocol)
      return { ok: true, changes, verification: await binding.profile.verify() }
    }
    if (args.action === 'verify') return { ok: true, result: await binding.profile.verify() }
    if (args.action === 'handle') return { ok: true, result: binding.handles.read(args.handle, args.cursor ?? 0, args.limitTokens) }
    if (args.action === 'call') return { ok: true, result: await this.execute(config.id, args.tool, args.arguments ?? {}, { ...(args.claim ? { claim: args.claim } : {}), ...(args.approval ? { approval: args.approval } : {}) }) }
    fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown connection action')
  }
  async close() { for (const binding of this.bindings.values()) binding.transport.close?.(); this.bindings.clear(); this.protocols.clear(); await Promise.all([...this.listeners.values()].map(listener => listener.close())); this.listeners.clear() }
}
