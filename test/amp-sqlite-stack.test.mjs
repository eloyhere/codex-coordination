import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ampSqliteResolver, verifyAmpSqliteSnapshot } from '../scripts/amp-sqlite-resolver.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'amp-exact-sqlite-'))
const require = createRequire(import.meta.url)
const currentPackage = JSON.parse(readFileSync(require.resolve('attention-manifest-protocol/package.json'), 'utf8'))
const snapshot = verifyAmpSqliteSnapshot()
// Isolated test compilation uses the very same resolver and multi-entry splitting
// as build.mjs; it never writes or rebuilds any plugin production artifact.
const upperEntry = join(scratch, 'upper.mjs')
writeFileSync(upperEntry, `export { createKernel } from 'attention-manifest-protocol/kernel';\nexport { Store as UpperStore } from 'attention-manifest-protocol/service/store.js';\nexport { safeStringify as nativeStringify } from 'attention-manifest-protocol/serialization';\n`)
const built = await build({
  absWorkingDir: root,
  entryPoints: { storage: resolve(root, 'src/mcp/amp/storage.mts'), upper: upperEntry },
  outdir: join(scratch, 'compiled'), bundle: true, splitting: true, format: 'esm',
  platform: 'node', target: 'node24', metafile: true, write: false,
  plugins: [ampSqliteResolver(), { name: 'test-package-resolution', setup(context) {
    context.onResolve({ filter: /^attention-manifest-protocol\// }, args => ({ path: require.resolve(args.path) }))
  } }],
})
for (const output of built.outputFiles) {
  mkdirSync(dirname(output.path), { recursive: true })
  writeFileSync(output.path, output.contents)
}
writeFileSync(join(scratch, 'package.json'), '{"type":"module"}')
const storage = await import(pathToFileURL(join(scratch, 'compiled/storage.js')))
const upper = await import(pathToFileURL(join(scratch, 'compiled/upper.js')))
const { Store } = storage
const now = '2026-11-07T00:00:00.000Z'
const row = (id, label, version = 1, sessionId = 'session-a') => ({ id, label, version, sessionId, tenantId: 'tenant-a', updatedAt: now })

// Only the random test scratch directory is removed, never an existing database.
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

test('reference files remain byte exact; real resolver keeps native upper modules and a single Store output', () => {
  assert.equal(snapshot.source.version, '0.7.1')
  assert.equal(currentPackage.version, '0.7.9')
  assert.deepEqual(snapshot.layers, ['entity', 'cache', 'service', 'repository', 'sql'])
  const inputs = Object.keys(built.metafile.inputs).map(path => path.replaceAll('\\', '/'))
  for (const layer of [...snapshot.layers, 'connection']) {
    assert.ok(inputs.some(path => path.includes(`vendor/amp-sqlite/lib/${layer}/`)), layer)
    assert.ok(!inputs.some(path => path.includes(`node_modules/attention-manifest-protocol/lib/${layer}/`)), layer)
  }
  assert.ok(inputs.some(path => path.includes('node_modules/attention-manifest-protocol/lib/kernel/kernel.js')))
  assert.ok(inputs.some(path => path.includes('node_modules/attention-manifest-protocol/lib/serialization/json.js')))
  assert.ok(inputs.some(path => path.includes('vendor/amp-sqlite/lib/serialization/json.js')))
  const storeOutputs = Object.values(built.metafile.outputs).filter(output => Object.keys(output.inputs).some(path => path.replaceAll('\\', '/').endsWith('vendor/amp-sqlite/lib/service/store.js')))
  assert.equal(storeOutputs.length, 1)
  assert.equal(Store, upper.UpperStore)
})

test('separate entrypoints and native kernel share Store class, pool and managed entity identity', () => {
  const path = join(scratch, 'identity.sqlite')
  const left = Store.open({ path })
  const kernel = upper.createKernel({ tenantId: 'tenant-a', rootId: 'root-a', storePath: path })
  try {
    assert.ok(kernel.ports.store instanceof Store)
    const saved = left.save('receipt', row('one', 'initial'))
    const right = kernel.ports.store
    assert.equal(left.driver, right.driver)
    assert.equal(saved, right.resolve('receipt', 'one'))
    saved.label = 'changed'
    assert.equal(right.resolve('receipt', 'one').label, 'changed')
    // Exact upstream descriptor decodes the payload version unchanged on proxy writes.
    assert.equal(right.resolve('receipt', 'one').version, 1)
    left.close()
    assert.equal(right.resolve('receipt', 'one').label, 'changed')
  } finally { left.close(); kernel.close() }
})

test('shared Store invalidation, stale CAS, nested rollback, session filter and reopen preserve rows', () => {
  const path = join(scratch, 'transactions.sqlite')
  const left = Store.open({ path })
  const right = upper.UpperStore.open({ path })
  try {
    left.save('receipt', row('one', 'initial'))
    left.save('receipt', row('two', 'other-session', 1, 'session-b'))
    const managed = right.resolve('receipt', 'one')
    managed.label = 'written-through'
    right.save('receipt', row('one', 'new', 2), { expectedVersion: 1 })
    assert.equal(left.resolve('receipt', 'one').label, 'new')
    assert.throws(() => right.save('receipt', row('one', 'stale', 3), { expectedVersion: 1 }), /version_conflict/)
    assert.equal(managed.label, 'new')
    assert.throws(() => left.save('receipt', row('missing', 'stale', 2), { expectedVersion: 1 }), /version_conflict/)
    assert.equal(left.list('receipt').length, 2)
    assert.throws(() => left.transaction(store => {
      store.resolve('receipt', 'one').label = 'outer'
      assert.throws(() => store.transaction(inner => {
        inner.resolve('receipt', 'one').label = 'inner'
        inner.appendEvent('rolled-back-inner', { marker: 1 })
        throw new Error('inner rollback')
      }), /inner rollback/)
      assert.equal(store.resolve('receipt', 'one').label, 'outer')
      store.appendEvent('rolled-back-outer', { marker: 2 })
      throw new Error('outer rollback')
    }), /outer rollback/)
    assert.equal(right.resolve('receipt', 'one').label, 'new')
    assert.deepEqual(left.events(), [])
    // Exact upstream shares a connection but keeps transactionContext on each
    // Store: a nested transaction on another owner is rejected, never committed.
    assert.throws(() => left.transaction(() => {
      right.transaction(() => right.resolve('receipt', 'one').label = 'cross-store')
    }), /connection already has an active transaction/)
    assert.equal(left.resolve('receipt', 'one').label, 'new')
    assert.equal(right.resolve('receipt', 'one').label, 'new')
    left.transaction(store => {
      store.resolve('receipt', 'one').label = 'committed'
      store.appendEvent('committed', { marker: 3 })
    })
    assert.deepEqual(right.list('receipt', { sessionId: 'session-a' }).map(item => item.id), ['one'])
    assert.deepEqual(right.list('receipt', { sessionId: 'session-b' }).map(item => item.id), ['two'])
    left.close()
    assert.equal(right.resolve('receipt', 'one').label, 'committed')
  } finally { left.close(); right.close() }
  const reopened = Store.open({ path })
  try {
    assert.equal(reopened.stats().schemaVersion, 1)
    assert.equal(reopened.resolve('receipt', 'one').label, 'committed')
    assert.equal(reopened.resolve('receipt', 'two').label, 'other-session')
    assert.equal(reopened.events({ kind: 'committed' }).length, 1)
  } finally { reopened.close() }
})

test('cache namespaces invalidate across service proxies sharing the same entity cache', () => {
  const cache = storage.cache.createEntityCache()
  let value = 'before'
  let reads = 0
  const service = { readValue() { reads++; return value }, writeValue(next) { value = next } }
  const first = storage.cache.createServiceProxy(service, cache, { namespace: 'shared' })
  const second = storage.cache.createServiceProxy(service, cache, { namespace: 'shared' })
  assert.equal(first.readValue(), 'before')
  assert.equal(second.readValue(), 'before')
  assert.equal(reads, 1)
  second.writeValue('after')
  assert.equal(first.readValue(), 'after')
  assert.equal(reads, 2)
})

test('native 0.7.8 workflow and budget ledger persist in the copied schema and rehydrate', async () => {
  const path = join(scratch, 'kernel-budget.sqlite')
  const options = { tenantId: 'tenant-a', rootId: 'root-a', storePath: path, clock: () => now, budgetLimits: { calls: 10 } }
  const kernel = upper.createKernel(options)
  try {
    kernel.flow.startSession({ sessionId: 'session' })
    kernel.flow.beginTurn({ turnId: 'turn', sessionId: 'session' })
    kernel.flow.captureIntent({ intentId: 'intent', turnId: 'turn', text: 'verify copied store' })
    kernel.flow.confirmIntent({ intentId: 'intent' })
    kernel.flow.createMission({ missionId: 'mission', intentId: 'intent' })
    kernel.flow.createGoal({ goalId: 'goal', missionId: 'mission', contractVersion: '1', acceptanceCriteria: ['stored'] })
    kernel.flow.createPlan({ planId: 'plan', goalId: 'goal', bounds: { maxAttempts: 1, deadline: '2027-01-01T00:00:00.000Z', progressMetric: 'done', deadLetterOwner: 'host' }, tasks: [{ taskId: 'task' }] })
    kernel.flow.readyTasks({ planId: 'plan' })
    const started = await kernel.flow.startAction({ actionId: 'action', taskId: 'task', operationId: 'operation', effect: 'read', budget: { calls: 1 } })
    assert.equal(started.reservation.state, 'reserved')
    const settled = await kernel.flow.settleAction({ actionId: 'action', observation: { status: 'success', value: { stored: true } }, usage: { calls: 1 }, completeTask: true, completePlan: true })
    assert.equal(settled.budget.settled.calls, 1)
    assert.equal(kernel.store.stats().schemaVersion, 1)
    assert.ok(kernel.store.list('budget_ledger').length > 0)
  } finally { kernel.close() }
  const reopened = upper.createKernel(options)
  try {
    assert.equal(reopened.snapshot().budget.settled.calls, 1)
    assert.equal(reopened.snapshot().counts.action, 1)
    assert.equal(reopened.store.resolve('action', 'action').state, 'succeeded')
    assert.equal(reopened.store.events({ kind: 'budget_ledger.transitioned' }).filter(event => event.payload.operation === 'settled').length, 1)
  } finally { reopened.close() }
})

test('0.7.8 ordinary SQLite rows reopen through exact reference without rewriting payloads', async () => {
  const { Store: CurrentStore } = await import('attention-manifest-protocol/service')
  const { DatabaseSync } = await import('node:sqlite')
  const path = join(scratch, 'existing-075.sqlite')
  const current = CurrentStore.open({ path })
  try {
    current.save('receipt', row('existing', 'preserved'))
    current.appendEvent('existing-event', { message: 'kept' }, 'existing')
  } finally { current.close() }
  const before = new DatabaseSync(path)
  const original = before.prepare('SELECT payload FROM entities WHERE id = ?').get('existing').payload
  before.close()
  const copied = Store.open({ path })
  try {
    assert.equal(copied.resolve('receipt', 'existing').label, 'preserved')
    assert.equal(copied.events({ kind: 'existing-event' })[0].payload.message, 'kept')
    copied.save('receipt', row('added', 'alongside'))
  } finally { copied.close() }
  const after = new DatabaseSync(path)
  try {
    assert.equal(after.prepare('SELECT payload FROM entities WHERE id = ?').get('existing').payload, original)
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM entities').get().count, 2)
  } finally { after.close() }
})
