import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureCacheIgnored } from '../plugins/codex-coordination/mcp/lib/cache-ignore.mjs'
import { makeWorkspace, seedGoal } from './helpers.mjs'
import { ingestHook } from '../plugins/codex-coordination/mcp/codex/events.mjs'

test('cache creation excludes legacy and native persistence at project level without replacing existing rules', async t => {
  for (const mode of ['legacy', 'native']) {
    const root = makeWorkspace(t)
    writeFileSync(join(root, '.gitignore'), '# existing\r\nkeep-this')
    if (mode === 'legacy') await seedGoal(root)
    else ingestHook({ cwd: root, session_id: 'ignore-test', hook_event_name: 'SessionStart' })
    const expected = '# existing\r\nkeep-this\r\n/.codex-coordination/\r\n'
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), expected)
    ensureCacheIgnored(root)
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), expected)
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true })
    const ignored = execFileSync('git', ['-C', root, 'check-ignore', '.codex-coordination/amp-07/store.sqlite', '.codex-coordination/ledger.json'], { encoding: 'utf8', windowsHide: true })
    assert.match(ignored, /amp-07\/store.sqlite/)
    assert.match(ignored, /ledger.json/)
  }
})

test('detected Mercurial, Bazaar and Fossil projects receive their own preserved ignore formats', t => {
  const root = makeWorkspace(t)
  for (const marker of ['.hg', '.bzr', '.fossil-settings']) mkdirSync(join(root, marker))
  writeFileSync(join(root, '.hgignore'), 'syntax: glob\n*.log\n')
  writeFileSync(join(root, '.bzrignore'), '*.tmp\n')
  writeFileSync(join(root, '.fossil-settings', 'ignore-glob'), '*.bak\n')
  ensureCacheIgnored(root)
  const paths = ['.hgignore', '.bzrignore', '.fossil-settings/ignore-glob']
  const before = paths.map(path => readFileSync(join(root, path), 'utf8'))
  assert.match(before[0], /^syntax: glob\n\*\.log\nsyntax: regexp\n\^/)
  assert.match(before[1], /\*\.tmp\n\.\/\.codex-coordination\n/)
  assert.match(before[2], /\*\.bak\n\.codex-coordination\n\.codex-coordination\/\*\n/)
  ensureCacheIgnored(root)
  assert.deepEqual(paths.map(path => readFileSync(join(root, path), 'utf8')), before)
})

test('ignore configuration refuses links outside the selected project', t => {
  const root = makeWorkspace(t), other = makeWorkspace(t)
  symlinkSync(other, join(root, '.fossil-settings'), 'junction')
  assert.throws(() => ensureCacheIgnored(root), /remain within the project/)
})
