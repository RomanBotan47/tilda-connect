import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createWizard } from '../plugins/tilda-connect/scripts/wizard.mjs';
import { configureClient } from '../plugins/tilda-connect/scripts/desktop.mjs';
import { SafeError } from '../plugins/tilda-connect/scripts/common.mjs';
const require = createRequire(new URL('../plugins/tilda-connect/package.json', import.meta.url));
const { parse } = require('smol-toml');
const token = 'synthetic-wizard-key-1234567890';

async function session(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tilda-wizard-test-'));
  const root = path.join(home, 'app');
  const installation = { runtime: path.join(root, 'versions/test'), node: path.join(root, 'versions/test/bin/node') };
  const wizard = await createWizard({ home, root, prepare: async () => installation, read: async () => { throw new Error('missing'); }, check: async () => ({ toolCount: 5, more: false }), save: async () => {}, ...options });
  const response = await fetch(wizard.origin);
  const page = await response.text();
  const csrf = page.match(/name="tilda-setup" content="([a-f0-9]+)"/)[1];
  const call = (route, body, headers = {}) => fetch(wizard.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Tilda-Setup': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: wizard.origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { ...wizard, home, root, installation, csrf, call, page, cleanup: async () => { wizard.close(); await fs.rm(home, { recursive: true, force: true }); } };
}

test('wizard accepts one masked key and configures Codex without key-bearing files', async () => {
  const actions = [];
  const s = await session({ check: async key => { assert.equal(key, token); actions.push('check'); return { toolCount: 5 }; }, save: async key => { assert.equal(key, token); actions.push('save'); } });
  try {
    assert.match(s.page, /type="password"/);
    assert.ok(!s.page.includes(token));
    const response = await s.call('/api/connect', { client: 'codex', token });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.client, 'Codex');
    assert.deepEqual(actions, ['check', 'save']);
    const text = await fs.readFile(path.join(s.home, '.codex/config.toml'), 'utf8');
    assert.ok(!text.includes(token));
    assert.equal(parse(text).mcp_servers['tilda-connect'].command, s.installation.node);
    assert.ok(!JSON.stringify(data).includes(token));
  } finally { await s.cleanup(); }
});

test('HTTP boundaries reject cross-origin requests, missing CSRF and unsafe input', async () => {
  let checked = 0;
  const s = await session({ check: async () => { checked++; return { toolCount: 1 }; } });
  try {
    assert.equal((await s.call('/api/connect', { client: 'codex', token }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.call('/api/connect', { client: 'codex', token }, { 'X-Tilda-Setup': '0'.repeat(64) })).status, 403);
    assert.equal((await s.call('/api/connect', { client: 'codex', token }, { 'X-Tilda-Setup': 'é'.repeat(64) })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.request(s.origin + '/api/status', { headers: { Host: 'evil.example', 'X-Tilda-Setup': s.csrf } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await s.call('/api/connect', { client: 'codex', token }, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await s.call('/api/connect', { client: 'bad-client', token })).status, 400);
    assert.equal((await s.call('/api/connect', { client: 'codex', token: 'x'.repeat(9000) })).status, 400);
    assert.equal(checked, 0);
  } finally { await s.cleanup(); }
});

test('invalid credentials do not alter settings or save secrets', async () => {
  let saved = false;
  const s = await session({ check: async () => { throw new SafeError('Ключ отклонён'); }, save: async () => { saved = true; } });
  try {
    assert.equal((await s.call('/api/connect', { client: 'codex', token })).status, 400);
    assert.equal(saved, false);
    await assert.rejects(fs.access(path.join(s.home, '.codex/config.toml')));
  } finally { await s.cleanup(); }
});

test('vault failure rolls back config changes and secret stays out of errors', async () => {
  const s = await session({ save: async () => { throw new SafeError('backend accidentally echoes ' + token); } });
  try {
    const response = await s.call('/api/connect', { client: 'claude-code', token });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(token));
    await assert.rejects(fs.access(path.join(s.home, '.claude.json')));
  } finally { await s.cleanup(); }
});

test('saved credentials can be reused without entering a key again', async () => {
  let saves = 0;
  const s = await session({ read: async () => token, save: async () => { saves++; } });
  try {
    assert.equal((await (await s.call('/api/status')).json()).hasKey, true);
    assert.equal((await s.call('/api/connect', { client: 'claude-code', useSaved: true })).status, 200);
    assert.equal(saves, 0);
  } finally { await s.cleanup(); }
});

test('managed Codex TOML preserves comments and other settings through updates and rollback', async () => {
  const s = await session();
  try {
    const file = path.join(s.home, '.codex/config.toml');
    await fs.mkdir(path.dirname(file));
    const original = '# My setting\nmodel = "chosen-model"\n[mcp_servers.other]\ncommand = "keep"\n';
    await fs.writeFile(file, original);
    await configureClient('codex', s.installation, { home: s.home, root: s.root });
    assert.ok((await fs.readFile(file, 'utf8')).startsWith(original.trimEnd()));
    const update = { runtime: path.join(s.root, 'versions/two'), node: '/safe-node' };
    const result = await configureClient('codex', update, { home: s.home, root: s.root });
    const changed = await fs.readFile(file, 'utf8');
    assert.equal(parse(changed).mcp_servers['tilda-connect'].command, '/safe-node');
    assert.equal((changed.match(/BEGIN TILDA CONNECT/g) || []).length, 1);
    await result.rollback();
    assert.equal(parse(await fs.readFile(file, 'utf8')).mcp_servers['tilda-connect'].command, s.installation.node);
  } finally { await s.cleanup(); }
});

test('existing Tilda plugin is reused, and unrelated colliding configs are preserved', async () => {
  const s = await session();
  try {
    const file = path.join(s.home, '.codex/config.toml');
    await fs.mkdir(path.dirname(file));
    const original = '[plugins."tilda-connect@tilda-connect-marketplace"]\nenabled = true\n';
    await fs.writeFile(file, original);
    assert.equal((await configureClient('codex', s.installation, { home: s.home, root: s.root })).reused, true);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const other = '[mcp_servers.tilda-connect]\ncommand = "other"\nargs = ["elsewhere"]\n';
    await fs.writeFile(file, other);
    await assert.rejects(configureClient('codex', s.installation, { home: s.home, root: s.root }));
    assert.equal(await fs.readFile(file, 'utf8'), other);
  } finally { await s.cleanup(); }
});
