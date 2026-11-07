/** A client of the existing Codex control socket; never launches another harness. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function codexGoalRpc(method: 'thread/goal/get' | 'thread/goal/set', params: Record<string, unknown>, options: { executable?: string; socket?: string; timeoutMs?: number } = {}) {
  const child = spawn(options.executable ?? process.env.CODEX_AMP_CODEX_EXE ?? 'codex', ['app-server', 'proxy', ...(options.socket ?? process.env.CODEX_AMP_CONTROL_SOCKET ? ['--sock', options.socket ?? process.env.CODEX_AMP_CONTROL_SOCKET!] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let next = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const fail = () => { for (const item of pending.values()) item.reject(Object.assign(new Error('Existing Codex control socket is unavailable'), { code: 'CODEX_UNAVAILABLE' })); pending.clear() }
  child.on('error', fail); child.on('exit', fail)
  // Drain diagnostics without copying private host paths or credentials into tool output.
  child.stderr.on('data', () => {})
  lines.on('line', line => {
    try { const value = JSON.parse(line); const item = pending.get(value.id); if (!item) return; pending.delete(value.id); value.error ? item.reject(Object.assign(new Error('Codex API rejected request: ' + String(value.error.message)), { code: 'CODEX_REJECTED' })) : item.resolve(value.result) } catch {}
  })
  const request = (name: string, arguments_: Record<string, unknown>) => new Promise<any>((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method: name, params: arguments_ }) + '\n') })
  child.stdin.on('error', fail)
  const timer = setTimeout(() => { fail(); child.kill() }, options.timeoutMs ?? 2500)
  try {
    await request('initialize', { clientInfo: { name: 'codex-coordination', version: '0.6.3' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return await request(method, params)
  } finally { clearTimeout(timer); fail(); lines.close(); child.kill() }
}
