// TeamRoster — «Turni del team»: le operatrici sulle righe, i giorni sulle
// colonne (GET /api/staff/roster), con sotto la copertura di ogni giorno —
// quante sono in turno e, mezz'ora per mezz'ora negli orari del centro, dove
// non c'è nessuna. Un clic su una casella segna ferie, festività o un'assenza
// (anche per più giorni) o la toglie; il nome apre la scheda sui turni.
// Prima ognuna si guardava sulla sua scheda: per sapere se il sabato
// pomeriggio era coperto bisognava aprirle tutte (il titolare, 16/10).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, parseISO, toDateStr, todayStr, toastApiError } from '@youty/shared';
import { useDash, useLive } from '../../ctx.jsx';
import { useClickAway } from '../../hooks/useClickAway.js';
import { absencesApi, staffApi } from '../../api/staff.js';
import { ABSENCE_TYPES, AVAIL_META, MONTHS_EN, MONTHS_IT, WEEKDAYS, dayCoverage, fmtWindows, hmCompact, inputCss, minCompact, opName, outLabel } from './lib.js';

const SPANS = [7, 14, 28];
const AWAY = { event: 'pointerdown', capture: true, escape: true };
const POP_W = 290;

/** Il lunedì della settimana di `dateStr`, come «YYYY-MM-DD». */
export function mondayStr(dateStr) {
  const d = parseISO(dateStr);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateStr(d);
}
const shiftDays = (dateStr, n) => { const d = parseISO(dateStr); d.setDate(d.getDate() + n); return toDateStr(d); };

/** La casella di un'operatrice in un giorno: che cosa dice e di che colore. */
export function cellLook(cell, day, t, lang) {
  if (day.opening && !day.opening.length) return { kind: 'closed', bg: 'var(--paper-2)', c: 'var(--muted-2)', lines: ['—'] };
  // prima di «nel team dal» o dopo «fino al»: niente turno, e non è riposo
  if (cell.out_of_team) return { kind: 'out', bg: AVAIL_META.out.bg, c: AVAIL_META.out.c, lines: [cell.out_of_team === 'after' ? t('Uscita', 'Left') : t('Non ancora', 'Not yet')], tip: outLabel(cell.out_of_team, t) };
  if (cell.absence) {
    const meta = AVAIL_META[cell.absence.type] || AVAIL_META.other;
    return { kind: 'absence', bg: meta.bg, c: meta.c, lines: [meta[lang === 'en' ? 'en' : 'it']] };
  }
  if (cell.windows.length) return { kind: 'work', bg: AVAIL_META.work.bg, c: AVAIL_META.work.c, lines: cell.windows.map(([a, b]) => `${hmCompact(a)}–${hmCompact(b)}`) };
  return { kind: 'off', bg: AVAIL_META.off.bg, c: AVAIL_META.off.c, lines: [t('Riposo', 'Day off')] };
}

/** `top` = la scelta fra le viste dello Staff; `onOpen(id)` apre la scheda. */
export default function TeamRoster({ top = null, onOpen }) {
  const { t, lang, fireToast, hasScope, locationId, opColors } = useDash();
  const canEdit = hasScope('team');
  const today = todayStr();
  const [start, setStart] = useState(() => mondayStr(today));
  const [span, setSpan] = useState(14);
  const [data, setData] = useState(null);   // RosterOut | 'error'
  const [pop, setPop] = useState(null);     // { opId, date, x, y }
  const [form, setForm] = useState(null);   // { type, to, note }
  const [saving, setSaving] = useState(false);
  const popRef = useRef(null);
  const closePop = useCallback(() => { setPop(null); setForm(null); }, []);
  useClickAway(popRef, !!pop, closePop, AWAY);

  const load = useCallback(() => staffApi.roster({ start, days: span, ...(locationId ? { location_id: locationId } : {}) })
    .then(setData)
    .catch(() => setData('error')), [start, span, locationId]);
  useEffect(() => { setData(null); load(); }, [load]);
  // turni e assenze cambiati da un'altra postazione
  useLive(/^operator\./, () => { load(); });

  const months = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const end = shiftDays(start, span - 1);
  const rangeLabel = (() => {
    const a = parseISO(start), b = parseISO(end);
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${months[b.getMonth()]} ${b.getFullYear()}`
      : `${a.getDate()} ${months[a.getMonth()].slice(0, 3)} – ${b.getDate()} ${months[b.getMonth()].slice(0, 3)} ${b.getFullYear()}`;
  })();
  const ready = data && data !== 'error';
  const ops = ready ? data.operators : [];
  const days = ready ? data.days : [];
  const dayHead = (dateStr) => {
    const d = parseISO(dateStr);
    const dow = (d.getDay() + 6) % 7;
    return { dow: t(WEEKDAYS[dow][0], WEEKDAYS[dow][1]), num: d.getDate() };
  };

  const openCell = (e, op, day) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
    setPop({ opId: op.id, date: day.date, x, y: r.bottom + 6 });
    setForm({ type: 'vacation', to: day.date, note: '' });
  };

  const addAbsence = async () => {
    if (!pop || !form || saving) return;
    if (form.to < pop.date) { fireToast({ msg: t('Intervallo di date non valido', 'Invalid date range'), icon: 'alert' }); return; }
    setSaving(true);
    try {
      await absencesApi.create(pop.opId, { date_from: pop.date, date_to: form.to, type: form.type, note: form.note || '' });
    } catch (err) { toastApiError(err, fireToast, t); setSaving(false); return; }
    setSaving(false);
    closePop();
    fireToast({ msg: t('Assenza aggiunta', 'Time off added'), icon: 'check' });
    load();
  };
  const removeAbsence = async (absence) => {
    if (!pop || saving) return;
    setSaving(true);
    try { await absencesApi.remove(pop.opId, absence.id); } catch (err) { toastApiError(err, fireToast, t); setSaving(false); return; }
    setSaving(false);
    closePop();
    fireToast({ msg: t('Assenza eliminata', 'Time off deleted'), icon: 'x' });
    load();
  };

  const popDay = pop && days.find((d) => d.date === pop.date);
  const popCell = popDay && popDay.cells.find((c) => c.operator_id === pop.opId);
  const popOp = pop && ops.find((o) => o.id === pop.opId);
  const colW = span > 14 ? 52 : 64;

  return (
    <div className="dk-page" style={{ maxWidth: 1400 }}>
      {top}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="dk-iconbtn" onClick={() => setStart((s) => shiftDays(s, -7))} aria-label={t('Settimana prima', 'Previous week')}><Icon name="chevL" size={18} /></button>
        <button className="dk-btn dk-btn--ghost" style={{ height: 36 }} onClick={() => setStart(mondayStr(today))}>{t('Oggi', 'Today')}</button>
        <button className="dk-iconbtn" onClick={() => setStart((s) => shiftDays(s, 7))} aria-label={t('Settimana dopo', 'Next week')}><Icon name="chevR" size={18} /></button>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, marginLeft: 6 }}>{rangeLabel}</div>
        <span style={{ flex: 1 }} />
        <div className="dk-agseg" role="group" aria-label={t('Quanti giorni', 'How many days')}>
          {SPANS.map((n) => (
            <button key={n} type="button" aria-pressed={span === n} onClick={() => setSpan(n)}>
              {n === 7 ? t('1 settimana', '1 week') : t(`${n / 7} settimane`, `${n / 7} weeks`)}
            </button>
          ))}
        </div>
      </div>

      {data === 'error' && (
        <div className="dk-card" style={{ padding: 20, color: 'var(--muted)' }}>
          {t('Turni non disponibili ora.', 'Shifts not available right now.')}{' '}
          <button className="dk-btn dk-btn--ghost" style={{ height: 32, marginLeft: 8 }} onClick={() => { setData(null); load(); }}>{t('Riprova', 'Retry')}</button>
        </div>
      )}
      {!data && <div className="skel" style={{ height: 360, borderRadius: 16 }} />}

      {ready && (
        <div className="dk-card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 190 + span * colW }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface)', textAlign: 'left', padding: '10px 14px', borderBottom: '1px solid var(--hair)', minWidth: 170 }}>
                  <span className="t-meta">{t('Operatrice', 'Stylist')}</span>
                </th>
                {days.map((d) => {
                  const h = dayHead(d.date);
                  const isToday = d.date === today;
                  const closed = d.opening && !d.opening.length;
                  const gaps = dayCoverage(d).gaps.length > 0;
                  return (
                    <th key={d.date} data-date={d.date} style={{ padding: '8px 2px', borderBottom: '1px solid var(--hair)', borderLeft: (parseISO(d.date).getDay() === 1) ? '2px solid var(--line-strong)' : '1px solid var(--hair-2)', minWidth: colW, background: isToday ? 'var(--clay-tint)' : 'transparent' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--clay-ink)' : 'var(--muted)' }}>{h.dow}</div>
                      <div className="t-num" style={{ fontSize: 14, color: closed ? 'var(--muted-2)' : 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {h.num}
                        {gaps && <span title={t('Ci sono ore scoperte', 'There are uncovered hours')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--danger)' }} />}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ops.map((o, row) => (
                <tr key={o.id}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', padding: '6px 14px', borderBottom: '1px solid var(--hair-2)' }}>
                    <button type="button" onClick={() => onOpen(o.id)} title={t('Apri la scheda: turni e assenze', 'Open the profile: shifts and time off')}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
                      <Avatar initials={o.initials} size={30} color={opColors?.[o.id] || o.color} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{opName(o)}</span>
                        {o.cycle_weeks > 1 && <span className="t-sm" style={{ color: 'var(--muted)', fontSize: 11 }}>{t(`ciclo di ${o.cycle_weeks} settimane`, `${o.cycle_weeks}-week cycle`)}</span>}
                      </span>
                    </button>
                  </td>
                  {days.map((d) => {
                    const cell = d.cells[row];
                    const look = cellLook(cell, d, t, lang);
                    const tip = look.tip || (cell.absence ? `${look.lines[0]}${cell.absence.note ? ' · ' + cell.absence.note : ''}` : look.kind === 'work' ? fmtWindows(cell.windows) : look.lines[0]);
                    // fuori dal rapporto di lavoro un'assenza non ha senso: la cella non apre niente
                    const out = look.kind === 'out';
                    return (
                      <td key={d.date} style={{ padding: 3, borderBottom: '1px solid var(--hair-2)', borderLeft: (parseISO(d.date).getDay() === 1) ? '2px solid var(--line-strong)' : '1px solid var(--hair-2)', background: d.date === today ? 'color-mix(in srgb, var(--clay) 6%, transparent)' : 'transparent' }}>
                        <button type="button" data-cell={`${o.id}:${d.date}`} data-kind={look.kind} title={tip}
                          onClick={out ? undefined : (e) => openCell(e, o, d)}
                          style={{ width: '100%', minHeight: 40, borderRadius: 8, border: pop && pop.opId === o.id && pop.date === d.date ? '1.5px solid var(--ink)' : '1px solid transparent', background: look.bg, color: look.c, cursor: out ? 'default' : 'pointer', padding: '3px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                          {look.lines.map((l, k) => <span key={k} className="tabnum" style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.15, whiteSpace: 'nowrap' }}>{l}</span>)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* la copertura: in quante sono e dove non c'è nessuna */}
              <tr>
                <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface-2)', padding: '8px 14px' }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{t('Copertura', 'Coverage')}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11 }}>{t('in turno · per mezz’ora', 'on shift · per half hour')}</div>
                </td>
                {days.map((d) => {
                  const cov = dayCoverage(d);
                  const closed = d.opening && !d.opening.length;
                  const gapText = cov.gaps.map(([a, b]) => `${minCompact(a)}–${minCompact(b)}`).join(', ');
                  return (
                    <td key={d.date} data-coverage={d.date} style={{ padding: '6px 4px', background: 'var(--surface-2)', borderLeft: (parseISO(d.date).getDay() === 1) ? '2px solid var(--line-strong)' : '1px solid var(--hair-2)', verticalAlign: 'top' }}
                      title={closed ? t('Centro chiuso', 'Closed') : gapText ? t(`Scoperto: ${gapText}`, `Uncovered: ${gapText}`) : cov.known ? t('Coperto', 'Covered') : t('Imposta gli orari del centro per vedere le ore scoperte', 'Set the opening hours to see uncovered hours')}>
                      {closed ? <div className="t-sm" style={{ textAlign: 'center', color: 'var(--muted-2)', fontSize: 11 }}>{t('Chiuso', 'Closed')}</div> : (
                        <>
                          <div className="tabnum" style={{ textAlign: 'center', fontSize: 12, fontWeight: 800, color: cov.working ? 'var(--ink)' : cov.known ? 'var(--danger)' : 'var(--muted-2)' }}>{cov.working}/{cov.total}</div>
                          <div style={{ display: 'flex', height: 6, borderRadius: 99, overflow: 'hidden', marginTop: 4, background: 'var(--paper-2)' }}>
                            {cov.slots.map((sl, k) => (
                              <span key={k} style={{ flex: 1, background: sl.count === 0 ? (cov.known ? 'var(--danger)' : 'transparent') : sl.count === 1 ? 'var(--warn)' : 'var(--ok)', opacity: sl.count >= 2 ? Math.min(1, 0.45 + sl.count * 0.12) : 1 }} />
                            ))}
                          </div>
                          {gapText && <div className="tabnum" style={{ marginTop: 3, fontSize: 9.5, fontWeight: 700, color: 'var(--danger)', textAlign: 'center', lineHeight: 1.2 }}>{gapText}</div>}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {ready && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 12, alignItems: 'center' }}>
          {['work', 'off', ...ABSENCE_TYPES].map((k) => (
            <span key={k} className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <span style={{ width: 12, height: 12, borderRadius: 4, background: AVAIL_META[k].bg, border: '1px solid ' + AVAIL_META[k].c }} />
              {k === 'work' ? t('In turno', 'On shift') : k === 'off' ? t('Riposo', 'Day off') : AVAIL_META[k][lang === 'en' ? 'en' : 'it']}
            </span>
          ))}
          <span className="t-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted)' }}>
            <span style={{ width: 22, height: 6, borderRadius: 99, background: 'linear-gradient(90deg, var(--danger) 0 33%, var(--warn) 33% 66%, var(--ok) 66%)' }} />
            {t('copertura: nessuna · una · due o più', 'coverage: none · one · two or more')}
          </span>
          {canEdit && <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Clic su una casella: ferie, festività o assenza.', 'Click a cell: vacation, holiday or time off.')}</span>}
          {days.length > 0 && days.every((d) => d.opening == null) && (
            <span className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600 }}>{t('Imposta gli orari del centro (Impostazioni) per vedere le ore scoperte.', 'Set the opening hours (Settings) to see uncovered hours.')}</span>
          )}
        </div>
      )}

      {/* la casella aperta: il turno, e le eccezioni */}
      {pop && popCell && popOp && (
        <div ref={popRef} className="dk-card" role="dialog" aria-label={t('Turno del giorno', 'Day shift')}
          style={{ position: 'fixed', top: Math.min(pop.y, window.innerHeight - 330), left: pop.x, width: POP_W, zIndex: 80, padding: 14, boxShadow: 'var(--sh-pop)', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{popOp.first_name} · {dayHead(pop.date).dow} {dayHead(pop.date).num}</span>
            <button className="dk-iconbtn" style={{ width: 28, height: 28 }} onClick={closePop} aria-label={t('Chiudi', 'Close')}><Icon name="x" size={14} /></button>
          </div>
          <div className="t-sm" style={{ marginBottom: 10, color: 'var(--ink-2)' }}>
            {popCell.absence
              ? <>{AVAIL_META[popCell.absence.type]?.[lang === 'en' ? 'en' : 'it']} · {popCell.absence.date_from === popCell.absence.date_to ? popCell.absence.date_from.split('-').reverse().slice(0, 2).join('/') : `${popCell.absence.date_from.split('-').reverse().slice(0, 2).join('/')}–${popCell.absence.date_to.split('-').reverse().slice(0, 2).join('/')}`}{popCell.absence.note ? ` · ${popCell.absence.note}` : ''}</>
              : popCell.windows.length ? t(`In turno ${fmtWindows(popCell.windows)}`, `On shift ${fmtWindows(popCell.windows)}`) : t('Riposo', 'Day off')}
          </div>
          {canEdit && popCell.absence && (
            <button type="button" onClick={() => removeAbsence(popCell.absence)} disabled={saving}
              style={{ width: '100%', padding: '9px 0', borderRadius: 9, background: 'transparent', border: '1px solid var(--danger-tint)', color: 'var(--danger)', fontWeight: 700, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
              {t('Togli l’assenza (torna il turno)', 'Remove the time off (shift returns)')}
            </button>
          )}
          {canEdit && !popCell.absence && form && (
            <div>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Segna un’assenza', 'Mark time off')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {ABSENCE_TYPES.map((k) => {
                  const meta = AVAIL_META[k];
                  const on = form.type === k;
                  return (
                    <button key={k} type="button" aria-pressed={on} onClick={() => setForm((f) => ({ ...f, type: k }))}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? meta.c : 'var(--hair)'), background: on ? meta.bg : 'var(--surface)', color: on ? meta.c : 'var(--ink-2)' }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: meta.c }} />{meta[lang === 'en' ? 'en' : 'it']}
                    </button>
                  );
                })}
              </div>
              <label style={{ display: 'block', marginBottom: 6 }}>
                <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('Fino al (compreso)', 'Until (included)')}</span>
                <input type="date" value={form.to} min={pop.date} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} style={{ ...inputCss, fontSize: 13.5, padding: '7px 10px', marginTop: 3 }} />
              </label>
              <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder={t('Nota (facoltativa)', 'Note (optional)')} style={{ ...inputCss, fontSize: 13.5, padding: '7px 10px', marginBottom: 8 }} />
              <button type="button" className="dk-btn dk-btn--clay" onClick={addAbsence} disabled={saving} style={{ width: '100%', height: 38, opacity: saving ? 0.6 : 1 }}>
                <Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}
              </button>
            </div>
          )}
          <button type="button" className="dk-btn dk-btn--ghost" onClick={() => { closePop(); onOpen(popOp.id); }} style={{ width: '100%', height: 34, marginTop: 8, fontSize: 12.5 }}>
            {t('Apri la scheda: turni e assenze', 'Open the profile: shifts and time off')}
          </button>
        </div>
      )}
    </div>
  );
}
