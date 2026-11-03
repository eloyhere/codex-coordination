import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'

// Local preview only. Production communicates through the MCP Apps bridge.
function previewApi(): Plugin {
  return { name: 'coordination-preview', configureServer(server) {
    server.middlewares.use('/api/tool', async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      if (request.method !== 'POST' || request.headers['x-coordination-preview'] !== '1') {
        response.statusCode = 403; response.end(JSON.stringify({ error: 'preview requests only' })); return
      }
      // A cross-origin page cannot supply this custom header without a preflight.
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        response.statusCode = 403; response.end(JSON.stringify({ error: 'origin rejected' })); return
      }
      try {
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 128_000) throw new Error('Request too large')
        }
        const { name, args } = JSON.parse(body) as { name: string; args: Record<string, unknown> }
        const readOnly = name === 'coordination_dashboard' || name === 'coordination_status' || name === 'coordination_check'
          || (name === 'coordination_protocol' && ['describe', 'list', 'validate'].includes(String(args.action)))
        if (!readOnly) throw new Error('浏览器预览仅支持读取和校验；请在 Codex 中记录变更')
        const modulePath = new URL('./plugins/codex-coordination/mcp/lib/tools.mjs', import.meta.url).href
        const { toolNamed } = await import(modulePath) as { toolNamed(name: string): { handler(args: Record<string, unknown>): Promise<unknown> } | undefined }
        const tool = toolNamed(name)
        if (!tool) throw new Error('Unknown tool')
        const value = await tool.handler(args)
        response.end(JSON.stringify({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }))
      } catch (error) {
        response.statusCode = 400
        response.end(JSON.stringify({ isError: true, structuredContent: { ok: false, error: { message: error instanceof Error ? error.message : String(error) } } }))
      }
    })
  } }
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  plugins: [react(), viteSingleFile(), previewApi()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false },
  build: { outDir: '../../plugins/codex-coordination/app', emptyOutDir: true, target: 'es2022', license: { fileName: 'THIRD_PARTY_LICENSES.md' } },
})
