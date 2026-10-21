import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { dataDir } from './common.mjs';

export async function launch(args = ['serve']) {
  try {
    const root = dataDir();
    const { runtime, node } = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    const relative = path.relative(path.join(root, 'versions'), runtime);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error();
    const child = spawn(node, [path.join(runtime, 'scripts/main.mjs'), ...args], { stdio: 'inherit', windowsHide: true });
    const forward = () => child.kill('SIGTERM');
    process.once('SIGTERM', forward);
    process.once('SIGINT', forward);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
    });
    process.off('SIGTERM', forward);
    process.off('SIGINT', forward);
  } catch {
    console.error('Tilda Connect ещё не установлен. Откройте локальный терминал в папке пакета и выполните node setup.mjs. Ключ в чат не отправляйте.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await launch(process.argv.slice(2));
