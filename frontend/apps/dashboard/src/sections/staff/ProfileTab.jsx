// ProfileTab.jsx — linguetta «Anagrafica» della scheda operatrice (StaffPage):
// dati anagrafici, colore in agenda, servizi abilitati. Il modulo è lo stato
// `form` della pagina (useOperatorEditor): qui si modifica, «Salva» è in alto.
import { NumInput } from '@youty/shared';
import { HexInput } from '../../ui/index.js';
import { GD_PALETTE } from '../../ui/palette.js';
import { HIDDEN, inputCss } from './lib.js';
import ServicesAssign from './ServicesAssign.jsx';

export default function ProfileTab({
  form, setForm, canTeam, canPricing, locations, initials, color, opPalette,
  services, serviceCategories, toggleSvc, onServiceCreated, t, lang, fireToast,
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
          <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 34, height: 34, borderRadius: 9, cursor: canTeam ? 'pointer' : 'default', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: color }}>
            <input type="color" value={color} disabled={!canTeam} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
          </label>
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
      </div>

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
