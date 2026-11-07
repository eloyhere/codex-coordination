/** Native pinned tool execution, durable read budgets and issued execution receipts. */
import { ManifestStore } from 'attention-manifest-protocol/manifest'
import { BudgetLedger } from 'attention-manifest-protocol/budget'
import { Executor, DefaultPolicyEnforcementPoint } from 'attention-manifest-protocol/execution'
import { LcpService, executionFactDigest } from 'attention-manifest-protocol/runtime'
import { RetrievalHandleStore } from 'attention-manifest-protocol/retrieval'
import { createInvocation, createObservation, createReceiptCore } from 'attention-manifest-protocol/receipt'
import { bindBudget } from 'attention-manifest-protocol/persistence'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest, nativeEnvironment } from './native-store.mjs'
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import { fileReceiptTools } from './file-freshness.mjs'
import { isNativeReadContract, nativeReadQuota, nativeReadReservation } from './read-budget.mjs'

const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(nativeRequest(value)).digest('hex')
const now = () => new Date().toISOString()
const quota = nativeReadQuota

export function executionBindings(tools: ToolDefinition[], binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  // This first native execution port admits only concrete read contracts. Writes
  // must be wired to workflow Action/attempt fencing before joining the catalog.
  const sources = tools.filter(isNativeReadContract)
  const validators = new Map(sources.map(tool => [tool.name, new (Ajv as any)({ strict: false }).compile(tool.inputSchema)]))
  const definitions = sources.map(tool => ({ toolId: tool.name, version: '1', digest: digest({ name: tool.name, schema: tool.inputSchema, description: tool.description }), summary: tool.description, inputSchema: tool.inputSchema as any, risk: 'read' as const, effect: 'read_only' as const, policyScope: 'native-read' }))
  const manifest = { manifestId: 'codex-native-read', tenantId: binding.tenantId, endpointId: 'codex-native-read', endpointIdentity: 'local-plugin', serverVersion: '1', digest: digest(definitions), policyScope: 'native-read', issuedAt: now(), tools: definitions }
  const manifests = new ManifestStore(); manifests.put(manifest)
  const handles = new RetrievalHandleStore<any>()
  const policyVersion = 'native-read-v1'
  const policy = new DefaultPolicyEnforcementPoint(request => ({ allowed: request.context.tenantId === binding.tenantId && request.context.principalId === binding.principalId && request.object.tenantId === binding.tenantId && (request.object.kind === 'data_handle' || definitions.some(tool => tool.toolId === request.object.id)), policyVersion, reason: 'Installed read-only native contracts; execution is not business verification' }))
  const scopedSession = (root: string) => binding.sessionId + ':' + digest(root)
  const context = (root?: string) => ({ tenantId: binding.tenantId, principalId: binding.principalId, agentId: 'codex-coordination', sessionId: root ? scopedSession(root) : binding.sessionId, operationId: randomUUID(), attemptId: randomUUID(), executionId: randomUUID(), policyVersion, cancellationEpoch: 0 })
  const makeService = (executor: Executor) => new LcpService({ manifests, executor, policy, handles, catalog: () => [manifest] })
  const unusedExecutor = new Executor(manifests, policy, new BudgetLedger(), async () => { throw new Error('Execution requires a durable budget') }, { id: randomUUID, now, measure: () => ({}) })
  const lookup = (toolId: unknown, pinned: unknown) => {
    const definition = definitions.find(tool => tool.toolId === toolId)
    if (!definition || definition.digest !== pinned) throw new Error('Unknown or stale tool contract; find and inspect it again')
    return manifests.createHandle(manifest, definition.toolId)!
  }
  const wrap = (name: string, description: string, properties: Record<string, any>, required: string[], handler: (args: Record<string, unknown>) => Promise<Record<string, any>>, readOnly = true): ToolDefinition => ({ name: 'attention_manifest_protocol_' + name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required }, annotations: { readOnlyHint: readOnly }, async handler(input) { assertModelParameters(input); const args = JSON.parse(nativeRequest(input)) as Record<string, unknown>; return handler(args) } })
  const pin = { toolId: { type: 'string' }, digest: { type: 'string' } }
  return [
    wrap('execution.find_tools', 'Rank installed native read tools and return pinned contracts for inspect/run. Write tools are withheld until Action/attempt execution fencing is connected.', { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query'], async args => {
      const result = await makeService(unusedExecutor).findTools(context(), { query: String(args.query), limit: Number(args.limit ?? 10) })
      return { ...result, tools: result.tools.map(item => ({ ...item, pinned: { toolId: item.tool.toolId, digest: item.tool.digest } })) }
    }),
    wrap('execution.inspect_tool', 'Inspect an exact native tool digest before execution.', pin, ['toolId', 'digest'], async args => ({ tool: await makeService(unusedExecutor).inspectTool(context(), lookup(args.toolId, args.digest)) })),
    wrap('budget.remaining', 'Read the durable native I/O quota shared by direct reads, Executor reads and host-reviewed file writes for this workspace/principal. Retains the native-read ledger key for compatibility; not Codex model token usage.', {}, [], async () => {
      const { store } = openNativeStore(workspace)
      try { const ledger = new BudgetLedger(); const bound = bindBudget(store, ledger); bound.rehydrate(); if (bound.report.skipped.length) throw new Error('Invalid native budget facts'); if (!store.list<any>('budget_ledger').some(row => row.budgetKey === 'native-read:' + binding.principalId)) return { snapshot: { limit: quota, settled: {}, reserved: {} }, quotaSource: 'host-fixed', configured: false }; return { snapshot: bound.snapshot('native-read:' + binding.principalId), quotaSource: 'host-fixed', configured: true } } finally { store.close() }
    }),
    wrap('execution.run', 'Run pinned typed child calls through native policy, durable budget and journaling. Only installed read contracts are admitted. Issues execution receipts, never business acceptance. Interrupted operations require reconciliation and are not automatically retried.', { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, calls: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'toolId', 'digest', 'arguments'], properties: { id: { type: 'string', minLength: 1 }, ...pin, arguments: { type: 'object' } } } } }, ['idempotencyKey', 'calls'], async args => {
      const { root, store } = openNativeStore(workspace)
      try {
        const request = nativeRequest(args), key = binding.principalId + ':' + args.idempotencyKey
        const previous = store.events({ kind: 'codex.amp.execution.started' }).find(event => (event.payload as any).key === key)?.payload as any
        if (previous) {
          if (previous.request !== request) throw new Error('Idempotency key already used for another execution')
          const finished = store.events({ kind: 'codex.amp.execution.finished' }).find(event => (event.payload as any).runId === previous.runId)?.payload as any
          if (finished) return { ...finished.result, replayed: true }
          throw new Error('Execution outcome is unresolved; host reconciliation is required before retry')
        }
        const input = args.calls as any[]
        if (!Array.isArray(input) || !input.length || input.length > 8) throw new Error('Provide 1-8 typed calls')
        const calls = input.map(call => { const tool = lookup(call.toolId, call.digest); if (!validators.get(call.toolId)!(call.arguments)) throw new Error('Child arguments do not match the pinned schema'); return { id: call.id, tool, arguments: call.arguments, budget: nativeReadReservation } })
        const budgetKey = 'native-read:' + binding.principalId
        const budget = () => { const ledger = new BudgetLedger(); const bound = bindBudget(store, ledger); bound.rehydrate(); if (bound.report.skipped.length) throw new Error('Invalid native budget facts'); return bound }
        store.transaction(() => { const bound = budget(); if (!store.list<any>('budget_ledger').some(row => row.budgetKey === budgetKey)) bound.configure(budgetKey, quota) })
        const durableLedger = new Proxy(new BudgetLedger(), { get(target, property) { if (['reserve', 'settle', 'release'].includes(String(property))) return (...values: unknown[]) => store.transaction(() => (budget() as any)[property](...values)); const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value } })
        const runId = randomUUID()
        const environment = nativeEnvironment(store, root)
        store.transaction(() => {
          if (store.events({ kind: 'codex.amp.execution.started' }).some(event => (event.payload as any).key === key)) throw new Error('Concurrent execution already claimed this key; retry to inspect its outcome')
          store.appendEvent('codex.amp.execution.started', { key, request, runId })
        })
        const executor = new Executor(manifests, policy, durableLedger, async (input, definition) => {
          const current = openNativeStore(workspace); current.store.close()
          if (current.root !== root) throw new Error('Workspace changed before tool invocation')
          return await sources.find(tool => tool.name === definition.toolId)!.handler(input as Record<string, unknown>) as any
        }, { id: randomUUID, now, measure: (input, output) => ({ bytes: Buffer.byteLength(nativeRequest({ input, output: output ?? null })) }), maxChildCalls: 8,
          beforeInvoke(invocation) { store.appendEvent('codex.amp.execution.invocation', invocation) },
        })
        const result = await makeService(executor).run(context(root), calls, budgetKey)
        const receipts = result.children.map(child => {
          const output = child.output as any
          const path = (child.invocation.arguments as any)?.path
          const rawHash = output?.rawHash ?? output?.snapshot?.rawHash
          const fileAnchor = fileReceiptTools.has(child.invocation.toolId) && typeof path === 'string' && typeof rawHash === 'string' ? { affectedFiles: [path], snapshotId: rawHash } : {}
          return createReceiptCore({ id: 'receipt:' + child.invocation.id, invocation: createInvocation(child.invocation), observation: createObservation(child.observation), issuedAt: now(), hashAlgorithm: 'sha256-json-execution-facts/2', payloadDigest: executionFactDigest(child.invocation, child.observation), lifecycle: 'issued', workspaceAnchor: { workspaceId: digest(root), changeHash: environment, ...fileAnchor } })
        })
        const handle = handles.create({ id: randomUUID(), tenantId: binding.tenantId, ownerId: binding.principalId, sessionId: scopedSession(root), sourceDigest: digest(result), ttlMilliseconds: 300000, revocationEpoch: 0, records: result.children })
        const value = { execution: result, receipts, businessVerification: 'not_performed', resultHandle: { id: handle.id, expiresAt: handle.expiresAt, scope: 'current-connection' } }
        store.transaction(() => { for (const receipt of receipts) store.save('receipt', receipt); store.appendEvent('codex.amp.execution.finished', { runId, result: value }) })
        return value
      } finally { store.close() }
    }, false),
    wrap('execution.read_handle', 'Read a page of native execution results. Handles expire after five minutes and belong to their issuing connection and workspace; cached replay handles may require a fresh execution.', { id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['id'], async args => {
      const { root, store } = openNativeStore(workspace); store.close()
      return { page: await makeService(unusedExecutor).readHandle(context(root), String(args.id), { tenantId: binding.tenantId, ownerId: binding.principalId, sessionId: scopedSession(root), cursor: args.cursor as string | undefined, limit: Number(args.limit ?? 20), now: now(), expectedRevocationEpoch: 0 }) }
    }),
  ]
}
