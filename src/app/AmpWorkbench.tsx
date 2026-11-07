import { useState } from 'react'
import { PeriodicityButton as Button, PeriodicityCard as Card, PeriodicityTextArea as TextArea, PeriodicityAlert as Alert } from 'periodicity-react'
import type { Connection } from './bridge'
import { toolValue, SETTINGS_INTERFACES, type SettingsView } from '../mcp/contracts.mjs'

const examples: Record<string, Record<string, unknown>> = {
  coordination_registry: { registry: 'skills', action: 'list' },
  coordination_environment: { action: 'list' },
  coordination_keys: { action: 'list' }, coordination_connections: { action: 'list' },
}
export function AmpWorkbench({ connection, workspace, interfaces }: { connection?: Connection; workspace: string; interfaces?: SettingsView['interfaces'] }) {
  const [catalog, setCatalog] = useState(interfaces ?? SETTINGS_INTERFACES.map(item => ({ ...item, inputSchema: {} })))
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
      const metadata = toolValue(await connection.call('coordination_dashboard', { workspace, view: 'settings' })) as unknown as SettingsView
      if (!metadata.interfaces.length) throw new Error('宿主未注册可用的设置接口')
      setCatalog(metadata.interfaces)
      if (!metadata.interfaces.some(item => item.name === selected)) {
        const name = metadata.interfaces[0].name; setSelected(name); setRequest(JSON.stringify(examples[name] ?? {}, null, 2))
      }
      const value = toolValue(await connection.call('coordination_workspace', { workspace, verbosity: 'compact' }))
      if (value.workspace !== workspace) throw new Error('项目绑定与设置页不一致，请重新打开设置')
      setConnected(true); setResult(value)
    } catch (error) { setConnected(false); setResult(undefined); setError(String(error)) }
    finally { setBusy(false) }
  }
  async function run() {
    if (!connection) return
    setBusy(true); setError(''); setResult(undefined)
    try {
      const input = JSON.parse(request)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是 JSON 对象')
      if (!catalog.some(item => item.name === selected)) throw new Error('所选设置接口未注册')
      const bound = toolValue(await connection.call('coordination_workspace', { workspace, verbosity: 'compact' }))
      if (bound.workspace !== workspace) throw new Error('项目绑定已变化，请重新连接设置')
      setResult(toolValue(await connection.call(selected, { ...input, expectedWorkspace: workspace })))
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <div className="record-list">
    <Card title="AMP 配置" eyebrow="SETTINGS">
      <p className="muted">管理当前项目的注册中心、环境、连接和密钥设置。</p>
      <Button disabled={busy || connection?.preview || !connection} onClick={() => void bind()}>{connected ? '重新连接设置' : '连接项目设置'}</Button>
      {connection?.preview && <p className="muted">请在 Codex 中打开工作台以使用宿主能力。</p>}
    </Card>
    {connected && <Card title="配置项" eyebrow="CONFIGURATION">
      <label className="amp-tool-label">设置接口<select aria-label="设置接口" value={selected} disabled={busy} onChange={event => { const name = event.target.value; setSelected(name); setRequest(JSON.stringify(examples[name] ?? {}, null, 2)); setResult(undefined); setError('') }}>{catalog.map(tool => <option key={tool.name} value={tool.name}>{tool.label}</option>)}</select></label>
      <TextArea label="设置参数 JSON" value={request} disabled={busy} onChange={event => setRequest(event.target.value)} rows={12} />
      <details><summary>查看参数格式</summary><pre>{JSON.stringify(catalog.find(item => item.name === selected)?.inputSchema, null, 2)}</pre></details>
      <div className="editor-actions"><Button disabled={busy} onClick={() => void run()}>读取或应用设置</Button></div>
    </Card>}
    {error && <Alert tone="danger" title="调用失败" description={error} />}
    {result !== undefined && <Card title="设置数据" eyebrow="SETTINGS DATA"><pre aria-label="AMP 设置数据">{JSON.stringify(result, null, 2)}</pre></Card>}
  </div>
}
