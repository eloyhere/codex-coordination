import { PROTOCOL_INFO, SCHEMAS } from './protocol.mjs'
import { buildStatus } from './status.mjs'
import { auditLedger } from './check.mjs'
import { peekState, resolveWorkspace } from './store.mjs'
import type { DashboardData } from '../contracts.mjs'
import { sessionSnapshot } from '../codex/snapshot.mjs'

export const DASHBOARD_URI = 'ui://codex-coordination/dashboard'
export function protocolInfo() {
  return { package: PROTOCOL_INFO.package as string, version: PROTOCOL_INFO.version as string, wireVersion: '0.1', supportedKinds: Object.keys(SCHEMAS) }
}
export async function dashboardData(rawWorkspace?: unknown, threadId?: string): Promise<DashboardData> {
  const protocol = protocolInfo()
  if (rawWorkspace === undefined) return { ok: true, workspace: null, protocol }
  const workspace = resolveWorkspace(rawWorkspace)
  const state = peekState(workspace)
  return {
    ok: true, workspace, protocol,
    ampSession: sessionSnapshot(workspace, threadId),
    status: buildStatus(state, { workspace, limit: 50 }),
    audit: auditLedger(state),
    records: state.journal.filter((entry: any) => entry.kind === 'frame' || entry.kind === 'receipt').slice(-50).reverse(),
  }
}
