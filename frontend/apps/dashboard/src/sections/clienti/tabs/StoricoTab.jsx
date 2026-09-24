// StoricoTab.jsx — lo storico del cliente in un'unica timeline
// (GET /api/clients/{id}/history): ogni visita con servizi, operatrici, stato,
// incasso, nota appuntamento, note di trattamento con foto/documenti e schede
// tecniche; più vendite al banco, note e schede non legate a una visita.
// Da ogni visita si aggiunge una nota di trattamento (con allegati) o si apre
// la scheda tecnica, senza uscire dal profilo.
import React, { useCallback, useEffect, useState } from 'react';
import { EmptyState, Icon, fmtEur, fmtEurNoFree, fmtDur, timeLabel, minutesOfDay, statusMeta, toastApiError } from '@youty/shared';
import { useDash, useLive } from '../../../ctx.jsx';
import { NoteCard, NoteComposer } from '../NoteBits.jsx';
import { dateLabel, depositBadge, sheetVal, timelineDate } from '../helpers.js';
import { clientsApi } from '../../../api/clients.js';

export default function StoricoTab({ c }) {
  const { t, lang, fireToast, hasScope, openModal, modal } = useDash();
  const canWrite = hasScope('clients');
  const [hist, setHist] = useState(null);
  const [filter, setFilter] = useState('all'); // all | visits | notes | sheets
  const [composer, setComposer] = useState(null); // appointment id | 'free' | null
  const [showUpcoming, setShowUpcoming] = useState(true);

  const load = useCallback(() => (
    clientsApi.history(c.id)
      .then(setHist)
      .catch((err) => { setHist({ entries: [], counts: {} }); toastApiError(err, fireToast, t); })
  ), [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHist(null); load(); }, [load]);
  // `deposit.`: una caparra pagata o rimborsata altrove cambia l'etichetta della visita
  useLive(/^(appointment|sale|visit|deposit|client\.note|client\.sheet)/, () => load());
  // la scheda tecnica si crea in un modale del registro: al suo chiudersi ricarico
  const [prevModal, setPrevModal] = useState(modal);
  useEffect(() => { if (prevModal && !modal && prevModal.name === 'techsheet') load(); setPrevModal(modal); }, [modal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hist == null) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 96, borderRadius: 14 }} />)}</div>;
  }

  const entries = hist.entries || [];
  // Senza il permesso «vendite» il server toglie gli incassi da ogni visita
  // (C5): `sale: null` vuol dire «nascosto», non «non pagato». Prima ogni
  // visita chiusa risultava «non incassato» e l'operatrice diceva alla
  // reception che la cliente l'ultima volta non aveva pagato (06-05, 17-04).
  const salesHidden = !!hist.sales_hidden;
  const upcoming = entries.filter((e) => e.kind === 'visit' && e.upcoming);
  const past = entries.filter((e) => !(e.kind === 'visit' && e.upcoming));
  const visible = past.filter((e) => filter === 'all' || (filter === 'visits' && (e.kind === 'visit' || e.kind === 'sale')) || (filter === 'notes' && (e.kind === 'note' || (e.kind === 'visit' && e.notes.length))) || (filter === 'sheets' && (e.kind === 'sheet' || (e.kind === 'visit' && e.sheets.length))));
  const counts = hist.counts || {};

  const patchNote = (apptId, note, remove = false) => setHist((h) => ({
    ...h,
    entries: h.entries.map((e) => {
      if (e.kind === 'visit' && e.appointment.id === apptId) {
        const notes = remove ? e.notes.filter((n) => n.id !== note.id) : (e.notes.some((n) => n.id === note.id) ? e.notes.map((n) => (n.id === note.id ? note : n)) : [note, ...e.notes]);
        return { ...e, notes };
      }
      if (e.kind === 'note' && e.note.id === note.id) return remove ? null : { ...e, note };
      return e;
    }).filter(Boolean),
  }));

  return (
    <div>
      {/* riepilogo + filtri + azione */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['all', t('Tutto', 'All'), null], ['visits', t('Visite', 'Visits'), counts.visits], ['notes', t('Note', 'Notes'), counts.notes], ['sheets', t('Schede', 'Sheets'), counts.sheets]].map(([k, l, n]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={'dk-pill' + (filter === k ? ' dk-pill--on' : '')} style={{ padding: '4px 11px', fontSize: 12.5 }}>{l}{n != null && <span style={{ opacity: 0.7 }}> · {n}</span>}</button>
        ))}
        <div style={{ flex: 1 }} />
        {canWrite && composer !== 'free' && (
          <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} onClick={() => setComposer('free')}><Icon name="plus" size={14} />{t('Nota generale', 'General note')}</button>
        )}
      </div>
      {composer === 'free' && (
        <div style={{ marginBottom: 14 }}>
          <NoteComposer clientId={c.id} autoFocus onCancel={() => setComposer(null)}
            onSaved={(n) => { setComposer(null); setHist((h) => ({ ...h, counts: { ...h.counts, notes: (h.counts?.notes || 0) + 1 }, entries: [{ kind: 'note', date: n.created_at, note: n }, ...h.entries] })); }} />
        </div>
      )}

      {/* prossimi appuntamenti */}
      {upcoming.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button type="button" onClick={() => setShowUpcoming((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: 'transparent', border: 'none', padding: '0 0 8px' }}>
            <span className="t-meta" style={{ color: 'var(--clay-ink)' }}>{t('Prossimi appuntamenti', 'Upcoming appointments')} · {upcoming.length}</span>
            <Icon name="chevD" size={13} color="var(--muted-2)" style={{ transform: showUpcoming ? 'none' : 'rotate(-90deg)', transition: 'transform 140ms' }} />
          </button>
          {showUpcoming && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{upcoming.slice().reverse().map((e) => <VisitCard key={'u' + e.appointment.id} e={e} lang={lang} t={t} upcoming salesHidden={salesHidden} />)}</div>}
        </div>
      )}

      {/* timeline */}
      {!visible.length ? (
        <EmptyState icon="calendar" title={filter === 'all' ? t('Nessuna visita registrata', 'No visits yet') : t('Niente in questo filtro', 'Nothing in this filter')} sub={filter === 'all' ? t('Lo storico si popola con appuntamenti, vendite, note e schede tecniche.', 'History fills up with appointments, sales, notes and technical sheets.') : ''} />
      ) : (
        <div style={{ position: 'relative', paddingLeft: 78 }}>
          <div style={{ position: 'absolute', left: 61, top: 8, bottom: 8, width: 2, background: 'var(--hair)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visible.map((e, i) => {
              const d = timelineDate(e.date, lang);
              const key = e.kind + (e.appointment?.id || e.sale?.id || e.note?.id || e.sheet?.id || i);
              const dot = e.kind === 'visit' ? 'var(--clay)' : e.kind === 'sale' ? 'var(--info)' : e.kind === 'note' ? 'var(--muted-2)' : 'var(--warn)';
              return (
                <div key={key} style={{ position: 'relative' }}>
                  {/* data a sinistra */}
                  <div style={{ position: 'absolute', left: -78, top: 2, width: 52, textAlign: 'right' }}>
                    <div className="t-num" style={{ fontSize: 20, lineHeight: 1, fontWeight: 700 }}>{d.day}</div>
                    <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5, textTransform: 'capitalize' }}>{d.month} {d.year}</div>
                  </div>
                  <span style={{ position: 'absolute', left: -22, top: 8, width: 12, height: 12, borderRadius: 99, background: dot, border: '2px solid var(--surface)', boxShadow: '0 0 0 1px var(--hair)' }} />
                  {e.kind === 'visit' && (
                    <VisitCard e={e} lang={lang} t={t} canWrite={canWrite} salesHidden={salesHidden}
                      composerOpen={composer === e.appointment.id}
                      onCompose={() => setComposer(composer === e.appointment.id ? null : e.appointment.id)}
                      onSheet={() => openModal('techsheet', { clientId: c.id, apptId: e.appointment.id, apptLabel: `${dateLabel(e.date, lang)} · ${(e.appointment.items || []).map((x) => x.service_name).join(' + ')}`, viewSheetId: e.sheets[0]?.id || null })}
                      composer={composer === e.appointment.id && (
                        <NoteComposer clientId={c.id} appointmentId={e.appointment.id} autoFocus compact onCancel={() => setComposer(null)}
                          onSaved={(n) => { setComposer(null); patchNote(e.appointment.id, n); }} />
                      )}
                      noteCards={e.notes.map((n) => (
                        <NoteCard key={n.id} note={n} clientId={c.id} canWrite={canWrite} compact
                          onChanged={(u) => patchNote(e.appointment.id, u)} onDeleted={(dn) => patchNote(e.appointment.id, dn, true)} />
                      ))}
                    />
                  )}
                  {e.kind === 'sale' && (
                    <div className="dk-card" style={{ padding: '12px 14px', boxShadow: 'none', border: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--info-tint)', display: 'grid', placeItems: 'center' }}><Icon name="wallet" size={16} color="var(--info)" /></div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Vendita al banco', 'Counter sale')}</div>
                        <div className="t-sm" style={{ color: 'var(--muted)' }}>{timeLabel(minutesOfDay(e.date))}</div>
                      </div>
                      <span className="t-num" style={{ fontSize: 16, fontWeight: 700 }}>{fmtEur(Number(e.sale.total), lang)}</span>
                    </div>
                  )}
                  {e.kind === 'note' && (
                    <NoteCard note={e.note} clientId={c.id} canWrite={canWrite}
                      onChanged={(u) => patchNote(null, u)} onDeleted={(dn) => patchNote(null, dn, true)} />
                  )}
                  {e.kind === 'sheet' && <SheetRow sheet={e.sheet} t={t} onOpen={() => openModal('techsheet', { clientId: c.id, viewSheetId: e.sheet.id })} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- una visita: servizi, operatrici, stato, incasso, note, schede ---- */
function VisitCard({ e, lang, t, upcoming, canWrite, salesHidden, composerOpen, onCompose, onSheet, composer, noteCards }) {
  const a = e.appointment;
  const sm = statusMeta(a.status, t);
  const start = minutesOfDay(a.start), end = minutesOfDay(a.end);
  const cancelled = a.status === 'cancelled' || a.status === 'no_show';
  // l'incasso di una visita passata è nascosto a chi non ha «vendite» (C5);
  // il prezzo «previsto» di una visita futura è dell'agenda e resta
  const saleHidden = salesHidden && !upcoming;
  const dep = depositBadge(a);
  const depLook = dep && {
    paid: { color: 'var(--ok)', label: fmtEurNoFree(dep.amount, lang),
      title: dep.refunded > 0
        ? t(`Caparra incassata: ${fmtEurNoFree(dep.amount, lang)} ancora a credito, ${fmtEurNoFree(dep.refunded, lang)} già rimborsati`, `Deposit collected: ${fmtEurNoFree(dep.amount, lang)} still on credit, ${fmtEurNoFree(dep.refunded, lang)} already refunded`)
        : t('Caparra incassata', 'Deposit collected') },
    refund_due: { color: 'var(--warn)', label: t(`Caparra da rimborsare ${fmtEurNoFree(dep.amount, lang)}`, `Deposit to refund ${fmtEurNoFree(dep.amount, lang)}`), title: t('Annullata in tempo: la caparra va restituita', 'Cancelled in time: the deposit must be returned') },
    refunding: { color: 'var(--warn)', label: t('Rimborso caparra in corso', 'Deposit refund in progress'), title: fmtEurNoFree(dep.amount, lang) },
    refunded: { color: 'var(--muted)', label: t(`Caparra rimborsata ${fmtEurNoFree(dep.amount, lang)}`, `Deposit refunded ${fmtEurNoFree(dep.amount, lang)}`), title: '' },
    forfeited: { color: 'var(--ink-2)', label: t(`Caparra trattenuta ${fmtEurNoFree(dep.amount, lang)}`, `Deposit retained ${fmtEurNoFree(dep.amount, lang)}`), title: '' },
  }[dep.kind];
  return (
    <div className="dk-card" style={{ boxShadow: 'none', border: '1px solid ' + (upcoming ? 'color-mix(in srgb, var(--clay) 40%, var(--hair))' : 'var(--hair)'), overflow: 'hidden', opacity: cancelled ? 0.75 : 1 }}>
      <div style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {upcoming && <span className="t-sm" style={{ fontWeight: 700, color: 'var(--clay-ink)' }}>{dateLabel(a.start, lang)} ·</span>}
            <span className="tabnum" style={{ fontWeight: 700, fontSize: 14.5 }}>{timeLabel(start)}–{timeLabel(end)}</span>
            <span className="t-sm" style={{ color: 'var(--muted)' }}>· {fmtDur(a.total_duration_min, lang)}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: sm.color, background: sm.tint, padding: '2px 8px', borderRadius: 99 }}>{sm.label}</span>
            {depLook && <span title={depLook.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: depLook.color }}><Icon name="wallet" size={11} color={depLook.color} />{depLook.label}</span>}
            {a.created_via === 'app' && <span className="t-sm" style={{ fontSize: 11, color: 'var(--muted-2)' }}>· {t('dall’app', 'from the app')}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
            {(a.items || []).map((it) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                <Icon name="scissors" size={13} color="var(--muted-2)" />
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{it.service_name}</span>
                <span className="t-sm" style={{ color: 'var(--muted)' }}>· {it.operator_name.split(' ')[0]} · {fmtDur(it.duration_min, lang)}</span>
                <span className="t-num" style={{ marginLeft: 'auto', fontSize: 13.5 }}>{fmtEur(Number(it.price), lang)}</span>
              </div>
            ))}
          </div>
          {a.note && <div style={{ marginTop: 8, padding: '7px 10px', background: 'var(--warn-tint)', borderRadius: 8, fontSize: 13, color: 'var(--ink-2)', display: 'flex', gap: 7 }}><Icon name="info" size={13} color="var(--warn)" style={{ marginTop: 2, flexShrink: 0 }} /><span>{a.note}</span></div>}
          {a.cancel_reason && <div className="t-sm" style={{ marginTop: 6, color: 'var(--danger)' }}>{t('Motivo', 'Reason')}: {a.cancel_reason}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {saleHidden ? (
            <div className="t-sm" title={t('Richiede il permesso vendite', 'Requires the sales permission')} style={{ color: 'var(--muted-2)', fontSize: 11.5, fontWeight: 600 }}>{t('importo riservato', 'amount restricted')}</div>
          ) : (
            <React.Fragment>
              <div className="t-num" style={{ fontSize: 17, fontWeight: 700 }}>{fmtEur(Number(e.sale ? e.sale.total : a.total_price), lang)}</div>
              <div className="t-sm" style={{ color: e.sale ? 'var(--ok)' : 'var(--muted-2)', fontSize: 11.5, fontWeight: 600 }}>{e.sale ? t('incassato', 'paid') : upcoming ? t('previsto', 'expected') : t('non incassato', 'not paid')}</div>
            </React.Fragment>
          )}
        </div>
      </div>

      {(e.sheets?.length > 0 || e.notes?.length > 0 || composerOpen) && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {e.sheets?.map((sh) => <SheetRow key={sh.id} sheet={sh} t={t} onOpen={onSheet} inline />)}
          {noteCards}
          {composer}
        </div>
      )}

      {!upcoming && canWrite && !composerOpen && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
          <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12, padding: '0 10px' }} onClick={onCompose}><Icon name="camera" size={13} />{t('Nota / foto trattamento', 'Treatment note / photo')}</button>
          <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12, padding: '0 10px' }} onClick={onSheet}><Icon name="edit" size={13} />{e.sheets?.length ? t('Scheda tecnica', 'Technical sheet') : t('Compila scheda tecnica', 'Fill technical sheet')}</button>
        </div>
      )}
    </div>
  );
}

function SheetRow({ sheet, t, onOpen, inline }) {
  return (
    <button type="button" onClick={onOpen} className="dk-row" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: inline ? '8px 10px' : '12px 14px', borderRadius: 10, border: '1px solid var(--hair)', background: 'var(--surface)', cursor: 'pointer' }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="edit" size={14} color="var(--clay-ink)" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t('Scheda tecnica', 'Technical sheet')} · {sheet.treatment}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[sheet.category, sheetVal(sheet, 'products'), sheet.outcome].filter(Boolean).join(' · ') || t('apri per i dettagli', 'open for details')}
        </div>
      </div>
      {sheet.photo && <Icon name="camera" size={14} color="var(--muted-2)" />}
      <Icon name="chevR" size={14} color="var(--muted-2)" />
    </button>
  );
}
