// ServedClients.jsx — linguetta «Clienti serviti» della scheda operatrice
// (StaffPage), con la ricerca lato server.
import { Avatar, Icon, salonTzOpts } from '@youty/shared';
import { HIDDEN } from './lib.js';

/* ================= Clienti serviti (GET /{id}/clients?q=) ================= */
export default function ServedClients({ clients, q, setQ, onOpen, rev, t, lang }) {
  const fmtVisit = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    // Il giorno del salone: una visita delle 20:00 a Roma, vista da un
    // portatile su un altro fuso, compariva col giorno dopo (09-11, 15-22).
    return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', salonTzOpts({ day: 'numeric', month: 'short', year: 'numeric' }));
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="t-meta" style={{ marginBottom: 10 }}>{t('Clienti serviti', 'Clients served')}</div>
      <div className="dk-search" style={{ width: '100%', marginBottom: 12 }}>
        <Icon name="search" size={16} color="var(--muted-2)" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per nome o telefono…', 'Search by name or phone…')} />
        {q && (
          <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'transparent' }}>
            <Icon name="x" size={14} color="var(--muted-2)" />
          </button>
        )}
      </div>

      {clients == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 58, borderRadius: 12 }} />)}
        </div>
      ) : !clients.length ? (
        <div className="dk-card" style={{ padding: 28, textAlign: 'center' }}>
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>
            {q ? t('Nessun cliente trovato.', 'No client found.') : t('Nessun cliente servito finora.', 'No clients served yet.')}
          </div>
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 120px 100px', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
            <span className="t-meta">{t('Cliente', 'Client')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Visite', 'Visits')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Ultima visita', 'Last visit')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Spesa tot.', 'Total spent')}</span>
          </div>
          {clients.map((c) => {
            const initials = ((c.first_name[0] || '') + (c.last_name[0] || '')).toUpperCase();
            return (
              <button key={c.client_id} className="dk-row" onClick={() => onOpen(c.client_id)}
                style={{ display: 'grid', gridTemplateColumns: '1fr 84px 120px 100px', gap: 10, alignItems: 'center', width: '100%', padding: '11px 16px', borderTop: '1px solid var(--hair)', textAlign: 'left', background: 'transparent' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  <Avatar initials={initials} size={34} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.first_name} {c.last_name}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{c.phone}</span>
                  </span>
                </span>
                {/* visite, ultima visita e spesa sono dati di cassa: senza il
                    permesso vendite arrivano null con cash_hidden (C6) */}
                <span className="t-num" style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{c.visits == null ? HIDDEN : c.visits}</span>
                <span className="t-sm" style={{ textAlign: 'right', color: 'var(--ink-2)' }}>{c.cash_hidden ? HIDDEN : fmtVisit(c.last_visit)}</span>
                <span className="t-num" style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{rev(c.total_spent)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
