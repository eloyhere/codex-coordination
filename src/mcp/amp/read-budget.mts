/** Native read contracts use the same durable quota through direct MCP or execution.run. */
import { BudgetLedger } from 'attention-manifest-protocol/budget'
import { bindBudget } from 'attention-manifest-protocol/persistence'
import { assertModelParameters } from 'attention-manifest-protocol/agent'
import type { AgentBinding } from 'attention-manifest-protocol/agent'
import type { ToolDefinition } from '../lib/tools.mjs'
import { openNativeStore, nativeRequest, nativeWorkspaceRoot } from './native-store.mjs'
import { randomUUID } from 'node:crypto'
import Ajv from 'ajv'

export const nativeReadQuota = Object.freeze({ calls: 1000, bytes: 64 * 1024 * 1024, milliseconds: 3600000, tokens: 0, retries: 0, concurrency: 8 })
export const nativeReadReservation = Object.freeze({ calls: 1, bytes: 4 * 1024 * 1024, milliseconds: 30000, concurrency: 1 })
export const isNativeReadContract = (tool: ToolDefinition) => tool.annotations?.readOnlyHint === true && !tool.name.startsWith('attention_manifest_protocol_execution.') &&
  (tool.name.startsWith('attention_manifest_protocol_project.') || /attention_manifest_protocol_(goal|plan|task|mission|intent|action|evidence)\./.test(tool.name) || tool.name.startsWith('attention_manifest_protocol_workspace.'))

export function nativeIoBudget(store: ReturnType<typeof openNativeStore>['store'], key: string) {
  const bound = bindBudget(store, new BudgetLedger())
  bound.rehydrate()
  if (bound.report.skipped.length) throw new Error('Invalid native budget facts')
  if (!store.list<any>('budget_ledger').some(row => row.budgetKey === key)) bound.configure(key, nativeReadQuota)
  return bound
}

/** Called after executionBindings captures its raw sources, avoiding double charging. */
export function guardNativeReadContracts(tools: ToolDefinition[], binding: AgentBinding, workspace: () => unknown): ToolDefinition[] {
  return tools.map(tool => {
    if (!isNativeReadContract(tool)) return tool
    const validate = new (Ajv as any)({ strict: false }).compile(tool.inputSchema)
    return { ...tool, async handler(input) {
      assertModelParameters(input)
      const args = JSON.parse(nativeRequest(input)) as Record<string, unknown>
      if (!validate(args)) throw new Error('Read arguments do not match the installed schema')
      const { root, store } = openNativeStore(workspace)
      const id = 'direct-read:' + randomUUID(), key = 'native-read:' + binding.principalId
      try {
        store.transaction(() => {
          nativeIoBudget(store, key).reserve(id, key, nativeReadReservation)
          store.appendEvent('codex.amp.read.started', { id, key, tool: tool.name, arguments: args, principalId: binding.principalId })
        })
      } finally { store.close() }
      let value: Record<string, any> | undefined, failure: unknown, succeeded = false
      // Keep a live owner while adapters return managed entities, and detach the
      // result before closing it. No database transaction spans the async call.
      const owner = openNativeStore(() => root)
      try {
        if (nativeWorkspaceRoot(workspace()) !== root) throw new Error('Workspace changed before native read')
        value = JSON.parse(nativeRequest(await tool.handler(args))) as Record<string, any>
        if (nativeWorkspaceRoot(workspace()) !== root) throw new Error('Workspace changed during native read')
        if (Buffer.byteLength(nativeRequest({ input: args, output: value })) > nativeReadReservation.bytes) throw new Error('Native read result exceeds the reserved byte budget')
        succeeded = true
      } catch (error) { failure = error } finally { owner.store.close() }
      const current = openNativeStore(() => root)
      try {
        current.store.transaction(() => {
          const bound = nativeIoBudget(current.store, key)
          // A failed operation still consumed a call. If its output cannot be
          // delivered, conservatively charge the entire byte reservation.
          const bytes = succeeded ? Buffer.byteLength(nativeRequest({ input: args, output: value })) : nativeReadReservation.bytes
          bound.settle(id, { calls: 1, bytes })
          current.store.appendEvent('codex.amp.read.finished', { id, tool: tool.name, success: succeeded, bytes, ...(succeeded ? {} : { error: String(failure) }) })
        })
      } finally { current.store.close() }
      if (!succeeded) throw failure
      return value!
    } }
  })
}
