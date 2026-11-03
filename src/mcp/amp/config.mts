import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
export interface EndpointConfig {
  id: string; family: 'mcp' | 'a2a' | 'amp-team' | 'cooperation'; name?: string; url?: string; command?: string; args?: string[]; cwd?: string
  env?: Record<string, string>; headers?: Record<string, string>; headerEnv?: Record<string, string>; timeoutMs?: number
  envVars?: string[]
  budget?: { tokens?: number; calls?: number; ms?: number; money?: number }; maxResultTokens?: number
  catalogVersion?: number
  signingKid?: string; signer?: string
}
export interface ListenerConfig { id: string; host?: string; port?: number; path?: string; maxBodyBytes?: number }
export interface SearchProcessConfig { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; envVars?: string[]; keepAlive?: boolean }
export function processEnvironment(extra?: Record<string, string>, forward: string[] = []) {
  const names = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramW6432', ...forward]
  return { ...Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!])), ...extra }
}
export interface HostConfiguration {
  searchNode?: string
  searchProcess?: SearchProcessConfig
  searchConnection?: Record<string, any>
  endpoints?: EndpointConfig[]
  listeners?: ListenerConfig[]
  llm?: { apiKeyEnv: string; baseUrl?: string; model?: string; timeoutMs?: number; retries?: number; inputMissPricePerMTok?: number; inputHitPricePerMTok?: number; outputPricePerMTok?: number }
}
export function readHostConfiguration(): HostConfiguration {
  const path = process.env.CODEX_AMP_HOST_CONFIG ?? join(homedir(), '.codex', 'coordination', 'host.json')
  if (!existsSync(path)) return {}
  const config = JSON.parse(readFileSync(path, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid AMP host configuration')
  return config
}
