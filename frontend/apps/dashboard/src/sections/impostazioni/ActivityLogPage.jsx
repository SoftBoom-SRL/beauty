// ActivityLogPage.jsx — port of DkActivityLogPage on GET /api/core/activity
// (paginated ?limit&offset, filters ?type=&q=&date_from=&date_to=).
// `type` filter is a startswith prefix server-side → chips are type prefixes.
// The prototype's per-author filter has no API param → dropped (q searches the summary).
// Scope 'activity_log' (owner bypasses).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, Icon, todayStr, toDateStr, addDays } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { inputCss, toastErr, LockNote } from './lib.jsx';

const PAGE = 50;

// meta derived from the real event type string ("appointment.created", "sale.created", …)
const PREFIX_META = {
  appointment: { icon: 'calendar', color: 'var(--info)' },
  pause: { icon: 'pause', color: 'var(--info)' },
  waitlist: { icon: 'clock', color: 'var(--info)' },
  sale: { icon: 'wallet', color: 'var(--ok)' },
  deposit: { icon: 'wallet', color: 'var(--ok)' },
  client: { icon: 'clients', color: 'var(--info)' },
  client_category: { icon: 'tag', color: 'var(--info)' },
  service: { icon: 'scissors', color: 'var(--clay-ink)' },
  package: { icon: 'gift', color: 'var(--clay-ink)' },
  category: { icon: 'tag', color: 'var(--clay-ink)' },
  product: { icon: 'box', color: 'var(--info)' },
  stock: { icon: 'box', color: 'var(--info)' },
  order: { icon: 'send', color: 'var(--warn)' },
  supplier: { icon: 'box', color: 'var(--warn)' },
  coupon: { icon: 'coupon', color: 'var(--ok)' },
  giftcard: { icon: 'gift', color: 'var(--ok)' },
  loyalty: { icon: 'heart', color: 'var(--ok)' },
  loyalty_program: { icon: 'heart', color: 'var(--ok)' },
  communication: { icon: 'message', color: 'var(--info)' },
  automation: { icon: 'bolt', color: 'var(--clay-ink)' },
  operator: { icon: 'user', color: 'var(--info)' },
  team: { icon: 'user', color: 'var(--clay-ink)' },
  settings: { icon: 'settings', color: 'var(--muted)' },
  deposit_rule: { icon: 'coupon', color: 'var(--clay-ink)' },
};
const SUFFIX_COLOR = {
  deleted: 'var(--danger)', removed: 'var(--danger)',
  cancelled: 'var(--warn)', no_show: 'var(--warn)',
  created: 'var(--ok)', paid: 'var(--ok)',
};
function typeMeta(type) {
  const [prefix, suffix] = String(type || '').split('.');
  const base = PREFIX_META[prefix] || { icon: 'edit', color: 'var(--info)' };
  return { icon: base.icon, color: SUFFIX_COLOR[suffix] || base.color };
}

function logDateLabel(iso, lang) {
  const d = new Date(iso);
  const now = new Date();
  const day0 = new Date(d); day0.setHours(0, 0, 0, 0);
  const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
  const diff = Math.round((t0 - day0) / 86400000);
  const hm = d.toTimeString().slice(0, 5);
  if (diff === 0) return (lang === 'en' ? 'Today' : 'Oggi') + ' · ' + hm;
  if (diff === 1) return (lang === 'en' ? 'Yesterday' : 'Ieri') + ' · ' + hm;
  const months = lang === 'en'
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + hm;
}

export default function ActivityLogPage({ onBack, initialPeriod }) {
  const { t, lang, hasScope, fireToast } = useDash();
  const canLog = hasScope('activity_log');

  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [filt, setFilt] = useState('');            // type prefix, '' = all
  const [period, setPeriod] = useState(initialPeriod || 'all');
  const [from, setFrom] = useState(toDateStr(addDays(new Date(), -30)));
  const [to, setTo] = useState(todayStr());
  const [items, setItems] = useState(null);        // null = loading
  const [count, setCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // debounce search
  useEffect(() => { const h = setTimeout(() => setQDeb(q), 300); return () => clearTimeout(h); }, [q]);

  const dateRange = useCallback(() => {
    const today = todayStr();
    if (period === 'today') return { date_from: today, date_to: today };
    if (period === '7d') return { date_from: toDateStr(addDays(new Date(), -7)), date_to: today };
    if (period === '30d') return { date_from: toDateStr(addDays(new Date(), -30)), date_to: today };
    if (period === 'year') return { date_from: toDateStr(addDays(new Date(), -365)), date_to: today };
    if (period === 'custom') return { date_from: from, date_to: to };
    return {};
  }, [period, from, to]);

  const seq = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const mySeq = ++seq.current;
    if (offset === 0) setItems(null); else setLoadingMore(true);
    try {
      const params = { limit: PAGE, offset, ...(filt ? { type: filt } : {}), ...(qDeb ? { q: qDeb } : {}), ...dateRange() };
      const res = await api.get('/api/core/activity', { params });
      if (mySeq !== seq.current) return;
      setCount(res.count);
      setItems((prev) => (offset === 0 ? res.items : [...(prev || []), ...res.items]));
    } catch (err) {
      if (mySeq === seq.current) { toastErr(err, fireToast, t); setItems((prev) => prev || []); }
    } finally {
      if (mySeq === seq.current) setLoadingMore(false);
    }
  }, [filt, qDeb, dateRange, fireToast, t]);

  useEffect(() => { if (canLog) load(0); }, [canLog, load]);
  useEffect(() => {
    const c = document.querySelector('.dk-content');
    if (c) c.scrollTop = 0;
  }, []);

  const tabs = [
    ['', t('Tutto', 'All')],
    ['appointment', t('Appuntamenti', 'Appointments')],
    ['sale', t('Vendite', 'Sales')],
    ['client', t('Clienti', 'Clients')],
    ['service', t('Servizi', 'Services')],
    ['stock', t('Magazzino', 'Inventory')],
    ['order', t('Ordini', 'Orders')],
    ['team', t('Team', 'Team')],
    ['settings', t('Impostazioni', 'Settings')],
  ];
  const periods = [['today', t('Oggi', 'Today')], ['7d', t('7 giorni', '7 days')], ['30d', t('30 giorni', '30 days')], ['year', t('Anno', 'Year')], ['all', t('Tutto', 'All')], ['custom', t('Personalizzato', 'Custom')]];

  return (
    <div className="dk-page" style={{ maxWidth: 900 }}>
      <button className="dk-btn dk-btn--ghost" onClick={onBack} style={{ marginBottom: 16 }}><Icon name="chevL" size={16} />{t('Impostazioni', 'Settings')}</button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={22} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>{t('Registro attività', 'Activity log')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Ogni azione con data, ora e autore.', 'Every action with date, time and author.')}</div>
        </div>
      </div>

      {!canLog ? (
        <LockNote t={t} msg={t('Ti serve il permesso "Registro attività" per consultare il registro.', 'You need the "Activity log" permission to view the log.')} />
      ) : (
        <React.Fragment>
          {/* search */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <div className="dk-search" style={{ flex: 1, minWidth: 220, width: 'auto' }}>
              <Icon name="search" size={17} color="var(--muted-2)" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca nella descrizione…', 'Search the description…')} />
              {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'none', border: 'none' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
            </div>
          </div>

          {/* period filter */}
          <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="t-meta" style={{ marginRight: 2 }}>{t('Periodo', 'Period')}</span>
            {periods.map(([k, l]) => {
              const on = period === k;
              return <button key={k} onClick={() => setPeriod(k)} style={{ padding: '6px 12px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{l}</button>;
            })}
          </div>
          {period === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={{ ...inputCss, fontSize: 13, padding: '8px 11px', cursor: 'pointer' }} />
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>→</span>
              <input type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} style={{ ...inputCss, fontSize: 13, padding: '8px 11px', cursor: 'pointer' }} />
            </div>
          )}

          {/* type filter */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {tabs.map(([k, l]) => {
              const on = filt === k;
              return <button key={k} onClick={() => setFilt(k)} style={{ padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>;
            })}
          </div>

          {items === null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 64, borderRadius: 14 }} />)}
            </div>
          ) : (
            <React.Fragment>
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>{count} {t('voci', 'entries')}</div>
              <div className="dk-card" style={{ overflow: 'hidden' }}>
                {items.map((e, i) => {
                  const m = typeMeta(e.type);
                  return (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'color-mix(in srgb, ' + m.color + ' 14%, transparent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={m.icon} size={16} color={m.color} /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{e.summary}</div>
                        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, color: m.color, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>{e.type}</span>
                          {e.actor_name && <span>{e.actor_name}</span>}
                        </div>
                      </div>
                      <div className="tabnum t-sm" style={{ color: 'var(--muted-2)', flexShrink: 0, textAlign: 'right' }}>{logDateLabel(e.created_at, lang)}</div>
                    </div>
                  );
                })}
                {!items.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '36px 16px', textAlign: 'center' }}>{t('Nessuna voce per i filtri selezionati.', 'No entries for the selected filters.')}</div>}
              </div>
              {items.length < count && (
                <button className="dk-btn dk-btn--ghost" disabled={loadingMore} style={{ width: '100%', marginTop: 12, opacity: loadingMore ? 0.6 : 1 }} onClick={() => load(items.length)}>
                  {loadingMore ? t('Caricamento…', 'Loading…') : t('Carica altre voci', 'Load more entries')}
                </button>
              )}
            </React.Fragment>
          )}
        </React.Fragment>
      )}
    </div>
  );
}
