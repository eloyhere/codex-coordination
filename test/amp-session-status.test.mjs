import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'
import { sessionBindings } from '../plugins/codex-coordination/mcp/codex/session-tools.mjs'
import { makeWorkspace } from './helpers.mjs'

const binding = { tenantId: 'local', principalId: 'codex', sessionId: 'mcp-connection', policyVersion: 'test', cancellationEpoch: 0 }

test('session.report_status persists an idempotent, unverified claim without changing session state', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'status-thread', hook_event_name: 'SessionStart' })
  const tools = sessionBindings(binding, () => root)
  const bySuffix = suffix => tools.find(tool => tool.name.endsWith(`session.${suffix}`))
  const get = bySuffix('get')
  const reportStatus = bySuffix('report_status')
  const initial = await get.handler({ threadId: 'status-thread' })
  const args = { threadId: 'status-thread', expectedVersion: initial.entity.version, status: 'Investigating failure', summary: 'Reproduced locally', idempotencyKey: 'status-1' }
  const report = await reportStatus.handler(args)
  assert.equal(report.sessionId, initial.entity.id)
  assert.equal(report.sessionVersion, initial.entity.version)
  assert.equal(report.verified, false)
  assert.equal(report.replayed, false)
  const replay = await reportStatus.handler(args)
  assert.equal(replay.id, report.id)
  assert.equal(replay.replayed, true)
  await assert.rejects(reportStatus.handler({ ...args, status: 'Different claim' }), /Idempotency key/)
  const latest = await get.handler({ threadId: 'status-thread' })
  assert.equal(latest.entity.state, initial.entity.state)
  assert.equal(latest.entity.version, initial.entity.version)
  assert.equal(latest.reportedStatus, 'Investigating failure')
  await assert.rejects(reportStatus.handler({ ...args, threadId: 'unmapped' }), /no native session mapping/)
  await assert.rejects(reportStatus.handler({ ...args, expectedVersion: initial.entity.version + 1, idempotencyKey: 'wrong-version' }), /Session version changed/)
})

test('session.report_status validates payload and separates idempotency keys by principal', async t => {
  const root = makeWorkspace(t)
  ingestHook({ cwd: root, session_id: 'status-thread', hook_event_name: 'SessionStart' })
  const initial = await sessionBindings(binding, () => root).find(tool => tool.name.endsWith('session.get')).handler({ threadId: 'status-thread' })
  const report = identity => sessionBindings(identity, () => root).find(tool => tool.name.endsWith('session.report_status'))
  const args = { threadId: 'status-thread', expectedVersion: initial.entity.version, status: 'Ready', idempotencyKey: 'same-key' }
  const first = await report(binding).handler(args)
  const second = await report({ ...binding, principalId: 'another-agent' }).handler(args)
  assert.notEqual(first.id, second.id)
  await assert.rejects(report(binding).handler({ ...args, status: 'two lines\nnot allowed', idempotencyKey: 'invalid' }), /status line/)
  await assert.rejects(report(binding).handler({ ...args, summary: 'x'.repeat(2001), idempotencyKey: 'oversized' }), /bound/)
})
