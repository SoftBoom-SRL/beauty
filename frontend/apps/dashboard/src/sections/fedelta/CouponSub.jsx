import React, { useCallback, useEffect, useState } from 'react';
import { fmtEur, Icon, EmptyState, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { GroupedFilterMenu } from '../../ui/index.js';
import Pager from './Pager.jsx';
import CouponEditModal from './modals/CouponEditModal.jsx';
import { COUPON_ORIGIN_META, COUPON_STATUS_META, effectiveStatus } from './meta.js';
import { salonDay, shortDate } from './dates.js';
import { couponsApi } from '../../api/marketing.js';
import { useLatestRequest } from '../../hooks/useLatestRequest.js';

const LIMIT = 24;

function couponValueLabel(c, lang) {
  if (!c) return '';
  // i Decimal dell'API viaggiano come stringhe ("20.00"): senza Number() un
  // coupon del 20% si leggeva «-20.00%» qui e «-20%» nella scheda cliente
  return c.kind === 'amount' ? '-' + fmtEur(Number(c.value), lang) : '-' + Number(c.value) + '%';
}

export default function CouponSub() {
  const { t, lang, hasScope, fireToast } = useDash();
  const canWrite = hasScope('marketing');
  // chi non ha marketing né vendite vede i codici mascherati e non cerca per codice (C21)
  const codesVisible = canWrite || hasScope('sales');

  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [originF, setOriginF] = useState('all');
  const [statusF, setStatusF] = useState('all');
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);

  // debounce the search box into `query`, resetting to page 1
  useEffect(() => {
    const tm = setTimeout(() => { setQuery(q); setOffset(0); }, 300);
    return () => clearTimeout(tm);
  }, [q]);

  /* Un solo effetto, con filtri e offset fra le dipendenze, e l'offset
   * azzerato dallo stesso gestore che cambia il filtro (come fa ProdottiSub):
   * con l'azzeramento in un effetto separato partivano due richieste — una con
   * l'offset vecchio — e vinceva l'ultima che rispondeva, così si vedeva la
   * pagina 3 mentre il pager in fondo diceva «1–24 di N».
   * `req` (useLatestRequest) scarta comunque le risposte in ritardo. */
  const req = useLatestRequest();
  const setFilter = (setter) => (v) => { setter(v); setOffset(0); };

  const reload = useCallback(() => {
    const seq = req.begin();
    setLoading(true);
    couponsApi.list({
      origin: originF === 'all' ? undefined : originF,
      status: statusF === 'all' ? undefined : statusF,
      q: query || undefined,
      limit: LIMIT, offset,
    }).then((res) => {
      if (!req.isLatest(seq)) return;
      setItems(res.items || []);
      setCount(res.count || 0);
    }).catch((err) => {
      if (!req.isLatest(seq)) return;
      setItems([]); setCount(0);
      toastApiError(err, fireToast, t);
    }).finally(() => { if (req.isLatest(seq)) setLoading(false); });
  }, [originF, statusF, query, offset, fireToast, t, req]);

  useEffect(() => { reload(); }, [reload]);

  const blank = () => ({ _new: true, kind: 'percent', value: 10, client: null, expires_at: null });

  const openNew = () => setEdit(blank());
  const openExisting = (c) => setEdit({
    ...c,
    // scaduto = non più modificabile né «utilizzabile», come per il server
    status: effectiveStatus(c),
    client: c.client_id ? { id: c.client_id, full_name: c.client_name } : null,
    // normalise the API's ISO datetime to a YYYY-MM-DD string for the modal's date input —
    // il giorno del SALONE: col fuso del dispositivo la scadenza slittava a ogni salvataggio
    expires_at: salonDay(c.expires_at),
  });

  const handleSaved = (msg) => {
    setEdit(null);
    fireToast({ msg, icon: 'check' });
    reload();
  };

  const handleDeleted = () => {
    setEdit(null);
    fireToast({ msg: t('Coupon eliminato', 'Coupon deleted'), icon: 'x' });
    reload();
  };

  return (
    <React.Fragment>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>
        {t('Crea coupon manuali e assegnali ai clienti dalla loro scheda. Quelli con origine “Fedeltà” nascono dal riscatto di un premio.', 'Create manual coupons and assign them from each client’s profile. “Loyalty”-origin ones are minted when a reward is redeemed.')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 0, width: 'auto' }}>
          <Icon name="search" size={18} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={codesVisible ? t('Cerca per codice o cliente…', 'Search by code or client…') : t('Cerca per cliente…', 'Search by client…')} />
          {q && <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={15} color="var(--muted-2)" /></button>}
        </div>
        <GroupedFilterMenu t={t} groups={[
          { label: t('Origine', 'Origin'), value: originF, set: setFilter(setOriginF), opts: [['all', t('Tutte', 'All')], ['manual', t('Manuale', 'Manual')], ['auto', t('Automatico', 'Automatic')], ['loyalty', t('Da fedeltà', 'From loyalty')]] },
          { label: t('Stato', 'Status'), value: statusF, set: setFilter(setStatusF), opts: [['all', t('Tutti', 'All')], ['active', t('Attivi', 'Active')], ['redeemed', t('Utilizzati', 'Redeemed')], ['expired', t('Scaduti', 'Expired')]] },
        ]} />
        {canWrite && <button className="dk-btn dk-btn--clay" onClick={openNew} style={{ flexShrink: 0 }}><Icon name="plus" size={17} color="#fff" />{t('Nuovo coupon', 'New coupon')}</button>}
      </div>

      {loading && !items.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {[...Array(6)].map((_, i) => <div key={i} className="skel" style={{ height: 128, borderRadius: 16 }} />)}
        </div>
      ) : items.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {items.map((c) => {
            const om = COUPON_ORIGIN_META[c.origin] || COUPON_ORIGIN_META.manual;
            // scaduto si legge scaduto anche se la risposta dice ancora «attivo» (07-07)
            const status = effectiveStatus(c);
            const sm = COUPON_STATUS_META[status] || COUPON_STATUS_META.active;
            return (
              <div key={c.id} className="dk-card dk-hovercard" onClick={() => openExisting(c)}
                style={{ padding: 18, opacity: status === 'active' ? 1 : 0.72, borderLeft: '3px solid ' + (status === 'active' ? 'var(--clay)' : 'var(--faint)') }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <Icon name="coupon" size={21} color="var(--clay-ink)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--ink)', background: 'var(--paper-2)', padding: '3px 9px', borderRadius: 6, display: 'inline-block' }}>{c.code}</span>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="user" size={13} color="var(--muted-2)" />
                      {c.client_name || t('Nessun cliente assegnato', 'No client assigned')}
                    </div>
                  </div>
                  <div className="t-num" style={{ fontSize: 20, color: 'var(--clay-ink)' }}>{couponValueLabel(c, lang)}</div>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="calendar" size={13} color="var(--muted-2)" />
                  {c.expires_at ? t('Scade il ', 'Expires ') + shortDate(c.expires_at, lang) : t('Nessuna scadenza', 'No expiry')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: om.color, background: om.bg, padding: '3px 9px', borderRadius: 99 }}>
                    <Icon name={om.icon} size={12} color={om.color} />{om[lang]}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: sm.color, background: sm.bg, padding: '2px 8px', borderRadius: 99 }}>{sm[lang]}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon="coupon" title={t('Nessun coupon', 'No coupons')} sub={t('Crea il tuo primo coupon.', 'Create your first coupon.')}
          action={canWrite ? t('Nuovo coupon', 'New coupon') : null} onAction={openNew} />
      )}

      <Pager count={count} limit={LIMIT} offset={offset} setOffset={setOffset} t={t} />

      {edit && (
        <CouponEditModal
          draft={edit} setDraft={setEdit} onClose={() => setEdit(null)}
          onSaved={handleSaved} onDeleted={handleDeleted} onRedeemed={reload}
          canWrite={canWrite} t={t} lang={lang} fireToast={fireToast}
        />
      )}
    </React.Fragment>
  );
}
