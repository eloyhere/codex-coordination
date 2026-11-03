/** Native cognitive/kernel/governed runtimes wired to durable AMP adapters. */
import { database as databaseApi, process as processApi, runtime, moduleApi, kernel as kernelApi, thread } from './runtime.mjs'
import type { Database } from 'attention-manifest-protocol/database'
import type { ControlPort } from 'attention-manifest-protocol/control'
import type { LlmClient } from 'attention-manifest-protocol/module'
import type { HostConfiguration } from './config.mjs'
import type { HostRegistries } from './registries.mjs'
import type { HostConnections } from './connections.mjs'
import type { DomainApi } from './api.mjs'
import type { WorkspaceToolDefinition } from 'attention-manifest-protocol/protocol/workspace.js'
import { ERROR_CODES, fail } from '../lib/amp.mjs'
import { requestHostApproval } from './host-client.mjs'

export class HostCognitiveRuntime {
  private agents: InstanceType<typeof processApi.AgentService>
  private sessions: InstanceType<typeof databaseApi.SqliteSessionStore>
  private turns: InstanceType<typeof databaseApi.SqliteTurnStore>
  private kernel: InstanceType<typeof kernelApi.Kernel>
  constructor(private readonly database: Database, private readonly control: ControlPort, private readonly registries: HostRegistries,
    private readonly connections: HostConnections, private readonly api: DomainApi, private readonly config: HostConfiguration,
    private readonly definitions: WorkspaceToolDefinition[], private readonly dispatch: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>, private readonly injectedLlm?: LlmClient) {
    this.agents = new processApi.AgentService(database.adapters.agents, database.adapters.social, { createProcess: input => processApi.createProcess(database.db, { id: input.id, name: input.name }, input.at) })
    this.sessions = new databaseApi.SqliteSessionStore(database.adapters.sessions)
    this.turns = new databaseApi.SqliteTurnStore(database.adapters.turns)
    this.kernel = new kernelApi.Kernel(database.db, { eventSink: databaseApi.outboxEventSink, workerId: `codex.${crypto.randomUUID()}` })
  }
  private llm() {
    if (this.injectedLlm) return this.injectedLlm
    const config = this.config.llm
    if (!config) {
      if (process.env.DEEPSEEK_API_KEY) return moduleApi.DeepSeekLlm.fromEnv()
      fail(ERROR_CODES.INVALID_STATE, 'Configure llm in the host configuration or DEEPSEEK_API_KEY; no provider usage will be fabricated')
    }
    const apiKey = process.env[config.apiKeyEnv]
    if (!apiKey) fail(ERROR_CODES.INVALID_STATE, `Missing configured model environment variable ${config.apiKeyEnv}`)
    const { apiKeyEnv, ...options } = config
    return new moduleApi.DeepSeekLlm({ ...options, apiKey })
  }
  private async cognitive(pid: number, endpointIds: string[] = []) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail(ERROR_CODES.INVALID_ARGUMENT, 'A valid agent pid is required')
    // A profile must exist in this repository's domain database.
    this.agents.assemble(pid, { tokens: 100 })
    const tools = new moduleApi.ToolRegistry()
    this.definitions.forEach(tool => tools.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }))
    const aliases = this.registries.runtimeTools()
    aliases.tools.forEach(tool => tools.register(tool))
    const remote = new Map<string, string>()
    for (const id of endpointIds) {
      const result = await this.connections.connect(id)
      for (const tool of result.tools) {
        if (tools.get(tool.name)) fail(ERROR_CODES.CONFLICT, `Duplicate tool name ${tool.name} across host bindings`)
        tools.register(tool); remote.set(tool.name, id)
      }
    }
    const sessionSnapshot = this.sessions.load(pid)
    const session = sessionSnapshot ? runtime.RuntimeSession.restore(sessionSnapshot) : new runtime.RuntimeSession({ id: `codex.runtime.${pid}`, scope: `agent.${pid}` })
    return new runtime.CognitiveRuntime({ pid, agent: this.agents.reader(), social: this.agents.socialReader(), llm: this.llm(), model: this.config.llm?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', session, sessionStore: this.sessions, turnStore: this.turns,
      control: this.control, telemetry: new runtime.NodeTelemetry(), behaviors: this.registries.runtimeBehaviors(), diagnosis: true, contextAst: true,
      receiptSink: new databaseApi.OutboxRuntimeReceiptSink(this.database.adapters.outbox), tools, toolPolicy: new moduleApi.RiskToolPolicy({ approve: invocation => remote.has(invocation.tool) ? true : requestHostApproval('local-workspace', invocation.tool, invocation.args) }),
      toolExecutor: { execute: async invocation => {
        const endpoint = remote.get(invocation.tool)
        if (endpoint) { const outcome = await this.connections.execute(endpoint, invocation.tool, invocation.args); return { ok: outcome.receipt.outcome === 'success', content: outcome.inline ?? JSON.stringify({ handle: outcome.handle, tokens: outcome.tokens }) } }
        const response = await this.dispatch(aliases.targets.get(invocation.tool) ?? invocation.tool, invocation.args)
        return { ok: response.ok !== false, content: JSON.stringify(response) }
      } },
    })
  }
  async call(args: Record<string, any>) {
    if (args.action === 'create_agent') return { ok: true, result: this.agents.createAgent({ ...args.input, at: new Date().toISOString() }) }
    if (args.action === 'turns') return { ok: true, result: this.turns.list(args.pid, args.limit ?? 20) }
    if (args.action === 'replay') { const turn = this.turns.get(args.turnId); if (!turn) fail(ERROR_CODES.NOT_FOUND, 'Unknown runtime turn'); return { ok: true, result: runtime.replayTurn(turn) } }
    if (args.action === 'session') return { ok: true, result: this.sessions.load(args.pid) ?? null }
    if (args.action === 'archive') return { ok: true, archived: this.sessions.archive(args.pid, new Date().toISOString()) }
    if (args.action === 'delete_session') return { ok: true, deleted: this.sessions.delete(args.pid) }
    if (args.action === 'feedback' || args.action === 'rest') {
      const snapshot = this.sessions.load(args.pid)
      if (!snapshot) fail(ERROR_CODES.NOT_FOUND, 'Unknown runtime session')
      const session = runtime.RuntimeSession.restore(snapshot)
      const result = args.action === 'feedback' ? session.feedback(args.turnId, args.feedback) : session.rest(args.cycles)
      this.sessions.save(args.pid, session.serialize(), new Date().toISOString())
      return { ok: true, result }
    }
    if (typeof args.input !== 'string' || !args.input.trim()) fail(ERROR_CODES.INVALID_ARGUMENT, 'A nonempty runtime input is required')
    const cognitive = await this.cognitive(args.pid, args.endpoints)
    if (args.action === 'turn') return { ok: true, result: await cognitive.respond(args.input, args.override) }
    if (args.action === 'run_task') {
      if (thread.getThread(this.database.db, args.tid).pid !== args.pid) fail(ERROR_CODES.INVALID_ARGUMENT, 'Task does not belong to the selected runtime agent')
      return { ok: true, result: await new runtime.KernelRuntime({ kernel: this.kernel, cognitive }).runTask(args.tid, args.input) ?? null }
    }
    if (args.action === 'governed_turn') {
      await this.api.call({ action: 'resources' })
      const result = await new runtime.GovernedTask({ runtime: cognitive, manifest: args.manifest, budget: this.api.port(args.budget), legal: this.api.port(args.legal), context: this.api.port(args.context), ...(args.audit ? { audit: this.api.port(args.audit) } : {}), credential: args.credential, now: () => new Date().toISOString() }).turn(args.input, args.override)
      return { ok: true, result }
    }
    fail(ERROR_CODES.INVALID_ARGUMENT, 'Unknown runtime action')
  }
  close() { this.kernel.close() }
}
