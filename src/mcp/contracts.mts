/** Typed data exchanged between the local MCP server and the React app. */
export const SETTINGS_INTERFACES = [
  { name: 'coordination_registry', label: '注册中心' },
  { name: 'coordination_environment', label: '环境' },
  { name: 'coordination_connections', label: '连接' },
  { name: 'coordination_keys', label: '密钥' },
] as const
export interface SettingsView {
  ok: true
  view: 'settings'
  workspace: string | null
  interfaces: { name: string; label: string; inputSchema: Record<string, unknown> }[]
}
export interface GoalSummary {
  id: string
  statement: string
  state: string
  priority: number
}
export interface PlanSummary {
  id: string
  goal?: string
  status: string
  tasks: number
  done: number
  ready: number
  blocked: number
}
export interface DutySummary {
  id: string
  role: string
  owner: string
  assignee: string
  status: string
}
export interface StatusView {
  ok: true
  amp: string
  workspace: string
  ledger: { path: string; agent: string; tip: string; count: number; verified: boolean }
  counts: { goals: number; plans: number; duties: number }
  goals: GoalSummary[]
  plans: PlanSummary[]
  duties: DutySummary[]
  waitingOnPeople: { duty: string; waitingOn: string; action: string }[]
  readyTasks: { plan: string; task: string; intent: string }[]
  nextSteps: string[]
  openViolations: number
  warnings: number
}
export interface AuditView {
  ok: boolean
  violations: { code: string; id: string; message: string }[]
  warnings: { code: string; id: string; message: string }[]
}
export interface ProtocolRecord {
  seq: number
  kind: string
  hash: string
  payload: Record<string, unknown>
}
export interface DashboardData {
  ampSession?: { sessions: { threadId: string; sessionId: string }[]; selected: { threadId: string; sessionId: string } | null; modules: { module: string; tier: string }[]; groups: Record<string, { scope: string; records: unknown[]; total: number }>; limitations: string[]; observedAt: string } | null
  ok: true
  workspace: string | null
  protocol: { package: string; version: string; wireVersion: string; supportedKinds: string[] }
  status?: StatusView
  audit?: AuditView
  records?: ProtocolRecord[]
}
export interface ToolResponse {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: { type: string; text?: string }[]
}
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResponse>

export function toolValue(result: ToolResponse): Record<string, unknown> {
  const text = result.content?.find(item => item.type === 'text')?.text
  const value: unknown = result.structuredContent ?? (text ? JSON.parse(text) : {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器返回了无效数据')
  const record = value as Record<string, unknown>
  if (result.isError || record.ok === false) {
    const error = record.error as { message?: string } | undefined
    throw new Error(error?.message ?? '请求未通过，请检查输入或台账')
  }
  return record
}
