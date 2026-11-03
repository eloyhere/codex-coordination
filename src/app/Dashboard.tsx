import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  PeriodicityTheme, PeriodicityInternational, PeriodicityButton as Button,
  PeriodicityCard as Card, PeriodicityChip as Chip, PeriodicityTextInput as TextInput,
  PeriodicityTextArea as TextArea, PeriodicityTabs as Tabs, PeriodicityTabPanel as TabPanel,
  PeriodicityAlert as Alert, PeriodicityRing as Ring,
} from 'periodicity-react'
import { connect, type Connection } from './bridge'
import { toolValue, type DashboardData, type ToolResponse } from '../mcp/contracts.mjs'
import { AmpWorkbench } from './AmpWorkbench'
import { NotificationCenter, useNotifications } from './Notifications'

const tabs = [{ value: 'goals', label: '目标' }, { value: 'plans', label: '计划' }, { value: 'duties', label: '交接' }, { value: 'protocol', label: '注意与回执' }, { value: 'audit', label: '审计' }, { value: 'amp', label: 'AMP 能力' }]
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div> }
function readDashboard(result: ToolResponse): DashboardData {
  const value = toolValue(result)
  if (!('protocol' in value) || !('workspace' in value)) throw new Error('未收到工作区视图')
  return value as unknown as DashboardData
}

export function Dashboard() {
  const [workspace, setWorkspace] = useState('')
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>('system')
  const [data, setData] = useState<DashboardData>()
  const [connection, setConnection] = useState<Connection>()
  const [tab, setTab] = useState('goals')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const notifications = useNotifications()
  const [notificationOnly, setNotificationOnly] = useState(false)
  const [json, setJson] = useState('')
  const [validation, setValidation] = useState<{ ok: boolean; problems: string[]; digest?: string }>()
  const generation = useRef(0)
  const activeWorkspace = useRef<string | null>(null)

  useEffect(() => {
    const updateTheme = () => setMode(document.documentElement.dataset.hostTheme === 'dark' ? 'dark' : document.documentElement.dataset.hostTheme === 'light' ? 'light' : 'system')
    window.addEventListener('coordination-theme', updateTheme)
    let disposed = false
    let live: Connection | undefined
    void connect(result => {
      if (disposed) return
      try {
        const value = toolValue(result)
        if (Array.isArray(value.notifications) && value.notifications.length) {
          notifications.receive(value.notifications)
          if (!activeWorkspace.current) setNotificationOnly(true)
          return
        }
        const next = readDashboard(result)
        setNotificationOnly(false)
        activeWorkspace.current = next.workspace
        setData(next)
        setWorkspace(next.workspace ?? '')
      } catch { /* Results of other tools do not replace the dashboard. */ }
    }).then(value => {
      live = value
      if (disposed) { value.close(); return }
      setConnection(value)
    }).catch(reason => { if (!disposed) setError(`连接宿主失败：${message(reason)}`) })
    return () => { disposed = true; live?.close(); window.removeEventListener('coordination-theme', updateTheme) }
  }, [notifications.receive])

  async function load(path = activeWorkspace.current ?? workspace) {
    if (!connection || !path.trim()) return
    const current = ++generation.current
    setBusy(true); setError(''); setNotice(''); setValidation(undefined)
    if (path !== activeWorkspace.current) { setData(undefined); activeWorkspace.current = null }
    try {
      const next = readDashboard(await connection.call('coordination_dashboard', { workspace: path.trim() }))
      if (current !== generation.current) return
      activeWorkspace.current = next.workspace
      setData(next); setWorkspace(next.workspace ?? '')
    } catch (reason) { if (current === generation.current) setError(message(reason)) }
    finally { if (current === generation.current) setBusy(false) }
  }

  async function exportSnapshot() {
    if (!connection || !data?.workspace) return
    setBusy(true); setError('')
    try {
      const result = toolValue(await connection.call('coordination_check', { workspace: data.workspace, action: 'snapshot' }))
      setJson(JSON.stringify(result.snapshot, null, 2)); setValidation(undefined); setTab('protocol')
      setNotice('快照已导出至下方 JSON 面板，可选中并复制。')
    } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }

  async function artifactAction(record: boolean) {
    if (!connection || !data?.workspace) return
    setBusy(true); setError(''); setNotice(''); setValidation(undefined)
    try {
      const artifact: unknown = JSON.parse(json)
      const response = await connection.call('coordination_protocol', { workspace: data.workspace, action: record ? 'record' : 'validate', artifact })
      if (response.isError) toolValue(response)
      const value = response.structuredContent ?? toolValue(response)
      if (record) { await load(); setNotice('协议记录已追加到台账。') }
      else setValidation(value as unknown as { ok: boolean; problems: string[]; digest?: string })
    } catch (reason) { setError(message(reason)) }
    finally { setBusy(false) }
  }

  const status = data?.status
  const matches = (value: unknown) => JSON.stringify(value).toLowerCase().includes(filter.toLowerCase())
  const connected = Boolean(connection)
  return <PeriodicityTheme theme={mode === 'dark' ? 'space-gray' : 'default'} mode={mode} radius="rounded" tokens={{ '--font-sans': '"Segoe UI", "Microsoft YaHei", sans-serif', '--font-display': '"Segoe UI", "Microsoft YaHei", sans-serif' }}><PeriodicityInternational locale="zh-CN">
    <NotificationCenter items={notifications.items} dismiss={notifications.dismiss} />
    {notificationOnly && <section className="notification-view" aria-label="通知视图">{!notifications.items.length && <p>通知已关闭</p>}</section>}
    <main className="dashboard" aria-busy={busy} hidden={notificationOnly}>
      <header className="masthead">
        <div className="brand"><span className="brand-mark" aria-hidden="true">Co</span><div><span className="eyebrow">ATTENTION MANIFEST PROTOCOL</span><h1>协作台账</h1></div></div>
        <div className="header-actions"><Chip label={connection?.preview ? '本地预览 · 只读' : connected ? 'Codex 已连接' : '正在连接宿主'} />{busy && <Ring aria-label="正在加载" />}</div>
      </header>

      <Card className="workspace-card" title="工作区" eyebrow="WORKSPACE">
        <form className="workspace-form" onSubmit={event => { event.preventDefault(); void load(workspace) }}>
          <TextInput label="仓库绝对路径" placeholder="例如 R:\project\my-project" value={workspace} onChange={event => setWorkspace(event.target.value)} disabled={busy} required />
          <Button type="submit" disabled={!connected || busy || !workspace.trim()}>打开台账</Button>
          <Button type="button" variant="outline" disabled={!status || busy} onClick={() => void load()}>刷新与审计</Button>
          <Button type="button" variant="ghost" disabled={!status || busy} onClick={() => void exportSnapshot()}>导出快照</Button>
        </form>
      </Card>
      {error && <Alert tone="danger" title="请求未完成" description={error} role="alert" />}
      {notice && <Alert tone="success" title={notice} role="status" />}

      {!status ? <div className="welcome"><span className="eyebrow">A SHARED RECORD OF WHAT MATTERS</span><h2>让每一次协作有据可循。</h2><p>打开仓库，查看目标、计划与交接，以及当下关注什么、为何暂缓什么。</p><div className="welcome-pills"><Chip label="可观察的目标" /><Chip label="有界计划" /><Chip label="不可变回执" /></div></div> : <>
        <section className="metrics" aria-label="台账概览">
          {[['目标', status.counts.goals, 'goals'], ['计划', status.counts.plans, 'plans'], ['交接', status.counts.duties, 'duties'], ['待修复', status.openViolations, 'audit']].map(([label, count, target]) => <button className="metric" key={label} onClick={() => setTab(String(target))}><span>{label}</span><strong>{count}</strong><span className="metric-arrow" aria-hidden="true">↗</span></button>)}
        </section>
        <section className="ledger-strip" aria-label="链状态"><span className={status.ledger.verified ? 'dot verified' : 'dot broken'} /><strong>{status.ledger.verified ? '摘要链完整' : '摘要链校验失败'}</strong><span>{status.ledger.count} 条记录</span><code title={status.ledger.tip}>{status.ledger.tip.slice(0, 23)}…</code><span className="protocol-version">AMP {data.protocol.version} / wire {data.protocol.wireVersion}</span></section>
        <div className="content-layout">
          <section className="records-section" aria-label="协作记录">
            <div className="tab-bar"><Tabs items={tabs} value={tab} onValueChange={setTab} ariaLabel="记录类型" /><TextInput label="搜索记录" value={filter} onChange={event => setFilter(event.target.value)} placeholder="名称、状态或内容" /></div>
            <TabPanel value="goals" activeValue={tab}>
              <div className="record-list">{status.goals.filter(matches).map(goal => <Card key={goal.id} title={goal.statement} eyebrow={goal.id} action={<Chip label={goal.state} />}><p className="muted">优先级 {goal.priority}</p></Card>)}{!status.goals.filter(matches).length && <Empty>暂无匹配的目标。可在聊天中请 Codex 创建带成功条件的目标。</Empty>}</div>
            </TabPanel>
            <TabPanel value="plans" activeValue={tab}>
              <div className="record-list">{status.plans.filter(matches).map(plan => <Card key={plan.id} title={plan.id} eyebrow={plan.goal ?? 'PLAN'} action={<Chip label={plan.status} />}><div className="plan-progress"><progress value={plan.done} max={Math.max(plan.tasks, 1)} aria-label={`${plan.id} 完成进度`} /><span>{plan.done} / {plan.tasks}</span></div><p className="muted">{plan.ready} 项可开始 · {plan.blocked} 项等待依赖</p></Card>)}{!status.plans.filter(matches).length && <Empty>暂无匹配的计划。</Empty>}</div>
            </TabPanel>
            <TabPanel value="duties" activeValue={tab}>
              <div className="record-list">{status.duties.filter(matches).map(duty => <Card key={duty.id} title={duty.id} eyebrow={duty.role} action={<Chip label={duty.status} />}><p>{duty.owner} <span className="muted">→</span> {duty.assignee}</p></Card>)}{!status.duties.filter(matches).length && <Empty>暂无匹配的交接。</Empty>}</div>
            </TabPanel>
            <TabPanel value="protocol" activeValue={tab}>
              <div className="record-list">{data.records?.filter(matches).map(record => <Card key={record.seq} title={String(record.payload.id)} eyebrow={`${record.kind.toUpperCase()} / #${record.seq}`}><details><summary>查看协议内容</summary><pre>{JSON.stringify(record.payload, null, 2)}</pre></details></Card>)}{!data.records?.filter(matches).length && <Empty>尚无注意帧或回执。注意帧记录关注项、排除项及预算。</Empty>}</div>
              <Card className="artifact-editor" title="协议 JSON" eyebrow="VALIDATE / RECORD"><TextArea label="AMP 对象" value={json} onChange={event => { setJson(event.target.value); setValidation(undefined) }} placeholder={'{ "amp": "0.1", "kind": "receipt", … }'} rows={10} /><div className="editor-actions"><Button variant="outline" disabled={busy || !json.trim()} onClick={() => void artifactAction(false)}>校验对象</Button><Button disabled={busy || !json.trim() || connection?.preview} onClick={() => void artifactAction(true)}>追加注意帧或回执</Button></div>{validation && <Alert tone={validation.ok ? 'success' : 'danger'} title={validation.ok ? '协议结构校验通过' : '协议结构校验未通过'} description={validation.ok ? validation.digest : validation.problems.join('\n')} />}</Card>
            </TabPanel>
            <TabPanel value="audit" activeValue={tab}>
              <Card title={data.audit?.ok ? '台账结构一致' : '台账需要修复'} eyebrow="CONSISTENCY AUDIT"><p className="muted">校验摘要链、生命周期与交接结构。证据内容仍需实际验证。</p>{data.audit?.violations.map((item, index) => <Alert key={`v${index}`} tone="danger" title={`${item.id} · ${item.code}`} description={item.message} />)}{data.audit?.warnings.map((item, index) => <Alert key={`w${index}`} tone="warning" title={`${item.id} · ${item.code}`} description={item.message} />)}{data.audit?.ok && !data.audit.warnings.length && <Empty>未发现结构违规或警告。</Empty>}</Card>
            </TabPanel>
            <TabPanel value="amp" activeValue={tab}><AmpWorkbench key={data.workspace} connection={connection} workspace={data.workspace!} /></TabPanel>
          </section>
          <aside><Card title="接下来" eyebrow="NEXT ACTIONS"><ol className="next-steps">{status.nextSteps.map(step => <li key={step}>{step}</li>)}</ol>{!status.nextSteps.length && <p className="muted">当前没有待处理动作。</p>}</Card><Card title="可开始的任务" eyebrow="READY TO START">{status.readyTasks.map(task => <div className="ready-task" key={`${task.plan}:${task.task}`}><span className="eyebrow">{task.plan}</span><strong>{task.task}</strong><p>{task.intent}</p></div>)}{!status.readyTasks.length && <p className="muted">暂无可开始的任务。</p>}</Card></aside>
        </div>
      </>}
      <footer>Coordination <span>目标 · 计划 · 注意 · 交接</span></footer>
    </main>
  </PeriodicityInternational></PeriodicityTheme>
}
