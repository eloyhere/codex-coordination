/** Read-only, schema-guarded fallback for hosts without a published control socket. */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexGoalRpc } from './client.mjs'

export function readPersistedCodexGoal(threadId: string, path = process.env.CODEX_AMP_GOAL_DB ?? join(homedir(), '.codex', 'goals_1.sqlite')) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(thread_goals)').all() as { name: string }[]).map(column => column.name))
    if (!['thread_id', 'goal_id', 'objective', 'status', 'token_budget', 'tokens_used', 'time_used_seconds', 'created_at_ms', 'updated_at_ms'].every(name => columns.has(name))) throw new Error('Unsupported Codex goal database schema; no fallback read performed')
    const row = db.prepare('SELECT thread_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms FROM thread_goals WHERE thread_id = ?').get(threadId) as any
    if (!row) return { goal: null, source: 'codex-readonly-goal-db' as const }
    const statuses: Record<string, string> = { active: 'active', paused: 'paused', blocked: 'blocked', usage_limited: 'usageLimited', budget_limited: 'budgetLimited', complete: 'complete' }
    if (!statuses[row.status]) throw new Error('Unsupported persisted Codex goal status')
    return { goal: { threadId: row.thread_id, objective: row.objective, status: statuses[row.status], tokenBudget: row.token_budget, tokensUsed: row.tokens_used, timeUsedSeconds: row.time_used_seconds, createdAt: Math.floor(row.created_at_ms / 1000), updatedAt: Math.floor(row.updated_at_ms / 1000) }, source: 'codex-readonly-goal-db' as const }
  } finally { db.close() }
}

export async function getCodexGoal(threadId: string) {
  try { const result = await codexGoalRpc('thread/goal/get', { threadId }); return { goal: result.goal, source: 'codex-app-server' as const } }
  catch (error: any) { if (error.code !== 'CODEX_UNAVAILABLE') throw error; return readPersistedCodexGoal(threadId) }
}
