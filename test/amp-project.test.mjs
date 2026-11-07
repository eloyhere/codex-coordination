import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAmpSurface } from '../plugins/codex-coordination/mcp/amp/surface.mjs'
import { openNativeStore, nativeRequest } from '../plugins/codex-coordination/mcp/amp/native-store.mjs'
import { Project, createProjectToolHandlers } from 'attention-manifest-protocol/project'
import { createHash } from 'node:crypto'

test('native project environment and rules persist with CAS, idempotency and workspace isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amp07-project-'))
  const other = mkdtempSync(join(tmpdir(), 'amp07-project-other-'))
  let workspace = root
  const call = (verb, args = {}) => withAmpSurface([], () => workspace).find(tool => tool.name === 'attention_manifest_protocol_project.' + verb).handler(args)
  try {
    const empty = await call('environment')
    const input = { idempotencyKey: 'env-1', variables: { AMP_MODE: 'test' }, paths: ['src'], dependencies: [{ id: 'node', scope: 'runtime' }], expectedVersion: empty.version }
    const written = await call('configure_environment', input)
    assert.equal(written.environment.variables.AMP_MODE, 'test')
    assert.equal((await call('environment')).version, written.version)
    assert.equal((await call('configure_environment', input)).replayed, true)
    await assert.rejects(call('configure_environment', { ...input, idempotencyKey: 'env-2', variables: { AMP_MODE: 'stale' } }))
    await assert.rejects(call('configure_environment', { ...input, variables: { AMP_MODE: 'different' } }), /Idempotency/)
    assert.equal((await call('environment')).environment.variables.AMP_MODE, 'test')
    const rule = await call('put_rule', { idempotencyKey: 'rule-1', id: 'testing', text: 'Run checks before delivery' })
    assert.equal((await call('rules')).rules[0].hash, rule.hash)
    await assert.rejects(call('put_rule', { idempotencyKey: 'rule-2', id: 'testing', text: 'New text' }))
    const changed = await call('put_rule', { idempotencyKey: 'rule-3', id: 'testing', text: 'Updated rule', expectedVersion: rule.version })
    assert.ok(changed.version > rule.version)
    assert.equal((await call('rules')).rules[0].text, 'Updated rule')
    assert.ok((await call('describe_environment')).description.length > 0)
    await assert.rejects(call('configure_environment', { idempotencyKey: 'spoof', variables: { sessionId: 'spoof' } }))
    workspace = other
    assert.equal((await call('rules')).rules.length, 0)
    assert.equal((await call('environment')).environment.variables.AMP_MODE, undefined)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})

test('old command journals migrate once to native entities without changing hashes, versions or retry results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amp07-project-migrate-'))
  try {
    const at = '2026-11-07T00:00:00.000Z'
    const project = new Project({ tenantId: 'local', rootId: createHash('sha256').update(realpathSync(root)).digest('hex'), clock: () => at })
    const native = createProjectToolHandlers(project)
    const name = 'attention_manifest_protocol_project.put_rule'
    const parameters = { id: 'old-rule', text: 'Original rule' }
    const result = native[name](parameters, {})
    let { store } = openNativeStore(() => root)
    store.appendEvent('codex.amp.project.command', { name, parameters, at, key: 'codex:old-retry', request: nativeRequest({ name, parameters }), result })
    store.close()
    const call = (verb, args = {}) => withAmpSurface([], () => root).find(tool => tool.name === 'attention_manifest_protocol_project.' + verb).handler(args)
    const restored = (await call('rules')).rules[0]
    assert.deepEqual(restored, result)
    assert.equal((await call('put_rule', { ...parameters, idempotencyKey: 'old-retry' })).replayed, true)
    assert.equal((await call('rules')).rules[0].updatedAt, at)
    ;({ store } = openNativeStore(() => root))
    assert.equal(store.list('project_rule').length, 1)
    assert.equal(store.events({ kind: 'codex.amp.project.entity_migration' }).length, 1)
    assert.equal(store.events({ kind: 'codex.amp.project.command' }).length, 1)
    store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('inconsistent old project journals fail migration atomically and preserve their original events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amp07-project-corrupt-'))
  try {
    let { store } = openNativeStore(() => root)
    store.appendEvent('codex.amp.project.command', { name: 'attention_manifest_protocol_project.put_rule', parameters: { id: 'bad', text: 'Rule' }, at: '2026-11-07T00:00:00Z', key: 'old', request: '{}', result: { hash: 'incorrect' } })
    store.close()
    const read = withAmpSurface([], () => root).find(tool => tool.name === 'attention_manifest_protocol_project.rules')
    await assert.rejects(read.handler({}), /does not match native replay/)
    ;({ store } = openNativeStore(() => root))
    assert.equal(store.list('project_rule').length, 0)
    assert.equal(store.events({ kind: 'codex.amp.project.entity_migration' }).length, 0)
    assert.equal(store.events({ kind: 'codex.amp.project.command' }).length, 1)
    store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
