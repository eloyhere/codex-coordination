import { useState } from 'react'
import { PeriodicityButton as Button, PeriodicityCard as Card, PeriodicityTextArea as TextArea, PeriodicityAlert as Alert } from 'periodicity-react'
import type { Connection } from './bridge'
import { toolValue } from '../mcp/contracts.mjs'

const hostTools = ['coordination_registry', 'coordination_amp', 'coordination_artifacts', 'coordination_context', 'coordination_hooks', 'coordination_keys', 'coordination_connections', 'coordination_runtime', 'coordination_workspace']
const examples: Record<string, Record<string, unknown>> = {
  coordination_registry: { registry: 'skills', action: 'list' },
  coordination_amp: { action: 'describe' }, coordination_artifacts: { action: 'list' },
  coordination_context: { action: 'search', query: 'coordination_project' }, coordination_hooks: { action: 'describe' },
  coordination_keys: { action: 'list' }, coordination_connections: { action: 'list' },
  coordination_runtime: { action: 'turns', pid: 1 }, coordination_workspace: { action: 'status' },
  coordination_goal: { action: 'list' }, coordination_mission: { action: 'list' }, coordination_plan: { action: 'list' },
  coordination_knowledge: { action: 'list' }, coordination_project: { action: 'detect' }, coordination_search: { query: 'coordination_project', size: 3 },
  coordination_file: { depth: 2, limit: 30 }, coordination_outline: { limit: 30 }, coordination_importation: { limit: 20 }, coordination_exportation: { limit: 20 },
  coordination_control: { registry: 'skills', action: 'list' }, coordination_workspace_adjust: { registry: 'skills', action: 'list' },
  coordination_collaboration: { action: 'list' }, coordination_index: { action: 'index' },
  coordination_notification: { surface: 'snackbar', message: '工作区通知' },
}
export function AmpWorkbench({ connection, workspace }: { connection?: Connection; workspace: string }) {
  const [tools, setTools] = useState(hostTools)
  const [selected, setSelected] = useState('coordination_registry')
  const [request, setRequest] = useState(JSON.stringify(examples.coordination_registry, null, 2))
  const [result, setResult] = useState<unknown>()
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function bind() {
    if (!connection) return
    setBusy(true); setError('')
    try {
      const value = toolValue(await connection.call('coordination_workspace', { workspace, verbosity: 'full' }))
      const metrics = toolValue(await connection.call('coordination_context', { action: 'metrics', verbosity: 'full' }))
      const names = (metrics.catalog as { names?: string[] })?.names ?? []
      setTools([...new Set([...hostTools, ...value.tools as string[], ...names])]); setConnected(true); setResult(value)
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  async function run() {
    if (!connection) return
    setBusy(true); setError('')
    try {
      const input = JSON.parse(request)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是 JSON 对象')
      setResult(toolValue(await connection.call(selected, input)))
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <div className="record-list">
    <Card title="AMP 能力工作台" eyebrow="NATIVE AMP">
      <p className="muted">连接当前仓库后，可读写注册中心、使用文件与搜索工具、调用领域算法，并管理运行时、上下文和签名。参数与返回值来自 AMP。</p>
      <Button disabled={busy || connection?.preview || !connection} onClick={() => void bind()}>{connected ? '重新连接 AMP' : '连接 AMP'}</Button>
      {connection?.preview && <p className="muted">请在 Codex 中打开工作台以使用宿主能力。</p>}
    </Card>
    {connected && <Card title="调用能力" eyebrow="TOOLS">
      <label className="amp-tool-label">AMP 工具<select aria-label="AMP 工具" value={selected} onChange={event => { const name = event.target.value; setSelected(name); setRequest(JSON.stringify(examples[name] ?? {}, null, 2)) }}>{tools.map(tool => <option key={tool} value={tool}>{tool}</option>)}</select></label>
      <TextArea label="工具参数 JSON" value={request} onChange={event => setRequest(event.target.value)} rows={12} />
      <div className="editor-actions"><Button disabled={busy} onClick={() => void run()}>执行调用</Button></div>
    </Card>}
    {error && <Alert tone="danger" title="调用失败" description={error} />}
    {result !== undefined && <Card title="执行结果" eyebrow="RESULT"><pre aria-label="AMP 执行结果">{JSON.stringify(result, null, 2)}</pre></Card>}
  </div>
}
