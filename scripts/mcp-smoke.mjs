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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readState, verifyChain, verifySnapshot } from '../plugins/codex-coordination/mcp/lib/store.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'plugins', 'codex-coordination', 'mcp', 'server.mjs')
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
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT })
  const wire = new Wire(child)
  try {
    const initialize = await wire.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
    })
    assertEqual(initialize.result?.protocolVersion, '2025-06-18', 'initialize echoes a supported protocol version')
    assertEqual(initialize.result?.serverInfo?.name, 'codex-coordination', 'initialize advertises the server name')
    assertEqual(initialize.result?.serverInfo?.version, '0.2.0', 'initialize advertises the AMP-aware version')
    assertEqual(initialize.result?.capabilities?.tools !== undefined, true, 'initialize advertises the tools capability')
    assert(typeof initialize.result?.instructions === 'string' && initialize.result.instructions.includes('workspace'), 'initialize explains the workspace requirement')
    wire.notify('notifications/initialized')

    const ping = await wire.request('ping')
    assertEqual(ping.result, {}, 'ping answers an empty result')

    const list = await wire.request('tools/list')
    const tools = list.result?.tools ?? []
    assertEqual(tools.length, 5, 'five tools are registered')
    assertEqual(tools.map((tool) => tool.name).sort(), [
      'coordination_check',
      'coordination_goal',
      'coordination_handoff',
      'coordination_plan',
      'coordination_status',
    ], 'tool names are the documented five')
    for (const tool of tools) {
      assert(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} has a substantive description`)
      assertEqual(tool.inputSchema?.required?.includes('workspace'), true, `${tool.name} requires workspace`)
      assertEqual(tool.inputSchema?.type, 'object', `${tool.name} declares an object schema`)
    }

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
