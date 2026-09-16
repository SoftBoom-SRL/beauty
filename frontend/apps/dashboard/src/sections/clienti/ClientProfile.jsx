// ClientProfile.jsx — full client profile (ported DkClientProfile): header with
// contact actions, editable labels, KPI stats, deposit banner, language card
// and the 5 tabs (Storico / Scheda tecnica / Note / Wallet / Consensi).
import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, Avatar, Icon, fmtEur } from '@youty/shared';
import { useDash, useLive } from '../../ctx.jsx';
import { CatChip, ConfirmModal, ProfStat, RelRing } from './components.jsx';
import { initialsOf, relMeta, toClientIn, waHref, formatBirthday, daysToBirthday, genderLabel, genderGlyph, dateLabel } from './helpers.js';
import StoricoTab from './tabs/StoricoTab.jsx';
import TechSheetTab from './tabs/TechSheetTab.jsx';
import NotesTab from './tabs/NotesTab.jsx';
import WalletTab from './tabs/WalletTab.jsx';
import ConsensiTab from './tabs/ConsensiTab.jsx';

export default function ClientProfile({ clientId, onChanged, onDeleted }) {
  const { t, lang, fireToast, hasScope, clientCategories, openModal } = useDash();
  const canWrite = hasScope('clients');

  const [c, setC] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState('storico');
  const [labelPick, setLabelPick] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [onWaitlist, setOnWaitlist] = useState(false);

  const toastErr = useCallback((err) => {
    fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
  }, [fireToast, t]);

  /* detail (ClientDetailOut: + visits, total_spent, last_visit) */
  useEffect(() => {
    let dead = false;
    setC(null); setFailed(false);
    api.get(`/api/clients/${clientId}`)
      .then((res) => { if (!dead) setC(res); })
      .catch((err) => { if (!dead) { setFailed(true); toastErr(err); } });
    return () => { dead = true; };
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  // la scheda cambia altrove (altra postazione, altra scheda) → ricarico in silenzio
  useLive(/^client\.(updated|deleted)/, (events) => {
    if (events.some((e) => e.payload?.client_id === clientId)) api.get(`/api/clients/${clientId}`).then((res) => setC((prev) => (prev ? { ...prev, ...res } : res))).catch(() => {});
  });

  /* waiting-list badge (needs agenda read scope; fail silently) */
  useEffect(() => {
    let dead = false;
    if (!hasScope('agenda')) return undefined;
    api.get('/api/agenda/waitlist')
      .then((rows) => { if (!dead) setOnWaitlist((rows || []).some((w) => w.client_id === clientId)); })
      .catch(() => {});
    return () => { dead = true; };
  }, [clientId, hasScope]);

  /* PUT helper — always sends the FULL ClientIn (partial bodies would reset
   * unspecified fields to schema defaults). Response is a ClientOut: merge it
   * over the detail to keep visits/total_spent/last_visit. */
  const updateClient = async (patch, toast) => {
    try {
      const res = await api.put(`/api/clients/${clientId}`, toClientIn(c, patch));
      setC((prev) => ({ ...prev, ...res }));
      if (toast) fireToast(toast);
      onChanged && onChanged();
      return true;
    } catch (err) { toastErr(err); return false; }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await api.del(`/api/clients/${clientId}`);
      fireToast({ msg: t(`Cliente ${c.full_name} archiviato`, `Client ${c.full_name} archived`), icon: 'check' });
      setConfirmDel(false);
      onDeleted && onDeleted();
    } catch (err) { toastErr(err); } finally { setDeleting(false); }
  };

  if (failed) {
    return (
      <div style={{ padding: '40px 30px', textAlign: 'center' }}>
        <div className="t-title" style={{ marginBottom: 6 }}>{t('Cliente non disponibile', 'Client unavailable')}</div>
        <div className="t-body" style={{ color: 'var(--muted)' }}>{t('La scheda non può essere caricata.', 'The profile could not be loaded.')}</div>
      </div>
    );
  }
  if (!c) {
    return (
      <div style={{ padding: '26px 30px 40px', maxWidth: 880 }}>
        <div style={{ display: 'flex', gap: 18, marginBottom: 22 }}>
          <div className="skel" style={{ width: 76, height: 76, borderRadius: 99 }} />
          <div style={{ flex: 1 }}>
            <div className="skel" style={{ height: 30, width: 260, marginBottom: 10 }} />
            <div className="skel" style={{ height: 16, width: 180 }} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 14 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 90, borderRadius: 16 }} />)}
        </div>
        <div className="skel" style={{ height: 260, borderRadius: 16 }} />
      </div>
    );
  }

  const score = c.reliability ?? 100;
  const rel = relMeta(score, t);
  const visits = c.visits || 0;
  const totalSpent = Number(c.total_spent || 0);
  const wa = waHref(c.phone);
  const sinceYear = c.since ? String(c.since).slice(0, 4) : null;
  const assignedIds = (c.categories || []).map((x) => x.id);
  const bdays = daysToBirthday(c.birthday);
  const subtitle = [
    genderLabel(c.gender, t),
    c.age != null ? t(`${c.age} anni`, `${c.age} years old`) : null,
    sinceYear ? t(`cliente dal ${sinceYear}`, `client since ${sinceYear}`) : null,
    c.origin || null,
  ].filter(Boolean).join(' · ');
  const openEdit = () => openModal('newclient', { client: c, onSaved: (u) => { setC((prev) => ({ ...prev, ...u })); onChanged && onChanged(); } });

  const tabs = [
    ['storico', t('Storico', 'History')],
    ['scheda', t('Scheda tecnica', 'Tech sheet')],
    ['note', t('Note', 'Notes')],
    ['voucher', 'Wallet'],
    ['consensi', t('Consensi', 'Consents')],
  ];

  const btnA = { textDecoration: 'none' }; // anchor-as-button

  return (
    <div style={{ padding: '26px 30px 40px', maxWidth: 880 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 22, flexWrap: 'wrap' }}>
        <Avatar initials={initialsOf(c.full_name)} size={76} />
        <div style={{ flex: '1 1 210px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 500 }}>{c.full_name}</span>
            {c.gender && <span title={genderLabel(c.gender, t)} aria-label={genderLabel(c.gender, t)} style={{ fontSize: 18, color: 'var(--muted)', lineHeight: 1 }}>{genderGlyph(c.gender)}</span>}
            {bdays != null && bdays <= 14 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--warn-tint)', color: 'var(--warn)', whiteSpace: 'nowrap' }}>
                <Icon name="cake" size={12} color="var(--warn)" />{bdays === 0 ? t('Compleanno oggi!', 'Birthday today!') : bdays === 1 ? t('Compleanno domani', 'Birthday tomorrow') : t(`Compleanno tra ${bdays} giorni`, `Birthday in ${bdays} days`)}
              </span>
            )}
            {onWaitlist && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, background: 'var(--clay-tint)', color: 'var(--clay-ink)', border: '1px solid color-mix(in srgb, var(--clay) 25%, transparent)', whiteSpace: 'nowrap' }}>
                <Icon name="clock" size={11} color="var(--clay-ink)" />{t("In lista d'attesa", 'On waiting list')}
              </span>
            )}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 6, textTransform: 'none' }}>
            {subtitle || t('Cliente', 'Client')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {c.wa && wa
            ? <a className="dk-btn dk-btn--ghost" style={btnA} href={wa} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</a>
            : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('WhatsApp non disponibile', 'WhatsApp unavailable'), icon: 'whatsapp' })}><Icon name="whatsapp" size={17} color="#3F9D58" />WhatsApp</button>}
          {c.phone
            ? <a className="dk-btn dk-btn--ghost" style={btnA} href={`tel:${c.phone}`}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</a>
            : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Nessun numero di telefono', 'No phone number'), icon: 'phone' })}><Icon name="phone" size={17} />{t('Chiama', 'Call')}</button>}
          {c.email
            ? <a className="dk-btn dk-btn--ghost" style={btnA} href={`mailto:${c.email}`}><Icon name="mail" size={17} />Email</a>
            : <button className="dk-btn dk-btn--ghost" onClick={() => fireToast({ msg: t('Nessuna email in anagrafica', 'No email on file'), icon: 'mail' })}><Icon name="mail" size={17} />Email</button>}
          <button className="dk-btn dk-btn--clay" title={t('La conversazione si gestisce su Yourang', 'The conversation is managed on Yourang')} onClick={() => fireToast({ msg: t('Apertura di Yourang…', 'Opening Yourang…'), icon: 'ext' })}><Icon name="ext" size={16} color="#fff" />Yourang</button>
          {canWrite && (
            <button className="dk-btn dk-btn--ghost" onClick={openEdit} title={t('Modifica dati anagrafici', 'Edit personal details')}><Icon name="edit" size={16} />{t('Modifica', 'Edit')}</button>
          )}
          {canWrite && (
            <button className="dk-iconbtn" title={t('Archivia cliente', 'Archive client')} onClick={() => setConfirmDel(true)} style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--hair))' }}>
              <Icon name="x" size={16} color="var(--danger)" />
            </button>
          )}
        </div>
      </div>

      {/* labels — client categories from the catalog, editable via PUT category_ids */}
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', position: 'relative', margin: '-6px 0 20px' }}>
        {(c.categories || []).map((cat) => (
          <CatChip key={cat.id} cat={cat}
            onRemove={canWrite ? () => updateClient({ category_ids: assignedIds.filter((x) => x !== cat.id) }, { msg: t('Etichetta rimossa', 'Label removed'), icon: 'check' }) : null}
            removeTitle={t('Rimuovi etichetta', 'Remove label')} />
        ))}
        {canWrite && (
          <button onClick={() => setLabelPick((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', border: '1px dashed var(--line-strong)', background: 'transparent', padding: '4px 10px', borderRadius: 99, cursor: 'pointer' }}>
            <Icon name="plus" size={11} color="var(--muted)" />{t('etichetta', 'label')}
          </button>
        )}
        {labelPick && (
          <React.Fragment>
            <div onClick={() => setLabelPick(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
            <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 51, width: 250, padding: 6, boxShadow: 'var(--sh-pop)' }}>
              <div className="t-meta" style={{ padding: '6px 9px 7px' }}>{t('Etichette cliente', 'Client labels')}</div>
              <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                {clientCategories.map((cat) => {
                  const on = assignedIds.includes(cat.id);
                  return (
                    <button key={cat.id} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', border: 'none', background: 'transparent' }}
                      onClick={() => updateClient({ category_ids: on ? assignedIds.filter((x) => x !== cat.id) : [...assignedIds, cat.id] })}>
                      <span style={{ width: 11, height: 11, borderRadius: 99, background: cat.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{cat.name}</span>
                      {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
                    </button>
                  );
                })}
              </div>
              <div style={{ borderTop: '1px solid var(--hair)', marginTop: 5, paddingTop: 5 }}>
                <button className="dk-row" onClick={() => { setLabelPick(false); openModal('catsmgr', { scope: 'clienti' }); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', color: 'var(--clay-ink)', fontWeight: 600, fontSize: 12.5, border: 'none', background: 'transparent' }}>
                  <Icon name="settings" size={14} color="var(--clay-ink)" />{t('Gestisci catalogo', 'Manage catalogue')}<Icon name="chevR" size={13} color="var(--clay-ink)" style={{ marginLeft: 'auto' }} />
                </button>
              </div>
            </div>
          </React.Fragment>
        )}
      </div>

      {/* KPIs (visits / total_spent / avg ticket from ClientDetailOut) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginBottom: 14 }}>
        <ProfStat label={t('Visite', 'Visits')} value={visits} />
        <ProfStat label={t('Valore totale', 'Lifetime value')} value={totalSpent ? fmtEur(totalSpent, lang) : '€0'} />
        <ProfStat label={t('Scontrino medio', 'Avg ticket')} value={totalSpent ? fmtEur(Math.round(totalSpent / Math.max(1, visits)), lang) : '€0'} />
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Affidabilità', 'Reliability')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <RelRing score={score} color={rel.color} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: rel.color }}>{rel.label}</div>
              <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Punteggio', 'Score')} {score}/100</div>
            </div>
          </div>
        </div>
      </div>
      {/* anagrafica: tutto ciò che si può modificare, con il percorso per farlo */}
      <div className="dk-card" style={{ padding: '14px 16px', marginBottom: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div className="t-meta">{t('Anagrafica', 'Personal details')}</div>
          <div style={{ flex: 1 }} />
          {canWrite && <button onClick={openEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}><Icon name="edit" size={13} color="var(--clay-ink)" />{t('Modifica', 'Edit')}</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px 18px' }}>
          {[
            [t('Telefono', 'Phone'), c.phone, 'phone'],
            ['Email', c.email, 'mail'],
            [t('Genere', 'Gender'), genderLabel(c.gender, t), 'user'],
            [t('Compleanno', 'Birthday'), c.birthday ? formatBirthday(c.birthday, lang) + (c.age != null ? ` · ${c.age} ${t('anni', 'y.o.')}` : ` · ${t('anno non indicato', 'no year')}`) : '', 'cake'],
            [t('Come ci ha conosciuto', 'How they found us'), c.origin, 'sparkle'],
            [t('Cliente dal', 'Client since'), c.since ? dateLabel(c.since, lang) : '', 'calendar'],
          ].map(([label, value, icon]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 5 }}><Icon name={icon} size={11} color="var(--muted-2)" />{label}</div>
              {value
                ? <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={icon === 'phone' ? 'tabnum' : ''}>{value}</div>
                : canWrite
                  ? <button onClick={openEdit} style={{ fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0, marginTop: 2 }}>+ {t('aggiungi', 'add')}</button>
                  : <div style={{ fontSize: 14, color: 'var(--muted-2)', marginTop: 2 }}>—</div>}
            </div>
          ))}
        </div>
      </div>
      {c.deposit_always && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', background: 'var(--warn-tint)', borderRadius: 12, marginBottom: 14 }}>
          <Icon name="coupon" size={18} color="var(--warn)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)', flex: 1 }}>{t('Deposito sempre richiesto per questo cliente', 'Deposit always required for this client')}</span>
          {canWrite && <button onClick={() => updateClient({ deposit_always: false }, { msg: t('Caparra obbligatoria rimossa', 'Mandatory deposit removed'), icon: 'check' })} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Rimuovi', 'Remove')}</button>}
        </div>
      )}

      {/* preferred language — drives automatic WhatsApp messages */}
      <div className="dk-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', marginBottom: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="whatsapp" size={18} color="#3F9D58" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Lingua preferita', 'Preferred language')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{t('Tutte le comunicazioni WhatsApp automatiche (conferme, promemoria, post-visita, marketing) usano questa lingua.', 'All automatic WhatsApp messages (confirmations, reminders, post-visit, marketing) use this language.')}</div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', borderRadius: 10, padding: 4, flexShrink: 0 }}>
          {[['it', 'Italiano'], ['en', 'English']].map(([k, l]) => {
            const on = (c.lang || 'it') === k;
            return (
              <button key={k} disabled={!canWrite}
                onClick={() => !on && updateClient({ lang: k }, { msg: k === 'en' ? t('Comunicazioni WhatsApp in inglese', 'WhatsApp messages set to English') : t('Comunicazioni WhatsApp in italiano', 'WhatsApp messages set to Italian'), icon: 'whatsapp' })}
                style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canWrite ? 'pointer' : 'default', border: 'none', background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--ink)' : 'var(--muted)', boxShadow: on ? 'var(--sh-card)' : 'none' }}>{l}</button>
            );
          })}
        </div>
      </div>

      {/* tabs */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 20 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ padding: '11px 4px', marginRight: 18, fontSize: 14.5, fontWeight: 600, cursor: 'pointer', color: tab === k ? 'var(--ink)' : 'var(--muted)', background: 'transparent', border: 'none', borderBottom: '2px solid ' + (tab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'storico' && <StoricoTab c={c} />}
      {tab === 'scheda' && <TechSheetTab c={c} />}
      {tab === 'note' && <NotesTab clientId={c.id} />}
      {tab === 'voucher' && <WalletTab c={c} />}
      {tab === 'consensi' && <ConsensiTab c={c} updateClient={updateClient} canWrite={canWrite} />}

      {confirmDel && (
        <ConfirmModal t={t}
          title={t('Archiviare il cliente?', 'Archive this client?')}
          sub={c.full_name}
          body={t('Il cliente viene disattivato (soft delete): sparisce dalle liste ma lo storico resta. Potrà essere riattivato in seguito.', 'The client is deactivated (soft delete): removed from the lists, history is kept. It can be reactivated later.')}
          confirmLabel={t('Archivia', 'Archive')}
          busy={deleting}
          onConfirm={doDelete}
          onClose={() => setConfirmDel(false)} />
      )}
    </div>
  );
}
