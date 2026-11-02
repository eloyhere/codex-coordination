#!/usr/bin/env node
/**
 * Validate the marketplace and every plugin it lists.
 *
 * Codex discovers a plugin through `marketplace.json`, loads
 * `.codex-plugin/plugin.json`, then resolves `skills/`, `mcpServers` and the
 * files named by `interface`. A typo in any of those paths fails silently at
 * runtime, so this script checks them up front:
 *
 * - the marketplace parses, has a name, and lists at least one local plugin;
 * - each plugin directory exists and carries a manifest whose name matches;
 * - the manifest's version, skills and MCP configuration are present and point
 *   at files that exist;
 * - every skill has YAML frontmatter whose `name` matches its directory and a
 *   non-empty `description`;
 * - every `coordination_*` identifier used by a skill is a real MCP tool.
 *
 * Exit code 0 means the package is internally consistent; it says nothing about
 * whether Codex accepts the marketplace (run `codex plugin marketplace add`).
 *
 * @module codex-coordination/scripts/validate
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOOL_NAMES } from '../plugins/codex-coordination/mcp/lib/tools.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACE_PATH = join(ROOT, '.agents', 'plugins', 'marketplace.json')

/** @type {string[]} */
const failures = []
/** @type {string[]} */
const notes = []

/**
 * Record a failure.
 * @param {boolean} condition - the assertion.
 * @param {string} message - printed when the assertion fails.
 * @returns {void}
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

/**
 * Read and parse one JSON file.
 * @param {string} path - absolute path.
 * @param {string} label - name used in error messages.
 * @returns {any} the parsed value, or `null` when unreadable.
 */
function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`${label}: file not found (${relative(ROOT, path)})`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}

/**
 * Parse the small YAML frontmatter block a SKILL.md carries.
 *
 * Only flat `key: value` pairs are supported, which is all the skill format
 * needs; anything else is reported rather than silently half-parsed.
 *
 * @param {string} text - file contents.
 * @returns {{ data: Record<string, string>, body: string }|null} frontmatter and body.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return null
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const separator = line.indexOf(':')
    if (separator <= 0) return null
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: match[2] }
}

const ID_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const packageJson = readJson(join(ROOT, 'package.json'), 'package.json')
if (packageJson !== null) {
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    const match = /^node\s+(scripts\/\S+)/.exec(command)
    if (match !== null) check(existsSync(join(ROOT, match[1])), `package.json: script ${name} points at a missing file (${match[1]})`)
  }
}

const marketplace = readJson(MARKETPLACE_PATH, 'marketplace.json')
if (marketplace !== null) {
  check(typeof marketplace.name === 'string' && marketplace.name.length > 0, 'marketplace.json: name is required')
  check(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'marketplace.json: plugins must be a non-empty array')
  const seen = new Set()
  for (const [index, entry] of (marketplace.plugins ?? []).entries()) {
    const label = `marketplace.json: plugins[${index}]`
    if (entry === null || typeof entry !== 'object') {
      failures.push(`${label} must be an object`)
      continue
    }
    check(typeof entry.name === 'string' && ID_PATTERN.test(entry.name), `${label}: name must match ${ID_PATTERN.source}`)
    if (typeof entry.name === 'string') {
      check(!seen.has(entry.name), `${label}: duplicate plugin name ${entry.name}`)
      seen.add(entry.name)
    }
    const source = entry.source
    check(source !== null && typeof source === 'object', `${label}: source is required`)
    if (source === null || typeof source !== 'object') continue
    check(source.source === 'local', `${label}: only local sources are supported here (got ${String(source.source)})`)
    if (typeof source.path !== 'string') {
      failures.push(`${label}: source.path is required for a local source`)
      continue
    }
    const pluginRoot = resolve(ROOT, source.path)
    check(pluginRoot.startsWith(ROOT), `${label}: source.path must stay inside the repository`)
    check(existsSync(pluginRoot) && statSync(pluginRoot).isDirectory(), `${label}: source.path does not exist`)
    const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json')
    const manifest = readJson(manifestPath, `${entry.name}/plugin.json`)
    if (manifest === null) continue
    const manifestLabel = `${entry.name}/plugin.json`
    check(manifest.name === entry.name, `${manifestLabel}: name must match the marketplace entry (${String(manifest.name)})`)
    check(typeof manifest.version === 'string' && SEMVER.test(manifest.version), `${manifestLabel}: version must be semver`)
    check(typeof manifest.description === 'string' && manifest.description.length > 0, `${manifestLabel}: description is required`)
    check(typeof manifest.license === 'string' && manifest.license.length > 0, `${manifestLabel}: license is required`)
    check(existsSync(join(ROOT, 'LICENSE')), 'LICENSE is missing at the repository root')

    const face = manifest.interface
    check(face !== null && typeof face === 'object', `${manifestLabel}: interface is required`)
    if (face !== null && typeof face === 'object') {
      for (const key of ['displayName', 'shortDescription', 'developerName', 'category', 'brandColor']) {
        check(typeof face[key] === 'string' && face[key].length > 0, `${manifestLabel}: interface.${key} is required`)
      }
      check(Array.isArray(face.capabilities) && face.capabilities.length > 0, `${manifestLabel}: interface.capabilities must be non-empty`)
      check(Array.isArray(face.defaultPrompt), `${manifestLabel}: interface.defaultPrompt must be an array`)
      for (const key of ['composerIcon', 'logo', 'logoDark']) {
        if (face[key] === undefined) continue
        check(existsSync(resolve(pluginRoot, face[key])), `${manifestLabel}: interface.${key} points at a missing file (${face[key]})`)
      }
    }

    if (manifest.skills !== undefined) {
      const skillsRoot = resolve(pluginRoot, manifest.skills)
      check(existsSync(skillsRoot) && statSync(skillsRoot).isDirectory(), `${manifestLabel}: skills path does not exist`)
      if (existsSync(skillsRoot)) {
        const directories = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        check(directories.length > 0, `${manifestLabel}: skills directory is empty`)
        for (const directory of directories) {
          const skillPath = join(skillsRoot, directory.name, 'SKILL.md')
          if (!existsSync(skillPath)) {
            failures.push(`${entry.name}: skill ${directory.name} has no SKILL.md`)
            continue
          }
          const parsed = parseFrontmatter(readFileSync(skillPath, 'utf8'))
          if (parsed === null) {
            failures.push(`${entry.name}: skill ${directory.name} has no YAML frontmatter`)
            continue
          }
          check(parsed.data.name === directory.name, `${entry.name}: skill ${directory.name} frontmatter name must match its directory`)
          check(typeof parsed.data.description === 'string' && parsed.data.description.length > 20, `${entry.name}: skill ${directory.name} needs a description`)
          check(parsed.body.trim().length > 0, `${entry.name}: skill ${directory.name} has an empty body`)
          const referenced = new Set(parsed.body.match(/coordination_[a-z_]+/g) ?? [])
          for (const name of referenced) {
            if (!TOOL_NAMES.includes(name)) failures.push(`${entry.name}: skill ${directory.name} references unknown tool ${name}`)
          }
        }
      }
    }

    if (manifest.mcpServers !== undefined) {
      const mcpPath = resolve(pluginRoot, manifest.mcpServers)
      const mcp = readJson(mcpPath, `${entry.name}/mcpServers`)
      if (mcp !== null) {
        const servers = mcp.mcpServers ?? {}
        check(Object.keys(servers).length > 0, `${entry.name}/.mcp.json: mcpServers must not be empty`)
        for (const [name, server] of Object.entries(servers)) {
          const label = `${entry.name}/.mcp.json: mcpServers.${name}`
          if (server === null || typeof server !== 'object') {
            failures.push(`${label} must be an object`)
            continue
          }
          check(typeof server.command === 'string' && server.command.length > 0, `${label}: command is required`)
          check(Array.isArray(server.args), `${label}: args must be an array`)
          for (const variable of server.env_vars ?? []) {
            // Windows exposes mixed-case names (SystemRoot, ProgramFiles), so
            // the check is on the shape, not on upper-case convention.
            check(
              typeof variable === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable),
              `${label}: env_vars entry ${String(variable)} is not an environment variable name`,
            )
          }
          const scriptish = (server.args ?? []).find((argument) => typeof argument === 'string' && /\.(cmd|ps1|sh|mjs|js)$/.test(argument))
          if (typeof scriptish === 'string' && scriptish.startsWith('./')) {
            check(existsSync(resolve(pluginRoot, scriptish)), `${label}: launcher ${scriptish} does not exist`)
          }
        }
      }
    }

    const serverPath = join(pluginRoot, 'mcp', 'server.mjs')
    check(existsSync(serverPath), `${entry.name}: mcp/server.mjs is missing`)
    if (packageJson !== null) {
      check(manifest.version === packageJson.version, `${manifestLabel}: version must match package.json (${String(packageJson.version)})`)
    }
    if (existsSync(serverPath)) {
      const advertised = /name:\s*'codex-coordination',\s*version:\s*'([^']+)'/.exec(readFileSync(serverPath, 'utf8'))
      check(advertised !== null && advertised[1] === manifest.version, `${entry.name}: server.mjs serverInfo.version must match the manifest`)
    }
  }
}

if (failures.length === 0) {
  notes.push(`validated ${(marketplace?.plugins ?? []).length} plugin(s), ${TOOL_NAMES.length} tool(s)`)
  console.log(`ok ${notes.join('; ')}`)
  process.exit(0)
}
for (const failure of failures) console.error(`FAIL ${failure}`)
console.error(`\n${failures.length} problem(s) found`)
process.exit(1)
