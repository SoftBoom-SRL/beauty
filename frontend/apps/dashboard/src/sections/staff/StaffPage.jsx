// StaffPage — per-operator page (port of prototype DkStaffPage).
// Tabs: Anagrafica (basics + colour + assignable services, PUT /api/staff/{id}),
// Turni e ferie (weekly pattern PUT /{id}/shifts + absences CRUD),
// Performance (GET /{id}/performance bar chart), Clienti serviti (GET /{id}/clients).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon, NumInput } from '@youty/shared';
import { HexInput } from '../../ui/index.js';
import { useDash } from '../../ctx.jsx';
import {
  GD_PALETTE, eur, inputCss, monthShort, opName, svcLabel,
  weeksFromShifts, shiftsFromWeeks,
} from './lib.js';
import ShiftPattern from './ShiftPattern.jsx';
import AbsenceCalendar from './AbsenceCalendar.jsx';

export default function StaffPage({ id, onBack }) {
  const { t, lang, services, serviceCategories, reload, fireToast, hasScope, showRevenue, setSelClient, setTab, opPalette } = useDash();
  const canTeam = hasScope('team');
  const canPricing = hasScope('pricing'); // creare servizi dal profilo operatrice
  const rev = (v) => (showRevenue ? eur(v, lang) : '•••');

  /* ---- state ---- */
  const [detail, setDetail] = useState(null);       // OperatorDetailOut
  const [form, setForm] = useState(null);           // editable OperatorIn-shaped state
  const [weeks, setWeeks] = useState([]);           // shift editor model
  const [perf, setPerf] = useState(null);           // [PerformanceOut]
  const [absences, setAbsences] = useState(null);   // [AbsenceOut]
  const [clients, setClients] = useState(null);     // [ServedClientOut]
  const [clientQ, setClientQ] = useState('');
  const [staffTab, setStaffTab] = useState('anagrafica');
  const [saving, setSaving] = useState(false);
  const [savingShifts, setSavingShifts] = useState(false);

  const toastErr = useCallback((err) => {
    fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
  }, [fireToast, t]);

  const applyDetail = useCallback((d) => {
    setDetail(d);
    setForm({
      first_name: d.first_name, last_name: d.last_name, color: d.color,
      role_title: d.role_title, hourly_cost: String(Number(d.hourly_cost)),
      active: d.active, service_ids: d.service_ids || [],
      location_id: d.location_id ?? null, user_id: d.user_id ?? null, order: d.order,
    });
    setWeeks(weeksFromShifts(d.shifts, d.cycle_weeks));
  }, []);

  /* ---- load: detail + performance + absences ---- */
  useEffect(() => {
    let alive = true;
    setDetail(null); setForm(null); setPerf(null); setAbsences(null);
    Promise.all([
      api.get(`/api/staff/${id}`),
      api.get(`/api/staff/${id}/performance`, { params: { months: 6 } }),
      api.get(`/api/staff/${id}/absences`),
    ]).then(([d, p, a]) => {
      if (!alive) return;
      applyDetail(d); setPerf(p); setAbsences(a);
    }).catch((err) => { if (alive) { toastErr(err); onBack(); } });
    return () => { alive = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- served clients (debounced server-side search) ---- */
  const qTimer = useRef(null);
  useEffect(() => {
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => {
      api.get(`/api/staff/${id}/clients`, { params: { q: clientQ || undefined } })
        .then(setClients)
        .catch(() => setClients([]));
    }, clientQ ? 300 : 0);
    return () => clearTimeout(qTimer.current);
  }, [id, clientQ]);

  const reloadAbsences = useCallback(
    () => api.get(`/api/staff/${id}/absences`).then(setAbsences),
    [id],
  );

  /* ---- saves ---- */
  const buildPayload = (cycleWeeks) => ({
    first_name: form.first_name.trim(),
    last_name: form.last_name.trim(),
    color: form.color,
    role_title: form.role_title.trim(),
    location_id: form.location_id,
    user_id: form.user_id,
    service_ids: form.service_ids,
    hourly_cost: (Number(form.hourly_cost) || 0).toFixed(2),
    cycle_weeks: cycleWeeks,
    active: form.active,
    order: form.order,
  });

  const saveBasics = async () => {
    if (saving || !form) return;
    if (!form.first_name.trim() || !form.last_name.trim()) {
      fireToast({ msg: t('Nome e cognome sono obbligatori', 'First and last name are required'), icon: 'alert' });
      return;
    }
    setSaving(true);
    try {
      const updated = await api.put(`/api/staff/${id}`, buildPayload(detail.cycle_weeks));
      setDetail((d) => ({ ...d, ...updated }));
      await reload.operators().catch(() => {});
      fireToast({ msg: t('Modifiche salvate', 'Changes saved'), icon: 'check' });
    } catch (err) { toastErr(err); } finally { setSaving(false); }
  };

  const saveShifts = async () => {
    if (savingShifts || !form) return;
    let rows;
    try { rows = shiftsFromWeeks(weeks, t); } catch (err) {
      fireToast({ msg: err.message, icon: 'alert' });
      return;
    }
    setSavingShifts(true);
    try {
      // cycle length lives on the operator: sync it before the full-replace
      if (weeks.length !== detail.cycle_weeks) {
        const updated = await api.put(`/api/staff/${id}`, buildPayload(weeks.length));
        setDetail((d) => ({ ...d, ...updated }));
      }
      const saved = await api.put(`/api/staff/${id}/shifts`, { shifts: rows });
      setDetail((d) => ({ ...d, cycle_weeks: weeks.length, shifts: saved }));
      setWeeks(weeksFromShifts(saved, weeks.length));
      await reload.operators().catch(() => {});
      fireToast({ msg: t('Turni salvati', 'Shifts saved'), icon: 'check' });
    } catch (err) { toastErr(err); } finally { setSavingShifts(false); }
  };

  const toggleSvc = (sid) => {
    if (!canTeam) return;
    setForm((f) => ({
      ...f,
      service_ids: f.service_ids.includes(sid) ? f.service_ids.filter((x) => x !== sid) : [...f.service_ids, sid],
    }));
  };

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
          <button className="dk-btn dk-btn--clay" onClick={saveBasics} disabled={saving} style={{ opacity: saving ? 0.6 : 1 }}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
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
        ].map(([k, l]) => (
          <button key={k} onClick={() => setStaffTab(k)} style={{ padding: '11px 4px', marginRight: 22, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: staffTab === k ? 'var(--ink)' : 'var(--muted)', borderBottom: '2px solid ' + (staffTab === k ? 'var(--clay)' : 'transparent'), marginBottom: -1 }}>{l}</button>
        ))}
      </div>

      {/* ── ANAGRAFICA ── */}
      {staffTab === 'anagrafica' && (
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ display: 'block' }}>
                  <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 5 }}>{t('Costo orario €', 'Hourly cost €')}</div>
                  <NumInput min={0} value={form.hourly_cost} disabled={!canTeam} onChange={(hourly_cost) => setForm((f) => ({ ...f, hourly_cost }))} style={inputCss} />
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
              onCreated={async (svc) => {
                await reload.services().catch(() => {});
                setForm((f) => ({ ...f, service_ids: [...new Set([...f.service_ids, svc.id])] }));
              }}
              t={t} lang={lang} fireToast={fireToast}
            />
            {canTeam && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 12 }}>{t('Le modifiche ai servizi si applicano con “Salva” in alto.', 'Service changes apply with “Save” at the top.')}</div>}
          </div>
        </div>
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
          <ShiftPattern weeks={weeks} setWeeks={setWeeks} onSave={saveShifts} saving={savingShifts} canEdit={canTeam} t={t} />
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

/* ================= Performance (hand-rolled bar chart, port of prototype) ================= */
function PerformancePanel({ perf, clients, color, hourlyCost, rev, t, lang }) {
  const values = perf.map((p) => Number(p.revenue));
  const max = Math.max(...values, 1);
  const last = values[values.length - 1] || 0;
  const prev = values[values.length - 2] || 0;
  const delta = prev > 0 ? Math.round(((last - prev) / prev) * 100) : 0;
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / (values.length || 1));
  const chartH = 150;
  const salesThisMonth = perf[perf.length - 1] ? perf[perf.length - 1].sales_count : 0;

  const metrics = [
    { label: t('Incasso mese', 'Month revenue'), value: rev(last) },
    { label: t('Vendite (mese)', 'Sales (month)'), value: salesThisMonth },
    { label: t('Clienti serviti', 'Clients served'), value: clients ? clients.length : '—' },
    { label: t('Costo orario', 'Hourly cost'), value: eur(hourlyCost, lang) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div className="t-meta" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="insights" size={14} color="var(--muted)" />{t('Performance del mese', 'This month’s performance')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {metrics.map((m, i) => (
            <div key={i} className="dk-card" style={{ padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div className="t-meta" style={{ fontSize: 9.5, marginBottom: 5 }}>{m.label}</div>
              <div className="t-num" style={{ fontSize: 19 }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="dk-card" style={{ padding: '18px 20px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div className="t-meta" style={{ marginBottom: 4 }}>{t('Andamento incassi · 6 mesi', 'Revenue trend · 6 months')}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{rev(last)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: delta >= 0 ? 'var(--ok)' : 'var(--danger)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name={delta >= 0 ? 'arrowUp' : 'arrowDn'} size={13} color={delta >= 0 ? 'var(--ok)' : 'var(--danger)'} />{Math.abs(delta)}%
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="t-meta" style={{ marginBottom: 4 }}>{t('Media', 'Average')}</div>
            <span className="t-num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--muted)' }}>{rev(avg)}</span>
          </div>
        </div>
        <div style={{ position: 'relative', height: chartH }}>
          {[0, 0.5, 1].map((g) => (
            <div key={g} style={{ position: 'absolute', left: 0, right: 0, bottom: g * (chartH - 22) + 22, height: 1, background: 'var(--hair)', opacity: g === 0 ? 1 : 0.5 }} />
          ))}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: (avg / max) * (chartH - 22) + 22, height: 1, borderTop: '1px dashed var(--clay)', opacity: 0.6 }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 14 }}>
            {perf.map((p, i) => {
              const v = Number(p.revenue);
              const isLast = i === perf.length - 1;
              return (
                <div key={p.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                  <span className="t-sm" style={{ fontSize: 10.5, fontWeight: 700, color: isLast ? color : 'var(--muted-2)' }}>{rev(v)}</span>
                  <div style={{ width: '100%', maxWidth: 38, height: Math.max(2, (v / max) * (chartH - 22)) + 'px', borderRadius: '7px 7px 0 0', background: isLast ? color : 'color-mix(in srgb, ' + color + ' 30%, var(--paper-2))', transition: 'height 400ms var(--ease)' }} />
                  <span className="t-sm" style={{ fontSize: 10.5, fontWeight: isLast ? 700 : 500, color: isLast ? 'var(--ink)' : 'var(--muted-2)' }}>{monthShort(p.month, lang)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= Clienti serviti (GET /{id}/clients?q=) ================= */
function ServedClients({ clients, q, setQ, onOpen, rev, t, lang }) {
  const fmtVisit = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  return (
    <div style={{ maxWidth: 760 }}>
      <div className="t-meta" style={{ marginBottom: 10 }}>{t('Clienti serviti', 'Clients served')}</div>
      <div className="dk-search" style={{ width: '100%', marginBottom: 12 }}>
        <Icon name="search" size={16} color="var(--muted-2)" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per nome o telefono…', 'Search by name or phone…')} />
        {q && (
          <button onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'transparent' }}>
            <Icon name="x" size={14} color="var(--muted-2)" />
          </button>
        )}
      </div>

      {clients == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 58, borderRadius: 12 }} />)}
        </div>
      ) : !clients.length ? (
        <div className="dk-card" style={{ padding: 28, textAlign: 'center' }}>
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>
            {q ? t('Nessun cliente trovato.', 'No client found.') : t('Nessun cliente servito finora.', 'No clients served yet.')}
          </div>
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 84px 120px 100px', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-2)' }}>
            <span className="t-meta">{t('Cliente', 'Client')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Visite', 'Visits')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Ultima visita', 'Last visit')}</span>
            <span className="t-meta" style={{ textAlign: 'right' }}>{t('Spesa tot.', 'Total spent')}</span>
          </div>
          {clients.map((c) => {
            const initials = ((c.first_name[0] || '') + (c.last_name[0] || '')).toUpperCase();
            return (
              <button key={c.client_id} className="dk-row" onClick={() => onOpen(c.client_id)}
                style={{ display: 'grid', gridTemplateColumns: '1fr 84px 120px 100px', gap: 10, alignItems: 'center', width: '100%', padding: '11px 16px', borderTop: '1px solid var(--hair)', textAlign: 'left', background: 'transparent' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  <Avatar initials={initials} size={34} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.first_name} {c.last_name}</span>
                    <span className="t-sm" style={{ color: 'var(--muted)' }}>{c.phone}</span>
                  </span>
                </span>
                <span className="t-num" style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{c.visits}</span>
                <span className="t-sm" style={{ textAlign: 'right', color: 'var(--ink-2)' }}>{fmtVisit(c.last_visit)}</span>
                <span className="t-num" style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>{rev(c.total_spent)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


/* ================= Servizi abilitati: raggruppati per categoria + creazione inline =================
 * Non costringe a uscire dal profilo per creare un servizio mancante: "＋ Nuovo
 * servizio" apre un mini-form (nome, categoria, durata, prezzo) → POST
 * /api/catalog/services → il servizio appare già selezionato per l'operatrice.
 * Richiede il permesso "prezzi" (pricing) per creare; "team" per assegnare. */
function ServicesAssign({ services, categories, selected, onToggle, onBulk, canTeam, canPricing, onCreated, t, lang, fireToast }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name_it: '', category_id: null, duration_min: '45', price: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const nameRef = useRef(null);

  const active = services.filter((s) => s.active !== false);
  const match = (s) => !q || svcLabel(s, lang).toLowerCase().includes(q.toLowerCase());
  const groups = [...(categories || [])].sort((a, b) => a.order - b.order)
    .map((c) => ({ cat: c, items: active.filter((s) => s.category_id === c.id && match(s)) }))
    .filter((g) => g.items.length);
  const orphan = active.filter((s) => !(categories || []).some((c) => c.id === s.category_id) && match(s));
  if (orphan.length) groups.push({ cat: { id: 'none', name_it: t('Altro', 'Other'), name_en: 'Other', color: 'var(--muted-2)' }, items: orphan });
  const catLabel = (c) => (lang === 'en' && c.name_en ? c.name_en : c.name_it);

  const openCreate = (catId) => {
    setDraft({ name_it: q.trim(), category_id: catId ?? categories?.[0]?.id ?? null, duration_min: '45', price: '' });
    setErr(''); setCreating(true);
    requestAnimationFrame(() => nameRef.current?.focus());
  };
  const create = async () => {
    const name = draft.name_it.trim();
    if (!name) { setErr(t('Il nome è obbligatorio', 'Name is required')); return; }
    if (!draft.category_id) { setErr(t('Scegli una categoria', 'Pick a category')); return; }
    setSaving(true); setErr('');
    try {
      const svc = await api.post('/api/catalog/services', {
        category_id: draft.category_id, name_it: name, name_en: '',
        duration_min: Math.max(5, parseInt(draft.duration_min, 10) || 45),
        price: Number(draft.price || 0).toFixed(2), active: true, order: 0,
      });
      await onCreated(svc);
      fireToast({ msg: t(`Servizio creato e abilitato: ${name}`, `Service created and enabled: ${name}`), icon: 'check' });
      setCreating(false); setQ('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('Errore di rete', 'Network error'));
    } finally { setSaving(false); }
  };

  const total = active.length, on = active.filter((s) => selected.includes(s.id)).length;
  const inputSm = { ...inputCss, padding: '8px 10px', fontSize: 13.5 };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div>
          <div className="t-meta">{t('Servizi abilitati', 'Enabled services')} <span style={{ color: 'var(--ink)', letterSpacing: 0 }}>· {on}/{total}</span></div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('Cosa può erogare: determina cosa è prenotabile sulla sua colonna in agenda.', 'What she can perform: it drives what is bookable on her column in the calendar.')}</div>
        </div>
        <div style={{ flex: 1 }} />
        {active.length > 8 && (
          <div className="dk-search" style={{ width: 200, height: 36 }}>
            <Icon name="search" size={15} color="var(--muted-2)" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Filtra servizi…', 'Filter services…')} style={{ fontSize: 13 }} />
          </div>
        )}
        {canTeam && (
          <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 12px' }} onClick={() => onBulk(active.map((s) => s.id), on < total)}>
            {on < total ? t('Seleziona tutti', 'Select all') : t('Deseleziona tutti', 'Clear all')}
          </button>
        )}
      </div>

      {creating && (
        <div style={{ border: '1.5px solid var(--clay)', borderRadius: 12, padding: 12, margin: '10px 0 12px', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="scissors" size={15} color="var(--clay-ink)" /></div>
            <div style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>{t('Nuovo servizio', 'New service')} <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 500 }}>· {t('verrà subito abilitato per questa operatrice', 'it will be enabled for this stylist right away')}</span></div>
            <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => setCreating(false)} aria-label={t('Annulla', 'Cancel')}><Icon name="x" size={14} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 0.8fr 0.8fr', gap: 8, marginBottom: 8 }}>
            <input ref={nameRef} autoFocus value={draft.name_it} onChange={(e) => setDraft((d) => ({ ...d, name_it: e.target.value }))} placeholder={t('Nome servizio *', 'Service name *')} style={inputSm} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <select value={draft.category_id ?? ''} onChange={(e) => setDraft((d) => ({ ...d, category_id: Number(e.target.value) || null }))} style={{ ...inputSm, cursor: 'pointer' }}>
              <option value="">{t('Categoria *', 'Category *')}</option>
              {(categories || []).map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...inputSm, padding: '0 10px' }}>
              <NumInput integer min={5} value={draft.duration_min} onChange={(v) => setDraft((d) => ({ ...d, duration_min: v }))} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: 13.5, fontWeight: 600 }} />
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>min</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...inputSm, padding: '0 10px' }}>
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>€</span>
              <NumInput min={0} value={draft.price} onChange={(v) => setDraft((d) => ({ ...d, price: v }))} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: 13.5, fontWeight: 600 }} />
            </div>
          </div>
          {err && <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--danger)', marginBottom: 8 }}><Icon name="alert" size={14} color="var(--danger)" />{err}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="t-sm" style={{ color: 'var(--muted-2)', flex: 1 }}>{t('Nome inglese, posa e costi si completano in Servizi.', 'English name, soak and costs can be completed in Services.')}</span>
            <button type="button" className="dk-btn dk-btn--clay" style={{ height: 36, fontSize: 13 }} onClick={create} disabled={saving}>
              <Icon name="check" size={15} color="#fff" />{saving ? t('Creazione…', 'Creating…') : t('Crea e abilita', 'Create & enable')}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
        {groups.map(({ cat, items }) => {
          const ids = items.map((s) => s.id);
          const allOn = ids.every((id) => selected.includes(id));
          return (
            <div key={cat.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: cat.color || 'var(--muted-2)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-2)' }}>{catLabel(cat)}</span>
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 12 }}>· {ids.filter((id) => selected.includes(id)).length}/{ids.length}</span>
                {canTeam && <button type="button" onClick={() => onBulk(ids, !allOn)} style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', marginLeft: 4 }}>{allOn ? t('nessuno', 'none') : t('tutti', 'all')}</button>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {items.map((s) => {
                  const isOn = selected.includes(s.id);
                  return (
                    <button key={s.id} type="button" onClick={() => onToggle(s.id)} aria-pressed={isOn} aria-disabled={!canTeam} className={'dk-pill' + (isOn ? ' dk-pill--on' : '')} style={{ padding: '5px 11px', fontSize: 12.5 }} title={`${s.duration_min} min · € ${Number(s.price).toFixed(2)}`}>
                      {svcLabel(s, lang)}<Icon name={isOn ? 'check' : 'plus'} size={12} stroke={2.6} color={isOn ? '#fff' : 'var(--muted-2)'} />
                    </button>
                  );
                })}
                {canPricing && !creating && cat.id !== 'none' && (
                  <button type="button" onClick={() => openCreate(cat.id)} className="dk-pill" style={{ padding: '5px 11px', fontSize: 12.5, borderStyle: 'dashed', color: 'var(--clay-ink)' }} title={t('Crea un servizio in questa categoria', 'Create a service in this category')}>
                    <Icon name="plus" size={12} stroke={2.6} color="var(--clay-ink)" />{t('Nuovo', 'New')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!groups.length && (
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{q ? t('Nessun servizio corrisponde al filtro.', 'No service matches the filter.') : t('Nessun servizio attivo nel catalogo.', 'No active service in the catalog.')}</div>
        )}
        {canPricing && !creating && (
          <button type="button" onClick={() => openCreate(null)} className="dk-btn dk-btn--ghost" style={{ alignSelf: 'flex-start', height: 36, fontSize: 13, borderStyle: 'dashed' }}>
            <Icon name="plus" size={15} />{q ? t(`Crea “${q.trim()}”`, `Create “${q.trim()}”`) : t('Nuovo servizio', 'New service')}
          </button>
        )}
        {!canPricing && canTeam && (
          <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Per creare un servizio nuovo serve il permesso “prezzi”.', 'Creating a new service requires the “pricing” permission.')}</div>
        )}
      </div>
    </div>
  );
}
