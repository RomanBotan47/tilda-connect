import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ENDPOINT, SafeError, redactor, connectionError } from './common.mjs';

// The factory's second parameter supports isolated tests. Production always uses the constant endpoint.
export function pinnedFetch(token, fetchImpl = globalThis.fetch) {
  return async (input, init = {}) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== ENDPOINT) throw new SafeError('Заблокирован запрос за пределы официального MCP Tilda.');
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new SafeError('Для подключения включите проверку TLS: удалите NODE_TLS_REJECT_UNAUTHORIZED=0.');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const signal = init.method === 'GET' ? init.signal : AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)]);
    const response = await fetchImpl(ENDPOINT, { ...init, headers, signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok && !(init.method === 'GET' && response.status === 405)) {
      await response.body?.cancel();
      const message = {
        401: 'Tilda отклонила ключ. Проверьте срок действия и замените ключ через node tilda.mjs key set.',
        403: 'Ключу Tilda не хватает прав. Проверьте проект и разрешённые действия в настройках ключа.',
        429: 'Tilda ограничила частоту запросов. Повторите проверку позже.'
      }[response.status] || `Tilda вернула HTTP ${response.status}. Проверьте результат действия перед повтором.`;
      throw new SafeError(message);
    }
    return response;
  };
}

export function remoteTransport(token, fetchImpl) {
  return new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: pinnedFetch(token, fetchImpl),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
}

export async function bridge(token, { local = new StdioServerTransport(), remote = remoteTransport(token), input = process.stdin, diagnostic = (text) => process.stderr.write(`${text}\n`) } = {}) {
  const redact = redactor(token);
  const initializeIds = new Set();
  const pending = new Set();
  const failed = new Set();
  let closed = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const close = async () => {
    if (closed) return;
    closed = true;
    input.off('end', close);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    await Promise.allSettled([remote.close(), local.close()]);
    resolveDone();
  };
  const failPending = (error) => {
    const text = connectionError(error);
    diagnostic(text);
    for (const id of pending) {
      pending.delete(id);
      failed.add(id);
      void local.send({ jsonrpc: '2.0', id, error: { code: -32000, message: text } }).catch(close);
    }
  };
  remote.onmessage = (message) => {
    if ('id' in message && !('method' in message)) {
      if (failed.delete(message.id)) return;
      pending.delete(message.id);
      if (initializeIds.delete(message.id) && message.result?.protocolVersion) remote.setProtocolVersion(message.result.protocolVersion);
    }
    void local.send(redact(message)).catch(close);
  };
  // The SDK can include response bodies in errors; only our own fixed messages leave the process.
  remote.onerror = failPending;
  remote.onclose = close;
  local.onerror = () => diagnostic('Некорректное MCP-сообщение от приложения.');
  local.onclose = close;
  local.onmessage = (message) => {
    if ('method' in message && 'id' in message) failed.delete(message.id);
    if ('method' in message && 'id' in message) pending.add(message.id);
    if (message.method === 'initialize') initializeIds.add(message.id);
    void remote.send(message).catch((error) => {
      // Transport reports errors through onerror first; avoid a duplicate response.
      if ('id' in message && pending.has(message.id)) failPending(error);
    });
  };
  input.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await remote.start();
    await local.start();
    await done;
  } finally {
    await close();
  }
}
