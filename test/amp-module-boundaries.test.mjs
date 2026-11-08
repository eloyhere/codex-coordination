/**
 * Intentional AMP module boundaries: what the model-facing surface declares,
 * what it registers, and what it deliberately withholds.
 *
 * These are contract assertions only. Behavioral coverage stays in
 * amp-attention-schedule.test.mjs, amp-cooperation.test.mjs and
 * amp-execution-boundary.test.mjs; this file pins the shape that keeps Turn
 * unbound, the attention scheduler a host extension, cooperation local-only,
 * native I/O budget separate from Codex tokens, and attempt/verifier verbs out
 * of the registered tool list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { cooperationBindings } from '../plugins/codex-coordination/mcp/amp/cooperation.mjs'
import { executionBindings } from '../plugins/codex-coordination/mcp/amp/execution.mjs'
import { makeWorkspace } from './helpers.mjs'

const PREFIX = 'attention_manifest_protocol_'
const TURN_PREFIX = PREFIX + 'turn.'
const TURN_UNDERSCORE_PREFIX = PREFIX + 'turn_'
const TURN_VERBS = ['current', 'respond', 'clarify', 'report']
const TURN_NAMES = TURN_VERBS.map(verb => TURN_PREFIX + verb)
const SCHEDULE = PREFIX + 'attention_schedule'
const BINDING = Object.freeze({ tenantId: 'local', principalId: 'codex', sessionId: 'module-boundaries', policyVersion: 'test/1', cancellationEpoch: 0 })

/** Build the real plugin surface; no legacy tools are needed to inspect AMP contracts. */
const buildSurface = () => withAmpSurface([])
const toolNamed = (tools, name) => tools.find(tool => tool.name === name)
const callTool = (tools, name, args = {}) => toolNamed(tools, name).handler(args)
const isTurnName = name => name.startsWith(TURN_PREFIX) || name.startsWith(TURN_UNDERSCORE_PREFIX)

/** Collect every discovery leaf name, in tree order. */
function leafNames(node, names = []) {
  if (node.kind === 'tool') names.push(node.name)
  for (const child of node.children ?? []) leafNames(child, names)
  return names
}

test('turn stays unbound: declared by the canonical inventory, missing from registration and discovery', async () => {
  const tools = buildSurface()
  assert.deepEqual(tools.map(tool => tool.name).filter(isTurnName), [], 'no registered tool may be a Turn contract')

  const surface = await callTool(tools, PREFIX + 'surface')
  const turn = surface.modules.find(module => module.module === 'turn')
  assert.ok(turn, 'the surface still declares the turn module')
  assert.equal(turn.tier, 'agent')
  assert.deepEqual(turn.exposed.map(item => item.verb).sort(), [...TURN_VERBS].sort(), 'the four turn verbs remain declared contracts')

  const standardNames = surface.modules.flatMap(module => module.exposed.map(item => PREFIX + module.module + '.' + item.verb))
  const missing = standardNames.filter(name => !surface.registered.includes(name))
  assert.deepEqual(missing.sort(), [...TURN_NAMES].sort(), 'the registered/missing split leaves exactly the Turn verbs unbound')
  assert.ok(surface.registered.includes(SCHEDULE), 'the host extension is registered next to the canonical contracts')
  assert.equal(surface.registered.filter(isTurnName).length, 0, 'surface.registered never lists a Turn tool')

  const discovery = await callTool(tools, PREFIX + 'discover', { query: 'turn respond clarify report', sources: ['amp'], limit: 50, maxPerModule: 50 })
  assert.deepEqual(discovery.sources, ['amp'])
  assert.ok(discovery.considered > 0, 'the amp source inspected canonical contracts')
  assert.ok(discovery.returned >= 1, 'the query matches other canonical contracts, so the Turn absence is not vacuous')
  const names = leafNames(discovery.tree)
  assert.equal(names.length, discovery.returned)
  assert.deepEqual(names.filter(isTurnName), [], 'discovery never returns attention_manifest_protocol_turn.*')
})

test('attention scheduler is a read-only host extension outside the canonical tier table', async () => {
  const tools = buildSurface()
  const schedule = toolNamed(tools, SCHEDULE)
  assert.ok(schedule, 'attention_manifest_protocol_attention_schedule is registered')
  assert.equal(schedule.annotations?.readOnlyHint, true, 'the routing preview is annotated read-only')
  assert.equal(schedule.inputSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(schedule.inputSchema.properties).sort(), ['maxBytes', 'maxSelected', 'stage'], 'the schema exposes preview bounds only, no mutation knobs')
  assert.match(schedule.description, /^Host extension, not canonical AMP\./)
  assert.match(schedule.description, /read-only/i)
  assert.match(schedule.description, /never mounts/)

  const surface = await callTool(tools, PREFIX + 'surface')
  assert.equal(surface.modules.some(module => module.module === 'attention_schedule'), false, 'there is no canonical attention_schedule module')
  const canonicalNames = surface.modules.flatMap(module => module.exposed.map(item => PREFIX + module.module + '.' + item.verb))
  assert.equal(canonicalNames.includes(SCHEDULE), false, 'the extension is not an exposed canonical verb')
  assert.ok(surface.registered.includes(SCHEDULE), 'surface.registered still reports the extension')
  const attention = surface.modules.find(module => module.module === 'attention')
  assert.deepEqual(attention.exposed.map(item => item.verb).sort(), ['context', 'get', 'request_focus'], 'the canonical attention module keeps only its own verbs')
})

test('cooperation tools promise a local durable queue and no remote delivery or business acceptance', () => {
  const tools = cooperationBindings(BINDING, () => undefined, () => undefined)
  for (const verb of ['inbox', 'send', 'report_result']) {
    const tool = toolNamed(tools, PREFIX + 'cooperation.' + verb)
    assert.ok(tool, 'cooperation.' + verb + ' is registered')
    assert.match(tool.description, /Native local durable queue/)
    assert.match(tool.description, /host-approved delegation/)
    assert.match(tool.description, /No remote transport/)
    assert.match(tool.description, /business verification/)
    assert.doesNotMatch(tool.description, /remote delivery|deliver(?:s|ed)? remotely/i, 'cooperation.' + verb + ' must not claim remote delivery')
    assert.doesNotMatch(tool.description, /business acceptance/i, 'cooperation.' + verb + ' must not claim business acceptance')
  }
})

test('budget.remaining reports plugin-native I/O, never Codex token usage', async t => {
  const root = makeWorkspace(t)
  const tools = executionBindings([], BINDING, () => root)
  const budget = toolNamed(tools, PREFIX + 'budget.remaining')
  assert.ok(budget, 'budget.remaining is registered')
  assert.equal(budget.annotations?.readOnlyHint, true)

  const result = await budget.handler({})
  assert.equal(result.usageScope, 'plugin-native-io')
  assert.equal(result.tokens, 0, 'tokens is a literal zero, never a Codex token counter')
  assert.equal(result.notCodexTokenUsage, true)
  assert.equal(result.quotaSource, 'host-fixed')
  assert.equal(result.configured, false, 'a fresh workspace has no configured native-read ledger')
  assert.equal(result.snapshot.limit.tokens, 0, 'the native I/O quota does not meter Codex tokens')
})

test('action reads stay registered while attempt lifecycle and verifier verbs stay out of the surface', async () => {
  const tools = buildSurface()
  const names = new Set(tools.map(tool => tool.name))
  for (const verb of ['get', 'list']) {
    const tool = toolNamed(tools, PREFIX + 'action.' + verb)
    assert.ok(tool, 'action.' + verb + ' is registered')
    assert.equal(tool.annotations?.readOnlyHint, true, 'action.' + verb + ' stays read-only')
  }

  const withheld = [PREFIX + 'action.start', PREFIX + 'action.settle', PREFIX + 'goal.achieve', PREFIX + 'task.accept']
  assert.deepEqual(withheld.filter(name => names.has(name)), [], 'no fake attempt-start, settlement or acceptance tool may be registered')

  const surface = await callTool(tools, PREFIX + 'surface')
  assert.deepEqual(withheld.filter(name => surface.registered.includes(name)), [])
  const action = surface.modules.find(module => module.module === 'action')
  assert.deepEqual(action.exposed.map(item => item.verb).sort(), ['get', 'list'], 'the action module exposes reads only')
  assert.deepEqual(action.withheld.map(item => item.verb).sort(), ['reconcile', 'settle', 'start'], 'attempt lifecycle verbs stay host withheld')
  assert.ok(surface.modules.find(module => module.module === 'goal').withheld.some(item => item.verb === 'achieve'), 'goal achievement stays host/verifier withheld')
  assert.ok(surface.modules.find(module => module.module === 'task').withheld.some(item => item.verb === 'accept'), 'task acceptance stays host/verifier withheld')
})
