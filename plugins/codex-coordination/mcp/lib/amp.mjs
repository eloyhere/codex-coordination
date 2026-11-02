/**
 * AMP v0.1 primitives shared by the coordination server, its library modules
 * and the tests.
 *
 * Everything here mirrors the Attention Manifest Protocol as published by the
 * `attention-manifest-protocol` package (`0.5.0`, wire tag `0.1`). The rules
 * that matter for byte compatibility are:
 *
 * - **Canonical JSON.** A digest covers canonical JSON: object keys sorted by
 *   UTF-16 code units, no whitespace, arrays in order, and a strict I-JSON value
 *   domain. `undefined`, non-finite numbers, `-0`, unpaired surrogates, sparse
 *   arrays and class instances are rejected instead of being silently rewritten
 *   by `JSON.stringify`, because a digest of a rewritten value no longer binds
 *   what the caller passed.
 * - **Digests.** A digest is `sha256:<64 lowercase hex>` over the UTF-8 bytes of
 *   canonical JSON. The first chain entry links to {@link GENESIS}, not to
 *   `null`.
 * - **Chain entries.** One entry is `{ seq, kind, payload, prev, hash }` with
 *   `hash = digestOf({ seq, kind, payload, prev })` and `seq` counting from
 *   zero. `kind` is AMP's closed `EntryKind` vocabulary.
 * - **Objects.** AMP ids are `[a-z][a-z0-9._:-]{0,63}`; objects carry
 *   `amp: "0.1"` and a `kind`; unknown fields are rejected rather than dropped,
 *   and required fields are named in the error so a caller can fix the call
 *   without guessing.
 *
 * The module stays dependency-free — a Codex plugin must run from a checkout
 * with no `npm install` — so the only import is `node:crypto`. Nothing here
 * reaches into the reference package; `scripts/amp-conformance.mjs` proves
 * byte compatibility against it instead.
 *
 * @module codex-coordination/amp
 */

import { createHash } from 'node:crypto'

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

/**
 * Whether a value is a plain record, which is the only object shape AMP accepts.
 *
 * `Date`, `Map`, `Set` and class instances are excluded here rather than at the
 * canonical-JSON boundary so an input error names the field the caller passed.
 *
 * @param {unknown} value - anything.
 * @returns {boolean} whether it is a plain object.
 */
export function isRecord(value) {
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
export function requireRecord(value, label) {
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
export function requireExactKeys(record, allowed, required, label) {
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
export function assertWellFormedText(text, label) {
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
export function requireString(value, label, bounds = {}) {
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
export function requireNumber(value, min, max, label) {
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
export function requireInteger(value, min, max, label) {
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
 * Require an AMP digest string.
 * @param {unknown} value - candidate.
 * @param {string} label - field name used in the error message.
 * @returns {string} the digest.
 */
export function requireDigest(value, label) {
  const text = requireString(value, label, { min: 71, max: 71 })
  if (!DIGEST_PATTERN.test(text)) fail(ERROR_CODES.INVALID_ARGUMENT, `${label} must match ${DIGEST_PATTERN.source}`, { field: label })
  return text
}

/** Current wall-clock time as an RFC 3339 UTC timestamp. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Encode one JSON value as canonical JSON.
 *
 * Kept private so every caller goes through {@link canonicalJson}; the encoder
 * assumes the value domain was already checked.
 *
 * @param {unknown} value - a validated I-JSON value.
 * @returns {string} canonical text.
 */
function encodeCanonical(value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'boolean') return value === true ? 'true' : 'false'
  if (type === 'string') return JSON.stringify(value)
  if (type === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => encodeCanonical(item)).join(',')}]`
  const record = /** @type {Record<string, unknown>} */ (value)
  const members = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`)
  return `{${members.join(',')}}`
}

/**
 * Assert that a value is the strict I-JSON domain AMP digests require.
 *
 * The walk mirrors `attention-manifest-protocol/src/semantic`: plain objects and
 * dense arrays only, no accessors or inherited members, no `undefined`, no
 * non-finite numbers, no `-0`, no unpaired surrogates.
 *
 * @param {unknown} value - candidate value.
 * @param {string} at - path used in the error message.
 * @param {Set<object>} seen - objects on the current path, for cycle detection.
 * @returns {void}
 */
function assertCanonicalValue(value, at, seen) {
  if (value === null) return
  const type = typeof value
  if (type === 'string') {
    assertWellFormedText(value, at)
    return
  }
  if (type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODES.INVALID_ARGUMENT, `${at} is not a finite number`, { field: at })
    if (Object.is(value, -0)) fail(ERROR_CODES.INVALID_ARGUMENT, `${at} is -0`, { field: at })
    return
  }
  if (type === 'undefined') fail(ERROR_CODES.INVALID_ARGUMENT, `${at} is undefined`, { field: at })
  if (type !== 'object') fail(ERROR_CODES.INVALID_ARGUMENT, `${at} is a ${type}`, { field: at })
  const object = /** @type {object} */ (value)
  if (!isRecord(object) && !Array.isArray(object)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, `${at} is not a plain object`, { field: at })
  }
  if (seen.has(object)) fail(ERROR_CODES.INVALID_ARGUMENT, `${at} contains a cycle`, { field: at })
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index += 1) {
        if (!(index in object)) fail(ERROR_CODES.INVALID_ARGUMENT, `${at}[${index}] is a hole`, { field: at })
        assertCanonicalValue(object[index], `${at}[${index}]`, seen)
      }
      return
    }
    for (const key of Object.keys(object)) {
      assertWellFormedText(key, `${at} key`)
      assertCanonicalValue(/** @type {Record<string, unknown>} */ (object)[key], `${at}.${key}`, seen)
    }
  } finally {
    seen.delete(object)
  }
}

/**
 * Canonical JSON: stable key order, no whitespace, strict value domain.
 *
 * This is the one definition of "the bytes a digest covers". Object keys sort by
 * UTF-16 code unit — the order `Array.prototype.sort` uses and the order the
 * reference implementation uses — and arrays keep caller order because AMP
 * arrays are ordered by design.
 *
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} the canonical text.
 */
export function canonicalJson(value) {
  assertCanonicalValue(value, '$', new Set())
  return encodeCanonical(value)
}

/**
 * Assert that a value is in the canonical domain without encoding it.
 *
 * Callers that must copy a value before hashing (a clone would silently drop an
 * `undefined` member) use this to reject the value *before* the copy rewrites it.
 *
 * @param {unknown} value - candidate value.
 * @param {string} [label] - path prefix used in error messages.
 * @returns {void}
 */
export function assertCanonical(value, label = '$') {
  assertCanonicalValue(value, label, new Set())
}

/**
 * Digest one value exactly as AMP does.
 *
 * `digestOf({ seq, kind, payload, prev })` is the ledger hash; every other use
 * (checkpoints, snapshots, pinned references) uses the same construction, which
 * is why there is only one function.
 *
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} `sha256:` plus 64 lowercase hex digits.
 */
export function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

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
export function chainHash(seq, kind, payload, prev) {
  return digestOf({ seq, kind, payload, prev })
}

/**
 * Validate and normalise one AMP `Ref`.
 * @param {unknown} input - `{ kind, id, label? }`.
 * @param {string} label - path prefix used in error messages.
 * @returns {{ kind: string, id: string, label?: string }} the clean reference.
 */
export function normaliseRef(input, label) {
  const record = requireRecord(input, label)
  requireExactKeys(record, ['kind', 'id', 'label'], ['kind', 'id'], label)
  return {
    kind: requireEnum(record.kind, REF_KINDS, `${label}.kind`),
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
export function normaliseBudget(input, label) {
  if (input === undefined) return undefined
  const record = requireRecord(input, label)
  requireExactKeys(record, BUDGET_KEYS, [], label)
  /** @type {Record<string, number>} */
  const budget = {}
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
export function normaliseCriterion(input, label) {
  const record = requireRecord(input, label)
  requireExactKeys(record, ['id', 'statement', 'check', 'kind'], ['id', 'statement', 'check'], label)
  return {
    id: requireId(record.id, `${label}.id`),
    statement: requireString(record.statement, `${label}.statement`, { max: 2048 }),
    check: requireString(record.check, `${label}.check`, { max: 4096 }),
    ...(record.kind === undefined ? {} : { kind: requireEnum(record.kind, CHECK_KINDS, `${label}.kind`) }),
  }
}

/**
 * Copy the JSON-compatible subset of a value (used before returning results).
 * @param {unknown} value - JSON-compatible value.
 * @returns {unknown} a structured clone via JSON round-trip.
 */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}
