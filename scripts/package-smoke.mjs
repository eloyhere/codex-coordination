#!/usr/bin/env node
/** Verify that the installed payload runs outside this repository's node_modules. */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'coordination-package-'))
try {
  const plugin = join(directory, 'plugin')
  cpSync(fileURLToPath(new URL('../plugins/codex-coordination', import.meta.url)), plugin, { recursive: true })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./mcp-smoke.mjs', import.meta.url)), '--server', join(plugin, 'mcp/server.mjs')], { encoding: 'utf8', timeout: 30_000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(directory, { recursive: true, force: true }) }
