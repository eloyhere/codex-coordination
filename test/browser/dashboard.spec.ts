import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolNamed } from '../../plugins/codex-coordination/mcp/lib/tools.mjs'
import { ampHost } from '../../plugins/codex-coordination/mcp/amp/host.mjs'

let workspace: string, directory: string
const previousDatabase = process.env.CODEX_AMP_DATABASE
test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'coordination-settings-ui-'))
  workspace = join(directory, 'repository')
  mkdirSync(workspace)
  process.env.CODEX_AMP_DATABASE = join(directory, 'host.sqlite')
})
test.afterAll(async () => {
  await ampHost.close()
  if (previousDatabase === undefined) delete process.env.CODEX_AMP_DATABASE
  else process.env.CODEX_AMP_DATABASE = previousDatabase
  rmSync(directory, { recursive: true, force: true })
})

test('settings UI opens a project without status, dashboard tabs or notifications', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'AMP 设置', exact: true })).toBeVisible()
  await page.getByLabel('仓库绝对路径').fill(workspace)
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AMP 配置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '连接项目设置' })).toBeDisabled()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.amp-status, [data-notification-surface]')).toHaveCount(0)
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    await expect(page.getByRole('heading', { name: 'AMP 设置', exact: true })).toBeVisible()
  }
  await page.screenshot({ path: '.tmp/settings-mobile.png', fullPage: true, animations: 'disabled' })
  await page.getByLabel('仓库绝对路径').fill('relative/path')
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('absolute')
})

test('production settings bridge ignores old notifications and keeps configuration available', async ({ page }) => {
  const errors: string[] = []
  const settingsCalls: Record<string, unknown>[] = []
  const other = join(directory, 'other-project'); mkdirSync(other)
  let switchBeforeCall = false
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('hostTool', async (name: string, args: Record<string, unknown>) => {
    try {
      if (name === 'coordination_registry') {
        settingsCalls.push(args)
        if (switchBeforeCall) { switchBeforeCall = false; await ampHost.select(other) }
      }
      const value = await toolNamed(name)!.handler(args)
      return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message: String(error) } }) }] }
    }
  })
  await page.route('**/settings-app', route => route.fulfill({ contentType: 'text/html', body: readFileSync('plugins/codex-coordination/app/index.html', 'utf8') }))
  const html = [
    '<!doctype html><html><body><iframe src="/settings-app" style="width:100%;height:100vh;border:0"></iframe><script>',
    'const initial = ' + JSON.stringify({ workspace, view: 'settings' }) + ';',
    "window.addEventListener('message', async event => { const request = event.data; if (!request || request.jsonrpc !== '2.0') return;",
    "const reply = result => event.source.postMessage({ jsonrpc:'2.0', id:request.id, result }, event.origin);",
    "if (request.method === 'ui/initialize') reply({ protocolVersion:'2026-01-26', hostInfo:{name:'settings-test',version:'1'}, hostCapabilities:{serverTools:{}}, hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline']} });",
    "if (request.method === 'ui/notifications/initialized') event.source.postMessage({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:await window.hostTool('coordination_dashboard', initial) }, event.origin);",
    "if (request.method === 'tools/call') reply(await window.hostTool(request.params.name, request.params.arguments));",
    '});</script></body></html>',
  ].join('\n')
  await page.route('**/settings-host', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('/settings-host')
  const app = page.frameLocator('iframe')
  await expect(app.getByRole('button', { name: '连接项目设置' })).toBeEnabled()
  await page.evaluate(() => {
    document.querySelector('iframe')!.contentWindow!.postMessage({ jsonrpc:'2.0', method:'ui/notifications/tool-result', params:{ structuredContent:{ notifications:[{ id:'old-dialog', surface:'dialog', title:'旧通知', message:'不得显示', duration:0 }, { id:'old-snackbar', surface:'snackbar', message:'不得显示', duration:0 }] } } }, location.origin)
  })
  await app.getByRole('button', { name: '连接项目设置' }).click()
  await expect(app.getByLabel('设置接口')).toBeVisible()
  expect(await app.getByLabel('设置接口').locator('option').allTextContents()).toEqual(['注册中心', '环境', '连接', '密钥'])
  await app.getByRole('button', { name: '读取或应用设置' }).click()
  await expect(app.getByLabel('AMP 设置数据')).toContainText('entries')
  expect(settingsCalls.at(-1)?.expectedWorkspace).toBe(realpathSync(workspace))
  switchBeforeCall = true
  await app.getByRole('button', { name: '读取或应用设置' }).click()
  await expect(app.getByText(/Settings project binding changed/)).toBeVisible()
  expect(ampHost.status().workspace).toBe(realpathSync(other))
  await app.getByRole('button', { name: '读取或应用设置' }).click()
  await expect(app.getByLabel('AMP 设置数据')).toContainText('entries')
  expect(ampHost.status().workspace).toBe(realpathSync(workspace))
  await expect(app.getByRole('dialog')).toHaveCount(0)
  await expect(app.locator('[data-notification-surface], .amp-status')).toHaveCount(0)
  await expect(app.getByText('不得显示')).toHaveCount(0)
  const notification = toolNamed('coordination_notification')!
  expect(notification._meta?.ui).toBeUndefined()
  expect(await notification.handler({ surface: 'dialog', message: 'test' })).toMatchObject({ displayed: false, notifications: [] })
  expect(errors).toEqual([])
  await page.screenshot({ path: '.tmp/settings-desktop.png', fullPage: true, animations: 'disabled' })
})
