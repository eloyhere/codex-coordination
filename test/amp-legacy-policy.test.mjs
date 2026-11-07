import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'
const { wrapLegacyTools } = await import(process.env.AMP_LEGACY_POLICY_MODULE ? pathToFileURL(process.env.AMP_LEGACY_POLICY_MODULE).href : '../plugins/codex-coordination/mcp/amp/legacy-policy.mjs')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'amp-legacy-policy-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); closeHostClient(); configureHostClient({}, () => {}) })
  let workspace = root, calls = 0, requests = []
  const raw = [
    ['coordination_keys', args => { calls++; return { ok: true, result: args } }],
    ['coordination_connections', args => { calls++; return { ok: true, result: args } }],
    ['coordination_runtime', args => { calls++; return { ok: true, result: args } }],
    ['coordination_amp', args => args.action === 'resources' ? { resources: [{ id: 'policy-handle', module: 'policy' }] } : (calls++, { ok: true })],
    ['coordination_registry', args => { calls++; return { ok: true } }],
    ['amp_tool_workspace_adjust', args => { calls++; return { ok: true } }],
  ].map(([name, handler]) => ({ name, description: name, inputSchema: { type: 'object' }, async handler(args) { return handler(args) } }))
  const tools = wrapLegacyTools(raw, () => workspace)
  const call = (name, args = {}) => tools.find(tool => tool.name === name).handler(args)
  return { root, tools, call, raw, requests, get calls() { return calls }, switchTo(path) { workspace = path }, decide(decision, hook) { configureHostClient({ elicitation: {} }, message => { requests.push(message); hook?.(message); queueMicrotask(() => acceptHostResponse({ id: message.id, result: { action: 'accept', content: { decision } } })) }) } }
}

test('legacy wrappers keep reads and calculations available without host prompts', async t => {
  const f = fixture(t); configureHostClient({}, () => {})
  await f.call('coordination_keys', { action: 'list' })
  await f.call('coordination_keys', { action: 'call', module: 'manifest', operation: 'verifyManifest', arguments: [] })
  await f.call('coordination_runtime', { action: 'turns', pid: 1 })
  await f.call('coordination_amp', { action: 'call', module: 'syntax', name: 'isSupported', arguments: ['x'] })
  await f.call('coordination_registry', { action: 'list', registry: 'behaviors' })
  await f.call('coordination_connections', { action: 'list' })
  await f.call('coordination_connections', { action: 'connect', id: 'configured' })
  assert.equal(f.calls, 7)
  assert.equal(f.requests.length, 0)
})

test('exact host-owned authority requires correlated approval and denial never executes', async t => {
  const f = fixture(t); configureHostClient({}, () => {})
  await assert.rejects(f.call('coordination_keys', { action: 'generate', kid: 'new-key' }), /not granted/)
  assert.equal(f.calls, 0)
  f.decide('reject')
  await assert.rejects(f.call('coordination_runtime', { action: 'create_agent', input: { id: 'x' } }), /not granted/)
  assert.equal(f.calls, 0)
  const args = { action: 'generate', kid: 'new-key' }
  f.decide('approve', message => {
    assert.match(message.params.message, /new-key/)
    assert.equal(acceptHostResponse({ method: 'tools/call', id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }), false)
    args.kid = 'mutated-after-request'
  })
  const result = await f.call('coordination_keys', args)
  assert.equal(result.ok, true)
  assert.equal(result.result.kid, 'new-key')
  assert.equal(f.calls, 1)
  assert.equal(f.requests.at(-1).params.requestedSchema.required[0], 'decision')
})

test('runtime services and registry authority edits are reviewed but dryrun is non-executing', async t => {
  const f = fixture(t); f.decide('approve')
  await f.call('coordination_amp', { action: 'create', module: 'policy', name: 'Guard', arguments: [] })
  await f.call('coordination_amp', { action: 'invoke', resource: 'policy-handle', method: 'approve', arguments: [] })
  await f.call('coordination_amp', { action: 'service', name: 'PolicyService', method: 'upsert', arguments: [] })
  await f.call('coordination_registry', { action: 'register', registry: 'behaviors', id: 'safe', value: { template: 'baseline' } })
  const count = f.calls
  await f.call('coordination_registry', { action: 'register', registry: 'tools', id: 'dry', dryRun: true, value: { target: 'x' } })
  await f.call('amp_tool_workspace_adjust', { action: 'register', registry: 'protocols', id: 'mcp', dryRun: true })
  assert.equal(f.calls, count + 2)
  assert.equal(f.requests.length, 4)
})

test('scope switching during approval and forged approval fields do not dispatch', async t => {
  const f = fixture(t)
  f.decide('approve', () => f.switchTo(mkdtempSync(join(tmpdir(), 'amp-other-'))))
  await assert.rejects(f.call('coordination_keys', { action: 'revoke', kid: 'old', reason: 'retire' }), /Workspace changed/)
  assert.equal(f.calls, 0)
  await assert.rejects(f.call('coordination_runtime', { action: 'archive', pid: 1, approved: true }), /approval fields/)
  assert.equal(f.calls, 0)
})

test('configured endpoints do not pre-authorize signing, delegation, or listener side effects', async t => {
  const f = fixture(t); f.decide('reject')
  for (const action of ['deliver', 'delegate', 'listen', 'stop_listener', 'disconnect']) {
    await assert.rejects(f.call('coordination_connections', { action, id: 'configured', dryRun: true, message: { payload: 'sign this' } }), /not granted/)
  }
  assert.equal(f.calls, 0)
  assert.equal(f.requests.length, 5)
  for (const field of ['approved', 'hostApproved', 'approvalToken', 'approval']) {
    await assert.rejects(f.call('coordination_connections', { action: 'deliver', id: 'configured', [field]: true }), /approval fields/)
  }
  assert.equal(f.calls, 0)
})

test('connection signature review dispatches only the deeply detached approved message', async t => {
  const f = fixture(t)
  const input = { action: 'deliver', id: 'configured', message: { payload: { text: 'approved' }, recipients: ['host-peer'] } }
  f.decide('approve', message => {
    assert.match(message.params.message, /approved/)
    input.id = 'other-endpoint'; input.message.payload.text = 'unapproved'; input.message.recipients.push('outsider')
  })
  const result = await f.call('coordination_connections', input)
  assert.deepEqual(result.result, { action: 'deliver', id: 'configured', message: { payload: { text: 'approved' }, recipients: ['host-peer'] } })
  assert.equal(f.calls, 1)
})
