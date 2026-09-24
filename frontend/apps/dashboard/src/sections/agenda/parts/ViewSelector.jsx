// ViewSelector — Giorno / Settimana / Mese nella barra.

export default function ViewSelector({ calView, setCalView, t }) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
      {[['day', 'Giorno', 'Day'], ['week', 'Settimana', 'Week'], ['month', 'Mese', 'Month']].map(([v, it, en]) => {
        const sel = calView === v;
        return <button key={v} onClick={() => setCalView(v)} style={{ padding: '8px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: sel ? 'var(--ink)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', transition: 'all 140ms' }}>{t(it, en)}</button>;
      })}
    </div>
  );
}
