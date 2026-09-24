// ui/SubTabs.jsx — la barra delle sottosezioni con la riga sotto la voce
// scelta: Servizi, Promozioni, Magazzino e la scheda operatrice.

/**
 * `tabs`: [[chiave, etichetta], …]; `onChange(chiave)` al clic.
 * `extra(chiave)`: un segno dopo l'etichetta (il pallino di Ordini, le
 * modifiche non salvate); `tabStyle`: le regole in più che servono a quel
 * segno (position, inline-flex).
 */
export default function SubTabs({ tabs, value, onChange, extra, tabStyle }) {
  return (
    <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
      {tabs.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', background: 'transparent', border: 'none', color: value === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (value === k ? 'var(--clay)' : 'transparent'), marginBottom: -1, ...tabStyle }}>
          {l}
          {extra?.(k)}
        </button>
      ))}
    </div>
  );
}
