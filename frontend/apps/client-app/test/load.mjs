// Carica un modulo dell'app cliente che `node --test` da solo non saprebbe
// caricare, perché importa api.js o degli schermi .jsx: esbuild lo impacchetta
// con un '@youty/shared' finto (il sorgente `shared`, solo i nomi che servono
// alla prova) e con ogni .jsx sostituito da un componente muto che porta il
// nome del file. Non è un file di test: lo importano i *.test.js.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');   // apps/client-app/

/** `entry` è un percorso da apps/client-app/ (es. 'src/api/client.js'). */
export async function loadModule(entry, { shared = '' } = {}) {
  const res = await build({
    entryPoints: [join(APP, entry)],
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
    plugins: [{
      name: 'finti',
      setup(b) {
        b.onResolve({ filter: /^@youty\/shared$/ }, () => ({ path: 'shared', namespace: 'finto' }));
        b.onResolve({ filter: /\.jsx$/ }, (a) => ({ path: a.path.split('/').pop().replace(/\.jsx$/, ''), namespace: 'muto' }));
        b.onLoad({ filter: /.*/, namespace: 'finto' }, () => ({ contents: shared, loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'muto' }, (a) => ({
          contents: `export default function ${a.path.replace(/\W/g, '_')}() { return null; }`, loader: 'js',
        }));
      },
    }],
  });
  return import('data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64'));
}
