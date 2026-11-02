/**
 * The durable coordination ledger.
 *
 * One workspace owns one ledger file:
 *
 * ```
 * <workspace>/.codex-coordination/ledger.json
 * ```
 *
 * The file is a materialised projection (goals, plans, duties) plus an
 * append-only, hash-chained journal of every mutation. Keeping the projection
 * in the same file as the journal means a reader never has to replay history to
 * answer "what is the state", and a verifier can still prove that the state was
 * reached through the recorded entries.
 *
 * Writes are serialised per ledger path inside this process and materialised
 * with a temporary file plus `rename`, so a crash leaves either the previous
 * or the next complete document — never a half-written one. Cross-process
 * concurrency is out of scope; the server is the only writer a Codex session
 * is expected to start.
 *
 * @module codex-coordination/store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  AMP_VERSION,
  CoordinationError,
  ERROR_CODES,
  digestOf,
  fail,
  isRecord,
  nowIso,
  requireString,
} from './amp.mjs'

/** Directory created beside the workspace root. */
export const LEDGER_DIRECTORY = '.codex-coordination'

/** File name inside {@link LEDGER_DIRECTORY}. */
export const LEDGER_FILENAME = 'ledger.json'

/** On-disk schema version of the whole document. */
export const LEDGER_VERSION = 1

/** Maximum retained journal entries; older entries are dropped tail-first. */
export const MAX_JOURNAL = 2000

/** Environment variable used when no `workspace` argument is supplied. */
export const WORKSPACE_ENV = 'CODEX_COORDINATION_WORKSPACE'

/** Ledger-relative path for one workspace. */
export function ledgerPath(workspace) {
  return join(workspace, LEDGER_DIRECTORY, LEDGER_FILENAME)
}

/**
 * Validate and normalise a workspace root.
 *
 * A silent fallback is refused on purpose: the server's own working directory
 * is the installed plugin, so "no workspace" would otherwise scatter ledgers
 * into the plugin cache. The error tells the caller to pass the repository
 * root, and names the environment variable that can supply it instead.
 *
 * @param {unknown} raw - the caller-supplied path, or `undefined`.
 * @returns {string} an absolute, existing directory.
 */
export function resolveWorkspace(raw) {
  const candidate = typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim()
    : (process.env[WORKSPACE_ENV] ?? '').trim()
  if (candidate.length === 0) {
    fail(
      ERROR_CODES.INVALID_ARGUMENT,
      `workspace is required: pass the absolute repository root as "workspace" (or set ${WORKSPACE_ENV})`,
    )
  }
  if (!isAbsolute(candidate)) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'workspace must be an absolute path', { workspace: candidate })
  }
  let stat
  try {
    stat = statSync(candidate)
  } catch {
    fail(ERROR_CODES.NOT_FOUND, 'workspace does not exist', { workspace: candidate })
  }
  if (!stat.isDirectory()) {
    fail(ERROR_CODES.INVALID_ARGUMENT, 'workspace must be a directory', { workspace: candidate })
  }
  return resolve(candidate)
}

/**
 * A fresh, empty document for one workspace.
 * @param {string} workspace - absolute workspace root.
 * @returns {Record<string, any>} the empty ledger.
 */
export function emptyState(workspace) {
  return {
    amp: AMP_VERSION,
    kind: 'coordination-ledger',
    version: LEDGER_VERSION,
    workspace,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    seq: 0,
    head: null,
    journalBase: null,
    journalDropped: 0,
    goals: {},
    plans: {},
    duties: {},
    journal: [],
  }
}

/**
 * Read one ledger, or an empty document when the file does not exist yet.
 *
 * A present but unreadable document is a hard failure: repairing it silently
 * would destroy the audit trail the protocol exists to provide.
 *
 * @param {string} workspace - absolute workspace root.
 * @returns {Record<string, any>} the ledger document.
 */
export function readState(workspace) {
  const path = ledgerPath(workspace)
  if (!existsSync(path)) return emptyState(workspace)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new CoordinationError(ERROR_CODES.IO, `cannot read ${path}: ${String(error.message ?? error)}`, { path })
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new CoordinationError(ERROR_CODES.INVALID_STATE, `ledger is not valid JSON: ${path}`, { path })
  }
  if (!isRecord(parsed) || parsed.kind !== 'coordination-ledger') {
    throw new CoordinationError(ERROR_CODES.INVALID_STATE, `ledger has an unknown shape: ${path}`, { path })
  }
  if (parsed.version !== LEDGER_VERSION) {
    throw new CoordinationError(
      ERROR_CODES.INVALID_STATE,
      `ledger version ${String(parsed.version)} is not supported (expected ${LEDGER_VERSION})`,
      { path },
    )
  }
  return {
    ...emptyState(workspace),
    ...parsed,
    // Defensive copies: a hand-edited file must not crash a later mutation.
    goals: isRecord(parsed.goals) ? parsed.goals : {},
    plans: isRecord(parsed.plans) ? parsed.plans : {},
    duties: isRecord(parsed.duties) ? parsed.duties : {},
    journal: Array.isArray(parsed.journal) ? parsed.journal : [],
  }
}

/**
 * Materialise one ledger atomically.
 * @param {string} workspace - absolute workspace root.
 * @param {Record<string, any>} state - the document to persist.
 * @returns {void}
 */
export function writeState(workspace, state) {
  const path = ledgerPath(workspace)
  const directory = dirname(path)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw new CoordinationError(ERROR_CODES.IO, `cannot create ${directory}: ${String(error.message ?? error)}`, { directory })
  }
  state.updatedAt = nowIso()
  const text = `${JSON.stringify(state, null, 2)}\n`
  const temporary = join(directory, `${LEDGER_FILENAME}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // Cleanup is best-effort; the write error below is the real failure.
    }
    throw new CoordinationError(ERROR_CODES.IO, `cannot write ${path}: ${String(error.message ?? error)}`, { path })
  }
}

/**
 * Append one hash-chained entry and advance the head.
 * @param {Record<string, any>} state - the live document, mutated in place.
 * @param {string} type - event type, e.g. `goal/created`.
 * @param {string} [id] - the record id the event concerns.
 * @param {Record<string, unknown>} [data] - small, JSON-serialisable payload.
 * @returns {Record<string, any>} the appended entry.
 */
export function appendJournal(state, type, id, data) {
  const body = {
    seq: state.seq + 1,
    at: nowIso(),
    type,
    ...(id === undefined ? {} : { id }),
    ...(data === undefined ? {} : { data }),
  }
  const prev = state.head ?? null
  const digest = digestOf(prev, body)
  const entry = { ...body, prev, digest }
  state.seq = body.seq
  state.head = digest
  state.journal.push(entry)
  while (state.journal.length > MAX_JOURNAL) {
    const dropped = state.journal.shift()
    state.journalBase = dropped.digest
    state.journalDropped = (state.journalDropped ?? 0) + 1
  }
  return entry
}

/**
 * Recompute the whole retained chain.
 *
 * Every retained entry carries its own `prev` digest, so even the first entry
 * after a truncation verifies: the document remembers the digest of the last
 * dropped entry in `journalBase`.
 *
 * @param {Record<string, any>} state - the document to verify.
 * @returns {{ ok: boolean, entries: number, head: string|null, journalBase: string|null, dropped: number, problems: Array<Record<string, unknown>> }} verdict.
 */
export function verifyJournal(state) {
  const problems = []
  let expectedPrev = state.journalBase ?? null
  let lastDigest = expectedPrev
  let lastSeq = null
  for (const [index, entry] of state.journal.entries()) {
    if (!isRecord(entry)) {
      problems.push({ code: 'ENTRY_NOT_OBJECT', index })
      continue
    }
    if (entry.prev !== expectedPrev) {
      problems.push({ code: 'PREV_MISMATCH', index, seq: entry.seq, expected: expectedPrev, actual: entry.prev })
    }
    const { digest, prev, ...body } = entry
    const recomputed = digestOf(prev, body)
    if (recomputed !== digest) {
      problems.push({ code: 'DIGEST_MISMATCH', index, seq: entry.seq, expected: recomputed, actual: digest })
    }
    if (lastSeq !== null && entry.seq !== lastSeq + 1) {
      problems.push({ code: 'SEQ_GAP', index, expected: lastSeq + 1, actual: entry.seq })
    }
    expectedPrev = digest
    lastDigest = digest
    lastSeq = entry.seq
  }
  if ((state.head ?? null) !== lastDigest) {
    problems.push({ code: 'HEAD_MISMATCH', expected: lastDigest, actual: state.head ?? null })
  }
  if (lastSeq !== null && state.seq !== lastSeq) {
    problems.push({ code: 'SEQ_MISMATCH', expected: lastSeq, actual: state.seq })
  }
  return {
    ok: problems.length === 0,
    entries: state.journal.length,
    head: state.head ?? null,
    journalBase: state.journalBase ?? null,
    dropped: state.journalDropped ?? 0,
    problems,
  }
}

/** Per-ledger serialisation queues, keyed by absolute ledger path. */
const queues = new Map()

/** Ledger paths whose stale temporaries were already swept in this process. */
const sweptKeys = new Set()

/**
 * Acquire the write slot for one ledger path.
 * @param {string} key - absolute ledger path.
 * @returns {Promise<() => void>} an idempotent release function.
 */
async function acquire(key) {
  const previous = queues.get(key) ?? Promise.resolve()
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolveGate) => {
    release = /** @type {any} */ (resolveGate)
  })
  const tail = previous.then(() => gate, () => gate)
  queues.set(key, tail)
  await previous.catch(() => {})
  return () => {
    release()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

/**
 * Run one read-modify-write transaction against a ledger.
 *
 * The operation receives a context whose `record` helper appends a chained
 * journal entry, so every mutation is logged in the same transaction that
 * applies it. The document is persisted only when the operation returns
 * normally; a throw leaves the previous file untouched.
 *
 * @template T
 * @param {string} workspace - absolute workspace root.
 * @param {(context: { state: Record<string, any>, workspace: string, record: (type: string, id?: string, data?: Record<string, unknown>) => Record<string, any> }) => T | Promise<T>} operation - the mutation.
 * @returns {Promise<T>} whatever the operation returned.
 */
export async function withLedger(workspace, operation) {
  const key = ledgerPath(workspace)
  const release = await acquire(key)
  try {
    if (!sweptKeys.has(key)) {
      sweptKeys.add(key)
      sweepTemporaries(workspace)
    }
    const state = readState(workspace)
    const context = {
      state,
      workspace,
      record: (type, id, data) => appendJournal(state, type, id, data),
    }
    const result = await operation(context)
    writeState(workspace, state)
    return result
  } finally {
    release()
  }
}

/**
 * Read a ledger without acquiring the write slot.
 * @param {string} workspace - absolute workspace root.
 * @returns {Record<string, any>} the document.
 */
export function peekState(workspace) {
  return readState(workspace)
}

/**
 * Remove stale temporary files left behind by a killed process.
 *
 * Called once at server start. Only files this module names are touched, and a
 * failure is ignored: leftovers never affect correctness because the rename is
 * atomic.
 *
 * @param {string} workspace - absolute workspace root.
 * @returns {number} the number of files removed.
 */
export function sweepTemporaries(workspace) {
  const directory = join(workspace, LEDGER_DIRECTORY)
  if (!existsSync(directory)) return 0
  let removed = 0
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.startsWith(`${LEDGER_FILENAME}.`) || !name.endsWith('.tmp')) continue
    try {
      unlinkSync(join(directory, name))
      removed += 1
    } catch {
      // A concurrently running writer may own it; leaving it is harmless.
    }
  }
  return removed
}

/**
 * Require that a record exists in one ledger map.
 * @param {Record<string, any>} map - `state.goals` / `state.plans` / `state.duties`.
 * @param {unknown} id - candidate id.
 * @param {string} label - singular label used in the error message.
 * @returns {string} the validated id.
 */
export function requireRecordId(map, id, label) {
  const text = requireString(id, label, { min: 1, max: 64 })
  if (!isRecord(map) || !isRecord(map[text])) {
    fail(ERROR_CODES.NOT_FOUND, `${label} ${text} does not exist`, { [label]: text })
  }
  return text
}
