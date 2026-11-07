import test from 'node:test'
import assert from 'node:assert/strict'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { makeWorkspace } from './helpers.mjs'

const tool = (tools, name) => tools.find(item => item.name === 'attention_manifest_protocol_' + name)
async function receiptsOn(t, root) {
  const tools = withAmpSurface([], () => root)
  const call = (name, args = {}) => tool(tools, name).handler(args)
  const found = await call('execution.find_tools', { query: 'project rules', limit: 20 })
  const pinned = found.tools.find(item => item.pinned.toolId === 'attention_manifest_protocol_project.rules').pinned
  const run = await call('execution.run', { idempotencyKey: 'eval-read', calls: [{ id: 'one', ...pinned, arguments: {} }] })
  assert.equal(run.execution.children[0].observation.status, 'success', JSON.stringify(run.execution))
  const evaluate = (args = {}) => call('receipt_evaluation', args)
  return { call, evaluate, run, root }
}

test('receipt evaluation aggregates only integrity-verified receipts in this connection scope', async t => {
  const { evaluate, run } = await receiptsOn(t, makeWorkspace(t))
  const result = await evaluate()
  assert.equal(result.receipts.matched, 1)
  assert.equal(result.receipts.evaluated, 1)
  assert.equal(result.receipts.invalid, 0)
  assert.equal(result.aggregate.total, 1)
  assert.equal(result.aggregate.success, 1)
  assert.equal(result.aggregate.failureRate, 0)
  const ownSession = run.receipts[0].invocation.context.sessionId
  assert.equal((await evaluate({ sessionId: ownSession })).receipts.evaluated, 1)
  assert.equal((await evaluate({ sessionId: 'foreign-session' })).receipts.matched, 0)
  assert.equal((await evaluate({ turnId: 'unobserved-turn' })).receipts.matched, 0)
  assert.equal(result.scope.tenantId, 'local')
  assert.equal(result.scope.principalId, 'codex')
  const byTool = await evaluate({ capabilityPrefix: 'attention_manifest_protocol_project.' })
  assert.equal(byTool.receipts.matched, 1)
  const none = await evaluate({ capabilityPrefix: 'attention_manifest_protocol_workspace.' })
  assert.equal(none.receipts.matched, 0)
  assert.equal(none.aggregate.total, 0)
  assert.match(String(run.receipts[0].id), /\S/)
  await assert.rejects(evaluate({ limit: 0 }), /limit must be/)
  await assert.rejects(evaluate({ unknown: true }), /Unknown receipt evaluation parameter/)
  await assert.rejects(evaluate({ turnId: '' }), /turnId/)
})

test('tampered receipts are reported and excluded instead of being aggregated', async t => {
  const root = makeWorkspace(t)
  const { evaluate } = await receiptsOn(t, root)
  const { store } = openNativeStore(() => root)
  try {
    const receipt = JSON.parse(JSON.stringify(store.list('receipt')[0]))
    receipt.observation.value = { forged: true }
    store.save('receipt', receipt)
  } finally { store.close() }
  const result = await evaluate()
  assert.equal(result.receipts.matched, 1)
  assert.equal(result.receipts.evaluated, 0)
  assert.equal(result.receipts.invalid, 1)
  assert.match(result.receipts.invalidReceipts[0].reason, /digest|integrity/i)
  assert.equal(result.aggregate.total, 0)
})

test('foreign principal, foreign session and other workspaces never enter the aggregate', async t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  const { evaluate } = await receiptsOn(t, root)
  const foreign = await receiptsOn(t, other)
  const { store } = openNativeStore(() => root)
  try {
    const source = JSON.parse(JSON.stringify(store.list('receipt')[0]))
    store.save('receipt', { ...source, id: 'receipt-foreign-principal', invocation: { ...source.invocation, context: { ...source.invocation.context, principalId: 'foreign' } } })
    store.save('receipt', { ...source, id: 'receipt-foreign-session', invocation: { ...source.invocation, context: { ...source.invocation.context, sessionId: 'someone-else' } } })
  } finally { store.close() }
  const scoped = await evaluate()
  assert.equal(scoped.receipts.matched, 1, 'only the real in-scope receipt is counted')
  assert.equal(scoped.aggregate.total, 1)
  const otherScoped = await foreign.evaluate()
  assert.equal(otherScoped.receipts.matched, 1, 'the other workspace only sees its own receipt')
  assert.notEqual(otherScoped.aggregate.total, 1 + scoped.aggregate.total)
})
