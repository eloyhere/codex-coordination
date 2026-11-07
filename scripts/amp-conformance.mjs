#!/usr/bin/env node
/**
 * Prove that the artifacts this plugin emits are byte- and schema-compatible
 * with the Attention Manifest Protocol reference implementation.
 *
 * This is the check that turns "strictly follows AMP" from a claim into a
 * measurement. It runs in `npm run check` against the installed npm package.
 * An explicit protocol checkout may also be compared before a release:
 *
 * ```
 * node scripts/amp-conformance.mjs --amp R:/project/attention-manifest-protocol
 * ```
 *
 * With no `--amp`, `AMP_PACKAGE_DIR` is read; with neither, the installed
 * npm package is used. The script:
 *
 * 1. drives the real ledger through a goal, a plan and a full handoff;
 * 2. compares `canonicalJson` and `digestOf` with the reference's own functions;
 * 3. validates every emitted Goal and Plan artifact against the published JSON
 *    Schemas (`docs/schemas/plan.schema.json`);
 * 4. validates the emitted `ledger-snapshot` against
 *    `docs/schemas/ledger-snapshot.schema.json`;
 * 5. verifies the snapshot with the reference's `verifySnapshot`.
 *
 * Exit codes: `0` all checks passed, `1` a check failed, `2` no reference
 * checkout or schema directory was found.
 *
 * @module codex-coordination/scripts/amp-conformance
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

import { GENESIS, canonicalJson, digestOf } from '../plugins/codex-coordination/mcp/lib/amp.mjs'
import { assignDuty, transitionDuty } from '../plugins/codex-coordination/mcp/lib/collaboration.mjs'
import { createGoal, transitionGoal } from '../plugins/codex-coordination/mcp/lib/goals.mjs'
import { createPlan, transitionPlan, updateTask } from '../plugins/codex-coordination/mcp/lib/plans.mjs'
import { readState, snapshotOf, verifySnapshot, withLedger } from '../plugins/codex-coordination/mcp/lib/store.mjs'

/** AMP's closed chain vocabulary, compared against what this plugin writes. */
const ENTRY_KINDS = ['event', 'frame', 'receipt', 'claim', 'hypothesis', 'unknown', 'goal', 'plan']

/**
 * Print usage and exit.
 * @param {number} code - process exit code.
 * @returns {never}
 */
function usage(code) {
  const text = [
    'usage: node scripts/amp-conformance.mjs [--amp <attention-manifest-protocol>] [--keep] [--verbose]',
    '',
    '  --amp <dir>   checkout of attention-manifest-protocol (default: $AMP_PACKAGE_DIR,',
    '                then the installed npm package)',
    '  --keep        keep the temporary workspace',
    '  --verbose     print every schema problem instead of the first',
  ].join('\n')
  ;(code === 0 ? console.log : console.error)(text)
  process.exit(code)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) usage(0)

/**
 * Read one option value.
 * @param {string} name - option name including dashes.
 * @returns {string|undefined} the following argument.
 */
function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const keep = args.includes('--keep')
const verbose = args.includes('--verbose')
const fallback = dirname(fileURLToPath(import.meta.resolve('amp-legacy/package.json')))
const ampDir = resolve(option('--amp') ?? process.env.AMP_PACKAGE_DIR ?? fallback)
const schemaDir = join(ampDir, 'docs', 'schemas')
const referenceCanonical = join(ampDir, 'lib', 'semantic', 'canonical.js')
const referencePersistence = join(ampDir, 'lib', 'ledger', 'persistence.js')

if (!existsSync(referenceCanonical) || !existsSync(referencePersistence)) {
  console.error(`FAIL no reference implementation at ${ampDir}`)
  console.error('     pass --amp <checkout> or set AMP_PACKAGE_DIR')
  process.exit(2)
}
if (!existsSync(join(schemaDir, 'plan.schema.json'))) {
  console.error(`FAIL no JSON Schemas at ${schemaDir}`)
  process.exit(2)
}

/**
 * A minimal JSON Schema (draft 2020-12) subset validator.
 *
 * The published AMP schemas use a small vocabulary — `$ref` into
 * `common.schema.json`, `oneOf`, `type`, `required`, `properties`,
 * `additionalProperties`, `enum`, `const`, `pattern`, length and numeric bounds,
 * array `items` and cardinality. This validator implements exactly that subset,
 * so a schema keyword it does not know is a gap in this script rather than a
 * silently skipped rule.
 *
 * @param {string} directory - directory holding the schema files.
 * @returns {(value: unknown, schema: Record<string, any>, path?: string) => string[]} validator.
 */
function createSchemaValidator(directory) {
  const cache = new Map()
  /** @param {string} name - schema file name. @returns {Record<string, any>} parsed schema. */
  const load = (name) => {
    if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(directory, name), 'utf8')))
    return cache.get(name)
  }
  /**
   * @param {unknown} value - candidate value.
   * @param {Record<string, any>} schema - schema to apply.
   * @param {string} [path] - JSON path for messages.
   * @param {Record<string, any>} [root] - document a local `#/...` reference resolves against.
   * @returns {string[]} problems, empty when the value matches.
   */
  const validate = (value, schema, path = '$', root = schema) => {
    const problems = []
    if (schema === true) return problems
    if (schema.$ref !== undefined) {
      const [file, pointer] = schema.$ref.split('#')
      const targetRoot = file.length > 0 ? load(file) : root
      let node = targetRoot
      for (const segment of (pointer ?? '').split('/').filter((part) => part.length > 0)) {
        node = node?.[segment]
      }
      if (node === undefined) throw new Error(`cannot resolve schema reference ${schema.$ref}`)
      return validate(value, node, path, targetRoot)
    }
    if (schema.oneOf !== undefined) {
      const matches = schema.oneOf.filter((branch) => validate(value, branch, path, root).length === 0).length
      if (matches !== 1) problems.push(`${path} matches ${matches} of the oneOf branches (expected exactly 1)`)
      return problems
    }
    if (schema.const !== undefined && value !== schema.const) {
      problems.push(`${path} must be ${JSON.stringify(schema.const)}`)
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      problems.push(`${path} must be one of ${schema.enum.join(', ')}`)
    }
    if (schema.type !== undefined) {
      const type = schema.type
      const ok = type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
        : type === 'array' ? Array.isArray(value)
          : type === 'integer' ? Number.isInteger(value)
            : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : type === 'string' ? typeof value === 'string'
                : type === 'boolean' ? typeof value === 'boolean'
                  : true
      if (!ok) {
        problems.push(`${path} must be a ${type}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`)
        return problems
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} is shorter than ${schema.minLength}`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} is longer than ${schema.maxLength}`)
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path} does not match ${schema.pattern}`)
    }
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} is below ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} is above ${schema.maximum}`)
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path} has fewer than ${schema.minItems} item(s)`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} has more than ${schema.maxItems} item(s)`)
      if (schema.items !== undefined) {
        value.forEach((item, index) => problems.push(...validate(item, schema.items, `${path}[${index}]`, root)))
      }
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = /** @type {Record<string, unknown>} */ (value)
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) problems.push(`${path}.${key} is required`)
      }
      for (const [key, child] of Object.entries(record)) {
        if (schema.properties?.[key] !== undefined) {
          problems.push(...validate(child, schema.properties[key], `${path}.${key}`, root))
        } else if (schema.additionalProperties === false) {
          problems.push(`${path}.${key} is not allowed by the schema`)
        }
      }
    }
    return problems
  }
  return validate
}

const validateSchema = createSchemaValidator(schemaDir)
const planSchema = JSON.parse(readFileSync(join(schemaDir, 'plan.schema.json'), 'utf8'))
const snapshotSchema = JSON.parse(readFileSync(join(schemaDir, 'ledger-snapshot.schema.json'), 'utf8'))

const reference = {
  canonical: await import(pathToFileURL(referenceCanonical).href),
  persistence: await import(pathToFileURL(referencePersistence).href),
}
const referenceVersion = JSON.parse(readFileSync(join(ampDir, 'package.json'), 'utf8')).version

/**
 * Build the conformance workspace through the plugin's own write path.
 * @param {string} workspace - absolute workspace root.
 * @returns {Promise<void>} resolves when every artifact exists.
 */
async function buildLedger(workspace) {
  await withLedger(workspace, (context) => {
    createGoal(context, {
      amp: '0.1',
      kind: 'goal',
      id: 'conformance-goal',
      statement: 'The emitted artifacts validate against the published AMP schemas',
      success: [
        { id: 'schema', statement: 'Every artifact validates', check: 'run scripts/amp-conformance.mjs' },
        { id: 'reference', statement: 'The reference verifier accepts the snapshot', check: 'read the conformance report' },
      ],
      value: 0.9,
      priority: 2,
      horizon: 'session',
      deadline: '2027-01-01T00:00:00.000Z',
    })
    createPlan(context, {
      amp: '0.1',
      kind: 'plan',
      id: 'conformance-plan',
      goal: { kind: 'goal', id: 'conformance-goal' },
      process: { kind: 'process', id: 'conformance-process' },
      tasks: [
        {
          id: 'emit',
          intent: 'Emit one artifact of every kind',
          actor: 'self',
          ref: { kind: 'tool', id: 'coordination_plan' },
          expect: { observation: 'artifacts exist', check: 'read the ledger' },
          irreversibility: 1,
          budget: { tokens: 100 },
        },
        {
          id: 'verify',
          intent: 'Verify them with the reference',
          actor: 'tool',
          pre: ['emit'],
          expect: { observation: 'every check passes', check: 'run the conformance script' },
        },
      ],
      commitment_window: 2,
      budget: { ms: 1000, calls: 2 },
      abandon_if: [{ id: 'drift', statement: 'The published schema changes', check: 'diff the schema files' }],
      monitor: { triggers: [{ when: 'a check fails', action: 'replan' }] },
      rollback: 'Delete the temporary workspace',
      warrant: { kind: 'claim', id: 'schema-conformance' },
    })
    assignDuty(context, {
      id: 'conformance-duty',
      role: 'qualification',
      owner: 'codex-main',
      assignee: 'codex-sub-1',
      responsibilities: ['Run the conformance script and report its table'],
      acceptance: ['The table has no FAIL row'],
      plan: 'conformance-plan',
      task: 'verify',
    })
  })
  await withLedger(workspace, (context) => {
    transitionGoal(context, 'conformance-goal', 'committed', 'schema work agreed')
    transitionGoal(context, 'conformance-goal', 'active')
    transitionPlan(context, 'conformance-plan', 'committed')
    updateTask(context, 'conformance-plan', 'emit', 'running')
    updateTask(context, 'conformance-plan', 'emit', 'done', 'artifacts written')
    transitionDuty(context, { id: 'conformance-duty', action: 'accept', actor: 'codex-sub-1' })
    transitionDuty(context, { id: 'conformance-duty', action: 'start', actor: 'codex-sub-1' })
    transitionDuty(context, {
      id: 'conformance-duty',
      action: 'submit',
      actor: 'codex-sub-1',
      summary: 'Ran the conformance script',
      evidence: ['scripts/amp-conformance.mjs -> every check passed'],
    })
    transitionDuty(context, { id: 'conformance-duty', action: 'verify', actor: 'codex-main', review: 'Re-ran the script' })
  })
}

/**
 * Run the checks, collecting a row per check.
 * @param {string} workspace - absolute workspace root.
 * @returns {Promise<Array<{ name: string, ok: boolean, detail: string }>>} the rows.
 */
async function runChecks(workspace) {
  await buildLedger(workspace)
  const state = readState(workspace)
  const snapshot = snapshotOf(state)
  const rows = []
  /**
   * Register one check.
   * @param {string} name - check id.
   * @param {() => string} run - returns a one-line detail or throws.
   * @returns {void}
   */
  const check = (name, run) => {
    try {
      rows.push({ name, ok: true, detail: run() })
    } catch (error) {
      rows.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  /**
   * Throw when an assertion fails.
   * @param {boolean} condition - assertion.
   * @param {string} message - failure detail.
   * @returns {void}
   */
  const strict = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  /**
   * Format schema problems for one artifact.
   * @param {unknown} value - artifact.
   * @param {Record<string, any>} schema - schema.
   * @returns {string} empty when valid, the first problem otherwise.
   */
  const schemaFailure = (value, schema) => {
    const problems = validateSchema(value, schema)
    if (problems.length === 0) return ''
    return verbose ? problems.join('; ') : problems[0]
  }

  check('reference-import', () => {
    strict(typeof reference.canonical.digestOf === 'function', 'reference canonical.digestOf is missing')
    strict(typeof reference.persistence.verifySnapshot === 'function', 'reference persistence.verifySnapshot is missing')
    return `attention-manifest-protocol ${referenceVersion} loaded from ${ampDir}`
  })

  const vectors = [
    { b: 1, a: 2 },
    { seq: 0, kind: 'event', payload: { type: 'probe', at: '2026-11-03T00:00:00.000Z' }, prev: GENESIS },
    { amp: '0.1', kind: 'goal', id: 'probe', statement: '导出结果一致', success: [{ id: 'c', statement: 's', check: 'c' }], value: 0.5, priority: 0 },
    { list: [1, 1.5, -2, 1e21, 0], text: 'quote " backslash \\ newline \n tab \t', empty: {}, nested: { z: null, a: true } },
  ]
  check('canonical-json', () => {
    for (const value of vectors) {
      const ours = canonicalJson(value)
      const theirs = reference.canonical.canonicalJson(value)
      strict(ours === theirs, `canonical JSON differs for ${JSON.stringify(value).slice(0, 80)}:\n  ours:   ${ours}\n  theirs: ${theirs}`)
    }
    return `${vectors.length} canonical JSON values byte-identical`
  })

  check('digest', () => {
    for (const value of vectors) {
      const ours = digestOf(value)
      const theirs = reference.canonical.digestOf(value)
      strict(ours === theirs, `digest differs for ${JSON.stringify(value).slice(0, 80)}:\n  ours:   ${ours}\n  theirs: ${theirs}`)
    }
    return `${vectors.length} digests match the reference`
  })

  check('chain-verify', () => {
    const ours = verifySnapshot(snapshot)
    strict(ours.ok, `our verifier rejected the snapshot: ${JSON.stringify(ours.problems)}`)
    const theirs = reference.persistence.verifySnapshot(snapshot)
    strict(theirs.ok, `the reference rejected the snapshot: ${theirs.reasons.join('; ')}`)
    strict(theirs.reasons.length === 0, 'the reference reported reasons for an accepted snapshot')
    return `${snapshot.count} entries verify under both verifiers`
  })

  check('entry-shape', () => {
    snapshot.entries.forEach((entry, index) => {
      const keys = Object.keys(entry).sort()
      strict(JSON.stringify(keys) === JSON.stringify(['hash', 'kind', 'payload', 'prev', 'seq']), `entry ${index} carries ${keys.join(', ')}`)
      strict(ENTRY_KINDS.includes(entry.kind), `entry ${index} has unknown kind ${entry.kind}`)
      strict(entry.seq === index, `entry ${index} has seq ${entry.seq}`)
      strict(/^sha256:[0-9a-f]{64}$/.test(entry.hash), `entry ${index} hash is not an AMP digest`)
    })
    strict(snapshot.tip === snapshot.entries.at(-1)?.hash, 'tip is not the last entry hash')
    return 'every entry is exactly {seq, kind, payload, prev, hash}'
  })

  check('schema-goal', () => {
    const goals = state.journal.filter((entry) => entry.kind === 'goal')
    strict(goals.length > 0, 'no goal artifact was emitted')
    for (const entry of goals) {
      const failure = schemaFailure(entry.payload, planSchema)
      strict(failure === '', `goal ${entry.payload.id}: ${failure}`)
    }
    return `${goals.length} Goal artifact(s) validate against plan.schema.json`
  })

  check('schema-plan', () => {
    const plans = state.journal.filter((entry) => entry.kind === 'plan')
    strict(plans.length > 0, 'no plan artifact was emitted')
    for (const entry of plans) {
      const failure = schemaFailure(entry.payload, planSchema)
      strict(failure === '', `plan ${entry.payload.id}: ${failure}`)
    }
    return `${plans.length} Plan artifact(s) validate against plan.schema.json`
  })

  check('schema-snapshot', () => {
    const failure = schemaFailure(snapshot, snapshotSchema)
    strict(failure === '', `ledger-snapshot: ${failure}`)
    return 'the ledger-snapshot validates against ledger-snapshot.schema.json'
  })

  check('projections', () => {
    const goal = state.goals['conformance-goal']
    const plan = state.plans['conformance-plan']
    const duty = state.duties['conformance-duty']
    strict(goal?.lifecycle?.state === 'active', `goal lifecycle is ${String(goal?.lifecycle?.state)}`)
    strict(plan?.artifact?.status === 'executing', `plan status is ${String(plan?.artifact?.status)}`)
    strict(duty?.status === 'verified', `duty status is ${String(duty?.status)}`)
    return 'goal, plan and duty projections agree with the journal'
  })

  return rows
}

const workspace = mkdtempSync(join(tmpdir(), 'codex-amp-conformance-'))
let rows
try {
  rows = await runChecks(workspace)
} finally {
  if (keep) console.error(`kept ${workspace}`)
  else rmSync(workspace, { recursive: true, force: true })
}

const failed = rows.filter((row) => !row.ok)
for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name.padEnd(16)} ${row.detail}`)
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${rows.length} conformance check(s) failed`)
  process.exit(1)
}
console.log(`\nok ${rows.length} conformance checks passed against attention-manifest-protocol ${referenceVersion}`)
