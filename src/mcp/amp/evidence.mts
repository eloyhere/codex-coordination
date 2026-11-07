/** Native evidence is created only after integrity checks and independent host review. */
import { EvidenceLedger } from 'attention-manifest-protocol/evidence'
import { bindEvidence } from 'attention-manifest-protocol/persistence'
import { verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { verifyBusinessSemantics } from 'attention-manifest-protocol/verification'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { AgentGateway, createAgentSurface, assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding, GatewayHandler } from 'attention-manifest-protocol/agent'
import type { ReceiptCore } from 'attention-manifest-protocol/receipt'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeEnvironment, nativeRequest } from './native-store.mjs'
import { requestHostApproval } from './host-client.mjs'
import { randomUUID } from 'node:crypto'
import { assertFileFreshness, fileReceiptTools } from './file-freshness.mjs'
import type { NativeFilesystemScope } from './filesystem.mjs'

export function evidenceBindings(binding: AgentBinding, workspace: () => unknown, filesystemPolicy?: () => NativeFilesystemScope | undefined): ToolDefinition[] {
  const standard = createAgentSurface()
  const descriptors = standard.tools.filter(tool => tool.module === 'evidence')
  const handlers: Record<string, GatewayHandler> = {}
  for (const descriptor of descriptors) handlers[descriptor.name] = parameters => {
    const { root, store } = openNativeStore(workspace)
    try {
      const ledger = new EvidenceLedger(), bound = bindEvidence(store, ledger)
      bound.rehydrate(); if (bound.report.skipped.length) throw new Error('Native evidence contains invalid facts')
      const consumable = (id: unknown) => {
        if (typeof id !== 'string') throw new Error('Evidence id is required')
        const evidence = ledger.getConsumable(id, binding.tenantId, new Date().toISOString())
        if (!evidence) throw new Error('Evidence is absent, expired, revoked or stale')
        if (evidence.environmentVersion !== nativeEnvironment(store, root)) throw new Error('Evidence environment is stale')
        const receipt = store.list<ReceiptCore>('receipt').find(item => item.id === evidence.receiptId)
        if (!receipt) throw new Error('Evidence receipt is missing')
        assertFileFreshness(JSON.parse(JSON.stringify(receipt)), root, binding.tenantId, filesystemPolicy)
        return evidence
      }
      if (descriptor.verb === 'get') { const evidence = ledger.get(String(parameters.id), binding.tenantId); if (!evidence) throw new Error('Evidence not found in this workspace'); return { evidence, currentEnvironmentMatches: evidence.environmentVersion === nativeEnvironment(store, root) } }
      if (descriptor.verb === 'cite') {
        if (!Array.isArray(parameters.ids) || !parameters.ids.length || parameters.ids.length > 20) throw new Error('Provide 1-20 evidence IDs')
        return { citations: parameters.ids.map(id => { const evidence = consumable(id); return { id: evidence.id, claim: evidence.claim, receiptId: evidence.receiptId, verificationId: evidence.verificationId, criteriaVersion: evidence.criteriaVersion, environmentVersion: evidence.environmentVersion } }), acceptanceGranted: false }
      }
      const limit = Number(parameters.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1-100')
      return { evidence: store.list<any>('evidence').filter(item => item.tenantId === binding.tenantId).slice(0, limit).map(item => JSON.parse(nativeRequest(item))) }
    } finally { store.close() }
  }
  const allowed = new Set(descriptors.flatMap(tool => tool.authority))
  const gateway = new AgentGateway({ handlers, surface: { ...standard, tools: descriptors }, authorize: values => values.every(value => allowed.has(value)), onCall(record) {
    if (typeof workspace() !== 'string') return
    const { store } = openNativeStore(workspace); try { store.appendEvent('codex.amp.evidence.call', { ...record, principalId: binding.principalId }) } finally { store.close() }
  } })
  const tools: ToolDefinition[] = descriptors.map(descriptor => ({ name: descriptor.name, description: descriptor.description + ' Native workspace evidence. Citations do not complete tasks or goals.',
    inputSchema: { type: 'object', additionalProperties: false, required: descriptor.verb === 'get' ? ['id'] : descriptor.verb === 'cite' ? ['ids'] : [], properties: descriptor.verb === 'get' ? { id: { type: 'string', minLength: 1 } } : descriptor.verb === 'cite' ? { ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } } } : { limit: { type: 'integer', minimum: 1, maximum: 100 } } }, annotations: { readOnlyHint: true },
    async handler(args) { return await gateway.call(descriptor.name, args, { binding }) as Record<string, any> },
  }))
  tools.push({ name: 'attention_manifest_protocol_evidence_review', description: 'Ask the independent MCP host to verify one explicit claim against a stored successful native receipt. Requires intact execution facts and unchanged anchored project environment. Creates native verification and evidence only on approval; never completes tasks or goals.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['receiptId', 'claim', 'criteriaVersion', 'idempotencyKey'], properties: { receiptId: { type: 'string', minLength: 1 }, claim: { type: 'string', minLength: 1, maxLength: 4000 }, criteriaVersion: { type: 'string', minLength: 1, maxLength: 200 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 } } }, annotations: { readOnlyHint: false },
    async handler(input) {
      assertModelParameters(input)
      const args = Object.freeze(JSON.parse(nativeRequest(input))) as Record<string, unknown>
      if (Object.keys(args).some(key => !['receiptId', 'claim', 'criteriaVersion', 'idempotencyKey'].includes(key)) || !['receiptId', 'claim', 'criteriaVersion', 'idempotencyKey'].every(key => typeof args[key] === 'string' && (args[key] as string).trim().length)) throw new Error('Invalid evidence review parameters')
      const { root, store } = openNativeStore(workspace)
      const request = nativeRequest(args), key = binding.principalId + ':' + args.idempotencyKey
      let receipt: ReceiptCore, environment: string
      try {
        const existing = store.events({ kind: 'codex.amp.evidence.review' }).find(event => (event.payload as any).key === key)?.payload as any
        if (existing) { if (existing.request !== request) throw new Error('Idempotency key already used for another evidence review'); return { ...existing.result, replayed: true } }
        const stored = store.list<ReceiptCore>('receipt').find(item => item.id === args.receiptId)
        if (!stored) throw new Error('Native receipt not found')
        receipt = JSON.parse(JSON.stringify(stored))
        if (receipt.invocation.context.tenantId !== binding.tenantId || receipt.invocation.context.principalId !== binding.principalId) throw new Error('Receipt belongs to another principal')
        if (receipt.observation.status !== 'success' || receipt.lifecycle !== 'issued') throw new Error('Only successful issued native receipts can be reviewed')
        if (!/^attention_manifest_protocol_(project|goal|plan|task|mission|intent|action)\./.test(receipt.invocation.toolId) && !fileReceiptTools.has(receipt.invocation.toolId)) throw new Error('Receipt source freshness anchors are not yet integrated for this tool')
        assertFileFreshness(receipt, root, binding.tenantId, filesystemPolicy)
        if (receipt.hashAlgorithm !== 'sha256-json-execution-facts/2') throw new Error('Unsupported native receipt integrity algorithm')
        environment = nativeEnvironment(store, root)
        if (receipt.workspaceAnchor?.changeHash !== environment) throw new Error('Receipt environment is missing or stale; execute against the current environment')
        store.appendEvent('codex.amp.evidence.review_requested', { key, request, receiptId: receipt.id, environment })
      } finally { store.close() }
      const integrity = await verifyReceiptIntegrity(receipt!, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'native-execution-facts/2', verifiedAt: new Date().toISOString() })
      if (integrity.status !== 'integrity_verified') throw new Error('Native receipt integrity verification failed')
      const approved = await requestHostApproval('evidence:' + receipt!.id, 'verify_claim', { claim: args.claim, criteriaVersion: args.criteriaVersion, environmentVersion: environment!, receipt: receipt! })
      const auditStore = openNativeStore(() => root).store
      try { auditStore.appendEvent('codex.amp.evidence.host_decision', { key, approved, receiptId: receipt!.id, environment: environment! }) } finally { auditStore.close() }
      const current = openNativeStore(workspace)
      try {
        if (current.root !== root) throw new Error('Workspace changed while awaiting evidence review')
        const latest = current.store.list<ReceiptCore>('receipt').find(item => item.id === receipt!.id)
        if (!latest || nativeRequest(JSON.parse(JSON.stringify(latest))) !== nativeRequest(receipt!) || nativeEnvironment(current.store, root) !== environment!) throw new Error('Receipt or environment changed while awaiting evidence review')
        const verification = approved ? await verifyBusinessSemantics(receipt!, integrity, { id: randomUUID(), criteriaVersion: String(args.criteriaVersion), verifier: 'independent-mcp-host-confirmation', verifiedAt: new Date().toISOString() }, () => true, [String(args.claim)]) : undefined
        return current.store.transaction(() => {
          const active = openNativeStore(workspace); active.store.close()
          if (active.root !== root || nativeEnvironment(current.store, root) !== environment!) throw new Error('Environment or workspace changed before evidence commit')
          const receiptHead = current.store.refresh<ReceiptCore>('receipt', receipt!.id)
          if (nativeRequest(JSON.parse(JSON.stringify(receiptHead))) !== nativeRequest(receipt!)) throw new Error('Receipt changed before evidence commit')
          assertFileFreshness(receipt!, root, binding.tenantId, filesystemPolicy)
          const prior = current.store.events({ kind: 'codex.amp.evidence.review' }).find(event => (event.payload as any).key === key)?.payload as any
          if (prior) { if (prior.request !== request) throw new Error('Idempotency key already used for another evidence review'); return { ...prior.result, replayed: true } }
          let evidence
          if (verification?.status === 'semantic_verified') {
            const bound = bindEvidence(current.store, new EvidenceLedger()); bound.rehydrate(); if (bound.report.skipped.length) throw new Error('Invalid evidence facts')
            current.store.save('receipt_integrity', integrity)
            current.store.save('verification', verification)
            evidence = bound.add({ id: randomUUID(), tenantId: binding.tenantId, claim: String(args.claim), polarity: 'supports', receipt: receipt!, integrity, verification, criteriaVersion: String(args.criteriaVersion), environmentVersion: environment!, createdAt: new Date().toISOString(), sessionId: receipt!.invocation.context.sessionId })
          }
          const result = { approved, evidence: evidence ?? null, verification: verification ?? null, acceptanceGranted: false }
          current.store.appendEvent('codex.amp.evidence.review', { key, request, result })
          return result
        })
      } finally { current.store.close() }
    },
  })
  return tools
}
