// rules.js — logica pura delle regole caparra (campi, frase riassuntiva,
// importo). Sta fuori da lib.jsx perché si possa provare con `node --test`;
// lib.jsx la riesporta. La voce mostrata dal menu di una condizione è
// dropCurrent di ui/ (la usa anche il menu delle automazioni): la frase la usa
// qui, e i test la importano da qui.
import { dropCurrent } from '../../ui/dropCurrent.js';

export { dropCurrent };

/* ---------------- deposit-rule fields (dkDepositFields port, API facts) ---------------- */
export function depositFields(clientCategories, t) {
  return [
    { id: 'reliability', type: 'num', defaultCmp: 'lt', defaultValue: 60, unit: '', label: { it: 'Affidabilità', en: 'Reliability' } },
    {
      id: 'categories', type: 'enum', cmp: 'contains', loose: true,
      label: { it: 'Etichetta cliente', en: 'Client label' },
      options: (clientCategories || []).map((c) => ({ value: c.name, label: c.name })),
      missingLabel: (v) => t(`etichetta non trovata: ${v}`, `label not found: ${v}`),
    },
    { id: 'total_spent', type: 'money', defaultCmp: 'lt', defaultValue: 100, unit: '€', label: { it: 'Totale speso', en: 'Total spent' } },
    { id: 'visits', type: 'num', defaultCmp: 'lt', defaultValue: 2, unit: '', label: { it: 'Numero di visite', en: 'Number of visits' } },
    { id: 'noshow_count', type: 'num', defaultCmp: 'gte', defaultValue: 1, unit: '', label: { it: 'No-show', en: 'No-shows' } },
    { id: 'latecancel_count', type: 'num', defaultCmp: 'gte', defaultValue: 1, unit: '', label: { it: 'Cancellazioni tardive', en: 'Late cancellations' } },
    { id: 'deposit_always', type: 'bool', label: { it: 'Deposito sempre richiesto', en: 'Deposit always required' } },
  ];
}

/* ---------------- natural-language rule sentence (dkRuleSentence port) ---------------- */
export function ruleSentence(conditions, fields, t, lang) {
  const rules = (conditions && conditions.rules) || [];
  if (!rules.length) return t('Tutte le clienti', 'All clients');
  const joinTxt = (conditions.op === 'or') ? ` ${t('O', 'OR')} ` : ` ${t('E', 'AND')} `;
  const CMP_TXT = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', neq: '≠' };
  return rules.map((r) => {
    const f = fields.find((x) => x.id === r.field);
    if (!f) return `${r.field} ${CMP_TXT[r.cmp] || r.cmp} ${r.value}`;
    const label = f.label[lang] || f.label.it;
    if (f.type === 'enum') return label + ' = ' + dropCurrent(f.options, r.value, { missingLabel: f.missingLabel, loose: f.loose }).label;
    if (f.type === 'bool') return label + (r.value ? '' : ' = No');
    return label + ' ' + (CMP_TXT[r.cmp] || r.cmp) + ' ' + (f.type === 'money' ? '€' : '') + r.value;
  }).join(joinTxt);
}

/** Importo della regola quando cambia il tipo. Il limite a 100 del campo
 *  percentuale valeva solo all'uscita dal campo: convertendo una regola da
 *  «Importo fisso» 150 € a «% del totale» si salvava un acconto del 150 %, cioè
 *  l'intero prezzo del servizio (15-16). In percentuale: intero fra 0 e 100. */
export function amountForType(amount, type) {
  const n = Number(amount) || 0;
  if (type === 'pct') return Math.min(100, Math.max(0, Math.round(n)));
  return Math.max(0, n);
}
