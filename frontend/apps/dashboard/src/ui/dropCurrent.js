// dropCurrent.js — la voce che un menu a tendina (DkDrop) mostra per un valore
// salvato. Logica pura, provata con node --test (test/impostazioni.test.js,
// che la importa da sections/impostazioni/rules.js).

/** Valore salvato → voce da mostrare nel menu di una condizione.
 *  Un valore che non è fra le opzioni si mostra COME TALE («etichetta non
 *  trovata: A rischio»): prima compariva la prima opzione della lista, e una
 *  regola su un'etichetta rinominata o eliminata sembrava configurata su
 *  un'altra etichetta (15-07). `loose`: stesso testo senza badare a maiuscole e
 *  spazi, come confronta il server le etichette (`contains`). */
export function dropCurrent(options, value, { missingLabel, loose = false } = {}) {
  const list = options || [];
  let option = list.find((o) => o.value === value);
  if (!option && loose && typeof value === 'string') {
    const k = value.trim().toLowerCase();
    option = list.find((o) => typeof o.value === 'string' && o.value.trim().toLowerCase() === k);
  }
  if (option) return { label: option.label, missing: false, option };
  if (value == null || value === '') return { label: '—', missing: false, option: null };
  return { label: missingLabel ? missingLabel(value) : String(value), missing: true, option: null };
}
