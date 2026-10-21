import { SERVICE, ACCOUNT, SafeError, validateToken } from './common.mjs';

export async function nativeEntry() {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    // Requiring Secret Service prevents the Linux binding from silently falling back.
    return new Entry(SERVICE, ACCOUNT, { linux: { store: 'secret-service' } });
  } catch {
    throw new SafeError('Хранилище ОС недоступно. Разблокируйте Keychain / Credential Manager / Secret Service. Ключ в файл сохранён не будет.');
  }
}

export async function readToken(factory = nativeEntry) {
  try {
    const token = (await factory()).getPassword();
    if (!token) throw new SafeError('Ключ Tilda ещё не сохранён. В своём терминале выполните: node tilda.mjs key set');
    return validateToken(token);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('Не удалось прочитать ключ из хранилища ОС. Разблокируйте хранилище или сохраните ключ заново.');
  }
}

export async function saveToken(token, factory = nativeEntry) {
  validateToken(token);
  try {
    const entry = await factory();
    entry.setPassword(token);
    if (entry.getPassword() !== token) throw new Error();
  } catch {
    throw new SafeError('Хранилище ОС не подтвердило сохранение ключа. Проверьте доступ к хранилищу и повторите.');
  }
}

export async function deleteToken(factory = nativeEntry) {
  try {
    const entry = await factory();
    if (entry.getPassword()) entry.deletePassword();
  } catch {
    throw new SafeError('Не удалось удалить ключ из хранилища ОС. Проверьте доступ к хранилищу.');
  }
}

export async function hiddenInput(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new SafeError('Ввод ключа разрешён только в вашем локальном интерактивном терминале. Запустите команду самостоятельно; не отправляйте ключ в чат.');
  }
  output.write('Ключ Tilda (ввод скрыт; Enter — сохранить, Ctrl+C — отмена): ');
  const previousRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  let value = '';
  try {
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('error', onEnd);
        process.off('SIGTERM', onEnd);
      };
      const finish = (error) => {
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onEnd = () => finish(new SafeError('Ввод ключа отменён.'));
      const onData = (chunk) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003' || char === '\u0004') { onEnd(); return; }
          if (char === '\r' || char === '\n') { finish(); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char === '\u0015') value = '';
          else if (char >= ' ' && char <= '~') value += char;
          else { finish(new SafeError('Ключ содержит управляющие символы. Повторите ввод.')); return; }
          if (value.length > 4096) { finish(new SafeError('Слишком длинный ключ.')); return; }
        }
      };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onEnd);
      process.once('SIGTERM', onEnd);
    });
  } finally {
    value = '';
    input.setRawMode(Boolean(previousRaw));
    input.pause();
    output.write('\n');
  }
}
