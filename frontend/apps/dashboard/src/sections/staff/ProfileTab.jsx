// ProfileTab.jsx — linguetta «Anagrafica» della scheda operatrice (StaffPage):
// dati anagrafici, periodo nel team, colore in agenda, servizi abilitati. Il
// modulo è lo stato `form` della pagina (useOperatorEditor): qui si modifica,
// «Salva» è in alto.
import { Icon, NumInput, todayStr } from '@youty/shared';
import { HexInput } from '../../ui/index.js';
import ColorWheel from '../../ui/ColorWheel.jsx';
import { GD_PALETTE } from '../../ui/palette.js';
import { HIDDEN, dayShort, inputCss } from './lib.js';
import ServicesAssign from './ServicesAssign.jsx';
import AccessCard from './AccessCard.jsx';

/** Da quando a quando è nel team. La data d'inizio conta: senza, il
 *  riempimento dei mesi passati metteva fra la capacità i turni di chi non
 *  c'era ancora, e lo sbagliava al ribasso (il titolare, 16/10). Quando manca
 *  si propone il giorno del primo appuntamento (`firstWorkDay`). */
function EmploymentFields({ form, setForm, canTeam, firstWorkDay, t, lang }) {
  const from = form.employed_from || '';
  const until = form.employed_until || '';
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value || null }));
  const reversed = from && until && until < from;
  const earlier = from && firstWorkDay && firstWorkDay < from;
  const ended = until && until < todayStr();
  const note = { fontSize: 12, lineHeight: 1.45, marginTop: 6 };
  return (
    <div data-employment>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'block' }}>
          <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Nel team dal', 'On the team since')}</div>
          <input type="date" value={from} max={until || undefined} disabled={!canTeam} onChange={set('employed_from')} style={inputCss} />
        </label>
        <label style={{ display: 'block' }}>
          <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Fino al', 'Until')} <span style={{ fontWeight: 500, color: 'var(--muted-2)' }}>{t('· se è andata via', '· if she left')}</span></div>
          <input type="date" value={until} min={from || undefined} disabled={!canTeam} onChange={set('employed_until')} style={inputCss} />
        </label>
      </div>
      <div className="t-sm" style={{ ...note, color: 'var(--muted)' }}>
        {t('Prima di questa data non ha turni: le statistiche di riempimento non contano i suoi turni nei giorni in cui non c’era. Vuota = da sempre.',
          'Before this date she has no shifts: occupancy stats do not count her shifts on days she was not here. Empty = always.')}
      </div>
      {!from && firstWorkDay && canTeam && (
        <button type="button" data-use-first-day onClick={() => setForm((f) => ({ ...f, employed_from: firstWorkDay }))}
          className="dk-btn dk-btn--soft" style={{ height: 30, padding: '0 10px', fontSize: 12.5, marginTop: 8, gap: 6 }}>
          <Icon name="calendar" size={13} />{t(`Usa il primo appuntamento: ${dayShort(firstWorkDay, lang)}`, `Use her first appointment: ${dayShort(firstWorkDay, lang)}`)}
        </button>
      )}
      {reversed && (
        <div data-employment-error className="t-sm" style={{ ...note, color: 'var(--danger)', fontWeight: 600 }}>
          {t('La fine non può venire prima dell’inizio.', 'The end cannot come before the start.')}
        </div>
      )}
      {earlier && !reversed && (
        <div data-employment-warn className="t-sm" style={{ ...note, color: 'var(--warn)' }}>
          {t(`Ha già appuntamenti dal ${dayShort(firstWorkDay, lang)}, prima di questa data: quei giorni restano in agenda, ma senza il suo turno.`,
            `She already has appointments from ${dayShort(firstWorkDay, lang)}, before this date: those days stay in the calendar, without her shift.`)}
        </div>
      )}
      {ended && !reversed && (
        <div className="t-sm" style={{ ...note, color: 'var(--muted)' }}>
          {t('Dopo questa data non ha turni e non si prenota. Per toglierla anche dagli elenchi, disattivala qui sotto.',
            'After this date she has no shifts and cannot be booked. To remove her from the lists too, deactivate her below.')}
        </div>
      )}
    </div>
  );
}

export default function ProfileTab({
  form, setForm, canTeam, canPricing, locations, initials, color, opPalette,
  services, serviceCategories, toggleSvc, onServiceCreated, t, lang, fireToast, firstWorkDay = null, operator = null,
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
      <div className="dk-card" style={{ padding: 20 }}>
        <div className="t-meta" style={{ marginBottom: 14 }}>{t('Dati anagrafici', 'Personal details')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'block' }}>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Nome', 'First name')}</div>
              <input value={form.first_name} disabled={!canTeam} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} style={inputCss} />
            </label>
            <label style={{ display: 'block' }}>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Cognome', 'Last name')}</div>
              <input value={form.last_name} disabled={!canTeam} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} style={inputCss} />
            </label>
          </div>
          <label style={{ display: 'block' }}>
            <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Ruolo', 'Role')}</div>
            <input value={form.role_title} disabled={!canTeam} onChange={(e) => setForm((f) => ({ ...f, role_title: e.target.value }))} style={inputCss} />
          </label>
          {locations.length > 1 && (
            /* La sede si poteva solo ereditare alla creazione (sempre quella
             * predefinita) e non c'era modo di cambiarla: chi apriva una
             * seconda sede si trovava tutto il team sulla prima. */
            <label style={{ display: 'block' }}>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Sede', 'Location')}</div>
              <select
                value={form.location_id ?? ''}
                disabled={!canTeam}
                onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value ? Number(e.target.value) : null }))}
                style={{ ...inputCss, cursor: canTeam ? 'pointer' : 'default' }}
              >
                <option value="">{t('Tutte le sedi', 'All locations')}</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
          <EmploymentFields form={form} setForm={setForm} canTeam={canTeam} firstWorkDay={firstWorkDay} t={t} lang={lang} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'block' }}>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Costo orario €', 'Hourly cost €')}</div>
              <NumInput min={0} value={form.hourly_cost ?? ''} placeholder={form.hourly_cost == null ? HIDDEN : '0'} disabled={!canTeam || form.hourly_cost == null} onChange={(hourly_cost) => setForm((f) => ({ ...f, hourly_cost }))} style={inputCss} />
            </label>
            <div>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Iniziali', 'Initials')}</div>
              <div style={{ ...inputCss, background: 'var(--surface-2)', color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.05em' }}>{initials}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Operatrice attiva', 'Active stylist')}</div>
              <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Se disattivata non compare in agenda né nelle prenotazioni.', 'When inactive she disappears from the calendar and bookings.')}</div>
            </div>
            <button className={'swt press' + (form.active ? ' swt--on' : '')} disabled={!canTeam} onClick={() => canTeam && setForm((f) => ({ ...f, active: !f.active }))} aria-pressed={form.active} />
          </div>
        </div>
      </div>

      <div className="dk-card" style={{ padding: 20 }}>
        <div className="t-meta" style={{ marginBottom: 6 }}>{t('Colore operatrice', 'Stylist colour')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>{t('Identifica questa operatrice nell’agenda e nei report.', 'Identifies this stylist in the calendar and reports.')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, border: '1px solid var(--hair)', background: color }} />
          <HexInput value={color} onChange={(c) => canTeam && setForm((f) => ({ ...f, color: c }))} width={70} />
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {opPalette.map((c) => (
            <button key={c} onClick={() => canTeam && setForm((f) => ({ ...f, color: c }))} title={c} style={{ width: 24, height: 24, borderRadius: 6, background: c, cursor: canTeam ? 'pointer' : 'default', border: '1px solid var(--hair)', outline: color.toLowerCase() === c.toLowerCase() ? '2px solid var(--ink)' : 'none', outlineOffset: 1 }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280 }}>
          {GD_PALETTE.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 3 }}>
              {row.map((c) => {
                const sel = color.toLowerCase() === c.toLowerCase();
                return (
                  <button key={c} onClick={() => canTeam && setForm((f) => ({ ...f, color: c }))} title={c} style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: canTeam ? 'pointer' : 'default', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: sel ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0 }} />
                );
              })}
            </div>
          ))}
        </div>
        {/* qualsiasi altra sfumatura, senza conoscerne il codice */}
        <div style={{ marginTop: 14 }}>
          <ColorWheel value={color} onChange={(c) => canTeam && setForm((f) => ({ ...f, color: c }))} t={t} disabled={!canTeam} />
        </div>
      </div>

      {/* con quale account entra nel gestionale: lo vede e lo cambia chi gestisce il team */}
      {canTeam && operator?.id && <AccessCard operator={operator} />}

      <div className="dk-card" style={{ padding: 20, gridColumn: '1 / -1' }}>
        <ServicesAssign
          services={services} categories={serviceCategories}
          selected={form.service_ids} onToggle={toggleSvc}
          onBulk={(ids, on) => canTeam && setForm((f) => ({ ...f, service_ids: on ? [...new Set([...f.service_ids, ...ids])] : f.service_ids.filter((x) => !ids.includes(x)) }))}
          canTeam={canTeam} canPricing={canPricing}
          onCreated={onServiceCreated}
          t={t} lang={lang} fireToast={fireToast}
        />
        {canTeam && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 12 }}>{t('Le modifiche ai servizi si applicano con “Salva” in alto.', 'Service changes apply with “Save” at the top.')}</div>}
      </div>
    </div>
  );
}
