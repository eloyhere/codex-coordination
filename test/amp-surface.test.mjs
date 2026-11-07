import test from 'node:test'
import assert from 'node:assert/strict'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'

const tools = withAmpSurface([{ name: 'coordination_goal', description: 'Track goals and acceptance evidence', inputSchema: { type: 'object' }, async handler() { return {} } }])
test('AMP gateway discovers executable host contracts and reports unavailable providers', async () => {
  const discovery = tools.find(tool => tool.name === 'attention_manifest_protocol_discover')
  const result = await discovery.handler({ query: 'goal', sources: ['host_modules'], limit: 50, maxPerModule: 50 })
  assert.ok(result.returned >= 1)
  assert.equal(result.authorization, 'not_granted')
  assert.ok(JSON.stringify(result.tree).includes('attention_manifest_protocol_goal.get'))
  const unavailable = await discovery.handler({ query: 'goal', sources: ['session_files'] })
  assert.ok(unavailable.unavailableSources.includes('session_files'))
})
test('AMP gateway rejects model supplied identity including nested fields', async () => {
  const discovery = tools.find(tool => tool.name === 'attention_manifest_protocol_discover')
  await assert.rejects(discovery.handler({ query: 'goal', sessionId: 'spoof' }))
  await assert.rejects(discovery.handler({ query: 'goal', nested: { principalId: 'spoof' } }))
})
test('AMP surface inventory does not expose host or hidden verbs as executable tools', async () => {
  const result = await tools.find(tool => tool.name === 'attention_manifest_protocol_surface').handler({})
  assert.ok(result.modules.length > 20)
  assert.ok(result.modules.some(module => module.tier === 'hidden'))
  const standardNames = result.modules.flatMap(module => module.exposed.map(verb => 'attention_manifest_protocol_' + module.module + '.' + verb.verb))
  const registered = new Set(tools.map(tool => tool.name))
  const missing = standardNames.filter(name => !registered.has(name))
  assert.deepEqual(missing.sort(), ['current', 'respond', 'clarify', 'report'].map(verb => 'attention_manifest_protocol_turn.' + verb).sort())
  for (const module of result.modules.filter(module => module.tier !== 'agent')) assert.equal(tools.some(tool => tool.name.startsWith('attention_manifest_protocol_' + module.module + '.')), false)
})

