// StaffPage — per-operator page (port of prototype DkStaffPage).
// Tabs: Anagrafica (basics + colour + assignable services, PUT /api/staff/{id}),
// Turni e ferie (weekly pattern PUT /{id}/shifts + absences CRUD),
// Performance (GET /{id}/performance bar chart), Clienti serviti (GET /{id}/clients).
import { useState } from 'react';
import { Avatar, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { HIDDEN, eur, opName } from './lib.js';
import { useOperatorEditor } from './useOperatorEditor.js';
import ProfileTab from './ProfileTab.jsx';
import ShiftPattern from './ShiftPattern.jsx';
import AbsenceCalendar from './AbsenceCalendar.jsx';
import PerformancePanel from './PerformancePanel.jsx';
import ServedClients from './ServedClients.jsx';

export default function StaffPage({ id, onBack }) {
  const { t, lang, services, serviceCategories, locations, fireToast, hasScope, showRevenue, setSelClient, setTab, opPalette } = useDash();
  const canTeam = hasScope('team');
  const canPricing = hasScope('pricing'); // creare servizi dal profilo operatrice
  // null = importo non mandato dal server a chi non ha il permesso (C6)
  const rev = (v) => (showRevenue && v != null ? eur(v, lang) : HIDDEN);

  const {
    detail, form, setForm, weeks, setWeeks, perf, absences, clients, clientQ, setClientQ,
    saving, basicsDirty, shiftsDirty, saveAll, saveShifts, reloadAbsences, toggleSvc, onServiceCreated,
  } = useOperatorEditor({ id, onBack, canTeam });
  const [staffTab, setStaffTab] = useState('anagrafica');

  const openClient = (cid) => { setSelClient(cid); setTab('clienti'); };

  /* ---- loading skeleton ---- */
  if (!detail || !form) {
    return (
      <div className="dk-page" style={{ maxWidth: 1180 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
          <div className="skel" style={{ width: 42, height: 42, borderRadius: 12 }} />
          <div className="skel" style={{ width: 56, height: 56, borderRadius: 99 }} />
          <div style={{ flex: 1 }}><div className="skel" style={{ height: 26, width: 260, marginBottom: 8 }} /><div className="skel" style={{ height: 14, width: 140 }} /></div>
        </div>
        <div className="skel" style={{ height: 42, width: 480, marginBottom: 22 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 220, borderRadius: 16 }} />)}
        </div>
      </div>
    );
  }

  const initials = ((form.first_name[0] || '') + (form.last_name[0] || '')).toUpperCase() || detail.initials;
  const color = form.color;

  return (
    <div className="dk-page" style={{ maxWidth: 1180 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        <button className="dk-iconbtn" onClick={onBack}><Icon name="chevL" size={20} /></button>
        <Avatar initials={initials} size={56} color={color} ring />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, lineHeight: 1.1 }}>{opName(form)}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>
            {form.role_title || t('Operatrice', 'Stylist')}
            {!form.active && <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--danger)', background: 'var(--danger-tint)', padding: '2px 8px', borderRadius: 99 }}>{t('Non attiva', 'Inactive')}</span>}
          </div>
        </div>
        {/* prototype clock in/out + commissions have no API backing yet */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--muted)', background: 'var(--paper-2)', padding: '7px 13px', borderRadius: 99 }}>
          <Icon name="clock" size={13} color="var(--muted-2)" />{t('Timbrature e commissioni: fase 2', 'Time clock & commissions: phase 2')}
        </span>
        {canTeam && (
          <button className="dk-btn dk-btn--clay" onClick={saveAll} disabled={!!saving || (!basicsDirty && !shiftsDirty)}
            title={basicsDirty || shiftsDirty ? undefined : t('Nessuna modifica da salvare', 'Nothing to save')}
            style={{ opacity: saving || (!basicsDirty && !shiftsDirty) ? 0.6 : 1 }}>
            <Icon name="check" size={17} color="#fff" />{saving === 'all' ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        )}
      </div>

      {/* sub-tabs */}
      <div style={{ borderBottom: '1px solid var(--hair)', display: 'flex', gap: 4, marginBottom: 22 }}>
        {[
          ['anagrafica', t('Anagrafica', 'Profile')],
          ['turni', t('Turni e ferie', 'Shifts & time off')],
          ['performance', t('Performance', 'Performance')],
          ['clienti', t('Clienti serviti', 'Clients served')],
        ].map(([k, l]) => {
          const pending = (k === 'anagrafica' && basicsDirty) || (k === 'turni' && shiftsDirty);
          return (
            <button key={k} onClick={() => setStaffTab(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: staffTab === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (staffTab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {l}
              {pending && <span title={t('Modifiche non salvate', 'Unsaved changes')} style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--clay)' }} />}
            </button>
          );
        })}
      </div>

      {/* ── ANAGRAFICA ── */}
      {staffTab === 'anagrafica' && (
        <ProfileTab
          form={form} setForm={setForm} canTeam={canTeam} canPricing={canPricing}
          locations={locations} initials={initials} color={color} opPalette={opPalette}
          services={services} serviceCategories={serviceCategories}
          toggleSvc={toggleSvc} onServiceCreated={onServiceCreated}
          t={t} lang={lang} fireToast={fireToast}
        />
      )}

      {/* ── TURNI E FERIE ── */}
      {staffTab === 'turni' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '13px 16px', background: 'var(--clay-tint)', borderRadius: 12 }}>
            <Icon name="sparkle" size={16} color="var(--clay-ink)" />
            <span className="t-sm" style={{ color: 'var(--clay-ink)', lineHeight: 1.5 }}>
              {t("Turni e disponibilità alimentano la pianificazione automatica degli appuntamenti. Imposta il pattern ricorrente e programma le eccezioni con largo anticipo: l'agenda proporrà slot solo quando l'operatrice è effettivamente presente.",
                 'Shifts and availability feed automatic appointment planning. Set the recurring pattern and plan exceptions well ahead: the calendar offers slots only when the stylist is actually in.')}
            </span>
          </div>
          <ShiftPattern weeks={weeks} setWeeks={setWeeks} onSave={saveShifts} saving={!!saving} canEdit={canTeam} t={t} />
          <div>
            <div className="t-meta" style={{ marginBottom: 12 }}>{t('Calendario disponibilità · assenze', 'Availability calendar · time off')}</div>
            {absences == null
              ? <div className="skel" style={{ height: 320, borderRadius: 16 }} />
              : <AbsenceCalendar operatorId={id} absences={absences} onChanged={reloadAbsences} canEdit={canTeam} />}
          </div>
        </div>
      )}

      {/* ── PERFORMANCE ── */}
      {staffTab === 'performance' && (
        perf == null
          ? <div className="skel" style={{ height: 320, borderRadius: 16 }} />
          : <PerformancePanel perf={perf} clients={clients} color={color} hourlyCost={form.hourly_cost} rev={rev} t={t} lang={lang} />
      )}

      {/* ── CLIENTI SERVITI ── */}
      {staffTab === 'clienti' && (
        <ServedClients clients={clients} q={clientQ} setQ={setClientQ} onOpen={openClient} rev={rev} t={t} lang={lang} />
      )}
    </div>
  );
}
