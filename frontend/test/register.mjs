// Registra l'hook di risoluzione dei test (vedi shared-loader.mjs).
// Usato da `npm test` con --import: permette ai test di importare i moduli
// delle app così come sono, senza bisogno di `npm install`.
import { register } from 'node:module';

register('./shared-loader.mjs', import.meta.url);
