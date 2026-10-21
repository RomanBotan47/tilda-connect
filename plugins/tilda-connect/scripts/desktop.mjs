import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { atomicJson, serverConfig } from './install.mjs';
import { dataDir, SafeError } from './common.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const BEGIN = '# BEGIN TILDA CONNECT';
const END = '# END TILDA CONNECT';
const parts = ['package.json', 'package-lock.json', 'plugin.json', '.codex-plugin', '.claude-plugin', '.mcp.json', 'mcp.json', 'scripts', 'skills', 'ui', 'LICENSE'];
export const CLIENTS = { codex: 'Codex', 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code' };

async function optionalText(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function prepareDesktopRuntime(root = dataDir()) {
  const pkg = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  const visit = async name => {
    const file = path.join(pluginRoot, name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new SafeError('Пакет повреждён. Скачайте его повторно.');
    if (stat.isDirectory()) for (const child of (await fs.readdir(file)).sort()) await visit(path.join(name, child));
    else { hash.update(name); hash.update(await fs.readFile(file)); }
  };
  for (const part of parts) await visit(part);
  const id = `${pkg.version}-${hash.digest('hex').slice(0, 12)}-${process.platform}-${process.arch}-${process.version}`;
  const runtime = path.join(root, 'versions', id);
  const node = path.join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  if (await optionalText(path.join(runtime, 'desktop-installed.json'))) {
    await fs.access(node);
    return { runtime, node };
  }
  await fs.mkdir(path.join(root, 'versions'), { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(root, 'versions', '.desktop-'));
  try {
    for (const part of parts) await fs.cp(path.join(pluginRoot, part), path.join(staging, part), { recursive: true });
    // Portable packages include platform dependencies. No package manager runs on the user's machine.
    await fs.cp(path.join(pluginRoot, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true, filter: file => !file.split(path.sep).includes('.bin') });
    await fs.mkdir(path.join(staging, 'bin'));
    await fs.copyFile(process.execPath, path.join(staging, 'bin', path.basename(node)));
    await fs.chmod(path.join(staging, 'bin', path.basename(node)), 0o755);
    const config = serverConfig(runtime, node);
    await atomicJson(path.join(staging, '.mcp.json'), { mcpServers: { tilda: config } });
    await atomicJson(path.join(staging, 'mcp.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { tilda: { type: 'stdio', ...config } } });
    await atomicJson(path.join(staging, 'desktop-installed.json'), { version: pkg.version, nodeVersion: process.version, platform: process.platform, arch: process.arch });
    await fs.rename(staging, runtime);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return { runtime, node };
}

function isOwned(entry, root) {
  const script = entry?.args?.[0];
  if (typeof script !== 'string') return false;
  const relative = path.relative(path.join(root, 'versions'), script);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && script.endsWith(path.join('scripts', 'main.mjs'));
}

// Return a rollback that only touches our exact write; concurrent user changes are preserved.
async function commit(file, before, after) {
  if (await optionalText(file) !== before) throw new SafeError('Настройки приложения изменились во время подключения. Нажмите «Подключить» ещё раз.');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, after, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
  return async () => {
    if (await optionalText(file) !== after) return;
    if (before === null) await fs.rm(file);
    else {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, before, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    }
  };
}

export async function configureClient(client, installation, { home = os.homedir(), root = dataDir(), platform = process.platform, env = process.env } = {}) {
  if (!Object.hasOwn(CLIENTS, client)) throw new SafeError('Выберите приложение для подключения.');
  const config = serverConfig(installation.runtime, installation.node);
  if (client === 'codex') {
    const file = path.join(home, '.codex', 'config.toml');
    const before = await optionalText(file);
    let parsed;
    try { parsed = parse(before || ''); } catch { throw new SafeError('Codex не смог прочитать свои настройки. Откройте Codex и проверьте настройки перед подключением.'); }
    const existing = parsed.mcp_servers?.['tilda-connect'];
    const activePlugin = Object.entries(parsed.plugins || {}).some(([name, value]) => name.startsWith('tilda-connect@') && value.enabled === true);
    // Reuse our original plugin if it is already installed; both read the same native credential.
    if (!existing && activePlugin) return { rollback: async () => {}, reused: true };
    if (existing && !isOwned(existing, root)) throw new SafeError('В Codex уже есть подключение Tilda с этим именем. Его настройки сохранены. Обратитесь к автору пакета для переноса.');
    let base = before || '';
    const block = /^# BEGIN TILDA CONNECT\r?\n[\s\S]*?^# END TILDA CONNECT\r?\n?/gm;
    const matches = [...base.matchAll(block)];
    if (existing && matches.length !== 1) throw new SafeError('Существующее подключение Tilda было настроено вручную. Его настройки сохранены.');
    if (matches.length > 1) throw new SafeError('Найдено несколько настроек Tilda. Его настройки сохранены.');
    if (matches.length) base = base.replace(block, '');
    const after = `${base.trimEnd()}\n\n${BEGIN}\n[mcp_servers.tilda-connect]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\nstartup_timeout_sec = 30\n${END}\n`;
    let checked;
    try { checked = parse(after); } catch { throw new SafeError('Не удалось безопасно добавить подключение в Codex. Настройки сохранены.'); }
    const omitOwn = value => {
      const copy = structuredClone(value);
      if (copy.mcp_servers) {
        delete copy.mcp_servers['tilda-connect'];
        if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers;
      }
      return copy;
    };
    if (!isDeepStrictEqual(omitOwn(parsed), omitOwn(checked))) throw new SafeError('Проверка сохранности настроек Codex не пройдена. Изменения остановлены.');
    return { rollback: await commit(file, before, after) };
  }
  const file = client === 'claude-code' ? path.join(home, '.claude.json')
    : path.join(platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
      : platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'), 'claude_desktop_config.json');
  const before = await optionalText(file);
  let parsed;
  try { parsed = JSON.parse(before || '{}'); } catch { throw new SafeError('Настройки Claude содержат ошибку. Откройте приложение и проверьте настройки перед подключением.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.mcpServers && (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) throw new SafeError('Не удалось безопасно прочитать настройки Claude.');
  const existing = parsed.mcpServers?.['tilda-connect'];
  if (existing && !isOwned(existing, root)) throw new SafeError('В Claude уже есть подключение Tilda с этим именем. Его настройки сохранены.');
  parsed.mcpServers = { ...parsed.mcpServers, 'tilda-connect': config };
  return { rollback: await commit(file, before, `${JSON.stringify(parsed, null, 2)}\n`) };
}
