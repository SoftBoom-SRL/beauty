import React, { useEffect, useState } from 'react';
import { api, ApiError, Icon, Avatar, EmptyState } from '@youty/shared';
import Pager from './Pager.jsx';
import ClientPicker from './ClientPicker.jsx';
import { LOYALTY_TYPES } from './meta.js';
import { shortDate } from './dates.js';

const LIMIT = 25;

/** Drawer content: paginated member accounts of a loyalty program
 * (GET /api/marketing/loyalty-programs/{id}/accounts → {items,count}).
 * Programmi con iscrizione «Su richiesta» o «A pagamento»: «Iscrivi cliente»
 * → POST …/accounts {client_id} (contratto C16, permesso marketing). */
export default function LoyaltyMembersDrawer({ program, onClose, t, lang, fireToast, canWrite = false, onEnrolled }) {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  /* Iscrizione dallo staff. Con «Su richiesta» o «A pagamento» nessuna via
   * creava il conto (il server iscrive da solo solo con «Automatica»): il
   * programma si salvava, il cassetto prometteva l'iscrizione su richiesta, e
   * le nuove clienti non maturavano niente, in silenzio (07-13). */
  const manual = !!program.enrollment && program.enrollment !== 'auto';
  const [adding, setAdding] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  const enroll = async (client) => {
    if (!client || enrolling) return;
    setEnrolling(true);
    try {
      await api.post(`/api/marketing/loyalty-programs/${program.id}/accounts`, { client_id: client.id });
      fireToast({ msg: t(`${client.full_name} iscritta al programma`, `${client.full_name} enrolled in the program`), icon: 'check' });
      setAdding(false);
      setOffset(0);
      setReloadKey((k) => k + 1);
      onEnrolled?.(); // il conteggio sulla scheda del programma
    } catch (err) {
      // 400 «già iscritta» / «programma disattivato», 404 cliente di un altro salone
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
    } finally {
      setEnrolling(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/marketing/loyalty-programs/${program.id}/accounts`, { params: { limit: LIMIT, offset } })
      .then((res) => { if (alive) { setItems(res.items || []); setCount(res.count || 0); } })
      .catch((err) => {
        if (!alive) return;
        setItems([]); setCount(0);
        fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [program.id, offset, reloadKey]);

  const typeMeta = LOYALTY_TYPES.find((x) => x.k === program.type) || LOYALTY_TYPES[0];
  const unit = program.type === 'stamps' ? t('timbri', 'stamps') : 'pt';
  const initials = (name) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '22px 24px 14px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: `color-mix(in srgb, ${program.color || 'var(--clay-ink)'} 16%, transparent)`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name={typeMeta.icon} size={20} color={program.color || 'var(--clay-ink)'} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{program.name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{count} {count === 1 ? t('cliente iscritta', 'enrolled client') : t('clienti iscritte', 'enrolled clients')} · {t('traguardo', 'threshold')} {program.threshold} {unit}</div>
        </div>
        {manual && canWrite && (
          <button className="dk-btn dk-btn--ghost" style={{ flexShrink: 0, height: 34, fontSize: 12.5 }}
            disabled={!program.active || enrolling} onClick={() => setAdding((v) => !v)}
            title={program.active ? undefined : t('Programma disattivato: riattivalo per iscrivere nuove clienti', 'Program deactivated: reactivate it to enroll new clients')}>
            <Icon name="plus" size={14} />{t('Iscrivi cliente', 'Enroll client')}
          </button>
        )}
        <button className="dk-iconbtn" style={{ flexShrink: 0 }} onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      {adding && (
        <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
          <ClientPicker client={null} onChange={enroll} placeholder={t('Cerca la cliente da iscrivere…', 'Search the client to enroll…')} t={t} />
          {enrolling && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6 }}>{t('Iscrizione…', 'Enrolling…')}</div>}
        </div>
      )}

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 24px 24px' }}>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...Array(6)].map((_, i) => <div key={i} className="skel" style={{ height: 58, borderRadius: 12 }} />)}
          </div>
        ) : items.length ? (
          <React.Fragment>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((a) => {
                const pct = program.threshold ? Math.min(100, Math.round((a.points * 100) / program.threshold)) : 0;
                return (
                  <div key={a.id} className="dk-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: 'none', border: '1px solid var(--hair)' }}>
                    <Avatar initials={initials(a.client_name)} size={38} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.client_name}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)' }}>
                        {t('Iscritta il', 'Joined')} {shortDate(a.joined_at, lang)}
                      </div>
                      <div style={{ height: 5, borderRadius: 99, background: 'var(--paper-2)', overflow: 'hidden', marginTop: 7 }}>
                        <div style={{ height: '100%', width: pct + '%', background: program.color || 'var(--clay)', borderRadius: 99 }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div className="t-num" style={{ fontSize: 17 }}>{a.points}</div>
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{unit}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <Pager count={count} limit={LIMIT} offset={offset} setOffset={setOffset} t={t} />
          </React.Fragment>
        ) : (
          <EmptyState icon="clients" title={t('Nessuna iscritta', 'No members yet')}
            sub={manual
              ? t('Con l’iscrizione su richiesta o a pagamento le clienti non entrano da sole: iscrivile con «Iscrivi cliente».', 'With opt-in or paid enrollment clients do not join on their own: enroll them with “Enroll client”.')
              : t('Le clienti si iscrivono automaticamente o su richiesta secondo le regole del programma.', 'Clients join automatically or on request, per the program rules.')} />
        )}
      </div>
    </div>
  );
}
