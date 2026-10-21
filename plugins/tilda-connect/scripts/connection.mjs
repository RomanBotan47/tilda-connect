import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { remoteTransport } from './bridge.mjs';
import { SafeError, connectionError } from './common.mjs';

export async function checkConnection(token) {
  const client = new Client({ name: 'tilda-connect-check', version: '1.1.0' });
  const remote = remoteTransport(token);
  let failure;
  remote.onerror = error => { failure = error; };
  try {
    await client.connect(remote, { timeout: 30_000 });
    const result = await client.listTools(undefined, { timeout: 30_000 });
    return { toolCount: result.tools.length, more: Boolean(result.nextCursor) };
  } catch (error) { throw new SafeError(connectionError(failure || error)); }
  finally { await client.close().catch(() => {}); }
}
