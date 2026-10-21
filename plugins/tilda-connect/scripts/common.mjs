import os from 'node:os';
import path from 'node:path';

export const ENDPOINT = 'https://tilda.ru/api/mcp/';
export const SERVICE = 'ru.avtomato.tilda-connect';
export const ACCOUNT = 'default';
export class SafeError extends Error {}

export function dataDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'TildaConnect');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'TildaConnect');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'tilda-connect');
}

export function validateToken(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value) || /YOUR_TOKEN|TOKEN_HERE|PLACEHOLDER/.test(value)) {
    throw new SafeError('Ключ должен быть скопирован целиком из Tilda и содержать только печатные символы без пробелов.');
  }
  return value;
}

export function redactor(token) {
  const needles = [...new Set([token, encodeURIComponent(token), Buffer.from(token).toString('base64')])];
  return function redact(value) {
    if (typeof value === 'string') {
      for (const needle of needles) value = value.split(needle).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), redact(v)]));
    return value;
  };
}

export function connectionError(error) {
  if (error instanceof SafeError) return error.message;
  return 'Соединение Tilda прервалось. Результат последнего действия может быть неизвестен. Проверьте его в Tilda перед повтором.';
}
