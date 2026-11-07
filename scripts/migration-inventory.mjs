#!/usr/bin/env node
/** Audit the actual built tool registry, current protocol surface and legacy consumers. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// Load the bundled host before upstream metadata: legacy schema initialization
// must finish before the native dependency's prototype hardening runs.
const { TOOLS } = await import('../plugins/codex-coordination/mcp/lib/tools.mjs')
const { SURFACE_MODULES } = await import('attention-manifest-protocol/agent')
const packageRoot = dirname(fileURLToPath(import.meta.resolve('attention-manifest-protocol/package.json')))
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const registered = new Set(TOOLS.map(tool => tool.name))
const native = new Set(['project'])
const nativeSessions = new Set(['session.get', 'session.list', 'session.report_status'])
native.add('evidence')
native.add('workspace')
native.add('cooperation')
const workflowReads = new Set(['goal.get', 'goal.list', 'plan.get', 'plan.list', 'plan.ready_tasks', 'mission.get', 'intent.get', 'intent.list', 'task.get', 'task.list_ready', 'action.get', 'action.list'])
workflowReads.add('plan.propose_draft')
workflowReads.add('task.report_progress')
workflowReads.add('attention.get')
workflowReads.add('attention.context')
for (const key of ['execution.find_tools', 'execution.inspect_tool', 'execution.run', 'execution.read_handle', 'budget.remaining']) workflowReads.add(key)
const pending = new Set(['intent.submit_clarification', 'goal.submit_evidence', 'attention.request_focus'])
const modules = SURFACE_MODULES.map(module => ({ module: module.module, tier: module.tier,
  verbs: module.exposed.map(verb => {
    const key = module.module + '.' + verb.verb
    const name = 'attention_manifest_protocol_' + key
    return { name, mutating: verb.mutating, status: !registered.has(name) ? 'unbound' : native.has(module.module) || workflowReads.has(key) || nativeSessions.has(key) ? 'native' : pending.has(key) ? 'durable-submission' : 'compatibility-port',
      ...(!registered.has(name) ? { remaining: ['session', 'turn'].includes(module.module) ? 'Bind an actual scoped host lifecycle port; plugin session identity is not Codex session state.' : 'Implement and validate the native domain port, state mapping and authorization before registration.' } : {}) }
  }), withheld: module.withheld,
}))
const consumers = []
for (const base of ['src', 'vendor/coordination-runtime', 'scripts', 'test']) {
  for (const name of readdirSync(join(root, base), { recursive: true })) {
    if (!/\.(?:mts|mjs|ts)$/.test(name)) continue
    const path = join(root, base, name)
    const text = readFileSync(path, 'utf8')
    const imports = [...new Set([...text.matchAll(/(?:['"`])(amp-legacy(?:\/[^'"`\s]+)?)(?:['"`])/g)].map(match => match[1]))].sort()
    if (imports.length) consumers.push({ path: relative(root, path).replaceAll('\\', '/'), imports })
  }
}
const verbs = modules.flatMap(module => module.verbs)
const summary = Object.fromEntries(['native', 'durable-submission', 'compatibility-port', 'unbound'].map(status => [status, verbs.filter(verb => verb.status === status).length]))
const result = { protocol: pkg.version, tools: TOOLS.length, summary, modules, legacyConsumers: consumers }
writeFileSync(join(root, 'docs/AMP-MIGRATION-INVENTORY.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ protocol: pkg.version, tools: TOOLS.length, ...summary, legacyFiles: consumers.length }))
