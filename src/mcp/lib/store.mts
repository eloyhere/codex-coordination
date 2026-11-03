/**
 * The durable coordination ledger.
 *
 * One workspace owns one file:
 *
 * ```
 * <workspace>/.codex-coordination/ledger.json
 * ```
 *
 * The file is a **host document** — `kind: "coordination-ledger"` is deliberately
 * not an AMP kind. It holds two things:
 *
 * 1. an AMP append-only chain in `journal`, where every entry is
 *    `{ seq, kind, payload, prev, hash }` with `hash = digestOf({seq,kind,payload,prev})`
 *    and `seq 0` linked to {@link GENESIS}; and
 * 2. a materialised projection (`goals`, `plans`, `duties`) so a reader never has
 *    to replay history to answer "what is the state".
 *
 * The strict AMP artifact is derived, never stored: {@link snapshotOf} returns a
 * `ledger-snapshot` whose entries are exactly AMP's `ChainEntry` shape (the
 * advisory `at` field is stripped) and which verifies under the reference
 * implementation's `verifySnapshot`.
 *
 * Writes are serialised per ledger path inside this process and materialised
 * with a temporary file plus `rename`, so a crash leaves either the previous or
 * the next complete document — never a half-written one. Cross-process
 * concurrency is out of scope: the MCP server is the only writer a Codex session
 * is expected to start.
 *
 * @module codex-coordination/store
 */

import { randomBytes } from 'node:crypto'
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
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  AMP_VERSION,
  CoordinationError,
  ENTRY_KINDS,
  ERROR_CODES,
  GENESIS,
  assertCanonical,
  canonicalJson,
  chainHash,
  cloneJson,
  fail,
  isRecord,
  nowIso,
  requireString,
} from './amp.mjs'

/** Directory created beside the workspace root. */
export const LEDGER_DIRECTORY = '.codex-coordination'

/** File name inside {@link LEDGER_DIRECTORY}. */
export const LEDGER_FILENAME = 'ledger.json'

/** On-disk schema version of the host document. */
export const LEDGER_VERSION = 2

/**
 * AMP id published as `ledger-snapshot.agent`.
 *
 * A Codex session carries no agent identity of its own, so the snapshot names the
 * writer instead of inventing a per-session id.
 */
export const AGENT_ID = 'codex-coordination'

/** Environment variable used when no `workspace` argument is supplied. */
export const WORKSPACE_ENV = 'CODEX_COORDINATION_WORKSPACE'

/** Ledger-relative path for one workspace. */
export function ledgerPath(workspace: any) {
  return join(workspace, LEDGER_DIRECTORY, LEDGER_FILENAME)
}

/**
 * Validate and normalise a workspace root.
 *
 * A silent fallback is refused on purpose: the server's own working directory is
 * the installed plugin, so "no workspace" would otherwise scatter ledgers into
 * the plugin cache. The error tells the caller to pass the repository root, and
 * names the environment variable that can supply it instead.
 *
 * @param {unknown} raw - the caller-supplied path, or `undefined`.
 * @returns {string} an absolute, existing directory.
 */
export function resolveWorkspace(raw: unknown) {
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
 * A fresh, empty host document for one workspace.
 *
 * An empty ledger still has a tip: {@link GENESIS}. That keeps `tip` a digest in
 * every state and lets a verifier start from one constant.
 *
 * @param {string} workspace - absolute workspace root.
 * @returns {Record<string, any>} the empty ledger.
 */
export function emptyState(workspace: string) {
  const at = nowIso()
  return {
    amp: AMP_VERSION,
    kind: 'coordination-ledger',
    version: LEDGER_VERSION,
    workspace,
    agent: AGENT_ID,
    createdAt: at,
    updatedAt: at,
    tip: GENESIS,
    count: 0,
    goals: {},
    plans: {},
    duties: {},
    journal: [],
  }
}

/**
 * Read one ledger, or an empty document when the file does not exist yet.
 *
 * A present but unreadable document, a different `kind`, or the 0.1 document
 * shape is a hard failure: silently repairing or re-chaining it would destroy
 * the audit trail the protocol exists to provide.
 *
 * @param {string} workspace - absolute workspace root.
 * @returns {Record<string, any>} the ledger document.
 */
export function readState(workspace: string) {
  const path = ledgerPath(workspace)
  if (!existsSync(path)) return emptyState(workspace)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new CoordinationError(ERROR_CODES.IO, `cannot read ${path}: ${String((error instanceof Error ? error.message : String(error)) ?? error)}`, { path })
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
      `ledger version ${String(parsed.version)} is not supported: this build writes version ${LEDGER_VERSION} `
        + `(an AMP ledger-snapshot chain). The 0.1 format is not migrated, because re-chaining it would `
        + `destroy the evidence it carries. Delete ${path} to start a new ledger.`,
      { path, version: parsed.version, expected: LEDGER_VERSION },
    )
  }
  return {
    ...emptyState(workspace),
    ...parsed,
    goals: isRecord(parsed.goals) ? parsed.goals : {},
    plans: isRecord(parsed.plans) ? parsed.plans : {},
    duties: isRecord(parsed.duties) ? parsed.duties : {},
    journal: Array.isArray(parsed.journal) ? parsed.journal : [],
  }
}

/**
 * Materialise one ledger atomically.
 *
 * The document is validated against the canonical-JSON value domain before it is
 * written. That turns an `undefined` that slipped into a projection into a loud
 * internal error instead of a silently dropped field on disk.
 *
 * @param {string} workspace - absolute workspace root.
 * @param {Record<string, any>} state - the document to persist.
 * @returns {void}
 */
export function writeState(workspace: string, state: Record<string, any>) {
  const path = ledgerPath(workspace)
  const directory = dirname(path)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw new CoordinationError(ERROR_CODES.IO, `cannot create ${directory}: ${String((error instanceof Error ? error.message : String(error)) ?? error)}`, { directory })
  }
  state.updatedAt = nowIso()
  try {
    canonicalJson(state)
  } catch (error) {
    throw new CoordinationError(
      ERROR_CODES.INTERNAL,
      `refusing to write a ledger that is not JSON-canonical: ${error instanceof Error ? (error instanceof Error ? error.message : String(error)) : String(error)}`,
      { path },
    )
  }
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
    throw new CoordinationError(ERROR_CODES.IO, `cannot write ${path}: ${String((error instanceof Error ? error.message : String(error)) ?? error)}`, { path })
  }
}

/**
 * Append one AMP chain entry and advance the tip.
 *
 * `at` is stored on the entry but excluded from the hash: it is advisory host
 * metadata, exactly like AMP's `LogEntry.at`.
 *
 * @param {Record<string, any>} state - the live document, mutated in place.
 * @param {string} kind - one of {@link ENTRY_KINDS}.
 * @param {unknown} payload - the entry payload; validated by the hash.
 * @returns {Record<string, any>} the appended entry.
 */
export function appendEntry(state: Record<string, any>, kind: string, payload: unknown) {
  if (!ENTRY_KINDS.includes(kind)) {
    throw new CoordinationError(ERROR_CODES.INTERNAL, `refusing to append an unknown AMP entry kind: ${String(kind)}`)
  }
  // Deep-copy before hashing: callers hand in live projection objects (a plan
  // artifact is updated in place on the next task move), and a shared reference
  // would let a later mutation rewrite an earlier entry's payload while its hash
  // stayed behind. The canonical check runs first so a value the copy would drop
  // (`undefined`) or rewrite is rejected instead of hashed in its rewritten form.
  assertCanonical(payload)
  const body = cloneJson(payload)
  const journal = Array.isArray(state.journal) ? state.journal : []
  const seq = journal.length
  const prev = seq === 0 ? GENESIS : journal[seq - 1].hash
  const hash = chainHash(seq, kind, body, prev)
  const entry = { seq, kind, payload: body, prev, hash, at: nowIso() }
  journal.push(entry)
  state.journal = journal
  state.tip = hash
  state.count = journal.length
  return entry
}

/**
 * The chain as AMP `ChainEntry` values: `at` stripped, nothing added.
 * @param {Record<string, any>} state - the ledger document.
 * @returns {Array<Record<string, any>>} the entry window.
 */
export function chainEntries(state: Record<string, any>) {
  const journal = Array.isArray(state.journal) ? state.journal : []
  return journal.map((entry: any) => ({
    seq: entry.seq,
    kind: entry.kind,
    payload: entry.payload,
    prev: entry.prev,
    hash: entry.hash,
  }))
}

/**
 * Derive the strict AMP `ledger-snapshot` of one ledger.
 *
 * The snapshot is the only ledger artifact this plugin emits; the host document
 * around it never pretends to be one.
 *
 * @param {Record<string, any>} state - the ledger document.
 * @returns {{ amp: string, kind: 'ledger-snapshot', agent: string, tip: string, count: number, entries: Array<Record<string, any>> }} the snapshot.
 */
export function snapshotOf(state: Record<string, any>) {
  const entries = chainEntries(state)
  return {
    amp: AMP_VERSION,
    kind: 'ledger-snapshot',
    agent: typeof state.agent === 'string' && state.agent.length > 0 ? state.agent : AGENT_ID,
    tip: entries.length === 0 ? GENESIS : entries[entries.length - 1].hash,
    count: entries.length,
    entries,
  }
}

/**
 * Verify one AMP ledger snapshot the way the reference implementation does.
 *
 * `tip` and `count` are checked against the chain rather than trusted, every
 * entry hash is recomputed from its four covered fields, and `seq` must be
 * contiguous from zero — an entry cannot be inserted, reordered or rewritten
 * without breaking every hash after it.
 *
 * @param {unknown} snapshot - a candidate `ledger-snapshot`.
 * @returns {{ ok: boolean, problems: Array<Record<string, unknown>>, tip: string, count: number }} the verdict.
 */
export function verifySnapshot(snapshot: unknown) {
  const problems: Array<Record<string, unknown>> = []
  if (!isRecord(snapshot)) {
    return { ok: false, problems: [{ code: 'SNAPSHOT_NOT_OBJECT' }], tip: GENESIS, count: 0 }
  }
  if (snapshot.amp !== AMP_VERSION) problems.push({ code: 'SNAPSHOT_AMP', expected: AMP_VERSION, actual: snapshot.amp })
  if (snapshot.kind !== 'ledger-snapshot') problems.push({ code: 'SNAPSHOT_KIND', actual: snapshot.kind })
  if (typeof snapshot.agent !== 'string' || snapshot.agent.length === 0) problems.push({ code: 'SNAPSHOT_AGENT' })
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : []
  let prev = GENESIS
  let expectedSeq = 0
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      problems.push({ code: 'ENTRY_NOT_OBJECT', index })
      continue
    }
    if (entry.seq !== expectedSeq) {
      problems.push({ code: 'SEQ_MISMATCH', index, expected: expectedSeq, actual: entry.seq })
    }
    if (!ENTRY_KINDS.includes(entry.kind)) {
      problems.push({ code: 'ENTRY_KIND', index, actual: entry.kind })
    }
    if (!isRecord(entry.payload)) {
      problems.push({ code: 'ENTRY_PAYLOAD', index })
    }
    if (entry.prev !== prev) {
      problems.push({ code: 'PREV_MISMATCH', index, seq: entry.seq, expected: prev, actual: entry.prev })
    }
    if (isRecord(entry.payload) && ENTRY_KINDS.includes(entry.kind)) {
      let expected
      try {
        expected = chainHash(expectedSeq, entry.kind, entry.payload, prev)
      } catch (error) {
        problems.push({ code: 'ENTRY_UNHASHABLE', index, message: String(error instanceof Error ? (error instanceof Error ? error.message : String(error)) : error) })
        expected = undefined
      }
      if (expected !== undefined && expected !== entry.hash) {
        problems.push({ code: 'HASH_MISMATCH', index, seq: entry.seq, expected, actual: entry.hash })
      }
    }
    if (typeof entry.hash === 'string') prev = entry.hash
    expectedSeq += 1
  }
  if (snapshot.count !== entries.length) {
    problems.push({ code: 'COUNT_MISMATCH', expected: entries.length, actual: snapshot.count })
  }
  if (snapshot.tip !== prev) {
    problems.push({ code: 'TIP_MISMATCH', expected: prev, actual: snapshot.tip })
  }
  return { ok: problems.length === 0, problems, tip: prev, count: entries.length }
}

/**
 * Verify the chain of a host ledger document.
 *
 * The document's *derived* snapshot is checked with the same rules AMP applies
 * to a snapshot, and then its declared `tip`/`count` are compared with what the
 * entries actually produce. Without the second step a hand-edited document could
 * carry a stale tip that no artifact ever reflects.
 *
 * @param {Record<string, any>} state - the ledger document.
 * @returns {{ ok: boolean, problems: Array<Record<string, unknown>>, tip: string, count: number }} the verdict.
 */
export function verifyChain(state: Record<string, any>) {
  const snapshot = snapshotOf(state)
  const verdict = verifySnapshot(snapshot)
  const problems = [...verdict.problems]
  if (state.tip !== snapshot.tip) {
    problems.push({ code: 'TIP_MISMATCH', source: 'document', expected: snapshot.tip, actual: state.tip })
  }
  if (state.count !== snapshot.count) {
    problems.push({ code: 'COUNT_MISMATCH', source: 'document', expected: snapshot.count, actual: state.count })
  }
  return { ok: problems.length === 0, problems, tip: snapshot.tip, count: snapshot.count }
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
async function acquire(key: string) {
  const previous = queues.get(key) ?? Promise.resolve()
  /** @type {() => void} */
  let release = () => {}
  const gate = new Promise((resolveGate: any) => {
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
 * The operation receives a context whose `append` helper chains one AMP entry, so
 * every mutation is logged in the same transaction that applies it. The document
 * is persisted only when the operation returns normally; a throw leaves the
 * previous file untouched.
 *
 * @template T
 * @param {string} workspace - absolute workspace root.
 * @param {(context: {
 *   state: Record<string, any>,
 *   workspace: string,
 *   append: (kind: string, payload: unknown) => Record<string, any>,
 * }) => T | Promise<T>} operation - the mutation.
 * @returns {Promise<T>} whatever the operation returned.
 */
export async function withLedger<T>(workspace: string, operation: (context: { state: Record<string, any>, append: (kind: string, payload: unknown) => any }) => T | Promise<T>): Promise<T> {
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
      append: (kind: any, payload: any) => appendEntry(state, kind, payload),
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
export function peekState(workspace: string) {
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
export function sweepTemporaries(workspace: string) {
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
export function requireRecordId(map: Record<string, any>, id: unknown, label: string) {
  const text = requireString(id, label, { min: 1, max: 64 })
  if (!isRecord(map) || !isRecord(map[text])) {
    fail(ERROR_CODES.NOT_FOUND, `${label} ${text} does not exist`, { [label]: text })
  }
  return text
}
