import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { validateToken, redactor, ENDPOINT, dataDir } from '../plugins/tilda-connect/scripts/common.mjs';
import { readToken, saveToken, deleteToken, hiddenInput } from '../plugins/tilda-connect/scripts/vault.mjs';
import { pinnedFetch } from '../plugins/tilda-connect/scripts/bridge.mjs';

const token = 'synthetic-security-test-key+/=123456';

test('credential validation rejects placeholders, CRLF, whitespace, and oversized values', () => {
  for (const value of ['', '[YOUR_TOKEN_HERE]', `${token}\r\nX-Evil: yes`, 'abc def', 'x'.repeat(4097)]) assert.throws(() => validateToken(value));
  assert.equal(validateToken(token), token);
});

test('vault reads/writes/verifies/deletes through the native store abstraction', async () => {
  let stored = null;
  const entry = { getPassword: () => stored, setPassword: value => { stored = value; }, deletePassword: () => { stored = null; } };
  const factory = async () => entry;
  await assert.rejects(readToken(factory), /ещё не сохранён/);
  await saveToken(token, factory);
  assert.equal(await readToken(factory), token);
  await deleteToken(factory);
  assert.equal(stored, null);
});

test('vault never falls back to files and never exposes a backend error', async () => {
  const broken = async () => { throw new Error(`secret backend error ${token}`); };
  for (const action of [() => saveToken(token, broken), () => readToken(broken), () => deleteToken(broken)]) {
    await assert.rejects(action(), error => !error.message.includes(token));
  }
});

test('key entry refuses pipes before reading any input', async () => {
  await assert.rejects(hiddenInput(new PassThrough(), new PassThrough()), /интерактивном терминале/);
});

test('hidden input does not echo secrets, restores terminal, and supports cancel', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough();
  let printed = '';
  output.on('data', chunk => { printed += chunk; });
  const result = hiddenInput(input, output);
  input.write(`${token}\r`);
  assert.equal(await result, token);
  assert.equal(input.isRaw, false);
  assert.ok(!printed.includes(token));
  const cancelled = hiddenInput(input, output);
  input.write('\x03');
  await assert.rejects(cancelled, /отменён/);
  assert.equal(input.isRaw, false);
});

test('redacts current credential from nested results, keys, and common encodings', () => {
  const result = redactor(token)({ [token]: ['Bearer ' + token, encodeURIComponent(token), Buffer.from(token).toString('base64')], safe: 42 });
  assert.deepEqual(result, { '[REDACTED]': ['Bearer [REDACTED]', '[REDACTED]', '[REDACTED]'], safe: 42 });
});

test('HTTP credential is restricted to exact endpoint; redirects and cookies are disabled', async () => {
  const calls = [];
  const fetch = pinnedFetch(token, async (url, init) => { calls.push({ url, init }); return new Response('{}', { headers: { 'content-type': 'application/json' } }); });
  await fetch(ENDPOINT, { method: 'POST', body: '{}' });
  assert.equal(calls[0].init.headers.get('Authorization'), `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].url, ENDPOINT);
  for (const url of ['https://evil.example/mcp', ENDPOINT + '?token=leak', 'http://tilda.ru/api/mcp/', 'https://tilda.ru/api/mcp']) await assert.rejects(fetch(url), /Заблокирован/);
  assert.equal(calls.length, 1);
});

test('HTTP errors discard potentially sensitive response bodies; only GET may accept 405', async () => {
  for (const status of [401, 403, 429, 500, 302, 307]) {
    const fetch = pinnedFetch(token, async () => new Response(`Authorization: Bearer ${token}`, { status }));
    await assert.rejects(fetch(ENDPOINT, { method: 'POST' }), error => !error.message.includes(token));
  }
  const fetch = pinnedFetch(token, async () => new Response(null, { status: 405 }));
  assert.equal((await fetch(ENDPOINT, { method: 'GET' })).status, 405);
  await assert.rejects(fetch(ENDPOINT, { method: 'POST' }));
});

test('platform storage paths stay outside the distributed plugin', () => {
  assert.match(dataDir('darwin', '/users/test', {}), /Library\/Application Support\/TildaConnect$/);
  assert.match(dataDir('linux', '/users/test', {}), /\.local\/share\/tilda-connect$/);
  assert.match(dataDir('win32', '/users/test', { LOCALAPPDATA: '/local' }), /local\/TildaConnect$/);
});
