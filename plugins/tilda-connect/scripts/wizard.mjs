import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir, SafeError, validateToken, redactor } from './common.mjs';
import { readToken, saveToken } from './vault.mjs';
import { checkConnection } from './connection.mjs';
import { atomicJson } from './install.mjs';
import { prepareDesktopRuntime, configureClient, CLIENTS } from './desktop.mjs';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/wizard.css': ['wizard.css', 'text/css; charset=utf-8'], '/wizard.js': ['wizard.js', 'text/javascript; charset=utf-8'] };

function setupMessage(error) {
  if (!(error instanceof SafeError)) return 'Подключение остановилось. Проверьте доступ к хранилищу ключей и попробуйте ещё раз.';
  if (error.message.startsWith('Tilda отклонила ключ')) return 'Tilda не приняла ключ. Проверьте, что вы скопировали его целиком. Если срок истёк, создайте новый ключ в Tilda.';
  if (error.message.startsWith('Ключ Tilda ещё не сохранён')) return 'Сохранённый ключ недоступен. Нажмите «Использовать другой ключ» и вставьте новый ключ из Tilda.';
  if (error.message.startsWith('Соединение Tilda прервалось')) return 'Не удалось связаться с Tilda. Проверьте интернет и попробуйте ещё раз.';
  return error.message;
}

export async function createWizard({ root = dataDir(), home = os.homedir(), prepare = prepareDesktopRuntime, configure = configureClient, check = checkConnection, save = saveToken, read = readToken, idleMs = 15 * 60_000 } = {}) {
  const csrf = randomBytes(32).toString('hex');
  let origin;
  let busy = false;
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const authenticate = req => {
    const supplied = req.headers['x-tilda-setup'];
    return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const expectedHost = new URL(origin).host;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin)) { json(res, 403, { error: 'Откройте мастер из приложения Tilda Connect.' }); return; }
    const asset = ASSETS[req.url];
    if (req.method === 'GET' && asset) {
      try {
        let content = await fs.readFile(path.join(ui, asset[0]));
        if (req.url === '/') content = Buffer.from(content.toString('utf8').replace('__CSRF__', csrf));
        res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content);
      } catch { json(res, 500, { error: 'Пакет повреждён. Скачайте его повторно.' }); }
      return;
    }
    if (!authenticate(req)) { json(res, 403, { error: 'Перезапустите мастер подключения.' }); return; }
    if (req.method === 'POST' && req.headers.origin !== origin) { json(res, 403, { error: 'Повторите действие из окна мастера.' }); return; }
    if (req.method === 'GET' && req.url === '/api/status') {
      let hasKey = false;
      try { hasKey = Boolean(await read()); } catch { /* Setup remains usable with a fresh key. */ }
      json(res, 200, { hasKey, platform: process.platform }); return;
    }
    if (req.method === 'POST' && req.url === '/api/close') { json(res, 200, { ok: true }); setImmediate(close); return; }
    if (req.method !== 'POST' || req.url !== '/api/connect') { json(res, 404, { error: 'Откройте главную страницу мастера.' }); return; }
    if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 403, { error: 'Повторите подключение из окна мастера.' }); return; }
    if (busy) { json(res, 409, { error: 'Подключение уже выполняется. Дождитесь результата.' }); return; }
    busy = true;
    let token = '';
    let body = '';
    let registration;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 8192) throw new SafeError('Вставьте только ключ, полученный в Tilda.');
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new SafeError('Не удалось прочитать форму. Повторите ввод ключа.'); }
      body = '';
      if (!Object.hasOwn(CLIENTS, data.client)) throw new SafeError('Выберите приложение.');
      token = data.useSaved === true ? await read() : validateToken(data.token);
      delete data.token;
      const verified = await check(token);
      const installation = await prepare(root);
      await atomicJson(path.join(root, 'current.json'), installation);
      registration = await configure(data.client, installation, { home, root });
      if (data.useSaved !== true) await save(token);
      token = '';
      json(res, 200, { ok: true, client: CLIENTS[data.client], toolCount: verified.toolCount, more: verified.more });
    } catch (error) {
      req.resume();
      await registration?.rollback?.().catch(() => {});
      const message = setupMessage(error);
      json(res, 400, { error: token ? redactor(token)(message) : message });
    } finally { token = ''; body = ''; busy = false; }
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 10_000;
  let timer;
  const close = () => { clearTimeout(timer); server.close(); server.closeIdleConnections(); };
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(close, idleMs);
  timer.unref();
  return { origin, server, close };
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { console.error('Откройте Tilda Connect повторно, чтобы запустить мастер в браузере.'); });
  child.unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const wizard = await createWizard();
    if (process.argv.includes('--no-open')) console.log(wizard.origin); else openBrowser(wizard.origin);
    process.once('SIGTERM', wizard.close);
    process.once('SIGINT', wizard.close);
  } catch { console.error('Tilda Connect не смог открыть мастер. Скачайте пакет повторно и запустите приложение.'); process.exitCode = 1; }
}
