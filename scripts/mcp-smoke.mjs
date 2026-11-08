#!/usr/bin/env node
/**
 * End-to-end smoke test of the MCP server over a real stdio pipe.
 *
 * The unit tests exercise the ledger in-process; this script exercises the part
 * only the wire can prove: that Codex can start the server, negotiate a protocol
 * version, list the tools, call them, and read results back. It also tampers with
 * one chain payload to prove the audit notices and refuses to export a snapshot.
 *
 * Usage: node scripts/mcp-smoke.mjs [--verbose]
 *
 * @module codex-coordination/scripts/mcp-smoke
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readState, verifyChain, verifySnapshot } from '../plugins/codex-coordination/mcp/lib/store.mjs'
import { AMP_DEFINITIONS } from '../plugins/codex-coordination/mcp/amp/host.mjs'
import { COORDINATION_CATALOG } from '../plugins/codex-coordination/mcp/coordination/tools.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverOption = process.argv.indexOf('--server')
const SERVER = serverOption === -1 ? join(ROOT, 'plugins', 'codex-coordination', 'mcp', 'server.mjs') : resolve(process.argv[serverOption + 1])
const VERBOSE = process.argv.includes('--verbose')

/** @type {string[]} */
const failures = []
let checks = 0

/**
 * Record one assertion.
 * @param {boolean} condition - whether the assertion holds.
 * @param {string} message - printed on failure.
 * @returns {void}
 */
function assert(condition, message) {
  checks += 1
  if (!condition) failures.push(message)
}

/**
 * Record a deep equality assertion.
 * @param {unknown} actual - observed value.
 * @param {unknown} expected - expected value.
 * @param {string} message - printed on failure.
 * @returns {void}
 */
function assertEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

/**
 * Minimal line-delimited JSON-RPC client.
 */
class Wire {
  /**
   * @param {import('node:child_process').ChildProcessWithoutNullStreams} child - the server process.
   */
  constructor(child) {
    this.child = child
    this.buffer = ''
    this.nextId = 1
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      if (VERBOSE) process.stderr.write(chunk)
    })
  }

  /** @param {string} chunk - stdout text. */
  onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length === 0) continue
      if (VERBOSE) console.error(`<- ${line}`)
      /** @type {any} */
      let message
      try {
        message = JSON.parse(line)
      } catch {
        failures.push(`server wrote a non-JSON line: ${line.slice(0, 120)}`)
        continue
      }
      if (typeof message.id !== 'number' || !this.pending.has(message.id)) continue
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  }

  /**
   * Send a request and await its response.
   * @param {string} method - JSON-RPC method.
   * @param {unknown} [params] - parameters.
   * @param {number} [timeoutMs] - per-request deadline.
   * @returns {Promise<any>} the response envelope.
   */
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    if (VERBOSE) console.error(`-> ${payload}`)
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      this.child.stdin.write(`${payload}\n`)
    })
  }

  /**
   * Send a notification (no response expected).
   * @param {string} method - JSON-RPC method.
   * @param {unknown} [params] - parameters.
   * @returns {void}
   */
  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
  }

  /** Terminate the server process. */
  close() {
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

/**
 * Read one structured tool result.
 * @param {any} response - JSON-RPC response.
 * @returns {{ value: any, isError: boolean, text: string }} parsed result.
 */
function toolResult(response) {
  const result = response.result ?? {}
  const text = result.content?.[0]?.text ?? ''
  /** @type {any} */
  let value = null
  try {
    value = JSON.parse(text)
  } catch {
    value = null
  }
  return { value, isError: result.isError === true, text }
}

/**
 * Call one tool and return its parsed result.
 * @param {Wire} wire - the client.
 * @param {string} name - tool name.
 * @param {Record<string, unknown>} args - tool arguments.
 * @returns {Promise<{ value: any, isError: boolean, text: string }>} parsed result.
 */
function call(wire, name, args) {
  return wire.request('tools/call', { name, arguments: args }).then((response) => toolResult(response))
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-coordination-smoke-'))
  writeFileSync(join(workspace, 'probe.ampx'), 'focus attention')
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT, env: { ...process.env, CODEX_AMP_DATABASE: join(workspace, '.codex-coordination', 'amp.sqlite') } })
  const wire = new Wire(child)
  try {
    const initialize = await wire.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
    })
    assertEqual(initialize.result?.protocolVersion, '2025-06-18', 'initialize echoes a supported protocol version')
    assertEqual(initialize.result?.serverInfo?.name, 'codex-coordination', 'initialize advertises the server name')
    assertEqual(initialize.result?.serverInfo?.version, '0.6.3', 'initialize advertises the AMP-aware version')
    assertEqual(initialize.result?.capabilities?.tools !== undefined, true, 'initialize advertises the tools capability')
    assert(typeof initialize.result?.instructions === 'string' && initialize.result.instructions.includes('workspace'), 'initialize explains the workspace requirement')
    wire.notify('notifications/initialized')

    const ping = await wire.request('ping')
    assertEqual(ping.result, {}, 'ping answers an empty result')

    const list = await wire.request('tools/list')
    const tools = list.result?.tools ?? []
    assertEqual(tools.length, 165, 'coordination and canonical AMP tools are registered')
    assertEqual(tools.map((tool) => tool.name).sort(), [...new Set([
      'coordination_check',
      'coordination_dashboard',
      'coordination_goal',
      'coordination_handoff',
      'coordination_plan',
      'coordination_protocol',
      'coordination_status',
      'coordination_workspace',
      'coordination_registry',
      'coordination_context',
      'coordination_amp',
      'coordination_artifacts',
      'coordination_keys',
      'coordination_connections',
      'coordination_hooks',
      'coordination_runtime',
      'attention_manifest_protocol_discover',
      'attention_manifest_protocol_surface',
      'attention_manifest_protocol_goal.get', 'attention_manifest_protocol_goal.list',
      'attention_manifest_protocol_plan.get', 'attention_manifest_protocol_plan.list',
      'attention_manifest_protocol_workspace.list', 'attention_manifest_protocol_workspace.read', 'attention_manifest_protocol_workspace.outline',
      'attention_manifest_protocol_execution.inspect_tool', 'attention_manifest_protocol_execution.find_tools',
      'attention_manifest_protocol_plan.propose_draft', 'attention_manifest_protocol_intent.submit_clarification',
      'attention_manifest_protocol_goal.submit_evidence', 'attention_manifest_protocol_attention.request_focus',
      'attention_manifest_protocol_submissions',
      'attention_manifest_protocol_migration',
      'attention_manifest_protocol_workflow_scope', 'attention_manifest_protocol_mission.get',
      'attention_manifest_protocol_workflow_bootstrap',
      'attention_manifest_protocol_workflow_review', 'attention_manifest_protocol_workflow_cancel_review', 'attention_manifest_protocol_workflow_acceptance_review', 'attention_manifest_protocol_governance', 'attention_manifest_protocol_governance_review', 'attention_manifest_protocol_project_views', 'attention_manifest_protocol_project_review', 'attention_manifest_protocol_workflow_reconciliation_review', 'attention_manifest_protocol_evidence_lifecycle_review', 'attention_manifest_protocol_receipt_evaluation',
      'attention_manifest_protocol_execution.run', 'attention_manifest_protocol_execution.read_handle', 'attention_manifest_protocol_budget.remaining',
      'attention_manifest_protocol_evidence.get', 'attention_manifest_protocol_evidence.list', 'attention_manifest_protocol_evidence.cite', 'attention_manifest_protocol_evidence_review',
      'attention_manifest_protocol_workspace.document_outline', 'attention_manifest_protocol_workspace.diff',
      'attention_manifest_protocol_codex_sync',
      'attention_manifest_protocol_session.get', 'attention_manifest_protocol_session.list', 'attention_manifest_protocol_session.report_status',
      'attention_manifest_protocol_workspace.write', 'attention_manifest_protocol_replace',
      'attention_manifest_protocol_cooperation.inbox', 'attention_manifest_protocol_cooperation.send', 'attention_manifest_protocol_cooperation.report_result',
      'attention_manifest_protocol_cooperation_review', 'attention_manifest_protocol_submission_review',
      'attention_manifest_protocol_task.report_progress',
      'attention_manifest_protocol_attention.get', 'attention_manifest_protocol_attention.context', 'attention_manifest_protocol_attention_schedule',
      'attention_manifest_protocol_intent.get', 'attention_manifest_protocol_intent.list',
      'attention_manifest_protocol_task.get', 'attention_manifest_protocol_task.list_ready',
      'attention_manifest_protocol_action.get', 'attention_manifest_protocol_action.list',
      'attention_manifest_protocol_plan.ready_tasks',
      'attention_manifest_protocol_project.rules', 'attention_manifest_protocol_project.metadata',
      'attention_manifest_protocol_project.environment', 'attention_manifest_protocol_project.describe_environment',
      'attention_manifest_protocol_project.configure_environment', 'attention_manifest_protocol_project.put_rule',
      ...AMP_DEFINITIONS.map(tool => tool.name),
      ...COORDINATION_CATALOG.map(tool => tool.name), 'coordination_project',
    ])].sort(), 'all documented tool names are exposed')
    for (const tool of tools) {
      assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} has a description`)
      if (['coordination_check', 'coordination_handoff', 'coordination_protocol', 'coordination_status'].includes(tool.name)) assertEqual(tool.inputSchema?.required?.includes('workspace'), true, `${tool.name} requires workspace`)
      assertEqual(tool.inputSchema?.type, 'object', `${tool.name} declares an object schema`)
      const original = AMP_DEFINITIONS.find(definition => definition.name === tool.name)
      if (original) assertEqual(tool.inputSchema, original.inputSchema, `${tool.name} preserves the upstream schema`)
    }

    const dashboardTool = tools.find(tool => tool.name === 'coordination_dashboard')
    assertEqual(dashboardTool?._meta?.ui?.resourceUri, 'ui://codex-coordination/dashboard', 'dashboard links to its MCP App')
    const resourceList = await wire.request('resources/list')
    assertEqual(resourceList.result?.resources?.length, 1, 'the UI resource is discoverable')
    const resource = await wire.request('resources/read', { uri: 'ui://codex-coordination/dashboard' })
    assertEqual(resource.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app', 'dashboard uses the MCP Apps MIME type')
    assert(resource.result?.contents?.[0]?.text?.includes('<div id="root">'), 'dashboard resource includes the React root')
    const unknownResource = await wire.request('resources/read', { uri: 'ui://unknown' })
    assertEqual(unknownResource.error?.code, -32002, 'unknown UI resources are refused')
    const emptyDashboard = await call(wire, 'coordination_dashboard', {})
    assertEqual(emptyDashboard.value?.workspace, null, 'thread entrypoint accepts empty arguments')
    const protocolWorkspace = join(workspace, 'protocol-probe')
    mkdirSync(protocolWorkspace)
    const protocol = await call(wire, 'coordination_protocol', { workspace: protocolWorkspace, action: 'describe' })
    assertEqual(protocol.value?.protocol?.version, '0.6.3', 'protocol reports the npm package version')
    const selected = await call(wire, 'coordination_workspace', { workspace })
    assertEqual(selected.isError, false, 'a real host workspace/session is selected')
    assertEqual('token' in selected.value, false, 'host session credentials stay off the wire')
    const nativeCapabilities = await call(wire, 'amp_tool_workspace_capabilities', {})
    assertEqual(nativeCapabilities.value?.ok, true, 'the canonical workspace service is operational')
    const exact = await call(wire, 'coordination_context', { action: 'search', query: 'coordination_project' })
    assertEqual(exact.value?.hits?.[0]?.id, 'coordination_project', 'exact tool lookup finds the named agent entrypoint')
    const missionList = await call(wire, 'coordination_mission', { action: 'list' })
    assertEqual(missionList.isError, false, 'copied mission tool runs through MCP')
    const copiedGoalList = await call(wire, 'coordination_goal', { action: 'list' })
    assertEqual(copiedGoalList.isError, false, 'goal tool accepts the copied workspace-bound interface')
    const copiedRead = await call(wire, 'coordination_read', { path: 'probe.ampx', mode: 'lines', start: 1, maxLines: 1 })
    assertEqual(copiedRead.value?.content, 'focus attention', 'copied reader returns actual file content')
    const copiedKnowledge = await call(wire, 'coordination_knowledge', { action: 'list' })
    assertEqual(copiedKnowledge.isError, false, 'knowledge tool is operational')
    const tree = await call(wire, 'amp_tool_workspace_tree', { revision: nativeCapabilities.value.revision, parentId: 'project:.' })
    const target = tree.value.data.items.find(item => item.label === 'probe.ampx')
    const quick = await call(wire, 'coordination_context', { action: 'read', targets: [target.id], maxLines: 1, budgetTokens: 2000 })
    assertEqual(quick.value?.ok, true, 'quick reader performs the native lifecycle')
    assertEqual(quick.value?.archive?.settled, true, 'quick reader archives its context')
    const pending = await call(wire, 'coordination_context', { action: 'pending' })
    assertEqual(pending.value?.pending?.length, 0, 'quick reader leaves no pending context')
    const expanded = await call(wire, 'coordination_context', { action: 'detail', id: quick.value.archive.id })
    assertEqual(expanded.value?.result?.reads?.[0]?.data?.text, 'focus attention', 'full native result can be expanded by archive reference')
    const language = await call(wire, 'coordination_registry', { registry: 'languages', action: 'register', id: 'custom', value: { family: 'code', extensions: ['ampx'], keywords: ['focus'] }, expectedVersion: 0 })
    assertEqual(language.value?.version, 1, 'native registry edits have a durable version')
    const syntax = await call(wire, 'amp_tool_filesystem_ast', { path: 'probe.ampx' })
    assertEqual(syntax.value?.data?.language, 'custom', 'registry edits affect the actual filesystem parser')
    const computed = await call(wire, 'coordination_amp', { action: 'call', module: 'semantic', name: 'sha256Hex', arguments: ['probe'] })
    assertEqual(/^[0-9a-f]{64}$/.test(computed.value?.result), true, 'the published algorithm runs through the real MCP gateway')
    const structured = await call(wire, 'coordination_amp', { action: 'call', module: 'semantic', name: 'canonicalJson', arguments: [{ count: 42, enabled: true, tags: ['x', 3] }] })
    assertEqual(structured.isError, false, 'the gateway accepts structured positional JSON arguments')
    assertEqual(structured.value?.result, JSON.stringify({ count: 42, enabled: true, tags: ['x', 3] }), 'native canonical JSON retains numeric, boolean and nested array values')
    const invalidNativeArgs = await call(wire, 'amp_tool_filesystem_read', { path: 'probe.ampx', sessionId: 'forged' })
    assertEqual(invalidNativeArgs.isError, true, 'tool schemas reject forged credentials before dispatch')
    const receipt = await call(wire, 'coordination_protocol', { workspace: protocolWorkspace, action: 'record', artifact: { amp: '0.1', kind: 'receipt', id: 'wire-read', op: 'read', at: '2026-11-03T00:00:00Z', usage: {}, outcome: 'success' } })
    assertEqual(receipt.isError, false, 'an AMP receipt is recorded through the real wire')
    const dashboard = await call(wire, 'coordination_dashboard', { workspace: protocolWorkspace })
    assertEqual(dashboard.value?.records?.[0]?.payload?.id, 'wire-read', 'dashboard reads the recorded receipt')

    const status = await call(wire, 'coordination_status', { workspace })
    assertEqual(status.isError, false, 'status call succeeds')
    assertEqual(status.value?.counts?.goals, 0, 'a fresh workspace has no goals')
    assertEqual(status.value?.amp, '0.1', 'status names the AMP wire version')
    assertEqual(status.value?.ledger?.verified, true, 'an empty chain verifies')

    const created = await call(wire, 'coordination_goal', {
      workspace,
      action: 'create',
      goal: {
        amp: '0.1',
        kind: 'goal',
        id: 'smoke-goal',
        statement: 'Prove the MCP server works end to end',
        success: [{ id: 'handshake', statement: 'tools call round-trips', check: 'read this result' }],
        value: 0.5,
        priority: 1,
      },
    })
    assertEqual(created.isError, false, 'goal create succeeds')
    assertEqual(created.value?.goal?.kind, 'goal', 'the result carries the AMP Goal artifact')
    assertEqual(created.value?.lifecycle?.state, 'proposed', 'a new goal starts proposed')

    const badGoal = await call(wire, 'coordination_goal', {
      workspace,
      action: 'create',
      goal: { id: 'Bad Id', statement: 'x', success: [], value: 2 },
    })
    assertEqual(badGoal.isError, true, 'an invalid goal is rejected')
    assertEqual(badGoal.value?.error?.code, 'INVALID_ARGUMENT', 'the rejection carries a typed code')

    const plan = await call(wire, 'coordination_plan', {
      workspace,
      action: 'create',
      plan: {
        id: 'smoke-plan',
        goal: { kind: 'goal', id: 'smoke-goal' },
        commitment_window: 2,
        abandon_if: [{ id: 'stop', statement: 'the server stops answering', check: 'ping it' }],
        tasks: [{
          id: 'call-tools',
          intent: 'Call every tool once',
          actor: 'tool',
          expect: { observation: 'each call answers', check: 'read every result' },
        }],
      },
    })
    assertEqual(plan.isError, false, 'plan create succeeds')
    assertEqual(plan.value?.plan?.kind, 'plan', 'the result carries the AMP Plan artifact')
    assertEqual(plan.value?.plan?.status, 'draft', 'a new plan is a draft')
    assertEqual(plan.value?.plan?.commitment_window, 2, 'commitment_window is an AMP field')

    const camelPlan = await call(wire, 'coordination_plan', {
      workspace,
      action: 'create',
      plan: {
        id: 'camel-plan',
        goal: { kind: 'goal', id: 'smoke-goal' },
        commitmentWindow: 2,
        abandon_if: [{ id: 'stop', statement: 'x', check: 'y' }],
        tasks: [{
          id: 'only',
          intent: 'work',
          actor: 'self',
          expect: { observation: 'x', check: 'y' },
        }],
      },
    })
    assertEqual(camelPlan.isError, true, 'a camelCase AMP field is rejected rather than renamed')
    assert(String(camelPlan.value?.error?.message ?? '').includes('commitment_window'), 'the rejection names the AMP spelling')

    const missingWorkspace = await call(wire, 'coordination_status', {})
    assertEqual(missingWorkspace.isError, true, 'a call without workspace is rejected')
    assert(String(missingWorkspace.value?.error?.message ?? '').includes('workspace'), 'the rejection names the missing field')

    const unknownTool = await call(wire, 'coordination_nope', { workspace })
    assertEqual(unknownTool.isError, true, 'an unknown tool is an error result')

    const unknownMethod = await wire.request('no/such/method', {})
    assertEqual(unknownMethod.error?.code, -32601, 'an unknown method is a JSON-RPC method-not-found')

    const audit = await call(wire, 'coordination_check', { workspace })
    assertEqual(audit.isError, false, 'check succeeds')
    assertEqual(audit.value?.ok, true, 'a freshly written ledger audits clean')
    assertEqual(audit.value?.summary?.chain?.verified, true, 'the audit reports a verified chain')
    assertEqual(audit.value?.journal?.[0]?.kind, 'goal', 'the journal page carries AMP entry kinds')

    const snapshotResult = await call(wire, 'coordination_check', { workspace, action: 'snapshot' })
    assertEqual(snapshotResult.isError, false, 'snapshot export succeeds')
    const snapshot = snapshotResult.value?.snapshot
    assertEqual(snapshot?.kind, 'ledger-snapshot', 'the snapshot carries the AMP kind')
    assertEqual(snapshot?.amp, '0.1', 'the snapshot carries the AMP wire version')
    assertEqual(verifySnapshot(snapshot).ok, true, 'the exported snapshot verifies')
    assertEqual(snapshot?.entries?.[0]?.seq, 0, 'the first entry is seq 0')
    assertEqual(snapshot?.entries?.[0]?.prev, `sha256:${'0'.repeat(64)}`, 'the first entry links to genesis')

    const document = readState(workspace)
    assertEqual(verifyChain(document).ok, true, 'the chain verifies')
    assertEqual(document.count, 2, 'two mutations recorded two chain entries')

    // Tamper with one payload: the audit must notice and the snapshot must be refused.
    const path = join(workspace, '.codex-coordination', 'ledger.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.journal[0].payload.statement = 'a different outcome'
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    const tampered = await call(wire, 'coordination_check', { workspace })
    assertEqual(tampered.value?.ok, false, 'a tampered chain is reported as failing')
    assertEqual(
      (tampered.value?.violations ?? []).some((violation) => violation.code === 'LEDGER_CHAIN'),
      true,
      'the violation names the broken chain',
    )
    const refused = await call(wire, 'coordination_check', { workspace, action: 'snapshot' })
    assertEqual(refused.isError, true, 'a broken chain refuses to export a snapshot')
    assertEqual(refused.value?.error?.code, 'INVALID_STATE', 'the refusal carries a typed code')
  } finally {
    wire.close()
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise()
      const timer = setTimeout(resolvePromise, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
    rmSync(workspace, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`)
    if (wire.stderr.trim().length > 0) console.error(`\nserver stderr:\n${wire.stderr}`)
    process.exit(1)
  }
  console.log(`ok mcp smoke: ${checks} checks passed`)
}

main().catch((error) => {
  console.error(`FAIL smoke run crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
