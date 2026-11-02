/**
 * AMP v0.1 primitives shared by the coordination server, its library modules
 * and the tests.
 *
 * The module is deliberately dependency-free: a Codex plugin must run from a
 * checkout with no `npm install`, so the only imports are `node:crypto` and
 * `node:*` builtins elsewhere. Everything here is pure and deterministic so a
 * ledger written on one machine verifies on another.
 *
 * Vocabulary follows the Attention Manifest Protocol as published by the
 * `attention-manifest-protocol` package: ids are `[a-z][a-z0-9._:-]{0,63}`,
 * objects carry `amp: "0.1"` and `kind`, and every ledger entry is chained by a
 * SHA-256 digest over its predecessor and its canonical JSON.
 *
 * @module codex-coordination/amp
 */

import { createHash } from 'node:crypto'

/** The protocol version this server writes and accepts. */
export const AMP_VERSION = '0.1'

/** AMP id grammar: lowercase start, then lowercase letters, digits and `._:-`. */
export const ID_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/

/** Stable error codes; the MCP layer turns them into `isError` tool results. */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_STATE: 'INVALID_STATE',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PERMISSION: 'PERMISSION',
  IO: 'IO',
  INTERNAL: 'INTERNAL',
})

/**
 * One typed, caller-facing failure.
 *
 * `details` stays JSON-serialisable: it is echoed into the tool result so the
 * model can fix the call without guessing which field was rejected.
 */
export class CoordinationError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_CODES}.
   * @param {string} message - one sentence naming the rejected value.
   * @param {Record<string, unknown>} [details] - JSON-serialisable context.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'CoordinationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * Throw one {@link CoordinationError}.
 * @param {string} code - one of {@link ERROR_CODES}.
 * @param {string} message - one sentence naming the rejected value.
 * @param {Record<string, unknown>} [details] - JSON-serialisable context.
 * @returns {never}
 */
export function fail(code, message, details) {
  throw new CoordinationError(code, message, details)
}

/** @param {unknown} value - anything. @returns {boolean} whether it is a plain object. */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require a plain object and return it narrowed.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {Record<string, unknown>} the same object.
 */
export function requireRecord(value, label) {
  if (!isRecord(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an object`, { field: label })
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Require a non-empty string within bounds.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @param {{ min?: number, max?: number }} [bounds] - length bounds (default 1..4096).
 * @returns {string} the trimmed string.
 */
export function requireString(value, label, bounds = {}) {
  const min = bounds.min ?? 1
  const max = bounds.max ?? 4096
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a string`, { field: label })
  const text = value.trim()
  if (text.length < min) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be at least ${min} character(s)`, { field: label })
  if (text.length > max) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be at most ${max} character(s)`, { field: label })
  return text
}

/**
 * Require an AMP id.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {string} the validated id.
 */
export function requireId(value, label) {
  const text = requireString(value, label, { min: 1, max: 64 })
  if (!ID_PATTERN.test(text)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must match ${ID_PATTERN.source}`, { field: label, value: text })
  }
  return text
}

/**
 * Require one value from a closed set.
 * @param {unknown} value - candidate.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} label - field name used in the error message.
 * @returns {string} the accepted value.
 */
export function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be one of ${allowed.join(', ')}`, { field: label, value })
  }
  return value
}

/** How a recorded check is observed: by reading, by querying, or by assertion. */
export const CHECK_KINDS = Object.freeze(['observe', 'query', 'assert'])

/**
 * Validate one `{ id, statement, check, kind? }` record.
 *
 * Success criteria and abandon conditions share this shape: a named statement
 * plus the check a human or model must actually perform. The check text is
 * required and non-empty because a criterion nobody can restate is not
 * observable.
 *
 * @param {unknown} input - the raw record.
 * @param {string} label - path prefix used in error messages.
 * @returns {{ id: string, statement: string, check: string, kind?: string }} the clean record.
 */
export function normaliseCheck(input, label) {
  const record = requireRecord(input, label)
  return {
    id: requireId(record.id, `${label}.id`),
    statement: requireString(record.statement, `${label}.statement`, { max: 2048 }),
    check: requireString(record.check, `${label}.check`, { max: 4096 }),
    ...(record.kind === undefined ? {} : { kind: requireEnum(record.kind, CHECK_KINDS, `${label}.kind`) }),
  }
}

/**
 * Require a finite number in a closed range.
 * @param {unknown} value - candidate.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {string} label - field name used in the error message.
 * @returns {number} the accepted number.
 */
export function requireNumber(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a finite number`, { field: label })
  }
  if (value < min || value > max) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be between ${min} and ${max}`, { field: label, value })
  }
  return value
}

/**
 * Require a non-empty string array.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @param {{ min?: number, max?: number, itemMax?: number }} [bounds] - size bounds.
 * @returns {string[]} the trimmed items.
 */
export function requireStringArray(value, label, bounds = {}) {
  const min = bounds.min ?? 1
  const max = bounds.max ?? 32
  const itemMax = bounds.itemMax ?? 4096
  if (!Array.isArray(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an array`, { field: label })
  if (value.length < min || value.length > max) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must contain ${min}-${max} item(s)`, { field: label })
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`, { max: itemMax }))
}

/**
 * Require an RFC 3339 timestamp with a timezone.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {string} the original timestamp.
 */
export function requireTimestamp(value, label) {
  const text = requireString(value, label, { min: 20, max: 64 })
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an RFC 3339 timestamp with a timezone`, { field: label })
  }
  return text
}

/**
 * Current wall-clock time as an RFC 3339 UTC timestamp.
 * @returns {string} e.g. `2026-11-03T05:30:00.000Z`.
 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Deterministically order an object graph so equal values hash equally.
 *
 * Object keys are sorted; `undefined` members are dropped (JSON has no such
 * value); array order is preserved because AMP arrays are ordered by design.
 * Non-finite numbers and class instances are rejected rather than silently
 * coerced, which keeps a digest from depending on `JSON.stringify` quirks.
 *
 * @param {unknown} value - JSON-compatible value.
 * @returns {unknown} the canonicalised copy.
 */
function canonicalise(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODES.INVALID_ARGUMENT, 'canonical JSON rejects non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalise(item))
  if (type === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value)
    const out = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue
      out[key] = canonicalise(source[key])
    }
    return out
  }
  fail(ERROR_CODES.INVALID_ARGUMENT, `canonical JSON rejects a ${type} value`)
}

/**
 * Canonical JSON: stable key order, no whitespace.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} the canonical text.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value))
}

/**
 * Chain one ledger entry to its predecessor.
 *
 * The predecessor is mixed in first so an entry cannot be replayed into a
 * different ledger position, and the separator keeps the two halves from
 * running together (`null` and `""` must not hash alike).
 *
 * @param {string|null} previous - the predecessor digest, or `null` for the first entry.
 * @param {unknown} entry - the entry body, without its own `digest`/`prev` fields.
 * @returns {string} lowercase hex SHA-256 digest.
 */
export function digestOf(previous, entry) {
  return createHash('sha256')
    .update(previous ?? '')
    .update('\u0000')
    .update(canonicalJson(entry))
    .digest('hex')
}

/**
 * Copy the JSON-compatible subset of a value (used before persisting results).
 * @param {unknown} value - JSON-compatible value.
 * @returns {unknown} a structured clone via JSON round-trip.
 */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}
