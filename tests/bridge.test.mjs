import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bridge, remoteTransport } from '../plugins/tilda-connect/scripts/bridge.mjs';
const require = createRequire(new URL('../plugins/tilda-connect/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const token = 'synthetic-mcp-test-key-123456789';

function transports() {
  const local = {
    async start() {}, async close() { this.onclose?.(); },
    async send(message) { clientSide.onmessage?.(message); }
  };
  const clientSide = {
    async start() {}, async close() {},
    async send(message) { local.onmessage?.(message); }
  };
  return { local, clientSide };
}

test('official SDK bridge negotiates MCP and relays tools, resources, prompts and SSE results', async () => {
  const seen = [];
  const fetch = async (_url, init) => {
    assert.equal(init.headers.get('Authorization'), `Bearer ${token}`);
    if (init.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    seen.push({ message, version: init.headers.get('mcp-protocol-version'), session: init.headers.get('mcp-session-id') });
    if (!('id' in message)) return new Response(null, { status: 202 });
    const results = {
      initialize: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'test-tilda', version: '1' } },
      'tools/list': { tools: [{ name: 'sample', description: 'test', inputSchema: { type: 'object' } }] },
      'resources/list': { resources: [{ uri: 'tilda://test', name: 'test' }] },
      'prompts/list': { prompts: [{ name: 'sample-prompt' }] },
      'tools/call': { content: [{ type: 'text', text: `redact ${token}` }] }
    };
    const response = { jsonrpc: '2.0', id: message.id, result: results[message.method] || {} };
    if (message.method === 'tools/call') {
      return new Response(`data: ${JSON.stringify(response)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' } });
  };
  const { local, clientSide } = transports();
  const input = new EventEmitter();
  const diagnostics = [];
  const running = bridge(token, { local, remote: remoteTransport(token, fetch), input, diagnostic: text => diagnostics.push(text) });
  await new Promise(resolve => setImmediate(resolve));
  const client = new Client({ name: 'bridge-test', version: '1' });
  try {
    await client.connect(clientSide);
    const [tools, resources, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listPrompts()]);
    assert.equal(tools.tools[0].name, 'sample');
    assert.equal(resources.resources[0].uri, 'tilda://test');
    assert.equal(prompts.prompts[0].name, 'sample-prompt');
    const result = await client.callTool({ name: 'sample', arguments: {} });
    assert.equal(result.content[0].text, 'redact [REDACTED]');
    assert.ok(seen.filter(item => item.message.method !== 'initialize').every(item => item.version === '2025-06-18' && item.session === 'fake-session'));
    assert.deepEqual(diagnostics, []);
  } finally {
    input.emit('end');
    await running;
    await client.close();
  }
});

test('an HTTP failure yields one safe RPC error and never retries the mutation', async () => {
  const sent = [];
  const input = new EventEmitter();
  let calls = 0;
  const local = { async start() {}, async close() {}, async send(message) { sent.push(message); } };
  const running = bridge(token, { local, remote: remoteTransport(token, async () => { calls++; return new Response(token, { status: 401 }); }), input, diagnostic: () => {} });
  await new Promise(resolve => setImmediate(resolve));
  local.onmessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write', arguments: {} } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 3);
  assert.ok(sent[0].error.message.includes('Tilda отклонила ключ'));
  assert.ok(!JSON.stringify(sent).includes(token));
  input.emit('end');
  await running;
});

test('a real subprocess exposes clean stdio MCP and shuts down after client closure', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-child.mjs', import.meta.url))], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'stdio-integration-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name, 'echo');
    assert.equal((await client.callTool({ name: 'echo', arguments: {} })).content[0].text, '[REDACTED]');
  } finally { await client.close(); }
  assert.equal(stderr, '');
});
