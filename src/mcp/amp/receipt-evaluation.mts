/** Read-only receipt evaluation over durable native receipts in the selected scope. */
import { aggregateReceipts } from 'attention-manifest-protocol/receipt'
import type { ReceiptCore } from 'attention-manifest-protocol/receipt'
import { verifyReceiptIntegrity } from 'attention-manifest-protocol/receipt'
import { executionFactDigest } from 'attention-manifest-protocol/runtime'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest } from './native-store.mjs'
import { createHash } from 'node:crypto'

const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(nativeRequest(value)).digest('hex')
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const MAX_RECEIPTS = 1000

/** Receipts are only evaluated inside the connection's tenant/principal and a
 * session this plugin actually owns: the MCP connection, its per-workspace
 * execution session, or a durable workflow session row. */
function inScope(context: any, binding: AgentBinding, root: string, sessions: Set<string>) {
  if (!context || context.tenantId !== binding.tenantId || context.principalId !== binding.principalId) return false
  const session = context.sessionId
  if (typeof session !== 'string') return false
  return session === binding.sessionId || session === binding.sessionId + ':' + digest(root) || sessions.has(session)
}

export function receiptEvaluation(binding: AgentBinding, workspace: () => unknown): ToolDefinition {
  return {
    name: 'attention_manifest_protocol_receipt_evaluation',
    description: 'Read-only evaluation of successful/failed native receipts in this connection, tenant, principal and owned sessions. Each stored receipt is re-verified with the native execution-fact digest and integrity checker; tampered receipts are reported and excluded from the aggregate. Counts are stored facts, not business acceptance or Codex token usage.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 200 }, turnId: { type: 'string', minLength: 1, maxLength: 200 },
      capabilityPrefix: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: MAX_RECEIPTS },
    } },
    annotations: { readOnlyHint: true },
    async handler(input) {
      // These two fields only narrow already-owned receipt rows. They never
      // replace the host binding; all other context overrides remain forbidden.
      const { sessionId: sessionFilter, turnId: turnFilter, ...parameters } = input
      assertModelParameters(parameters)
      const allowed = ['sessionId', 'turnId', 'capabilityPrefix', 'limit']
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown receipt evaluation parameter')
      const limit = Number((input as any).limit ?? 500)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECEIPTS) throw new Error(`limit must be 1-${MAX_RECEIPTS}`)
      for (const key of ['sessionId', 'turnId', 'capabilityPrefix']) {
        const value = (input as any)[key]
        if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) throw new Error(key + ' must be a bounded nonempty string')
      }
      const opened = openNativeStore(workspace), root = opened.root
      let rows: ReceiptCore[], sessions: Set<string>
      try {
        // Read durable facts, then close before the async integrity checks: no
        // transaction may span an await.
        sessions = new Set(opened.store.list<any>('session').map(row => String(row.id)))
        rows = opened.store.list<ReceiptCore>('receipt').filter(receipt => inScope(receipt.invocation?.context, binding, root, sessions)).map(plain)
      } finally { opened.store.close() }
      const filtered = rows
        .filter(receipt => !(input as any).sessionId || receipt.invocation.context.sessionId === (input as any).sessionId)
        .filter(receipt => {
          const context = receipt.invocation.context as typeof receipt.invocation.context & { turnId?: string }
          return !(input as any).turnId || [context.originTurnId, context.observedInTurnId, context.turnId].includes((input as any).turnId)
        })
        .filter(receipt => !(input as any).capabilityPrefix || String(receipt.invocation.toolId).startsWith(String((input as any).capabilityPrefix)))
      const bounded = filtered.slice(0, limit)
      const invalid: { id: string; reason: string }[] = []
      const valid: ReceiptCore[] = []
      for (const receipt of bounded) {
        try {
          if (receipt.hashAlgorithm !== 'sha256-json-execution-facts/2') throw new Error('unsupported hash algorithm')
          if (executionFactDigest(receipt.invocation, receipt.observation) !== receipt.payloadDigest) throw new Error('execution digest mismatch')
          const integrity = await verifyReceiptIntegrity(receipt, { digest: item => executionFactDigest(item.invocation, item.observation), verifier: 'native-execution-facts/2', verifiedAt: new Date().toISOString() })
          if (integrity.status !== 'integrity_verified') throw new Error('integrity not verified')
          valid.push(receipt)
        } catch (error) { invalid.push({ id: String(receipt.id), reason: String(error instanceof Error ? error.message : error) }) }
      }
      const aggregate = aggregateReceipts(valid)
      return {
        scope: { tenantId: binding.tenantId, principalId: binding.principalId, connectionSessionId: binding.sessionId, filters: { sessionId: (input as any).sessionId ?? null, turnId: (input as any).turnId ?? null, capabilityPrefix: (input as any).capabilityPrefix ?? null } },
        receipts: { matched: filtered.length, truncated: filtered.length > bounded.length, evaluated: valid.length, invalid: invalid.length, invalidReceipts: invalid.slice(0, 20) },
        aggregate: plain(aggregate),
        limitations: ['Only stored receipts in this connection/tenant/principal and owned sessions are counted.', 'Integrity re-verification excludes tampered receipts; it does not re-run the underlying operation.', 'Counts and durations are stored observations, not Codex model token usage or business acceptance.'],
      }
    },
  }
}
