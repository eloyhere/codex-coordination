/** MCP-facing authority gate; legacy adapters remain independently testable host ports. */
import type { ToolDefinition } from '../lib/tools.mjs'
import { requestHostApproval } from './host-client.mjs'
import { nativeRequest, nativeWorkspaceRoot } from './native-store.mjs'
import { randomUUID } from 'node:crypto'

const keyWrites = new Set(['generate', 'rotate', 'import_public', 'revoke', 'retire'])
const keyReads = new Set(['verifyManifest', 'verifyWithRegistry', 'verifyCardSignature', 'verifyCardWithRegistry', 'verifyAttestation', 'verifyAttestationWithKey', 'verifyCanonicalValue', 'verifyGovernanceSignature', 'verifyGovernanceBundle', 'verifyEnvelope', 'verifyCheckpoint', 'verifySnapshotAgainstCheckpoint'])
const runtimeReads = new Set(['session', 'turns', 'replay'])
const registryWrites = new Set(['register', 'update', 'remove', 'clear'])
const authorityRegistries = new Set(['behaviors', 'tools', 'protocols', 'modules', 'environments', 'skills'])
const authorityDomains = new Set(['governance', 'policy', 'runtime', 'manifest', 'protocol', 'cooperation', 'delegate', 'process', 'authz', 'control', 'registry', 'module', 'session', 'thread', 'kernel'])
const resourceReads = new Set(['get', 'list', 'snapshot', 'serialize', 'status', 'remaining', 'verify', 'find', 'has', 'record', 'revocations', 'isRevoked', 'verifyWindow', 'events', 'describe'])
const apiRootReads = new Set(['describe', 'resources'])
const approvalFields = ['approved', 'hostApproved', 'approvalGranted', 'hostApproval', 'approvalToken', 'approval']
function hasPrivateReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasPrivateReference)
  return Object.entries(value).some(([key, child]) => key === '$key' || key === '$signer' || hasPrivateReference(child))
}

/** Wrap the MCP catalog only. Calling a host adapter directly does not enter this gate. */
export function wrapLegacyTools(tools: ToolDefinition[], workspace: () => unknown): ToolDefinition[] {
  const names = new Set(['coordination_connections', 'coordination_keys', 'coordination_runtime', 'coordination_amp', 'coordination_registry', 'amp_tool_workspace_adjust', 'amp_tool_global_adjust'])
  return tools.map(tool => {
    if (!names.has(tool.name)) return tool
    const requiresReview = async (args: Record<string, any>): Promise<boolean> => {
      if (tool.name === 'coordination_keys') {
        if (hasPrivateReference(args)) return true
        if (keyWrites.has(args.action)) return true
        if (args.action === 'call') return !keyReads.has(args.operation)
        return false // describe/list/keyring reads retain their underlying validators.
      }
      if (tool.name === 'coordination_runtime') return !runtimeReads.has(args.action)
      if (tool.name === 'coordination_connections') {
        // Host configuration selects endpoints; it does not pre-authorize remote
        // signing, delegation, or listener lifecycle side effects.
        return ['deliver', 'delegate', 'listen', 'stop_listener', 'disconnect'].includes(args.action)
      }
      if (tool.name === 'coordination_registry' || tool.name.endsWith('_adjust')) {
        if (args.dryRun === true && registryWrites.has(args.action)) return false
        if (args.action === 'invoke') return args.registry === 'tools'
        const scopedWrite = tool.name === 'coordination_registry'
          ? registryWrites.has(args.action) && authorityRegistries.has(args.registry)
          : registryWrites.has(args.action)
        return scopedWrite
      }
      if (hasPrivateReference(args)) return true
      if (apiRootReads.has(args.action)) return false
      // DomainApi's `get` also falls through to a published function for function
      // exports; it is not a guaranteed read route. Property inspection is read.
      if (args.action === 'inspect') return false
      if (args.action === 'get') return authorityDomains.has(args.module)
      // Resource construction, append and aggregate service commands can create
      // durable state. Pure published computations remain directly callable.
      if (['create', 'append', 'service'].includes(args.action)) return true
      if (args.action === 'invoke') {
        // Resolve resource metadata through the host-owned inventory, never from
        // a caller-provided module/name. Unknown handles remain subject to review
        // and are ultimately rejected by the underlying adapter.
        const inventory = await tool.handler({ action: 'resources' }) as any
        const resource = inventory?.resources?.find((item: any) => item.id === args.resource)
        if (!resource) return true
        return authorityDomains.has(resource.module) || !resourceReads.has(args.method)
      }
      if (args.action === 'call') return authorityDomains.has(args.module)
      return false
    }
    return { ...tool, description: tool.description + ' MCP-facing host authority operations require an independent approval of the exact arguments and selected workspace.', async handler(input) {
      if (approvalFields.some(field => Object.hasOwn(input, field))) throw new Error('Model-supplied host approval fields are not accepted')
      // Detach before awaiting so neither classification nor execution can observe
      // caller mutation after the host has approved a different request.
      const args = JSON.parse(nativeRequest(input)) as Record<string, any>
      const root = nativeWorkspaceRoot(workspace())
      const review = await requiresReview(args)
      if (nativeWorkspaceRoot(workspace()) !== root) throw new Error('Workspace changed while resolving legacy authority')
      if (!review) return tool.handler(args)
      const request = { reviewId: randomUUID(), tool: tool.name, workspace: root, arguments: args }
      if (!await requestHostApproval('legacy-authority:' + root, tool.name, request)) throw new Error('Independent host approval was not granted for this legacy authority operation')
      if (nativeWorkspaceRoot(workspace()) !== root) throw new Error('Workspace changed while awaiting legacy authority approval')
      return tool.handler(args)
    } }
  })
}
