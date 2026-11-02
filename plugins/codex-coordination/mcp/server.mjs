#!/usr/bin/env node
/**
 * codex-coordination MCP server.
 *
 * A dependency-free Model Context Protocol server spoken over stdio: one JSON
 * object per line, JSON-RPC 2.0 envelopes. Codex starts it from the plugin's
 * `.mcp.json`, so the only runtime requirement is Node itself — no `npm
 * install`, no network, no build step.
 *
 * Design notes:
 *
 * - **stdout is the wire.** Nothing else may be written there: diagnostics go
 *   to stderr and are only emitted when `CODEX_COORDINATION_DEBUG` is set.
 * - **Requests are handled sequentially.** Tool calls mutate one ledger file;
 *   ordering them removes a class of interleaving bugs at no real cost, because
 *   a single Codex session issues them one at a time anyway.
 * - **The client negotiates the protocol version.** We echo a version we
 *   support and fall back to the newest one we know.
 * - **Nothing is authenticated.** The server runs as the user; `actor` values
 *   are declared identity, checked for consistency, not for authenticity.
 *
 * @module codex-coordination/server
 */

import { createInterface } from 'node:readline'

import { CoordinationError, ERROR_CODES, isRecord } from './lib/amp.mjs'
import { TOOLS, toolNamed } from './lib/tools.mjs'

/** Advertised server identity. */
const SERVER_INFO = Object.freeze({ name: 'codex-coordination', version: '0.2.0' })

/** Protocol revisions this server speaks, newest first. */
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])

/** Model-facing note attached to every session that connects. */
const INSTRUCTIONS = [
  'This server keeps a durable coordination ledger for one repository at <workspace>/.codex-coordination/ledger.json.',
  'The ledger is an AMP v0.1 append-only chain: every entry is {seq, kind, payload, prev, hash} with hash = sha256 over canonical JSON, and coordination_check action "snapshot" returns the strict ledger-snapshot artifact.',
  'Every call needs an absolute `workspace` path: the server does not guess it.',
  'Call coordination_status first, then create or advance goals, plans and handoffs. Use coordination_check before reporting that a task is finished.',
  'Goals and plans are strict AMP artifacts; a duty is a host projection recorded as events. The ledger records assertions. It does not run checks, authenticate identities or prove that evidence is true.',
].join(' ')

/** Emit one diagnostic line on stderr when debugging is enabled. */
function debug(...parts) {
  if (!process.env.CODEX_COORDINATION_DEBUG) return
  process.stderr.write(`[codex-coordination] ${parts.join(' ')}\n`)
}

/**
 * Write one protocol message.
 * @param {unknown} message - JSON-RPC envelope.
 * @returns {void}
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Build a JSON-RPC error response.
 * @param {unknown} id - request id.
 * @param {number} code - JSON-RPC error code.
 * @param {string} message - human-readable message.
 * @param {unknown} [data] - optional structured detail.
 * @returns {Record<string, unknown>} the envelope.
 */
function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/**
 * Convert one thrown value into a tool result the model can act on.
 * @param {unknown} error - the thrown value.
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }} the tool result.
 */
function toolFailure(error) {
  const known = error instanceof CoordinationError
  const payload = {
    ok: false,
    error: {
      code: known ? error.code : ERROR_CODES.INTERNAL,
      message: error instanceof Error ? error.message : String(error),
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  }
  if (!known) debug('unexpected failure:', error instanceof Error ? error.stack ?? error.message : String(error))
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true }
}

/**
 * Validate `tools/call` parameters and run the tool.
 * @param {unknown} params - JSON-RPC params.
 * @returns {Promise<Record<string, unknown>>} the tool result.
 */
async function callTool(params) {
  const record = isRecord(params) ? params : {}
  const name = typeof record.name === 'string' ? record.name : ''
  const tool = toolNamed(name)
  if (tool === undefined) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: false, error: { code: ERROR_CODES.NOT_FOUND, message: `unknown tool ${name}` } }, null, 2),
      }],
      isError: true,
    }
  }
  const args = record.arguments === undefined ? {} : record.arguments
  if (!isRecord(args)) {
    return toolFailure(new CoordinationError(ERROR_CODES.INVALID_ARGUMENT, 'tool arguments must be a JSON object'))
  }
  try {
    const value = await tool.handler(args)
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false }
  } catch (error) {
    return toolFailure(error)
  }
}

/**
 * Dispatch one JSON-RPC request.
 * @param {Record<string, unknown>} request - the request envelope.
 * @returns {Promise<void>} resolves once the response (if any) was written.
 */
async function dispatch(request) {
  const id = request.id
  const method = typeof request.method === 'string' ? request.method : ''
  const isNotification = id === undefined || id === null
  if (method === '') {
    if (!isNotification) send(errorResponse(id, -32600, 'invalid request: method must be a string'))
    return
  }

  switch (method) {
    case 'initialize': {
      const requested = isRecord(request.params) && typeof request.params.protocolVersion === 'string'
        ? request.params.protocolVersion
        : ''
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
      if (!isNotification) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        })
      }
      return
    }
    case 'ping':
      if (!isNotification) send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      if (!isNotification) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        })
      }
      return
    case 'tools/call':
      if (isNotification) return
      send({ jsonrpc: '2.0', id, result: await callTool(request.params) })
      return
    case 'resources/list':
    case 'resources/templates/list':
    case 'prompts/list':
      // Only tools are advertised, but an empty, well-formed answer costs
      // nothing and keeps a curious client from logging an error.
      if (!isNotification) send({ jsonrpc: '2.0', id, result: method === 'prompts/list' ? { prompts: [] } : { resourceTemplates: [], resources: [] } })
      return
    case 'logging/setLevel':
      if (!isNotification) send({ jsonrpc: '2.0', id, result: {} })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case '$/cancelRequest':
      return
    default:
      if (!isNotification) send(errorResponse(id, -32601, `method not found: ${method}`))
  }
}

/**
 * Start reading the stdio wire.
 * @returns {void}
 */
function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  /** @type {Promise<void>} */
  let queue = Promise.resolve()

  process.stdout.on('error', (error) => {
    debug('stdout closed:', String(error))
    process.exit(0)
  })

  input.on('line', (line) => {
    const text = line.trim().replace(/^\uFEFF/, '')
    if (text.length === 0) return
    /** @type {unknown} */
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      send(errorResponse(null, -32700, 'parse error: each line must be one JSON value'))
      return
    }
    queue = queue.then(async () => {
      if (Array.isArray(payload)) {
        for (const item of payload) {
          if (!isRecord(item)) {
            send(errorResponse(null, -32600, 'invalid request'))
            continue
          }
          await dispatch(item)
        }
        return
      }
      if (!isRecord(payload)) {
        send(errorResponse(null, -32600, 'invalid request'))
        return
      }
      await dispatch(payload)
    }).catch((error) => {
      debug('dispatch failed:', error instanceof Error ? error.stack ?? error.message : String(error))
    })
  })

  input.on('close', () => {
    queue.finally(() => process.exit(0))
  })
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

main()
