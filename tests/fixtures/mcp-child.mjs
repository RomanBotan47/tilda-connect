import { bridge, remoteTransport } from '../../plugins/tilda-connect/scripts/bridge.mjs';

// Public synthetic value; a real key is never passed in argv or the environment.
const synthetic = 'synthetic-stdio-key-1234567890';
const fetch = async (_url, init) => {
  if (init.method === 'GET') return new Response(null, { status: 405 });
  const message = JSON.parse(init.body);
  if (!('id' in message)) return new Response(null, { status: 202 });
  const result = message.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', version: '1' } }
    : message.method === 'tools/list'
      ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: synthetic }] };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
};
await bridge(synthetic, { remote: remoteTransport(synthetic, fetch) });
