import { useEffect, useRef, useState } from 'react'
import { PeriodicityTheme, PeriodicityInternational, PeriodicityButton as Button, PeriodicityCard as Card, PeriodicityChip as Chip, PeriodicityTextInput as TextInput } from 'periodicity-react'
import { connect, type Connection } from './bridge'
import { toolValue, type SettingsView } from '../mcp/contracts.mjs'
import { AmpWorkbench } from './AmpWorkbench'

/** The plugin UI is settings-only; notifications never mount a view. */
export function Dashboard() {
  const [workspace, setWorkspace] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [connection, setConnection] = useState<Connection>()
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>('system')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [interfaces, setInterfaces] = useState<SettingsView['interfaces']>()
  const generation = useRef(0)
  useEffect(() => {
    let disposed = false, live: Connection | undefined
    const theme = () => setMode(document.documentElement.dataset.hostTheme === 'dark' ? 'dark' : document.documentElement.dataset.hostTheme === 'light' ? 'light' : 'system')
    window.addEventListener('coordination-theme', theme)
    void connect(result => {
      if (disposed) return
      try {
        const value = toolValue(result)
        if (typeof value.workspace === 'string' && (value.protocol || value.view === 'settings')) {
          generation.current++
          setWorkspace(value.workspace); setSelected(value.workspace)
          setInterfaces(value.view === 'settings' ? value.interfaces as SettingsView['interfaces'] : undefined)
          setBusy(false); setError('')
        }
      } catch { /* Unrelated tool results do not replace settings. */ }
    }).then(value => { live = value; if (disposed) value.close(); else setConnection(value) }).catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true; live?.close(); window.removeEventListener('coordination-theme', theme) }
  }, [])
  async function open() {
    if (!connection || !workspace.trim()) return
    const current = ++generation.current
    setBusy(true); setError('')
    setSelected(null); setInterfaces(undefined)
    try {
      const result = toolValue(await connection.call('coordination_dashboard', { workspace: workspace.trim(), view: 'settings' }))
      if (current !== generation.current) return
      if (typeof result.workspace !== 'string') throw new Error('未收到有效项目路径')
      setSelected(result.workspace); setWorkspace(result.workspace); setInterfaces(result.interfaces as SettingsView['interfaces'])
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === generation.current) setBusy(false) }
  }
  return <PeriodicityTheme theme={mode === 'dark' ? 'space-gray' : 'default'} mode={mode}><PeriodicityInternational locale="zh-CN"><main className="dashboard" aria-busy={busy}>
    <header className="masthead"><div className="brand"><span className="brand-mark" aria-hidden="true">Co</span><div><span className="eyebrow">ATTENTION MANIFEST PROTOCOL</span><h1>AMP 设置</h1></div></div><Chip label={connection?.preview ? '本地预览 · 只读' : connection ? 'Codex 已连接' : '正在连接宿主'} /></header>
    <Card title="项目设置" eyebrow="WORKSPACE"><form className="workspace-form" onSubmit={event => { event.preventDefault(); void open() }}><TextInput label="仓库绝对路径" value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="例如 R:\project\my-project" disabled={busy} required /><Button type="submit" disabled={!connection || busy || !workspace.trim()}>打开设置</Button></form></Card>
    {error && <p role="alert">{error}</p>}
    {selected && <section className="settings-content" aria-label="当前项目配置"><p className="muted">当前设置项目：{selected}</p><AmpWorkbench key={selected} connection={connection} workspace={selected} interfaces={interfaces} /></section>}
  </main></PeriodicityInternational></PeriodicityTheme>
}
