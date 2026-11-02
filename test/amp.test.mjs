/**
 * AMP primitives: canonical JSON, digests and shared validators.
 *
 * The pinned vectors in this file were produced by the reference implementation
 * (`attention-manifest-protocol` 0.5.0, `lib/semantic/canonical.js`). They are
 * the always-on proof that this plugin's chain hashes are the same bytes an AMP
 * verifier recomputes; `scripts/amp-conformance.mjs` adds the full reference
 * comparison when that package is checked out.
 *
 * @module codex-coordination/test/amp
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AMP_VERSION,
  DIGEST_PATTERN,
  ENTRY_KINDS,
  GENESIS,
  ID_PATTERN,
  REF_KINDS,
  canonicalJson,
  chainHash,
  digestOf,
  normaliseBudget,
  normaliseCriterion,
  normaliseRef,
  requireExactKeys,
  requireInteger,
  requireString,
} from '../plugins/codex-coordination/mcp/lib/amp.mjs'
import { throwsCode } from './helpers.mjs'

test('the protocol constants match AMP v0.1', () => {
  assert.equal(AMP_VERSION, '0.1')
  assert.equal(GENESIS, `sha256:${'0'.repeat(64)}`)
  assert.match(GENESIS, DIGEST_PATTERN)
  assert.match('coordination-ledger', ID_PATTERN)
  assert.doesNotMatch('Coordination', ID_PATTERN)
  assert.deepEqual([...ENTRY_KINDS].sort(), ['claim', 'event', 'frame', 'goal', 'hypothesis', 'plan', 'receipt', 'unknown'])
  assert.ok(REF_KINDS.includes('goal') && REF_KINDS.includes('tool'))
})

test('canonical JSON sorts keys and keeps arrays in order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(
    canonicalJson({ empty: {}, list: [1, 1.5, -2, 1e21, 0], nested: { z: null, a: true } }),
    '{"empty":{},"list":[1,1.5,-2,1e+21,0],"nested":{"a":true,"z":null}}',
  )
})

test('digests are byte-identical to the reference implementation', () => {
  assert.equal(digestOf({ b: 1, a: 2 }), 'sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772')
  assert.equal(
    digestOf({ seq: 0, kind: 'event', payload: { type: 'probe', at: '2026-11-03T00:00:00.000Z' }, prev: GENESIS }),
    'sha256:7c409877359371576ac3136e3f54440abdc78c365778050962d67ede2edb831e',
  )
  assert.equal(
    digestOf({
      amp: '0.1',
      kind: 'goal',
      id: 'probe',
      statement: '导出结果一致',
      success: [{ id: 'c', statement: 's', check: 'c' }],
      value: 0.5,
      priority: 0,
    }),
    'sha256:f8e5fb1f58494dc233452d1c7cacafa5ee67f0a0f1c3dff5a8cbd83187d180df',
  )
  assert.equal(
    digestOf({
      list: [1, 1.5, -2, 1e21, 0],
      text: 'quote " backslash \\ newline \n tab \t',
      empty: {},
      nested: { z: null, a: true },
    }),
    'sha256:e66b42fbbeb9cfbea42fffde90833d73e165b199abe51fd05900fe42d5573253',
  )
})

test('a chain hash covers exactly four fields', () => {
  const payload = { type: 'probe' }
  assert.equal(chainHash(0, 'event', payload, GENESIS), digestOf({ seq: 0, kind: 'event', payload, prev: GENESIS }))
  assert.match(chainHash(0, 'event', payload, GENESIS), DIGEST_PATTERN)
  // A different seq, kind or prev must change the hash; the payload is not optional.
  const base = chainHash(1, 'event', payload, GENESIS)
  assert.notEqual(chainHash(2, 'event', payload, GENESIS), base)
  assert.notEqual(chainHash(1, 'goal', payload, GENESIS), base)
  assert.notEqual(chainHash(1, 'event', payload, 'sha256:' + '1'.repeat(64)), base)
})

test('canonical JSON rejects values JSON.stringify would silently rewrite', () => {
  throwsCode(() => canonicalJson({ a: undefined }), 'INVALID_ARGUMENT', /undefined/)
  throwsCode(() => canonicalJson({ a: -0 }), 'INVALID_ARGUMENT', /-0/)
  throwsCode(() => canonicalJson({ a: Number.NaN }), 'INVALID_ARGUMENT', /finite/)
  throwsCode(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), 'INVALID_ARGUMENT', /finite/)
  throwsCode(() => canonicalJson({ a: '\uD800' }), 'INVALID_ARGUMENT', /surrogate/)
  throwsCode(() => canonicalJson({ a: new Date() }), 'INVALID_ARGUMENT', /plain object/)
  const sparse = [1]
  sparse[2] = 3
  throwsCode(() => canonicalJson(sparse), 'INVALID_ARGUMENT', /hole/)
  const cyclic = {}
  cyclic.self = cyclic
  throwsCode(() => canonicalJson(cyclic), 'INVALID_ARGUMENT', /cycle/)
})

test('objects are validated strictly, not silently trimmed', () => {
  const record = { id: 'x', extra: true }
  throwsCode(() => requireExactKeys(record, ['id'], ['id'], 'probe'), 'INVALID_ARGUMENT', /extra is not a known field/)
  throwsCode(() => requireExactKeys({}, ['id'], ['id'], 'probe'), 'INVALID_ARGUMENT', /id is required/)
  throwsCode(() => normaliseRef({ kind: 'file', id: 'x' }, 'ref'), 'INVALID_ARGUMENT', /kind must be one of/)
  throwsCode(() => normaliseRef({ kind: 'goal' }, 'ref'), 'INVALID_ARGUMENT', /ref.id is required/)
  assert.deepEqual(normaliseRef({ kind: 'goal', id: 'g1', label: 'Goal one' }, 'ref'), { kind: 'goal', id: 'g1', label: 'Goal one' })
})

test('budgets accept AMP counters and reject anything else', () => {
  assert.deepEqual(normaliseBudget({ tokens: 10, ms: 5, calls: 1, interrupts: 0, money: 1.5 }, 'budget'), {
    tokens: 10,
    ms: 5,
    calls: 1,
    interrupts: 0,
    money: 1.5,
  })
  assert.deepEqual(normaliseBudget({}, 'budget'), {})
  throwsCode(() => normaliseBudget({ tokens: 1.5 }, 'budget'), 'INVALID_ARGUMENT', /integer/)
  throwsCode(() => normaliseBudget({ money: -1 }, 'budget'), 'INVALID_ARGUMENT', /between 0 and/)
  throwsCode(() => normaliseBudget({ seconds: 1 }, 'budget'), 'INVALID_ARGUMENT', /not a known field/)
})

test('criteria require a check and an AMP id', () => {
  assert.deepEqual(normaliseCriterion({ id: 'c1', statement: 'works', check: 'run it', kind: 'observe' }, 'c'), {
    id: 'c1',
    statement: 'works',
    check: 'run it',
    kind: 'observe',
  })
  throwsCode(() => normaliseCriterion({ id: 'c1', statement: 'works' }, 'c'), 'INVALID_ARGUMENT', /check is required/)
  throwsCode(() => normaliseCriterion({ id: 'c1', statement: 'works', check: 'x', kind: 'guess' }, 'c'), 'INVALID_ARGUMENT', /kind must be one of/)
  throwsCode(() => requireInteger(1.5, 0, 3, 'irreversibility'), 'INVALID_ARGUMENT', /integer/)
  throwsCode(() => requireString('\uDC00', 'text'), 'INVALID_ARGUMENT', /surrogate/)
})
