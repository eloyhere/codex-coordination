import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser',
  outputDir: '.tmp/playwright-results',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, screenshot: 'only-on-failure', channel: process.env.COORDINATION_TEST_BROWSER_CHANNEL },
  webServer: { command: 'node node_modules/vite/bin/vite.js', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 30_000 },
})
