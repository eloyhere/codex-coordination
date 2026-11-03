/** Correlated MCP host requests. Agent tool arguments cannot manufacture replies. */
let capabilities: Record<string, any> = {}
let send: ((message: Record<string, unknown>) => void) | undefined
const pending = new Map<string, { resolve(value: any): void; timer: NodeJS.Timeout }>()
export function configureHostClient(clientCapabilities: Record<string, any>, sender: (message: Record<string, unknown>) => void) { capabilities = clientCapabilities; send = sender }
export function acceptHostResponse(message: Record<string, unknown>) {
  if ('method' in message || typeof message.id !== 'string') return false
  const item = pending.get(message.id)
  if (!item) return false
  pending.delete(message.id); clearTimeout(item.timer)
  item.resolve(message.error ? undefined : message.result)
  return true
}
export async function requestHostApproval(endpoint: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
  if (!capabilities.elicitation || !send) return false
  const id = `amp.host.${crypto.randomUUID()}`
  const result = await new Promise<any>(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve(undefined) }, 5 * 60_000)
    pending.set(id, { resolve, timer })
    send!({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      message: `AMP requires host approval for ${endpoint}: ${tool}. Arguments: ${JSON.stringify(args)}. This requirement comes from AMP action policy §3.8 (host-issued approval).`,
      requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Approve this exact action', enum: ['approve', 'reject'] } }, required: ['decision'] },
    } })
  })
  return result?.action === 'accept' && result?.content?.decision === 'approve'
}
export function closeHostClient() { for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(undefined) }; pending.clear() }
