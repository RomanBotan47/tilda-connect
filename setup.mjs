#!/usr/bin/env node
import { install } from './plugins/tilda-connect/scripts/install.mjs';
import { SafeError } from './plugins/tilda-connect/scripts/common.mjs';
await install(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof SafeError ? error.message : 'Установка остановлена. Проверьте Node.js 22+, npm и доступ к registry.npmjs.org.');
  process.exitCode = 1;
});
