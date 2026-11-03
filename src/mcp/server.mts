#!/usr/bin/env node
/**
 * codex-coordination MCP server.
 *
 * A TypeScript Model Context Protocol server spoken over stdio: one JSON
 * object per line, JSON-RPC 2.0 envelopes. Codex starts it from the plugin's
 * `.mcp.json`. npm dependencies are bundled at build time; the installed plugin
 * needs Node 24+ without an npm install. Configured services can use the network.
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
 * - Ledger `actor` values are declared identities. AMP services additionally
 *   use host-bound authenticated sessions and retain credentials inside the host.
 *
 * @module codex-coordination/server
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

import { CoordinationError, ERROR_CODES, isRecord } from './lib/amp.mjs'
import { TOOLS, toolNamed } from './lib/tools.mjs'
import { DASHBOARD_URI } from './lib/dashboard.mjs'
import { ampHost } from './amp/host.mjs'
import { SERVER_INSTRUCTIONS } from './guidance.mjs'
import { advertisedSchema } from './coordination/schema.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from './amp/host-client.mjs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { fullFormats } from 'ajv-formats/dist/formats.js'
const argumentsValidator = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, formats: fullFormats })
const argumentChecks = new Map<string, ReturnType<typeof argumentsValidator.compile>>()

/** Advertised server identity. */
const SERVER_INFO = Object.freeze({ name: 'codex-coordination', version: '0.5.1' })

/** Protocol revisions this server speaks, newest first. */
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05'])

/** Model-facing note attached to every session that connects. */
const INSTRUCTIONS = SERVER_INSTRUCTIONS

/** Emit one diagnostic line on stderr when debugging is enabled. */
function debug(...parts: any) {
  if (!process.env.CODEX_COORDINATION_DEBUG) return
  process.stderr.write(`[codex-coordination] ${parts.join(' ')}\n`)
}

/**
 * Write one protocol message.
 * @param {unknown} message - JSON-RPC envelope.
 * @returns {void}
 */
function send(message: unknown) {
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
function errorResponse(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/**
 * Convert one thrown value into a tool result the model can act on.
 * @param {unknown} error - the thrown value.
 * @returns {{ content: Array<{ type: 'text', text: string }>, isError: true }} the tool result.
 */
function toolFailure(error: unknown) {
  const known = error instanceof CoordinationError
  const native = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9_-]*$/.test(error.code)
  const payload = {
    ok: false,
    error: {
      code: known || native ? error.code : ERROR_CODES.INTERNAL,
      message: error instanceof Error ? error.message : String(error),
      ...(known && error.details !== undefined ? { details: error.details } : {}),
      ...(native && 'problems' in error ? { problems: error.problems } : {}),
      ...(native && 'receipt' in error && error.receipt ? { receipt: error.receipt } : {}),
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
async function callTool(params: unknown) {
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
    let validate = argumentChecks.get(name)
    if (!validate) { validate = argumentsValidator.compile(tool.inputSchema); argumentChecks.set(name, validate) }
    if (!validate(args)) {
      const problems = validate.errors?.slice(0, 8).map(error => {
        if (error.keyword !== 'additionalProperties') return `${error.instancePath} ${error.message}`
        const parent = error.schemaPath.split('/').slice(1, -1).reduce<any>((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], tool.inputSchema)
        return `${error.instancePath} has unknown field ${error.params.additionalProperty}; allowed: ${Object.keys(parent?.properties ?? {}).join(', ')}`
      }).join('; ')
      throw new CoordinationError(ERROR_CODES.INVALID_ARGUMENT, `Arguments do not match the tool input schema: ${problems}`, { problems: validate.errors })
    }
    const value = await tool.handler(args)
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value.ok === false && !['coordination_check', 'coordination_protocol'].includes(name) }
  } catch (error) {
    return toolFailure(error)
  }
}

/**
 * Dispatch one JSON-RPC request.
 * @param {Record<string, unknown>} request - the request envelope.
 * @returns {Promise<void>} resolves once the response (if any) was written.
 */
async function dispatch(request: Record<string, unknown>) {
  const id = request.id
  const method = typeof request.method === 'string' ? request.method : ''
  const isNotification = id === undefined || id === null
  if (method === '') {
    if (!isNotification) send(errorResponse(id, -32600, 'invalid request: method must be a string'))
    return
  }

  switch (method) {
    case 'initialize': {
      configureHostClient(isRecord(request.params) && isRecord(request.params.capabilities) ? request.params.capabilities : {}, send)
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
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { 'io.modelcontextprotocol/ui': {} } },
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
            tools: TOOLS.map((tool: any) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: advertisedSchema(tool),
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool._meta ? { _meta: tool._meta } : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
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
      if (!isNotification) send({ jsonrpc: '2.0', id, result: { resources: [{ uri: DASHBOARD_URI, name: 'Coordination dashboard', mimeType: 'text/html;profile=mcp-app' }] } })
      return
    case 'resources/read': {
      if (isNotification) return
      if (!isRecord(request.params) || request.params.uri !== DASHBOARD_URI) { send(errorResponse(id, -32002, 'resource not found')); return }
      try {
        const text = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8')
        send({ jsonrpc: '2.0', id, result: { contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false }, 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } },
        }] } })
      } catch { send(errorResponse(id, -32603, 'dashboard build is missing; run npm run build')) }
      return
    }
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

  process.stdout.on('error', (error: any) => {
    debug('stdout closed:', String(error))
    process.exit(0)
  })

  input.on('line', (line: any) => {
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
    if (isRecord(payload) && acceptHostResponse(payload)) return
    if (isRecord(payload) && payload.method === 'notifications/cancelled') { closeHostClient(); return }
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
    }).catch((error: any) => {
      debug('dispatch failed:', error instanceof Error ? error.stack ?? error.message : String(error))
    })
  })

  input.on('close', () => {
    closeHostClient()
    queue.finally(async () => { await ampHost.close(); process.exit(0) })
  })
  process.on('SIGINT', () => { void ampHost.close().finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { void ampHost.close().finally(() => process.exit(0)) })
}

main()
