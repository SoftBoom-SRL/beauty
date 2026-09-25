// Sonda di live-shell.test.js: grid-harness.mjs compila la barra in alto e la
// pila dei livelli di ui/layers.js nello stesso bundle. La pila è interna al
// modulo: solo così la prova può aprire un livello (un modale o un pannello
// locale di una sezione) che la barra vede.
export { default as Topbar } from '../../src/shell/Topbar.jsx';
export { useEscLayer } from '../../src/ui/layers.js';
