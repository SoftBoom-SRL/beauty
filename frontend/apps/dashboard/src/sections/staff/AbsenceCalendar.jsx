// AbsenceCalendar — port of prototype AvailabilityCalendar, backed by the
// absences API (/api/staff/{id}/absences). Exceptions are date RANGES
// { date_from, date_to, type: vacation|holiday|other, note } instead of the
// prototype's per-date map; clicking a covered day selects its absence,
// clicking a free day starts a new single-day one.
// Ogni giorno dice anche che cosa prevede il pattern dei turni (`weeks`, quello
// nell'editor sopra, anche non ancora salvato): l'orario, «Riposo» o «Chiuso»
// se il centro è chiuso; con un ciclo di più settimane, a sinistra di ogni
// riga la settimana del ciclo che vale. Prima il calendario mostrava solo le
// assenze, e come sarebbe venuto un giorno libero che scorre non si vedeva
// (il titolare, 16/10).
import React, { useMemo, useState } from 'react';
import { Icon, WEEKDAYS_SHORT_EN, WEEKDAYS_SHORT_IT, todayStr, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { AVAIL_META, ABSENCE_TYPES, MONTHS_IT, MONTHS_EN, inputCss, patternDay } from './lib.js';
import { absencesApi } from '../../api/staff.js';

const fmtDM = (iso) => iso.split('-').slice(1).reverse().join('/'); // "2026-07-04" → "04/07"

/** `weeks` = il pattern dell'editor (useOperatorEditor), `draft` = ha
 *  modifiche non salvate: il calendario lo dice. */
export default function AbsenceCalendar({ operatorId, absences, onChanged, canEdit, weeks = null, draft = false }) {
  const { t, lang, fireToast, settings } = useDash();
  const openingWeek = settings?.opening_hours_week || null;
  const cycle = (weeks || []).length;
  // Il mese di partenza è quello del SALONE: a cavallo della mezzanotte del
  // primo del mese una postazione su un altro fuso apriva il mese sbagliato.
  const [cursor, setCursor] = useState(() => { const [ty, tm] = todayStr().split('-').map(Number); return new Date(ty, tm - 1, 1); });
  // edit = { id?, type, date_from, date_to, note } | null
  const [edit, setEdit] = useState(null);
  const [saving, setSaving] = useState(false);

  const months = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const dows = lang === 'en' ? WEEKDAYS_SHORT_EN : WEEKDAYS_SHORT_IT;
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const key = (d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const today = todayStr();

  /* date "YYYY-MM-DD" → covering absence (first match) */
  const coverage = useMemo(() => {
    const map = {};
    const monthPrefixFrom = key(1), monthPrefixTo = key(daysInMonth);
    (absences || []).forEach((a) => {
      if (a.date_to < monthPrefixFrom || a.date_from > monthPrefixTo) return;
      const from = a.date_from < monthPrefixFrom ? 1 : Number(a.date_from.slice(-2));
      const to = a.date_to > monthPrefixTo ? daysInMonth : Number(a.date_to.slice(-2));
      for (let d = from; d <= to; d++) { if (!map[d]) map[d] = a; }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key dipende solo da y e m, già qui
  }, [absences, y, m, daysInMonth]);

  const monthAbsences = useMemo(() => (
    (absences || [])
      .filter((a) => !(a.date_to < key(1) || a.date_from > key(daysInMonth)))
      .sort((a, b) => a.date_from.localeCompare(b.date_from))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key dipende solo da y e m, già qui
  ), [absences, y, m, daysInMonth]);

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const openDay = (d) => {
    if (!canEdit) return;
    const covering = coverage[d];
    if (covering) setEdit({ id: covering.id, type: covering.type, date_from: covering.date_from, date_to: covering.date_to, note: covering.note || '' });
    else setEdit({ type: 'vacation', date_from: key(d), date_to: key(d), note: '' });
  };

  const save = async () => {
    if (saving || !edit) return;
    if (!edit.date_from || !edit.date_to || edit.date_to < edit.date_from) {
      fireToast({ msg: t('Intervallo di date non valido', 'Invalid date range'), icon: 'alert' });
      return;
    }
    setSaving(true);
    try {
      const body = { date_from: edit.date_from, date_to: edit.date_to, type: edit.type, note: edit.note || '' };
      if (edit.id) await absencesApi.update(operatorId, edit.id, body);
      else await absencesApi.create(operatorId, body);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setSaving(false);
      return;
    }
    /* Scritta riuscita: il pannello si chiude qui. Stava nello stesso try della
     * ricarica, e se cadeva quella («Errore di rete») il pannello restava su
     * «Aggiungi»: al secondo clic nascevano due assenze identiche (15-19). */
    setEdit(null);
    setSaving(false);
    fireToast({ msg: edit.id ? t('Assenza aggiornata', 'Time off updated') : t('Assenza aggiunta', 'Time off added'), icon: 'check' });
    reloadAfterWrite();
  };

  const reloadAfterWrite = () => Promise.resolve(onChanged()).catch(() => {
    fireToast({ msg: t('Salvato, ma il calendario non si è aggiornato: riapri la scheda', 'Saved, but the calendar did not refresh: reopen the profile'), icon: 'info' });
  });

  const remove = async () => {
    if (saving || !edit?.id) return;
    setSaving(true);
    try {
      await absencesApi.remove(operatorId, edit.id);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setSaving(false);
      return;
    }
    setEdit(null);
    setSaving(false);
    fireToast({ msg: t('Assenza eliminata', 'Time off deleted'), icon: 'x' });
    reloadAfterWrite();
  };

  const typeChips = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
      {ABSENCE_TYPES.map((k) => {
        const meta = AVAIL_META[k];
        const on = edit && edit.type === k;
        return (
          <button key={k} onClick={() => setEdit((e) => ({ ...e, type: k }))}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? meta.c : 'var(--hair)'), background: on ? meta.bg : 'var(--surface)', color: on ? meta.c : 'var(--ink-2)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: meta.c }} />{meta[lang === 'en' ? 'en' : 'it']}
          </button>
        );
      })}
    </div>
  );

  const dateField = (label, value, extra, onChange) => (
    <label>
      <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <input type="date" value={value} {...extra} onChange={onChange} style={{ ...inputCss, fontSize: 13.5, padding: '8px 10px' }} />
    </label>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, alignItems: 'start' }}>
      <div className="dk-card" style={{ padding: 20 }}>
        {/* month nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button className="dk-iconbtn" onClick={() => setCursor(new Date(y, m - 1, 1))}><Icon name="chevL" size={18} /></button>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, flex: 1, textAlign: 'center' }}>{months[m]} {y}</div>
          <button className="dk-iconbtn" onClick={() => setCursor(new Date(y, m + 1, 1))}><Icon name="chevR" size={18} /></button>
        </div>
        {draft && (
          <div className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: 'var(--clay-ink)', fontWeight: 600 }}>
            <Icon name="info" size={13} color="var(--clay-ink)" />{t('Anteprima con i turni non ancora salvati', 'Preview with unsaved shifts')}
          </div>
        )}
        {/* dow header (con un ciclo, la prima colonna è la settimana del ciclo) */}
        <div style={{ display: 'grid', gridTemplateColumns: (cycle > 1 ? '30px ' : '') + 'repeat(7,1fr)', gap: 6, marginBottom: 6 }}>
          {cycle > 1 && <div className="t-meta" title={t('Settimana del ciclo dei turni', 'Week of the shift cycle')} style={{ textAlign: 'center' }}>{t('Sett.', 'Wk')}</div>}
          {dows.map((d) => <div key={d} className="t-meta" style={{ textAlign: 'center' }}>{d}</div>)}
        </div>
        {/* day grid */}
        <div style={{ display: 'grid', gridTemplateColumns: (cycle > 1 ? '30px ' : '') + 'repeat(7,1fr)', gap: 6 }}>
          {cells.map((d, i) => {
            // con un ciclo, in testa a ogni riga la settimana del ciclo che vale
            let rowLabel = null;
            if (cycle > 1 && i % 7 === 0) {
              const first = cells.slice(i, i + 7).find((x) => x != null);
              const w = patternDay(weeks, key(first), null).week;
              rowLabel = <div data-cycle-week={w + 1} title={t(`Settimana ${w + 1} del ciclo`, `Week ${w + 1} of the cycle`)} style={{ display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, color: 'var(--clay-ink)', background: 'var(--clay-tint)', borderRadius: 8 }}>{w + 1}</div>;
            }
            if (d == null) return <React.Fragment key={'e' + i}>{rowLabel}<div /></React.Fragment>;
            const k = key(d);
            const ab = coverage[d];
            const st = ab && (AVAIL_META[ab.type] || AVAIL_META.other);
            // senza assenza, quello che prevede il pattern
            const pd = !ab && weeks ? patternDay(weeks, k, openingWeek) : null;
            const look = st ? { bg: st.bg, c: st.c, label: st[lang === 'en' ? 'en' : 'it'] }
              : pd?.kind === 'work' ? { bg: AVAIL_META.work.bg, c: AVAIL_META.work.c, label: pd.label }
                : pd?.kind === 'off' ? { bg: AVAIL_META.off.bg, c: AVAIL_META.off.c, label: t('Riposo', 'Day off') }
                  : pd?.kind === 'closed' ? { bg: 'var(--paper-2)', c: 'var(--muted-2)', label: t('Chiuso', 'Closed') }
                    : pd?.kind === 'bad' ? { bg: 'var(--warn-tint)', c: 'var(--warn)', label: '?' }
                      : null;
            const tip = st ? (ab.note || look.label)
              : pd?.kind === 'work' ? `${pd.label}${pd.brk ? ' · ' + t('pausa', 'break') + ' ' + pd.brk : ''}`
                : pd?.kind === 'bad' ? t(`Orario non valido: «${pd.label}»`, `Invalid hours: “${pd.label}”`) : look?.label;
            const isToday = k === today;
            const selected = edit && edit.id && ab && ab.id === edit.id;
            return (
              <React.Fragment key={k}>
                {rowLabel}
                <button data-day={k} data-kind={st ? 'absence' : pd?.kind} onClick={() => openDay(d)} title={tip}
                  style={{ aspectRatio: '1', borderRadius: 10, cursor: canEdit ? 'pointer' : 'default', border: '1px solid ' + (selected ? 'var(--ink)' : isToday ? 'var(--clay)' : 'var(--hair)'), background: look ? look.bg : 'var(--surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, padding: 4, position: 'relative', minWidth: 0 }}>
                  <span style={{ fontWeight: isToday ? 800 : 600, fontSize: 13.5, color: st ? st.c : 'var(--ink)' }}>{d}</span>
                  {look && <span className="tabnum" style={{ fontSize: 8.5, fontWeight: 700, color: look.c, lineHeight: 1, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{look.label}</span>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* side: add/edit panel + legend + month exceptions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {canEdit && (edit ? (
          <div className="dk-card" style={{ padding: 16, border: '1px solid var(--clay)' }}>
            <div className="t-meta" style={{ marginBottom: 12 }}>
              {edit.id ? t('Modifica assenza', 'Edit time off') : t('Aggiungi assenza / periodo', 'Add time-off / period')}
            </div>
            {typeChips}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {dateField(t('Dal', 'From'), edit.date_from, {}, (e) => setEdit((x) => ({ ...x, date_from: e.target.value, date_to: x.date_to < e.target.value ? e.target.value : x.date_to })))}
              {dateField(t('Al', 'To'), edit.date_to, { min: edit.date_from }, (e) => setEdit((x) => ({ ...x, date_to: e.target.value })))}
              <label>
                <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Nota', 'Note')}</div>
                <input value={edit.note} onChange={(e) => setEdit((x) => ({ ...x, note: e.target.value }))} placeholder={t('facoltativa', 'optional')} style={{ ...inputCss, fontSize: 13.5, padding: '8px 10px' }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="dk-btn dk-btn--ghost" style={{ flex: 1, height: 40 }} onClick={() => setEdit(null)}>{t('Annulla', 'Cancel')}</button>
              <button className="dk-btn dk-btn--clay" style={{ flex: 1, height: 40, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>
                <Icon name="check" size={15} color="#fff" />{edit.id ? t('Salva', 'Save') : t('Aggiungi', 'Add')}
              </button>
            </div>
            {edit.id && (
              <button onClick={remove} disabled={saving} style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 9, background: 'transparent', border: '1px solid var(--danger-tint)', color: 'var(--danger)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {t('Elimina assenza', 'Delete time off')}
              </button>
            )}
          </div>
        ) : (
          <button className="dk-btn dk-btn--clay" style={{ width: '100%', height: 46 }}
            onClick={() => setEdit({ type: 'vacation', date_from: today, date_to: today, note: '' })}>
            <Icon name="plus" size={17} color="#fff" />{t('Aggiungi assenza / ferie', 'Add time-off')}
          </button>
        ))}

        <div className="dk-card" style={{ padding: 18 }}>
          <div className="t-meta" style={{ marginBottom: 12 }}>{t('Legenda', 'Legend')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(weeks ? ['work', 'off', ...ABSENCE_TYPES] : ABSENCE_TYPES).map((k) => {
              const meta = AVAIL_META[k];
              return (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: meta.bg, border: '1px solid ' + meta.c, flexShrink: 0 }} />
                  <span className="t-sm" style={{ fontWeight: 600 }}>
                    {/* le parole dei giorni del calendario */}
                    {k === 'work' ? t('In turno (con l’orario)', 'On shift (with hours)') : k === 'off' ? t('Riposo', 'Day off') : meta[lang === 'en' ? 'en' : 'it']}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="dk-card" style={{ padding: 18 }}>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Assenze · ', 'Time off · ') + months[m]}</div>
          {!monthAbsences.length ? (
            <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna assenza questo mese.', 'No time off this month.')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {monthAbsences.map((a) => {
                const meta = AVAIL_META[a.type] || AVAIL_META.other;
                return (
                  <button key={a.id} className="dk-row" onClick={() => canEdit && setEdit({ id: a.id, type: a.type, date_from: a.date_from, date_to: a.date_to, note: a.note || '' })}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px', borderRadius: 9, textAlign: 'left', width: '100%', cursor: canEdit ? 'pointer' : 'default' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: meta.c, flexShrink: 0 }} />
                    <span className="t-sm" style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {a.date_from === a.date_to ? fmtDM(a.date_from) : fmtDM(a.date_from) + '–' + fmtDM(a.date_to)}
                    </span>
                    <span className="t-sm" style={{ flex: 1, color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {meta[lang === 'en' ? 'en' : 'it']}{a.note ? ' · ' + a.note : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 14px', background: 'var(--clay-tint)', borderRadius: 12 }}>
          <Icon name="calendar" size={15} color="var(--clay-ink)" />
          <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.45 }}>
            {t("Le assenze confluiscono nell'agenda: nei giorni di ferie, festività o altra assenza non vengono proposti slot prenotabili.",
               'Time off flows into the calendar: on vacation, holiday or other absence dates no bookable slots are offered.')}
          </span>
        </div>
      </div>
    </div>
  );
}
