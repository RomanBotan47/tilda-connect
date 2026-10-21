import { bridge } from './bridge.mjs';
import { checkConnection } from './connection.mjs';
import { readToken, saveToken, deleteToken, hiddenInput } from './vault.mjs';
import { SafeError, connectionError } from './common.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && args[0] === 'serve')) return bridge(await readToken());
  const command = args.join(' ');
  if (command === 'key set') {
    let token = await hiddenInput();
    try { await saveToken(token); } finally { token = ''; }
    console.log('Ключ сохранён в хранилище ОС. Проверка подключения: node tilda.mjs check');
  } else if (command === 'key delete') {
    await deleteToken();
    console.log('Локальный ключ удалён. Для отзыва доступа удалите ключ также в профиле Tilda. Перезапустите Codex/Claude, чтобы завершить старые соединения.');
  } else if (command === 'key status') {
    await readToken();
    console.log('Ключ присутствует в хранилище ОС. Проверка Tilda: node tilda.mjs check');
  } else if (command === 'check') {
    const result = await checkConnection(await readToken());
    console.log(`Tilda подключена. Инструментов на первой странице: ${result.toolCount}${result.more ? '; есть продолжение' : ''}. Выполнены только initialize и tools/list.`);
  } else {
    throw new SafeError('Команды: serve | key set | key status | key delete | check. Ключ вводится только скрытым запросом команды key set.');
  }
}

try { await main(); } catch (error) {
  console.error(error instanceof SafeError ? error.message : 'Tilda Connect: операция завершилась с ошибкой. Проверьте установку и системное хранилище ключей.');
  process.exitCode = 1;
}
