// Lint del frontend: `npm run lint` dalla cartella frontend/.
//
// Il codice è JavaScript senza tipi, e il build di Vite non si accorge di un
// identificatore che non esiste: un componente spostato in un altro file con
// un import dimenticato passa il build e si rompe solo nel browser, alla prima
// apertura di quella schermata. ESLint è la rete che lo ferma prima:
// `no-undef` sugli identificatori (anche nel JSX) e `no-unused-vars` per il
// codice rimasto orfano.
//
// Solo regole che trovano errori: niente regole di stile, il formato resta
// quello del codice esistente.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['**/dist/**', '**/dist-check*/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      // Solo le due regole classiche degli hook: le altre del preset
      // «recommended» della versione 7 servono al React Compiler, che qui
      // non c'è.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Test (node --test), loader dei test e configurazioni di Vite girano in Node.
    files: ['test/**', '**/test/**', '**/vite.config.js', 'eslint.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];
