// HoursDrawer.jsx — orari di apertura del centro, per giorno della settimana
// (PUT /api/core/settings { opening_hours_week }). Fonte unica: agenda (chip
// "oggi"), app cliente (testo generato dal server) e impostazioni.
// Solo il titolare scrive; gli altri vedono in sola lettura.
import { useState } from 'react';
import { Icon, Toggle, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, LockNote } from './lib.jsx';
import { dayLabel } from './hours.js';
import { settingsApi } from '../../api/core.js';

export { dayLabel, todayRanges } from './hours.js';

export const DAYS = [['Lunedì', 'Monday'], ['Martedì', 'Tuesday'], ['Mercoledì', 'Wednesday'], ['Giovedì', 'Thursday'], ['Venerdì', 'Friday'], ['Sabato', 'Saturday'], ['Domenica', 'Sunday']];
const DEFAULT_DAY = [['09:00', '13:00'], ['14:00', '19:00']];

export default function HoursDrawer({ onClose }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const initial = settings?.opening_hours_week && Object.keys(settings.opening_hours_week).length
    ? settings.opening_hours_week
    : { 0: DEFAULT_DAY, 1: DEFAULT_DAY, 2: DEFAULT_DAY, 3: DEFAULT_DAY, 4: DEFAULT_DAY, 5: [['09:00', '13:00']], 6: [] };
  const [week, setWeek] = useState(() => Object.fromEntries([...Array(7)].map((_, d) => [d, (initial[String(d)] || initial[d] || []).map((r) => [...r])])));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isNew = !(settings?.opening_hours_week && Object.keys(settings.opening_hours_week).length);

  const setDay = (d, ranges) => setWeek((w) => ({ ...w, [d]: ranges }));
  const toggleDay = (d) => setDay(d, week[d].length ? [] : DEFAULT_DAY.map((r) => [...r]));
  const setRange = (d, i, k, v) => setDay(d, week[d].map((r, j) => (j === i ? (k === 0 ? [v, r[1]] : [r[0], v]) : r)));
  const addRange = (d) => { const last = week[d][week[d].length - 1]; setDay(d, [...week[d], [last ? last[1] : '14:00', '19:00']]); };
  const removeRange = (d, i) => setDay(d, week[d].filter((_, j) => j !== i));
  const copyToWorkdays = (d) => setWeek((w) => { const n = { ...w }; for (let k = 0; k < 5; k++) if (k !== d) n[k] = w[d].map((r) => [...r]); return n; });

  const problems = [];
  Object.entries(week).forEach(([d, ranges]) => {
    const mins = ranges.map(([a, b]) => [a, b].map((hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }));
    mins.forEach(([a, b], i) => { if (!(b > a)) problems.push(t(`${t(...DAYS[d])}: intervallo ${i + 1} invertito`, `${t(...DAYS[d])}: range ${i + 1} inverted`)); });
    mins.sort((x, y) => x[0] - y[0]).forEach((r, i) => { const nx = mins[i + 1]; if (nx && nx[0] < r[1]) problems.push(t(`${t(...DAYS[d])}: intervalli sovrapposti`, `${t(...DAYS[d])}: overlapping ranges`)); });
  });

  const save = async () => {
    if (!isOwner || saving) return;
    if (problems.length) { setErr(problems[0]); return; }
    setSaving(true); setErr('');
    try {
      await settingsApi.update({ opening_hours_week: Object.fromEntries(Object.entries(week).map(([d, r]) => [String(d), r])) });
      await reload.salon();
      fireToast({ msg: t('Orari di apertura salvati', 'Opening hours saved'), icon: 'check' });
      onClose();
    } catch (e) { toastApiError(e, fireToast, t); } finally { setSaving(false); }
  };

  const timeCss = { ...inputCss, width: 96, padding: '7px 8px', fontSize: 13.5, fontVariantNumeric: 'tabular-nums' };
  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead padBottom={16} onClose={onClose} closeLabel={t('Chiudi', 'Close')}
        title={t('Orari di apertura', 'Opening hours')}
        sub={t('Quando il centro è aperto al pubblico. I turni delle singole operatrici si impostano in Staff.', 'When the salon is open to the public. Individual staff shifts are set under Staff.')} />
      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 22px 22px' }}>
        {!isOwner && <LockNote t={t} msg={t('Solo il titolare può modificare gli orari.', 'Only the owner can edit the hours.')} />}
        {isNew && isOwner && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', background: 'var(--clay-tint)', borderRadius: 12, marginBottom: 14 }}>
            <Icon name="info" size={15} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t('Orari non ancora impostati: qui sotto una proposta da adattare e salvare.', 'Hours not set yet: below is a proposal to adjust and save.')}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {DAYS.map(([it, en], d) => {
            const open = week[d].length > 0;
            return (
              <div key={d} style={{ border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', background: open ? 'var(--surface)' : 'var(--surface-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Toggle on={open} onChange={() => isOwner && toggleDay(d)} />
                  <span style={{ fontWeight: 700, fontSize: 14, width: 84 }}>{t(it, en)}</span>
                  <span className="t-sm" style={{ color: open ? 'var(--ink-2)' : 'var(--muted-2)', flex: 1 }} >{dayLabel(week[d], t)}</span>
                  {isOwner && open && d < 5 && <button type="button" onClick={() => copyToWorkdays(d)} title={t('Copia su lunedì–venerdì', 'Copy to Monday–Friday')} style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('copia lun–ven', 'copy Mon–Fri')}</button>}
                </div>
                {/* chiudere un giorno che era aperto spegne le prenotazioni di quel
                    giorno, anche con le operatrici in turno: meglio dirlo qui */}
                {!open && !isNew && (initial[String(d)] || initial[d] || []).length > 0 && (
                  <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, marginTop: 6, paddingLeft: 56 }}>
                    {t('Salvando, in questo giorno non si potrà più prenotare, nemmeno con le operatrici in turno.', 'Once saved, this day can no longer be booked, even with stylists on shift.')}
                  </div>
                )}
                {open && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, paddingLeft: 56 }}>
                    {week[d].map((r, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input type="time" step={300} value={r[0]} disabled={!isOwner} onChange={(e) => setRange(d, i, 0, e.target.value)} style={timeCss} />
                        <span className="t-sm" style={{ color: 'var(--muted-2)' }}>–</span>
                        <input type="time" step={300} value={r[1]} disabled={!isOwner} onChange={(e) => setRange(d, i, 1, e.target.value)} style={timeCss} />
                        {isOwner && week[d].length > 1 && <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => removeRange(d, i)} aria-label={t('Rimuovi fascia', 'Remove range')}><Icon name="x" size={13} /></button>}
                      </div>
                    ))}
                    {isOwner && week[d].length < 3 && <button type="button" onClick={() => addRange(d)} style={{ alignSelf: 'flex-start', fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}>+ {t('aggiungi fascia (es. pausa pranzo)', 'add a range (e.g. lunch break)')}</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {(err || problems.length > 0) && <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 7, color: 'var(--danger)', fontSize: 13, fontWeight: 600 }}><Icon name="alert" size={14} color="var(--danger)" />{err || problems[0]}</div>}
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 14, lineHeight: 1.5 }}>
          {/* Il testo diceva che gli orari «non limitano le prenotazioni»: dal
              16/09 invece i turni si intersecano con queste fasce e un giorno
              senza fasce è chiuso (15-06, 08-19). Chi li impostava «a occhio»
              perdeva il pomeriggio del sabato senza capire perché. */}
          {t('Gli orari compaiono nell’app cliente e in cima all’agenda, e limitano le prenotazioni: fuori da queste fasce non si prenota, né online né in agenda, anche se l’operatrice è in turno. Un giorno senza fasce è chiuso. Dall’agenda lo staff può comunque forzare una prenotazione.',
             'Hours show in the client app and at the top of the agenda, and they limit bookings: outside these ranges nothing can be booked, online or in the agenda, even when a stylist is on shift. A day with no ranges is closed. Staff can still force a booking from the agenda.')}
        </div>
      </div>
      {isOwner && (
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--hair)', display: 'flex', gap: 10, justifyContent: 'flex-end', background: 'var(--surface-2)' }}>
          <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
          <button className="dk-btn dk-btn--clay" aria-disabled={saving || problems.length > 0} onClick={save}><Icon name="check" size={16} color="#fff" />{saving ? t('Salvo…', 'Saving…') : t('Salva orari', 'Save hours')}</button>
        </div>
      )}
    </DkDrawer>
  );
}
