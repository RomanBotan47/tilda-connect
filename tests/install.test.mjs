import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeDesktopConfig, serverConfig, addPersonalMarketplace } from '../plugins/tilda-connect/scripts/install.mjs';

test('Desktop configuration preserves unrelated servers and settings; supports own version updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tilda-config-test-'));
  try {
    const file = path.join(root, 'Claude/config.json');
    await fs.mkdir(path.dirname(file));
    const original = { theme: 'dark', mcpServers: { other: { command: 'other', args: ['keep'] } } };
    await fs.writeFile(file, JSON.stringify(original));
    const runtime = path.join(root, 'versions/one');
    await mergeDesktopConfig(file, runtime, root, '/node');
    const changed = JSON.parse(await fs.readFile(file));
    assert.equal(changed.theme, 'dark');
    assert.deepEqual(changed.mcpServers.other, original.mcpServers.other);
    assert.deepEqual(changed.mcpServers['tilda-connect'], serverConfig(runtime, '/node'));
    await mergeDesktopConfig(file, path.join(root, 'versions/two'), root, '/node');
    assert.match(JSON.parse(await fs.readFile(file)).mcpServers['tilda-connect'].args[0], /two/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid JSON or an existing unrelated Tilda connection is never overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tilda-config-test-'));
  try {
    const file = path.join(root, 'config.json');
    for (const source of ['{broken', JSON.stringify({ mcpServers: { 'tilda-connect': { command: 'keep', args: ['/other/main.mjs'] } } })]) {
      await fs.writeFile(file, source);
      await assert.rejects(mergeDesktopConfig(file, path.join(root, 'versions/new'), root));
      assert.equal(await fs.readFile(file, 'utf8'), source);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex catalog fallback preserves existing entries and only updates its own source', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tilda-catalog-test-'));
  const root = path.join(home, 'app-data');
  try {
    const file = path.join(home, '.agents/plugins/marketplace.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const other = { name: 'other', source: './other' };
    await fs.writeFile(file, JSON.stringify({ name: 'mine', plugins: [other], interface: { displayName: 'Keep' } }));
    assert.equal(await addPersonalMarketplace(home, path.join(root, 'versions/one'), root), 'mine');
    await addPersonalMarketplace(home, path.join(root, 'versions/two'), root);
    const catalog = JSON.parse(await fs.readFile(file));
    assert.equal(catalog.plugins.length, 2);
    assert.deepEqual(catalog.plugins[0], other);
    assert.equal(catalog.interface.displayName, 'Keep');
    assert.equal(catalog.plugins[1].source.path, './app-data/versions/two');
    catalog.plugins[1].source.path = './some-other-plugin';
    const original = JSON.stringify(catalog);
    await fs.writeFile(file, original);
    await assert.rejects(addPersonalMarketplace(home, path.join(root, 'versions/three'), root));
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
