/** Optional host-configured local Elasticsearch lifecycle; retrieval remains AMP's. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import type { SearchProcessConfig } from './config.mjs'
import { processEnvironment } from './config.mjs'
export class SearchProcess {
  private process?: ChildProcess
  private starting?: Promise<void>
  constructor(private readonly node: string, private readonly config?: SearchProcessConfig) {}
  private async reachable() {
    try { const result = await fetch(this.node, { signal: AbortSignal.timeout(1000) }); await result.body?.cancel(); return result.status < 500 } catch { return false }
  }
  async ensure() {
    if (!this.config || await this.reachable()) return
    if (this.starting) return this.starting
    this.starting = this.start()
    try { await this.starting } finally { this.starting = undefined }
  }
  private async start() {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.node).hostname)) throw new Error('searchProcess may start only a loopback search endpoint')
    const config = this.config!
    const child = this.process?.exitCode === null ? this.process : spawn(config.command, config.args ?? [], { cwd: config.cwd, env: processEnvironment(config.env, config.envVars), windowsHide: true, shell: false, stdio: 'ignore' })
    let failure = false
    child.once('error', () => { failure = true })
    this.process = child
    if (config.keepAlive) child.unref()
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (await this.reachable()) return
      if (failure) throw new Error('Configured local search process could not start')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Configured local search service did not become ready within 45 seconds')
  }
  async close() {
    const child = this.process
    if (!child || this.config?.keepAlive) return
    this.process = undefined
    if (process.platform === 'win32' && child.pid && child.exitCode === null) await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
    else child.kill()
  }
}
