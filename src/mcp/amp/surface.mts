/** AMP 0.7 discovery over executable Codex host contracts. */
import { AgentGateway, SURFACE_MODULES, createAgentSurface } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { randomUUID } from 'node:crypto'
import { proposalBindings } from './proposals.mjs'
import { projectBindings } from './project.mjs'
import ampPackage from 'attention-manifest-protocol/package.json' with { type: 'json' }
import { migrationTool } from './migration.mjs'
import { workflowBindings } from './workflow.mjs'
import { executionBindings } from './execution.mjs'
import { evidenceBindings } from './evidence.mjs'
import { filesystemBindings } from './filesystem.mjs'
import { codexSyncTool } from '../codex/tools.mjs'
import { sessionBindings } from '../codex/session-tools.mjs'
import { configureSnapshotCatalog } from '../codex/snapshot.mjs'
import { ENTITY_REGISTRY } from 'attention-manifest-protocol/entity'
import { attentionBindings } from './attention.mjs'
import { localDiscoveryProviders } from './discovery.mjs'
import { writeBinding } from './write.mjs'
import { cooperationBindings } from './cooperation.mjs'
import { submissionReview } from './submission-review.mjs'
import { wrapLegacyTools } from './legacy-policy.mjs'
import { guardNativeReadContracts } from './read-budget.mjs'
import { workflowCancelReview } from './cancellation.mjs'
import { workflowAcceptanceReview } from './acceptance.mjs'
import { governanceBindings } from './governance.mjs'
import { projectViewsBindings } from './project-views.mjs'
import { reconciliationReview } from './reconciliation.mjs'
import { evidenceLifecycleReview } from './evidence-lifecycle.mjs'
import { receiptEvaluation } from './receipt-evaluation.mjs'
import { replaceBinding } from './replace.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'

export function withAmpSurface(tools: ToolDefinition[], workspace: () => unknown = () => undefined, filesystemPolicy?: () => NativeFilesystemScope | undefined): ToolDefinition[] {
  tools = wrapLegacyTools(tools, workspace)
  configureSnapshotCatalog(SURFACE_MODULES, Object.keys(ENTITY_REGISTRY))
  // Identity is owned by this stdio connection, never supplied by model input.
  const binding = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: randomUUID(), policyVersion: 'codex-local-read-v1', cancellationEpoch: 0 })
  const selectedWorkflows = new Map<string, string>()
  const selectedThreads = new Map<string, string>()
  const workflows = [...workflowBindings(binding, workspace, selectedWorkflows), ...sessionBindings(binding, workspace).map(tool => {
    if (tool.name !== 'attention_manifest_protocol_session.get') return tool
    const handler = tool.handler
    return { ...tool, async handler(args: Record<string, unknown>) {
      const result = await handler(args)
      if (typeof args.threadId === 'string' && typeof workspace() === 'string') selectedThreads.set(String(workspace()), args.threadId)
      return result
    } }
  })]
  const workflowNames = new Set(workflows.map(tool => tool.name))
  tools = [...tools, ...proposalBindings(binding, workspace).filter(tool => !workflowNames.has(tool.name)), ...projectBindings(binding, workspace), migrationTool(workspace), ...workflows, ...cooperationBindings(binding, workspace, root => selectedWorkflows.get(root)), submissionReview(binding, workspace, root => selectedWorkflows.get(root), filesystemPolicy)]
  tools = [...tools, ...evidenceBindings(binding, workspace, filesystemPolicy), ...attentionBindings(binding, workspace)]
  const customFiles = [writeBinding(binding, workspace, filesystemPolicy, root => selectedWorkflows.get(root)), replaceBinding(binding, workspace, filesystemPolicy, root => selectedWorkflows.get(root))]
  const customFileNames = new Set(customFiles.map(tool => tool.name))
  const filesystem = [...filesystemBindings(binding, workspace, filesystemPolicy).filter(tool => !customFileNames.has(tool.name)), ...customFiles]
  const filesystemNames = new Set(filesystem.map(tool => tool.name))
  tools = [...tools.filter(tool => !filesystemNames.has(tool.name)), ...filesystem]
  const execution = executionBindings(tools, binding, workspace)
  const executionNames = new Set(execution.map(tool => tool.name))
  // executionBindings captured unwrapped sources; only direct MCP entries need
  // the additional guard, so both routes share one ledger without double debit.
  tools = [...guardNativeReadContracts(tools.filter(tool => !executionNames.has(tool.name)), binding, workspace), ...execution, codexSyncTool(workspace), workflowCancelReview(binding, workspace, root => selectedWorkflows.get(root)), workflowAcceptanceReview(binding, workspace, root => selectedWorkflows.get(root), filesystemPolicy),
    // Host extensions: exact approval, native guards and durable journals. None
    // claims Codex main-loop control; no host evaluator is injected by default,
    // so profession certification stays explicitly unsupported.
    ...governanceBindings(binding, workspace, {}, filesystemPolicy), ...projectViewsBindings(binding, workspace, filesystemPolicy),
    reconciliationReview(binding, workspace, filesystemPolicy, root => selectedWorkflows.get(root)), evidenceLifecycleReview(binding, workspace, root => selectedWorkflows.get(root), filesystemPolicy), receiptEvaluation(binding, workspace)]
  const standard = createAgentSurface()
  const registered = new Set(tools.map(tool => tool.name))
  const boundSurface = standard.tools.filter(tool => registered.has(tool.name))
  const boundAuthorities = new Set(boundSurface.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({
    handlers: Object.fromEntries(boundSurface.map(descriptor => [descriptor.name, (parameters, context) => tools.find(tool => tool.name === descriptor.name)!.handler({ ...parameters, ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}) })])),
    surface: { ...standard, tools: boundSurface },
    // Discovery is read-only. Domain writes continue through their existing gates.
    authorize: authorities => authorities.every(value => boundAuthorities.has(value) || value === 'execution:find' || ['host_modules', 'amp', 'session_files', 'session_outlines', 'conversation', 'network'].some(source => value === 'discovery:' + source)),
    discovery: { providers: [{ source: 'host_modules', search() {
      return tools.map(tool => ({ id: tool.name, source: 'host_modules' as const, kind: 'tool' as const,
        module: tool.name.split('_')[1] ?? 'coordination', name: tool.name,
        summary: tool.description, target: { tool: tool.name },
      }))
    } }, ...localDiscoveryProviders(workspace, filesystemPolicy, () => typeof workspace() === 'string' ? selectedThreads.get(String(workspace())) : undefined)] },
  })
  return [...tools, {
    name: 'attention_manifest_protocol_discover',
    description: 'AMP 0.7 ranked discovery over installed host tools, authorized selected-workspace files/outlines and the explicitly selected observed Codex conversation. The amp source searches only canonical contracts with actual host bindings. Network discovery is unavailable until a host network provider is configured.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { oneOf: [{ type: 'string', minLength: 1, maxLength: 4096 }, { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4096 } }] }, regex: { type: 'boolean' },
      weights: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['lexical', 'semantic', 'signature', 'context'].map(key => [key, { type: 'number', minimum: 0, maximum: 1 }])) }, sources: { type: 'array', items: { enum: ['host_modules', 'amp', 'session_files', 'session_outlines', 'conversation', 'network'] } },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, maxPerModule: { type: 'integer', minimum: 1, maximum: 100 }, minimumScore: { type: 'number', minimum: 0, maximum: 1 },
    } },
    async handler(args) { return await gateway.call('attention_manifest_protocol_discover', args.sources ? args : { ...args, sources: ['host_modules', 'amp', 'session_files', 'session_outlines'] }, { binding }) as Record<string, any> },
  }, {
    name: 'attention_manifest_protocol_surface',
    description: 'Inspect the AMP 0.7 standard module tiers and verb contracts. This is a migration inventory, not execution authorization. host and hidden modules are never registered as executable model tools.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: false, properties: { module: { type: 'string' } } },
    async handler(args) {
      const modules = SURFACE_MODULES.filter(row => !args.module || row.module === args.module)
      return { version: ampPackage.version, modules, registered: tools.filter(tool => tool.name.startsWith('attention_manifest_protocol_')).map(tool => tool.name), execution: 'Only registered contracts have executable host bindings; use discover with host_modules for installed tools.' }
    },
  }]
}

