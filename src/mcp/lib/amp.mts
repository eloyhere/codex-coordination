/** AMP adapter. Canonical values, hashes and cloning come from the pinned upstream runtime. */
import { canonicalJson as ampCanonicalJson, digestOf as ampDigestOf } from 'amp-legacy/semantic'
import { cloneJson as ampCloneJson } from 'amp-legacy/semantic/jsonValue.js'
import type { Ref, Budget, Criterion } from 'amp-legacy/types'

/** The protocol version this server writes and accepts. */
export const AMP_VERSION = '0.1'

/**
 * The predecessor of the first chain entry.
 *
 * AMP links `seq 0` to 64 zero digits rather than to `null`, so an empty ledger
 * has a tip instead of a hole and `prev` is always a digest.
 */
export const GENESIS = `sha256:${'0'.repeat(64)}`

/** AMP digest grammar: lowercase `sha256:` plus 64 hex digits. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/** AMP id grammar: lowercase start, then lowercase letters, digits and `._:-`. */
export const ID_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/

/** AMP's closed ledger vocabulary; this server writes `event`, `goal` and `plan`. */
export const ENTRY_KINDS = Object.freeze(['event', 'frame', 'receipt', 'claim', 'hypothesis', 'unknown', 'goal', 'plan'])

/** AMP `refKind` vocabulary, copied from `common.schema.json`. */
export const REF_KINDS = Object.freeze([
  'entity', 'concept', 'process', 'thread', 'question', 'hypothesis', 'claim',
  'evidence', 'goal', 'plan', 'task', 'tool', 'memory', 'other',
  'human', 'event', 'handle', 'frame', 'self', 'unknown', 'common-ground',
  'capability', 'agent', 'receipt', 'org',
])

/** Budget counters AMP defines; no other key is accepted. */
export const BUDGET_KEYS = Object.freeze(['tokens', 'ms', 'calls', 'interrupts', 'money'])

/** How a recorded check is observed: by reading, by querying, or by assertion. */
export const CHECK_KINDS = Object.freeze(['observe', 'query', 'assert'])

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
  code: string
  details?: Record<string, unknown>
  /**
   * @param {string} code - one of {@link ERROR_CODES}.
   * @param {string} message - one sentence naming the rejected value.
   * @param {Record<string, unknown>} [details] - JSON-serialisable context.
   */
  constructor(code: string, message: string, details?: Record<string, unknown>) {
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
export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new CoordinationError(code, message, details)
}

/**
 * Whether a value is a plain record, which is the only object shape AMP accepts.
 *
 * `Date`, `Map`, `Set` and class instances are excluded here rather than at the
 * canonical-JSON boundary so an input error names the field the caller passed.
 *
 * @param {unknown} value - anything.
 * @returns {boolean} whether it is a plain object.
 */
export function isRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Require a plain object and return it narrowed.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {Record<string, unknown>} the same object.
 */
export function requireRecord(value: unknown, label: string) {
  if (!isRecord(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a JSON object`, { field: label })
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Reject missing required fields and unknown fields.
 *
 * AMP object schemas are `additionalProperties: false`, so silently ignoring a
 * misspelled field would let a caller believe it recorded something it did not.
 * The check names the first offending field instead.
 *
 * @param {Record<string, unknown>} record - the object under validation.
 * @param {readonly string[]} allowed - every field the object may carry.
 * @param {readonly string[]} required - fields that must be present.
 * @param {string} label - path prefix used in error messages.
 * @returns {void}
 */
export function requireExactKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.${key} is not a known field (allowed: ${allowed.join(', ')})`, {
        field: `${label}.${key}`,
        allowed,
      })
    }
  }
  for (const key of required) {
    if (record[key] === undefined) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `${label}.${key} is required`, { field: `${label}.${key}`, required })
    }
  }
}

/**
 * Reject a string containing an unpaired UTF-16 surrogate.
 *
 * JSON can escape one, but UTF-8 cannot encode it and `TextEncoder` substitutes
 * U+FFFD, so two different strings could reach the same digest while a compliant
 * verifier re-derives different bytes. RFC 8785 §3.2.2.2 rejects the case; so do
 * we, at input time.
 *
 * @param {string} text - the candidate string.
 * @param {string} label - path used in the error message.
 * @returns {void}
 */
export function assertWellFormedText(text: string, label: string) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) {
        fail(ERROR_CODES.INVALID_ARGUMENT, `${label} contains an unpaired surrogate at index ${index}`, { field: label })
      }
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(ERROR_CODES.INVALID_ARGUMENT, `${label} contains an unpaired surrogate at index ${index}`, { field: label })
    }
  }
}

/**
 * Require a non-empty string within bounds.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @param {{ min?: number, max?: number }} [bounds] - length bounds (default 1..4096).
 * @returns {string} the trimmed string.
 */
export function requireString(value: unknown, label: string, bounds: { min?: number, max?: number } = {}) {
  const min = bounds.min ?? 1
  const max = bounds.max ?? 4096
  if (typeof value !== 'string') fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a string`, { field: label })
  assertWellFormedText(value, label)
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
export function requireId(value: unknown, label: string) {
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
export function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be one of ${allowed.join(', ')}`, { field: label, value })
  }
  return value
}

/**
 * Require a finite number in a closed range.
 *
 * `-0` is rejected rather than written as `0`: AMP's canonical JSON refuses it,
 * and a silent rewrite would make the digest cover a different value.
 *
 * @param {unknown} value - candidate.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {string} label - field name used in the error message.
 * @returns {number} the accepted number.
 */
export function requireNumber(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be a finite number`, { field: label })
  }
  if (Object.is(value, -0)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must not be -0`, { field: label })
  if (value < min || value > max) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be between ${min} and ${max}`, { field: label, value })
  }
  return value
}

/**
 * Require an integer in a closed range.
 * @param {unknown} value - candidate.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {string} label - field name used in the error message.
 * @returns {number} the accepted integer.
 */
export function requireInteger(value: unknown, min: number, max: number, label: string) {
  const number = requireNumber(value, min, max, label)
  if (!Number.isInteger(number)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an integer`, { field: label, value })
  return number
}

/**
 * Require a non-empty string array.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @param {{ min?: number, max?: number, itemMax?: number }} [bounds] - size bounds.
 * @returns {string[]} the trimmed items.
 */
export function requireStringArray(value: unknown, label: string, bounds: { min?: number, max?: number, itemMax?: number } = {}) {
  const min = bounds.min ?? 1
  const max = bounds.max ?? 32
  const itemMax = bounds.itemMax ?? 4096
  if (!Array.isArray(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an array`, { field: label })
  if (value.length < min || value.length > max) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must contain ${min}-${max} item(s)`, { field: label })
  }
  return value.map((item: any, index: any) => requireString(item, `${label}[${index}]`, { max: itemMax }))
}

/**
 * Require an RFC 3339 timestamp with a timezone.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {string} the original timestamp.
 */
export function requireTimestamp(value: unknown, label: string) {
  const text = requireString(value, label, { min: 20, max: 64 })
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must be an RFC 3339 timestamp with a timezone`, { field: label })
  }
  return text
}

/**
 * Require an AMP digest string.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {string} the digest.
 */
export function requireDigest(value: unknown, label: string) {
  const text = requireString(value, label, { min: 71, max: 71 })
  if (!DIGEST_PATTERN.test(text)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must match ${DIGEST_PATTERN.source}`, { field: label })
  return text
}

/** Current wall-clock time as an RFC 3339 UTC timestamp. */
export function nowIso() {
  return new Date().toISOString()
}

function protocolValue<T>(operation: () => T): T {
  try { return operation() } catch (error) { fail(ERROR_CODES.INVALID_ARGUMENT, (error instanceof Error ? error.message : String(error))) }
}
export function canonicalJson(value: unknown): string { return protocolValue(() => ampCanonicalJson(value)) }
export function assertCanonical(value: unknown, label = '$'): void { canonicalJson(value) }
export function digestOf(value: unknown): string { return protocolValue(() => ampDigestOf(value)) }

/**
 * Hash one chain entry from its four covered fields.
 *
 * `at` is deliberately absent: like AMP's `LogEntry.at`, it is advisory host
 * metadata and must not change a hash when a clock changes.
 *
 * @param {number} seq - zero-based position in the chain.
 * @param {string} kind - one of {@link ENTRY_KINDS}.
 * @param {unknown} payload - the entry payload.
 * @param {string} prev - the predecessor hash, or {@link GENESIS}.
 * @returns {string} the entry hash.
 */
export function chainHash(seq: number, kind: string, payload: unknown, prev: string) {
  return digestOf({ seq, kind, payload, prev })
}

/**
 * Validate and normalise one AMP `Ref`.
 * @param {unknown} input - `{ kind, id, label? }`.
 * @param {string} label - path prefix used in error messages.
 * @returns {{ kind: string, id: string, label?: string }} the clean reference.
 */
export function normaliseRef(input: unknown, label: string): Ref {
  const record = requireRecord(input, label)
  requireExactKeys(record, ['kind', 'id', 'label'], ['kind', 'id'], label)
  return {
    kind: requireEnum(record.kind, REF_KINDS, `${label}.kind`) as Ref['kind'],
    id: requireId(record.id, `${label}.id`),
    ...(record.label === undefined ? {} : { label: requireString(record.label, `${label}.label`, { max: 256 }) }),
  }
}

/**
 * Validate an optional AMP `Budget`.
 *
 * An absent budget is dropped rather than defaulted: `{}` means "declared, no
 * limits", which is a different statement from "not declared".
 *
 * @param {unknown} input - `{ tokens, ms, calls, interrupts, money }`.
 * @param {string} label - path prefix used in error messages.
 * @returns {Record<string, number>|undefined} the clean budget.
 */
export function normaliseBudget(input: unknown, label: string): Budget | undefined {
  if (input === undefined) return undefined
  const record = requireRecord(input, label)
  requireExactKeys(record, BUDGET_KEYS, [], label)
  /** @type {Record<string, number>} */
  const budget: Record<string, number> = {}
  for (const key of BUDGET_KEYS) {
    if (record[key] === undefined) continue
    budget[key] = key === 'money'
      ? requireNumber(record[key], 0, Number.MAX_SAFE_INTEGER, `${label}.${key}`)
      : requireInteger(record[key], 0, Number.MAX_SAFE_INTEGER, `${label}.${key}`)
  }
  return budget
}

/**
 * Validate one `{ id, statement, check, kind? }` criterion.
 *
 * Success criteria, abandon conditions and acceptance items share this shape: a
 * named statement plus the check a human or model must actually perform. The
 * check text is required because a criterion nobody can restate is not
 * observable.
 *
 * @param {unknown} input - the raw record.
 * @param {string} label - path prefix used in error messages.
 * @returns {{ id: string, statement: string, check: string, kind?: string }} the clean criterion.
 */
export function normaliseCriterion(input: unknown, label: string): Criterion {
  const record = requireRecord(input, label)
  requireExactKeys(record, ['id', 'statement', 'check', 'kind'], ['id', 'statement', 'check'], label)
  return {
    id: requireId(record.id, `${label}.id`),
    statement: requireString(record.statement, `${label}.statement`, { max: 2048 }),
    check: requireString(record.check, `${label}.check`, { max: 4096 }),
    ...(record.kind === undefined ? {} : { kind: requireEnum(record.kind, ['observe', 'query', 'assert'], `${label}.kind`) }),
  }
}

/**
 * Copy the JSON-compatible subset of a value (used before returning results).
 * @param {unknown} value - JSON-compatible value.
 * @returns {unknown} a structured clone via JSON round-trip.
 */
export function cloneJson(value: unknown): any {
  return protocolValue(() => ampCloneJson(value))
}
