// Browser QA only. Uses temporary settings and a public synthetic credential; never reads the user's vault.
import { createWizard } from '../../plugins/tilda-connect/scripts/wizard.mjs';
import { SafeError } from '../../plugins/tilda-connect/scripts/common.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tilda-browser-qa-'));
const root = path.join(home, 'data');
const wizard = await createWizard({ home, root, read: async () => { throw new Error('test vault is empty'); }, save: async () => {}, prepare: async () => ({ runtime: path.join(root, 'versions/qa'), node: process.execPath }), check: async key => {
  if (key !== 'synthetic-browser-qa-success-key') throw new SafeError('Tilda отклонила ключ.');
  return { toolCount: 5, more: false };
} });
console.log(wizard.origin);
process.once('SIGTERM', wizard.close);
process.once('SIGINT', wizard.close);
