import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HostConnections } from '../plugins/codex-coordination/mcp/amp/connections.mjs'
import { database, moduleApi } from '../plugins/codex-coordination/mcp/amp/runtime.mjs'
import { DomainApi } from '../plugins/codex-coordination/mcp/amp/api.mjs'
import { HostKeys } from '../plugins/codex-coordination/mcp/amp/keys.mjs'
import { configureHostClient, acceptHostResponse, closeHostClient } from '../plugins/codex-coordination/mcp/amp/host-client.mjs'

const tool = { name: 'echo', description: 'Read a local test value', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: true } }
async function endpoint(t) {
  let tools = [structuredClone(tool)]
  let calls = 0
  let advertised
  const messages = []
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') { res.end(JSON.stringify({ name: 'Local test agent', url: advertised })); return }
    let body = ''; for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    messages.push(message)
    let result
    if (message.method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 60000, cacheScope: 'private' }
    if (message.method === 'tools/list') result = { resultType: 'complete', tools, ttlMs: 60000, cacheScope: 'private' }
    if (message.method === 'tools/call') { calls++; result = { resultType: 'complete', content: [{ type: 'text', text: message.params.arguments.text }] } }
    if (message.method === 'message/send') result = { kind: 'task', id: 'accepted', status: { state: 'submitted' } }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  advertised = url
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { url, messages, calls: () => calls, tools: value => { tools = value }, redirect: value => { advertised = value } }
}

test('real HTTP MCP binding mirrors/withdraws tools and detects schema drift before dispatch', async t => {
  const peer = await endpoint(t)
  const db = new database.Database(':memory:')
  const host = new HostConnections([{ id: 'mcp.local', family: 'mcp', url: peer.url }], db)
  t.after(() => { host.close(); db.close() })
  const connected = await host.connect('mcp.local')
  assert.equal(connected.bound, true)
  assert.ok(host.protocols.resolveImplementation('mcp.local', moduleApi.isMcpProtocol, 'mcp'))
  assert.equal((await host.call({ action: 'call', id: 'mcp.local', tool: 'echo', arguments: { text: 'works' } })).result.inline.includes('works'), true)
  assert.equal(peer.calls(), 1)
  await assert.rejects(host.call({ action: 'call', id: 'mcp.local', tool: 'echo', arguments: { text: 12 } }))
  assert.equal(peer.calls(), 1)
  peer.tools([{ ...tool, description: 'Changed schema contract' }])
  await assert.rejects(host.call({ action: 'call', id: 'mcp.local', tool: 'echo', arguments: { text: 'blocked' } }), /changed/)
  assert.equal(peer.calls(), 1)
  peer.tools([])
  const synced = await host.call({ action: 'sync', id: 'mcp.local' })
  assert.deepEqual(synced.changes.removed, ['echo'])
  await host.call({ action: 'disconnect', id: 'mcp.local' })
  assert.equal(host.protocols.bound().length, 0)
  await assert.rejects(host.connect('mcp.local'), /catalog changed/)
})

test('reconnecting does not reset the native dispatcher budget', async t => {
  const peer = await endpoint(t)
  const db = new database.Database(':memory:')
  const host = new HostConnections([{ id: 'bounded', family: 'mcp', url: peer.url, budget: { calls: 1, tokens: 1000 } }], db)
  t.after(() => { host.close(); db.close() })
  await host.call({ action: 'call', id: 'bounded', tool: 'echo', arguments: { text: 'first' } })
  await host.call({ action: 'disconnect', id: 'bounded' })
  await assert.rejects(host.call({ action: 'call', id: 'bounded', tool: 'echo', arguments: { text: 'second' } }), /budget exceeded/)
  assert.equal(peer.calls(), 1)
})

test('A2A uses native card discovery and message/send while refusing origin escalation', async t => {
  const peer = await endpoint(t)
  const db = new database.Database(':memory:')
  const host = new HostConnections([{ id: 'a2a.local', family: 'a2a', url: peer.url }], db)
  t.after(() => { host.close(); db.close() })
  const delegation = { id: 'delegation.probe', granter: 'owner', delegatee: 'worker', goalDigest: `sha256:${'b'.repeat(64)}`, scope: ['read'], budget: { tokens: 100 }, deadline: '2099-01-01T00:00:00Z', mayRedelegate: false, depth: 0 }
  assert.equal((await host.call({ action: 'delegate', id: 'a2a.local', delegation })).ok, true)
  assert.ok(peer.messages.some(message => message.method === 'message/send'))
  assert.ok(host.protocols.bound().includes('a2a.local'))
  peer.redirect('https://not-configured.invalid')
  await assert.rejects(host.call({ action: 'delegate', id: 'a2a.local', delegation }), /configured origin/)
})

test('stdio MCP transport performs native legacy fallback and closes its owned child', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-stdio-peer-'))
  const script = join(directory, 'peer.mjs')
  writeFileSync(script, String.raw`import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      const result=q.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:q.method==='tools/list'?{tools:[${JSON.stringify(tool)}],ttlMs:60000}:q.method==='tools/call'?{content:[{type:'text',text:q.params.arguments.text}]}:undefined;
      process.stdout.write(JSON.stringify(result?{jsonrpc:'2.0',id:q.id,result}:{jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'not found'}})+'\n');
    });`)
  const db = new database.Database(':memory:')
  const host = new HostConnections([{ id: 'stdio.local', family: 'mcp', command: process.execPath, args: [script] }], db)
  t.after(() => { host.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal((await host.connect('stdio.local')).negotiated.mode, 'legacy')
  assert.ok((await host.call({ action: 'call', id: 'stdio.local', tool: 'echo', arguments: { text: 'stdio works' } })).result.inline.includes('stdio works'))
})

test('native execution gets approval only from a correlated MCP host response', async t => {
  const peer = await endpoint(t)
  peer.tools([{ ...tool, annotations: { readOnlyHint: false, destructiveHint: true } }])
  const db = new database.Database(':memory:')
  const host = new HostConnections([{ id: 'reviewed', family: 'mcp', url: peer.url }], db)
  t.after(async () => { closeHostClient(); configureHostClient({}, () => {}); await host.close(); db.close() })
  const claim = { amp: '0.1', kind: 'claim', id: 'claim.review', statement: 'The local test action is approved for testing.', tier: 'T3', confidence: 0.9, status: 'held', warrant: { evidence: [], inference: 'deduction', strength: 0.9 }, provenance: { source: 'integration-test' }, created: new Date().toISOString() }
  const input = { action: 'call', id: 'reviewed', tool: 'echo', arguments: { text: 'reviewed action' }, claim }
  configureHostClient({}, () => {})
  await assert.rejects(host.call(input), /approval/i)
  assert.equal(peer.calls(), 0)
  let review
  configureHostClient({ elicitation: {} }, message => {
    review = message
    assert.equal(acceptHostResponse({ method: 'tools/call', id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }), false)
    queueMicrotask(() => acceptHostResponse({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { decision: 'approve' } } }))
  })
  assert.equal((await host.call(input)).ok, true)
  assert.equal(review.method, 'elicitation/create')
  assert.ok(review.params.message.includes('reviewed action'))
  assert.equal(peer.calls(), 1)
})

test('native cooperation listeners bind only configured ports and retain transport authentication', async t => {
  const db = new database.Database(':memory:')
  const keys = new HostKeys(db)
  const api = new DomainApi(db, (kid, historical) => keys.verificationKey(kid, historical))
  const created = (await api.call({ action: 'create', module: 'governance', name: 'CooperationBus', arguments: [{}] })).result
  const bus = { $ampRef: created.$ampRef }
  const host = new HostConnections([], db, undefined, keys, api, [{ id: 'local-listener', port: 0 }])
  t.after(async () => { await host.close(); db.close() })
  await assert.rejects(host.call({ action: 'listen', id: 'not-configured', bus }), /host configuration/)
  const started = await host.call({ action: 'listen', id: 'local-listener', bus })
  assert.ok(started.port > 0)
  const denied = await fetch(started.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.notEqual(denied.status, 200)
  await denied.arrayBuffer()
  await host.call({ action: 'stop_listener', id: 'local-listener' })
  await assert.rejects(fetch(started.url))
})
