import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dataDir, SafeError } from './common.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const files = ['package.json', 'package-lock.json', 'plugin.json', '.codex-plugin', '.claude-plugin', '.mcp.json', 'mcp.json', 'skills', 'scripts', 'ui', 'LICENSE'];
const marketName = 'tilda-connect-marketplace';

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function serverConfig(runtime, node = process.execPath) {
  return { command: node, args: [path.join(runtime, 'scripts', 'main.mjs'), 'serve'] };
}

export async function mergeDesktopConfig(file, runtime, root, node = process.execPath) {
  let config;
  try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new SafeError('Конфигурация Claude Desktop содержит ошибку. Исправьте JSON и повторите установку.');
    config = {};
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) {
    throw new SafeError('Неожиданный формат конфигурации Claude Desktop. Установка остановлена.');
  }
  const previous = config.mcpServers?.['tilda-connect'];
  if (previous) {
    const script = previous.args?.[0];
    const relative = typeof script === 'string' ? path.relative(path.join(root, 'versions'), script) : '..';
    if (!script || relative.startsWith('..') || path.isAbsolute(relative) || !script.endsWith(path.join('scripts', 'main.mjs'))) {
      throw new SafeError('В Claude Desktop уже есть другое подключение tilda-connect. Переименуйте его вручную перед установкой.');
    }
  }
  config.mcpServers = { ...config.mcpServers, 'tilda-connect': serverConfig(runtime, node) };
  await atomicJson(file, config);
}

async function run(command, args, { cwd, visible = false } = {}) {
  // Never use a shell or pass a credential in arguments/environment.
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: visible ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (!visible) { child.stdout.resume(); child.stderr.resume(); }
    child.once('error', (cause) => {
      const error = new SafeError(`Не удалось запустить ${path.basename(command)}. Проверьте установку приложения и PATH.`);
      error.missing = cause.code === 'ENOENT';
      reject(error);
    });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new SafeError(`Команда ${path.basename(command)} завершилась с кодом ${code}. Повторите установку после проверки приложения и подключения к сети.`)));
  });
}

export async function addPersonalMarketplace(home, runtime, root) {
  const file = path.join(home, '.agents', 'plugins', 'marketplace.json');
  let catalog;
  try { catalog = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new SafeError('Личный marketplace содержит ошибку JSON. Исправьте файл перед установкой.');
    catalog = { name: 'tilda-connect-personal', interface: { displayName: 'Tilda Connect · Автомато' }, plugins: [] };
  }
  if (!catalog || !Array.isArray(catalog.plugins)) throw new SafeError('Неожиданный формат личного marketplace. Изменения остановлены.');
  const relative = path.relative(home, runtime);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SafeError('Для личного marketplace установите файлы внутри домашней папки.');
  const index = catalog.plugins.findIndex(plugin => plugin.name === 'tilda-connect');
  if (index >= 0) {
    const oldSource = catalog.plugins[index].source;
    const oldPath = typeof oldSource === 'string' ? oldSource : oldSource?.path;
    const oldRelative = typeof oldPath === 'string' ? path.relative(root, path.resolve(home, oldPath)) : '..';
    if (oldRelative.startsWith('..') || path.isAbsolute(oldRelative)) throw new SafeError('В личном marketplace уже есть другой tilda-connect. Переименуйте его перед установкой.');
  }
  const plugin = { name: 'tilda-connect', source: { source: 'local', path: `./${relative.split(path.sep).join('/')}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' };
  if (index < 0) catalog.plugins.push(plugin); else catalog.plugins[index] = plugin;
  await atomicJson(file, catalog);
  return catalog.name;
}

function npmInvocation() {
  // npm.cmd requires cmd.exe on Windows. Invoke npm's JS entrypoint directly instead.
  const executable = path.dirname(process.execPath);
  return process.platform === 'win32'
    ? [process.execPath, [path.join(executable, 'node_modules/npm/bin/npm-cli.js')]]
    : ['npm', []];
}

async function sourceDigest() {
  const hash = createHash('sha256');
  const visit = async (name) => {
    const source = path.join(pluginRoot, name);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new SafeError('Символические ссылки в пакете не поддерживаются.');
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(source)).sort()) await visit(path.join(name, child));
    } else { hash.update(name); hash.update(await fs.readFile(source)); }
  };
  for (const file of files) await visit(file);
  return hash.digest('hex').slice(0, 16);
}

export async function prepareRuntime(root) {
  const version = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8')).version;
  const digest = await sourceDigest();
  const runtime = path.join(root, 'versions', `${version}-${digest}`);
  try {
    const marker = JSON.parse(await fs.readFile(path.join(runtime, 'installed.json'), 'utf8'));
    if (marker.digest !== digest || marker.node !== process.execPath || marker.platform !== process.platform || marker.arch !== process.arch) throw new Error();
    await fs.access(path.join(runtime, 'node_modules/@modelcontextprotocol/sdk/package.json'));
    return runtime;
  } catch (error) {
    try { await fs.access(runtime); }
    catch { /* First installation. */ }
    if (await fs.stat(runtime).catch(() => null)) {
      throw new SafeError('Найдена несовместимая установленная сборка. Используйте ту же установку Node.js или перенесите папку версии и повторите установку.');
    }
  }
  await fs.mkdir(path.join(root, 'versions'), { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(root, 'versions', '.install-'));
  try {
    for (const file of files) await fs.cp(path.join(pluginRoot, file), path.join(staging, file), { recursive: true, dereference: false });
    console.log('Устанавливаю зависимости из package-lock.json. Это может занять несколько минут.');
    const [npm, prefix] = npmInvocation();
    await run(npm, [...prefix, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: staging });
    const config = { mcpServers: { tilda: serverConfig(runtime) } };
    await atomicJson(path.join(staging, '.mcp.json'), config);
    await atomicJson(path.join(staging, 'mcp.json'), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { tilda: { type: 'stdio', ...serverConfig(runtime) } } });
    await atomicJson(path.join(staging, 'installed.json'), { digest, node: process.execPath, platform: process.platform, arch: process.arch });
    await fs.rename(staging, runtime);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return runtime;
}

async function chooseClient() {
  if (!process.stdin.isTTY) throw new SafeError('Укажите приложение: --client codex | claude-code | claude-desktop | none.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('1 — Codex\n2 — Claude Code\n3 — Claude Desktop\n4 — Только установить файлы');
    return { '1': 'codex', '2': 'claude-code', '3': 'claude-desktop', '4': 'none' }[(await prompt.question('Куда подключить Tilda? [1]: ')).trim() || '1'];
  } finally { prompt.close(); }
}

export async function install(args) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new SafeError('Установите Node.js 22 или новее: https://nodejs.org/');
  if (args.includes('--help')) {
    console.log('node setup.mjs [--client codex|claude-code|claude-desktop|none] [--connect]\n--connect: после установки запросить ключ скрытым вводом в локальном терминале.');
    return;
  }
  let client;
  let connect = false;
  let root = dataDir();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client') client = args[++i];
    else if (args[i] === '--connect') connect = true;
    else if (args[i] === '--data-dir' && args[i + 1]) root = path.resolve(args[++i]);
    else throw new SafeError('Неизвестный параметр. Справка: node setup.mjs --help');
  }
  if (!client) client = await chooseClient();
  if (!['codex', 'claude-code', 'claude-desktop', 'none'].includes(client)) throw new SafeError('Выберите codex, claude-code, claude-desktop или none.');
  if (connect && !process.stdin.isTTY) throw new SafeError('--connect запускается только в вашем интерактивном терминале.');
  const runtime = await prepareRuntime(root);
  const source = `./${path.relative(root, runtime).split(path.sep).join('/')}`;
  await atomicJson(path.join(root, '.agents/plugins/marketplace.json'), {
    name: marketName, interface: { displayName: 'Tilda Connect · Автомато' },
    plugins: [{ name: 'tilda-connect', source: { source: 'local', path: source }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }]
  });
  await atomicJson(path.join(root, '.claude-plugin/marketplace.json'), {
    name: marketName, owner: { name: 'Роман Лазарев · Автомато' },
    plugins: [{ name: 'tilda-connect', source }]
  });
  await atomicJson(path.join(root, 'current.json'), { runtime, node: process.execPath });
  if (connect) await run(process.execPath, [path.join(runtime, 'scripts/main.mjs'), 'key', 'set'], { visible: true });
  if (client === 'codex') {
    try {
      await run('codex', ['plugin', 'marketplace', 'add', root]);
      await run('codex', ['plugin', 'add', `tilda-connect@${marketName}`]);
      console.log('Плагин установлен в Codex. Перезапустите приложение и откройте новый чат.');
    } catch (error) {
      if (!error.missing) throw error;
      const name = await addPersonalMarketplace(os.homedir(), runtime, root);
      console.log(`Источник ${name} добавлен. Перезапустите Codex → Плагины → этот источник → установите Tilda Connect. Затем откройте новый чат.`);
    }
  } else if (client === 'claude-code') {
    await run('claude', ['plugin', 'marketplace', 'add', root]);
    await run('claude', ['plugin', 'install', `tilda-connect@${marketName}`, '--scope', 'user']);
    console.log('Плагин установлен в Claude Code. Начните новую сессию.');
  } else if (client === 'claude-desktop') {
    const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
      : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude');
    const file = path.join(base, 'claude_desktop_config.json');
    await mergeDesktopConfig(file, runtime, root);
    console.log(`Подключение добавлено в ${file}. Полностью закройте и откройте Claude Desktop.`);
  }
  console.log(`Файлы установлены: ${runtime}`);
  if (!connect) console.log('Сохраните ключ самостоятельно в своём терминале: node tilda.mjs key set');
  console.log('Проверка: node tilda.mjs check');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await install(process.argv.slice(2)).catch(error => {
    console.error(error instanceof SafeError ? error.message : 'Установка Tilda Connect остановлена. Проверьте Node.js, npm и подключение к сети.');
    process.exitCode = 1;
  });
}
