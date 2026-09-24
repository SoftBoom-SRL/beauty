// L'anteprima dell'agenda (preview.html → preview/preview.jsx) non entra nel
// build di Vite: un import rotto verso i file che usa (ctx.jsx, Topbar,
// DkModals, DkToast, la sezione agenda, i fogli di stile) non lo vedrebbe
// nessuno fino alla prossima volta che qualcuno la apre. Qui la si compila con
// esbuild senza scrivere niente: un file che manca o un nome non più esportato
// fanno fallire la prova.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

test('l\'anteprima dell\'agenda si compila con tutti i suoi import', async () => {
  const res = await build({
    entryPoints: [join(APP, 'preview', 'preview.jsx')],
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
    jsx: 'automatic', loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty' },
  });
  assert.equal(res.errors.length, 0);
  assert.equal(res.outputFiles.length, 1);
});
