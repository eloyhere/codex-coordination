import { readCodexThread, mirrorGoal, goalDigest } from './events.mjs'
import { codexGoalRpc } from './client.mjs'
import { getCodexGoal } from './goals.mjs'
import type { ToolDefinition } from '../lib/tools.mjs'

export function codexSyncTool(workspace: () => unknown, rpc = codexGoalRpc, readGoal = getCodexGoal): ToolDefinition {
  return { name: 'attention_manifest_protocol_codex_sync', description: 'Read real Codex hook observations or synchronize its persisted thread goal through the existing app-server control socket. No raw event ingestion is exposed to agents. On observed conflicts Codex wins. Native goal API has no compare-and-set; outbound requests report that concurrency limitation. Codex completion is not AMP business verification.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'threadId'], properties: { action: { enum: ['status', 'pull_goal', 'push_goal'] }, threadId: { type: 'string', minLength: 1 }, expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, objective: { type: 'string', minLength: 1, maxLength: 4000 }, status: { enum: ['active', 'paused', 'blocked', 'complete'] } } },
    async handler(args) {
      const threadId = String(args.threadId)
      const observed = readCodexThread(workspace, threadId)
      if (args.action === 'status') return { ...observed, conflictPolicy: 'codex-wins', atomicGoalCAS: false }
      const result = await readGoal(threadId)
      const current = mirrorGoal(workspace, threadId, result.goal, result.source)
      if (args.action === 'pull_goal') return { ...current, authority: 'codex', atomicGoalCAS: false }
      if (args.action !== 'push_goal') throw new Error('Unknown synchronization action')
      if (args.expectedDigest !== goalDigest(result.goal)) return { ...current, conflict: true, winner: 'codex', changed: false }
      if (args.objective === undefined && args.status === undefined) throw new Error('Provide objective or status')
      const updated = await rpc('thread/goal/set', { threadId, origin: 'automatic', ...(args.objective === undefined ? {} : { objective: args.objective }), ...(args.status === undefined ? {} : { status: args.status }) })
      return { ...mirrorGoal(workspace, threadId, updated.goal), source: 'codex', atomicGoalCAS: false, concurrency: 'preflight-checked; host API has no atomic compare-and-set' }
    },
  }
}
