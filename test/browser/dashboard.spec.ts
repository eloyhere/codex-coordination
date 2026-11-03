import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolNamed } from '../../plugins/codex-coordination/mcp/lib/tools.mjs'
import { ampHost } from '../../plugins/codex-coordination/mcp/amp/host.mjs'

let workspace: string
let directory: string
const previousDatabase = process.env.CODEX_AMP_DATABASE
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'coordination-ui-'))
  workspace = join(directory, 'repository')
  mkdirSync(workspace)
  process.env.CODEX_AMP_DATABASE = join(directory, 'host.sqlite')
  await toolNamed('coordination_goal')!.handler({ workspace, action: 'create', goal: { id: 'ship-typescript', statement: '完成 TypeScript 与 React 升级', value: 0.9, success: [{ id: 'checks', statement: '检查通过', check: 'npm run check' }] } })
  await toolNamed('coordination_protocol')!.handler({ workspace, action: 'record', artifact: { amp: '0.1', kind: 'receipt', id: 'build-result', at: '2026-11-03T00:00:00Z', op: 'act', outcome: 'success', usage: {}, note: '构建已验证' } })
})
test.afterAll(async () => { await ampHost.close(); if (previousDatabase === undefined) delete process.env.CODEX_AMP_DATABASE; else process.env.CODEX_AMP_DATABASE = previousDatabase; rmSync(directory, { recursive: true, force: true }) })

test('loads real data, filters, audits, exports and validates at desktop and mobile sizes', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await expect(page.getByText('本地预览 · 只读')).toBeVisible()
  await page.getByLabel('仓库绝对路径').fill(workspace)
  await page.evaluate(() => {
    const state = window as Window & { observedRipples?: number }
    state.observedRipples = 0
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element) state.observedRipples! += (node.matches('.ripple') ? 1 : 0) + node.querySelectorAll('.ripple').length
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.getByRole('button', { name: '打开台账', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { observedRipples?: number }).observedRipples)).toBeGreaterThan(0)
  await expect(page.getByText('完成 TypeScript 与 React 升级')).toBeVisible()
  await expect(page.getByText('摘要链完整', { exact: true })).toBeVisible()
  await page.getByLabel('搜索记录').fill('nothing-matches')
  await expect(page.getByText('暂无匹配的目标。', { exact: false })).toBeVisible()
  await page.getByLabel('搜索记录').fill('')
  await page.getByRole('tab', { name: '注意与回执' }).click()
  await expect(page.getByText('build-result', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '导出快照' }).click()
  const editor = page.getByLabel('AMP 对象')
  await expect(editor).toHaveValue(/ledger-snapshot/)
  await page.getByRole('button', { name: '校验对象' }).click()
  await expect(page.getByRole('status')).toContainText('协议结构校验通过')
  await editor.fill('{"amp":"0.1","kind":"receipt"}')
  await page.getByRole('button', { name: '校验对象' }).click()
  await expect(page.getByRole('alert')).toContainText('协议结构校验未通过')
  await expect(page.getByRole('button', { name: '追加注意帧或回执' })).toBeDisabled()
  await page.getByRole('tab', { name: '审计', exact: true }).click()
  await expect(page.getByText('台账结构一致', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '目标', exact: true }).click()
  await expect(page.getByText('完成 TypeScript 与 React 升级')).toBeVisible()
  await page.screenshot({ path: '.tmp/dashboard-desktop.png', fullPage: true, animations: 'disabled' })
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByText('完成 TypeScript 与 React 升级')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflow, `horizontal overflow at ${width}px`).toBe(false)
  }
  await page.screenshot({ path: '.tmp/dashboard-mobile.png', fullPage: true, animations: 'disabled' })
  await page.getByLabel('仓库绝对路径').fill('relative/path')
  await page.getByRole('button', { name: '打开台账', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('absolute')
  expect(errors).toEqual([])
})

test('production single-file app handshakes with an MCP host and records a receipt through the bridge', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('hostTool', async (name: string, args: Record<string, unknown>) => {
    try {
      const value = await toolNamed(name)!.handler(args)
      return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: String(error) } }) }] }
    }
  })
  await page.route('**/mcp-dashboard', route => route.fulfill({ contentType: 'text/html', body: readFileSync('plugins/codex-coordination/app/index.html', 'utf8') }))
  await page.route('**/mcp-host*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><iframe title="Coordination" src="/mcp-dashboard" style="width:100%;height:100vh;border:0"></iframe><script>
    window.addEventListener('message', async event => {
      const request = event.data;
      if (!request || request.jsonrpc !== '2.0') return;
      const reply = result => event.source.postMessage({ jsonrpc:'2.0', id:request.id, result }, event.origin);
      if (request.method === 'ui/initialize') reply({ protocolVersion:'2026-01-26', hostInfo:{name:'integration-test',version:'1.0.0'}, hostCapabilities:{serverTools:{}}, hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen']} });
      if (request.method === 'ui/notifications/initialized') {
        const initialNotification = new URLSearchParams(location.search).has('notification');
        const result = await window.hostTool(initialNotification ? 'coordination_notification' : 'coordination_dashboard', initialNotification ? { surface:'dialog', title:'Agent 初始通知', message:'无需先打开台账', duration:0 } : ${JSON.stringify({ workspace })});
        event.source.postMessage({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:result }, event.origin);
      }
      if (request.method === 'tools/call') reply(await window.hostTool(request.params.name, request.params.arguments));
    });
  </script></body></html>` }))
  await page.goto('/mcp-host')
  const app = page.frameLocator('iframe')
  await expect(app.getByText('Codex 已连接', { exact: true })).toBeVisible()
  await expect(app.getByText('完成 TypeScript 与 React 升级')).toBeVisible()
  await app.getByRole('tab', { name: '注意与回执' }).click()
  await app.getByLabel('AMP 对象').fill(JSON.stringify({ amp: '0.1', kind: 'receipt', id: 'ui-recorded', at: '2026-11-03T00:00:00Z', op: 'act', outcome: 'success', usage: {} }))
  await app.getByRole('button', { name: '追加注意帧或回执' }).click()
  await expect(app.getByText('ui-recorded', { exact: true })).toBeVisible()
  const records = await toolNamed('coordination_protocol')!.handler({ workspace, action: 'list' })
  expect(records.records[0].payload.id).toBe('ui-recorded')
  await app.getByRole('tab', { name: 'AMP 能力' }).click()
  await app.getByRole('button', { name: '连接 AMP', exact: true }).click()
  await expect(app.getByLabel('AMP 工具')).toBeVisible()
  await app.getByLabel('工具参数 JSON').fill(JSON.stringify({ registry: 'languages', action: 'register', id: 'uiprobe', value: { family: 'code', extensions: ['ampui'], keywords: ['attention'] }, expectedVersion: 0 }))
  await app.getByRole('button', { name: '执行调用', exact: true }).click()
  await expect(app.getByLabel('AMP 执行结果')).toContainText('uiprobe')
  await app.getByLabel('AMP 工具').selectOption('coordination_amp')
  await app.getByRole('button', { name: '执行调用', exact: true }).click()
  await expect(app.getByLabel('AMP 执行结果')).toContainText('bayes')
  await app.getByLabel('AMP 工具').selectOption('coordination_mission')
  await app.getByRole('button', { name: '执行调用', exact: true }).click()
  await expect(app.getByLabel('AMP 执行结果')).toContainText('missions')
  await app.getByLabel('AMP 工具').selectOption('coordination_context')
  await app.getByRole('button', { name: '执行调用', exact: true }).click()
  await expect(app.getByLabel('AMP 执行结果')).toContainText('coordination_project')
  await app.getByLabel('AMP 工具').selectOption('coordination_notification')
  await app.getByRole('button', { name: '执行调用', exact: true }).click()
  await expect(app.getByText('工作区通知', { exact: true })).toBeVisible()
  // Dismiss the first snackbar, then verify all surfaces use distinct library components.
  await app.locator('[data-notification-surface="snackbar"]').getByRole('button').last().click()
  for (const surface of ['snackbar', 'popover', 'dialog', 'alert']) {
    await app.getByLabel('工具参数 JSON').fill(JSON.stringify({ surface, title: `${surface} 标题`, message: `${surface} 第一行\n第二行`, severity: 'warning', duration: 0, anchor: 'top-right', actions: [{ id: 'dismiss', label: '知道了' }] }))
    await app.getByRole('button', { name: '执行调用', exact: true }).click()
    const layer = app.locator(`[data-notification-surface="${surface}"]`)
    await expect(layer).toBeVisible()
    await expect(layer).toContainText(`${surface} 第一行`)
    if (surface === 'dialog') await expect(layer).toHaveAttribute('open', '')
    else expect((await layer.boundingBox())!.y).toBeLessThan(60)
    await layer.getByRole('button', { name: '知道了', exact: true }).click()
    await expect(layer).toHaveCount(0)
  }
  // Agent-delivered tool results use the same rendering path, including a notification-only app.
  await page.reload()
  await expect(app.getByText('Codex 已连接', { exact: true })).toBeVisible()
  const deliver = async (args: Record<string, unknown>, duplicate = false) => {
    const value = await toolNamed('coordination_notification')!.handler(args)
    expect(value.ok).toBe(true)
    const result = { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    await page.evaluate(({ result, duplicate }) => {
      const frame = document.querySelector('iframe')!
      const send = () => frame.contentWindow!.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, location.origin)
      send(); if (duplicate) send()
    }, { result, duplicate })
  }
  await deliver({ surface: 'dialog', title: 'Agent 对话框', message: '来自 agent 的工具结果', duration: 0 }, true)
  await expect(app.getByRole('dialog', { name: 'Agent 对话框' })).toBeVisible()
  await deliver({ surface: 'snackbar', message: '排队自动关闭', duration: 1000 })
  await expect(app.locator('[data-notification-surface="snackbar"]')).toHaveCount(0)
  await app.getByRole('button', { name: '关闭通知', exact: true }).click()
  await expect(app.locator('[data-notification-surface="snackbar"]')).toBeVisible()
  await expect(app.locator('[data-notification-surface="snackbar"]')).toHaveCount(0)
  await expect(app.getByRole('dialog')).toHaveCount(0)
  await page.goto('/mcp-host?notification=1')
  await expect(app.getByRole('dialog', { name: 'Agent 初始通知' })).toBeVisible()
  await page.screenshot({ path: '.tmp/notification-dialog.png', animations: 'disabled' })
  await expect(app.getByRole('heading', { name: '协作台账', exact: true })).toHaveCount(0)
  await app.getByRole('button', { name: '关闭通知', exact: true }).click()
  await expect(app.getByText('通知已关闭', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
