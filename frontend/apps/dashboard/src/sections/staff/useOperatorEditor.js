// useOperatorEditor.js — lo stato della scheda operatrice (StaffPage):
// dettaglio, prestazioni e assenze caricati insieme, clienti servite con la
// ricerca, modifiche in sospeso di anagrafica e turni, salvataggi (PUT
// parziale, C19) e il ricarico quando la scheda cambia da un'altra postazione.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toastApiError } from '@youty/shared';
import { rebaseDraft } from '../../ui/rebase.js';
import { useDash, useLive } from '../../ctx.jsx';
import {
  weeksFromShifts, shiftsFromWeeks,
  formFromDetail, changedOperatorFields, sameOperatorField, sameWeeks,
} from './lib.js';
import { absencesApi, staffApi } from '../../api/staff.js';

export function useOperatorEditor({ id, onBack, canTeam }) {
  const { t, reload, fireToast } = useDash();

  /* ---- state ---- */
  const [detail, setDetail] = useState(null);       // OperatorDetailOut
  const [form, setForm] = useState(null);           // editable OperatorIn-shaped state
  const [weeks, setWeeks] = useState([]);           // shift editor model
  const [perf, setPerf] = useState(null);           // [PerformanceOut]
  const [absences, setAbsences] = useState(null);   // [AbsenceOut]
  const [clients, setClients] = useState(null);     // [ServedClientOut]
  const [clientQ, setClientQ] = useState('');
  const [saving, setSaving] = useState(null);       // null | 'all' | 'shifts'

  const toastErr = useCallback((err) => toastApiError(err, fireToast, t), [fireToast, t]);

  const applyDetail = useCallback((d) => {
    setDetail(d);
    setForm(formFromDetail(d));
    setWeeks(weeksFromShifts(d.shifts, d.cycle_weeks));
  }, []);

  // ultimi valori per il ricarico dal feed live (la callback vive più a lungo del render)
  const live = useRef({});
  live.current = { detail, form, weeks };

  /* ---- load: detail + performance + absences ---- */
  useEffect(() => {
    let alive = true;
    setDetail(null); setForm(null); setPerf(null); setAbsences(null);
    Promise.all([
      staffApi.get(id),
      staffApi.performance(id, { months: 6 }),
      absencesApi.list(id),
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
      staffApi.clients(id, { q: clientQ || undefined })
        .then(setClients)
        .catch(() => setClients([]));
    }, clientQ ? 300 : 0);
    return () => clearTimeout(qTimer.current);
  }, [id, clientQ]);

  const reloadAbsences = useCallback(
    () => absencesApi.list(id).then(setAbsences),
    [id],
  );

  /* ---- cosa c'è da salvare ----
   * Anagrafica e turni stanno in due linguette ma la scheda è una: il «Salva»
   * dell'intestazione restava visibile in «Turni e ferie» ed eseguiva solo
   * l'anagrafica, quindi «Modifiche salvate» e si usciva con i turni vecchi
   * (sabato pomeriggio non prenotabile, 15-03). Ora salva tutto ciò che è
   * cambiato, e le linguette con modifiche in sospeso hanno un pallino. */
  const basicsChanges = form && detail ? changedOperatorFields(form, detail) : {};
  const basicsDirty = Object.keys(basicsChanges).length > 0;
  const shiftsDirty = !!detail && !sameWeeks(weeks, weeksFromShifts(detail.shifts, detail.cycle_weeks));

  /* ---- saves ----
   * La PUT operatrice porta solo i campi cambiati (C19): «Salva turni» manda
   * la sola lunghezza del ciclo, l'Anagrafica solo ciò che si è toccato, e ciò
   * che un'altra postazione ha cambiato nel frattempo non torna indietro. */
  const pendingRefresh = useRef(false);
  const savingRef = useRef(false);   // sincrono: lo stato `saving` arriva solo al render dopo
  const saveParts = async ({ basics, shifts }) => {
    if (saving || !form || !detail) return;
    const changes = basics ? changedOperatorFields(form, detail) : {};
    const doBasics = Object.keys(changes).length > 0;
    const doShifts = shifts && shiftsDirty;
    if (!doBasics && !doShifts) {
      fireToast({ msg: t('Nessuna modifica da salvare', 'Nothing to save'), icon: 'info' });
      return;
    }
    if (doBasics && (!String(form.first_name).trim() || !String(form.last_name).trim())) {
      fireToast({ msg: t('Nome e cognome sono obbligatori', 'First and last name are required'), icon: 'alert' });
      return;
    }
    let rows = null;
    if (doShifts) {
      try { rows = shiftsFromWeeks(weeks, t); } catch (err) {
        fireToast({ msg: err.message, icon: 'alert' });
        return;
      }
    }
    setSaving(basics ? 'all' : 'shifts');
    savingRef.current = true;
    try {
      // la lunghezza del ciclo vive sull'operatrice: va scritta prima dei turni
      const cycleChanged = doShifts && weeks.length !== detail.cycle_weeks;
      if (doBasics || cycleChanged) {
        const body = { ...changes, ...(cycleChanged ? { cycle_weeks: weeks.length } : {}) };
        const updated = await staffApi.update(id, body);
        setDetail((d) => ({ ...d, ...updated }));
      }
      if (doShifts) {
        const saved = await staffApi.updateShifts(id, { shifts: rows });
        setDetail((d) => ({ ...d, cycle_weeks: weeks.length, shifts: saved }));
        setWeeks(weeksFromShifts(saved, weeks.length));
      }
      reload.operators().catch(() => {});
      fireToast({
        msg: doBasics && doShifts ? t('Anagrafica e turni salvati', 'Profile and shifts saved')
          : doShifts ? t('Turni salvati', 'Shifts saved')
            : t('Modifiche salvate', 'Changes saved'),
        icon: 'check',
      });
    } catch (err) { toastErr(err); } finally {
      savingRef.current = false;
      setSaving(null);
      // un aggiornamento arrivato durante il salvataggio si applica adesso
      if (pendingRefresh.current) { pendingRefresh.current = false; refreshDetail(); }
    }
  };
  const saveAll = () => saveParts({ basics: true, shifts: true });
  const saveShifts = () => saveParts({ basics: false, shifts: true });

  /* ---- la scheda segue le modifiche fatte altrove ----
   * Senza, il colore cambiato dall'agenda o l'abilitazione data dal listino
   * restavano invisibili fino a riaprire la scheda. I campi che qui non si sono
   * toccati prendono il valore nuovo; quelli in modifica restano, con un avviso
   * se nel frattempo sono cambiati anche altrove. */
  const refreshDetail = async () => {
    if (savingRef.current) { pendingRefresh.current = true; return; }
    let fresh;
    try { fresh = await staffApi.get(id); } catch { return; }
    const { detail: old, form: curForm, weeks: curWeeks } = live.current;
    if (!old || !curForm) return;
    const merged = rebaseDraft(curForm, formFromDetail(old), formFromDetail(fresh), sameOperatorField);
    const oldWeeks = weeksFromShifts(old.shifts, old.cycle_weeks);
    const newWeeks = weeksFromShifts(fresh.shifts, fresh.cycle_weeks);
    const weeksUntouched = sameWeeks(curWeeks, oldWeeks);
    setDetail(fresh);
    setForm(merged.draft);
    if (weeksUntouched) setWeeks(newWeeks);
    const weeksConflict = !weeksUntouched && !sameWeeks(newWeeks, oldWeeks) && !sameWeeks(newWeeks, curWeeks);
    if (merged.conflicts.length || weeksConflict) {
      fireToast({
        msg: t('Scheda modificata da un’altra postazione: le tue modifiche non salvate restano, controllale prima di salvare.',
          'Profile changed from another workstation: your unsaved edits are kept, check them before saving.'),
        icon: 'info',
      });
    }
  };
  useLive(/^operator\./, (events) => {
    const mine = events.filter((e) => e.payload?.operator_id == null || e.payload.operator_id === id);
    if (!mine.length) return;
    refreshDetail();
    if (mine.some((e) => /^operator\.absence_/.test(e.type))) reloadAbsences().catch(() => {});
  });

  const toggleSvc = (sid) => {
    if (!canTeam) return;
    setForm((f) => ({
      ...f,
      service_ids: f.service_ids.includes(sid) ? f.service_ids.filter((x) => x !== sid) : [...f.service_ids, sid],
    }));
  };

  /* servizio creato dalla scheda (ServicesAssign) → 'enabled' | 'pending' | 'created' */
  const onServiceCreated = async (svc) => {
    await reload.services().catch(() => {});
    /* «Crea e abilita» deve abilitare davvero: prima il servizio
     * finiva solo nel modulo non salvato e il toast diceva
     * «creato e abilitato» anche a chi poi usciva senza salvare.
     * Si scrive subito il solo elenco dei servizi (PUT parziale),
     * partendo da quello del server. */
    if (!canTeam) return 'created';
    const addTo = (ids) => [...new Set([...(ids || []), svc.id])];
    setForm((f) => ({ ...f, service_ids: addTo(f.service_ids) }));
    try {
      const updated = await staffApi.update(id, { service_ids: addTo(live.current.detail?.service_ids) });
      setDetail((d) => ({ ...d, ...updated }));
      reload.operators().catch(() => {});
      return 'enabled';
    } catch { return 'pending'; }
  };

  return {
    detail, form, setForm, weeks, setWeeks, perf, absences, clients, clientQ, setClientQ,
    saving, basicsDirty, shiftsDirty, saveAll, saveShifts, reloadAbsences, toggleSvc, onServiceCreated,
  };
}
