// StoricoTab.jsx — the client's sales history (GET /api/sales/?q=<name word>,
// filtered exactly by client_id on our side: the API has no by-client filter).
// Expanding a row lazy-loads the sale detail (lines + payments).
import React, { useEffect, useState } from 'react';
import { api, ApiError, EmptyState, Icon, fmtEur } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';
import { clientQueryWord, dateLabel } from '../helpers.js';

const methodLabel = (m, t) => ({
  cash: t('Contanti', 'Cash'), card: t('Carta', 'Card'),
  gift_card: 'Gift card', other: t('Altro', 'Other'),
}[m] || m);

export default function StoricoTab({ c }) {
  const { t, lang, services, fireToast } = useDash();
  const [sales, setSales] = useState(null);
  const [expanded, setExpanded] = useState(null);   // sale id
  const [details, setDetails] = useState({});       // sale id → SaleDetailOut

  useEffect(() => {
    let dead = false;
    setSales(null);
    const word = clientQueryWord(c);
    api.get('/api/sales/', { params: { q: word || undefined, limit: 100 } })
      .then((res) => { if (!dead) setSales((res.items || []).filter((s) => s.client_id === c.id)); })
      .catch((err) => {
        if (dead) return;
        setSales([]);
        fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      });
    return () => { dead = true; };
  }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (id) => {
    const open = expanded === id;
    setExpanded(open ? null : id);
    if (!open && !details[id]) {
      try {
        const d = await api.get(`/api/sales/${id}`);
        setDetails((m) => ({ ...m, [id]: d }));
      } catch (err) {
        fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      }
    }
  };

  const svcName = (sid) => {
    const s = services.find((x) => x.id === sid);
    if (!s) return t('Servizio', 'Service');
    return (lang === 'en' && s.name_en) ? s.name_en : s.name_it;
  };
  const lineLabel = (ln) => {
    if (ln.line_type === 'service') return svcName(ln.service_id);
    if (ln.line_type === 'gift_card') return 'Gift card';
    return t('Prodotto', 'Product');
  };

  if (sales == null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 62, borderRadius: 12 }} />)}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {c.last_visit && (
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 2 }}>
          {t('Ultima visita', 'Last visit')}: <b style={{ color: 'var(--ink-2)' }}>{dateLabel(c.last_visit, lang)}</b> · {sales.length} {t('vendite registrate', 'recorded sales')}
        </div>
      )}
      {sales.map((s) => {
        const open = expanded === s.id;
        const d = details[s.id];
        return (
          <div key={s.id} className="dk-card" style={{ padding: 0, boxShadow: 'none', border: '1px solid var(--hair)', overflow: 'hidden' }}>
            <button className="dk-row" onClick={() => toggle(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', width: '100%', textAlign: 'left', background: 'transparent', cursor: 'pointer', border: 'none' }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: s.kind === 'checkout' ? 'var(--clay)' : 'var(--info)', flexShrink: 0 }} />
              <div style={{ width: 96, fontWeight: 700, fontSize: 13.5, flexShrink: 0 }}>{dateLabel(s.created_at, lang)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.kind === 'checkout' ? t('Appuntamento', 'Appointment') : t('Vendita al banco', 'Counter sale')}</div>
                {Number(s.deposit_deducted) > 0 && <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Acconto detratto', 'Deposit deducted')} {fmtEur(Number(s.deposit_deducted), lang)}</div>}
              </div>
              <span className="t-num" style={{ fontSize: 16, flexShrink: 0 }}>{fmtEur(Number(s.total), lang)}</span>
              <Icon name="chevD" size={15} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
            </button>
            {open && (
              <div style={{ padding: '0 18px 16px 42px', borderTop: '1px solid var(--hair)' }}>
                {!d && <div className="skel" style={{ height: 60, borderRadius: 10, marginTop: 14 }} />}
                {d && (
                  <React.Fragment>
                    <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {d.lines.map((ln) => (
                        <div key={ln.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>
                            {lineLabel(ln)}{ln.qty > 1 ? ` ×${ln.qty}` : ''}{ln.is_gift ? ' · ' + t('omaggio', 'gift') : ''}{ln.discount_pct ? ` · −${ln.discount_pct}%` : ''}
                          </span>
                          <span className="t-sm" style={{ color: 'var(--muted)' }}>{ln.operator_name}</span>
                          <span className="t-num" style={{ fontSize: 13.5 }}>{fmtEur(Number(ln.amount), lang)}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', paddingTop: 14, marginTop: 12, borderTop: '1px solid var(--hair)' }}>
                      <div>
                        <div className="t-meta" style={{ marginBottom: 4 }}>{t('Acconto', 'Deposit')}</div>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: Number(d.deposit_deducted) > 0 ? 'var(--ink-2)' : 'var(--muted-2)' }}>
                          {Number(d.deposit_deducted) > 0 ? fmtEur(Number(d.deposit_deducted), lang) + ' · ' + t('detratto', 'deducted') : t('Nessun acconto', 'No deposit')}
                        </div>
                      </div>
                      <div>
                        <div className="t-meta" style={{ marginBottom: 4 }}>{t('Pagamenti', 'Payments')}</div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          {d.payments.map((p) => (
                            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>
                              <Icon name={p.method === 'cash' ? 'wallet' : p.method === 'gift_card' ? 'gift' : 'coupon'} size={14} color="var(--muted)" />
                              {methodLabel(p.method, t)} · {fmtEur(Number(p.amount), lang)}
                            </span>
                          ))}
                          {!d.payments.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>—</span>}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!sales.length && <EmptyState icon="calendar" title={t('Nessuna visita', 'No visits yet')} sub={t('Lo storico apparirà dopo la prima vendita.', 'History will appear after the first sale.')} />}
      <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 4 }}>
        {t('I prossimi appuntamenti del cliente si consultano in Agenda.', "The client's upcoming appointments live in the Agenda.")}
      </div>
    </div>
  );
}
