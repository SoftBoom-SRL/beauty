// usePrenota.js — lo stato e le azioni della prenotazione (schermo Prenota):
// servizi scelti, operatrici idonee, orari del giorno con la guardia sulle
// risposte superate, regali già pagati, il codice via SMS di chi non ha la
// sessione e il POST dell'appuntamento a prova di secondo tentativo.
import React from 'react';
import { ApiError, SALON_SLUG, isPlausiblePhone, toDateStr } from '@youty/shared';
import { createAppointment, getAppointments, getAvailability, getPublicAvailability, getWallet } from '../../api/client.js';
import { useOtpFlow } from '../../hooks/useOtpFlow.js';
import { usePublicOperators, usePublicServices } from '../../hooks/usePublicCatalog.js';
import { useTodayKey } from '../../hooks/useTodayKey.js';
import { sameBooking } from '../../lib/appointments.js';
import { svcMinutes } from '../../lib/catalog.js';
import { nextDays } from '../../lib/dates.js';
import { errToast, toastSlotTaken } from '../../lib/errors.js';
import { giftServiceCards } from '../../lib/wallet.js';
import { STEP } from './steps.js';

/** `app`: t, lang, session e fireToast dal contesto. Restituisce quello che
 *  disegnano i passi (vedi index.jsx). */
export function usePrenota({ t, lang, session, fireToast }) {
  const { cats, error: catError } = usePublicServices(SALON_SLUG);
  const { operators } = usePublicOperators(SALON_SLUG);
  const [step, setStep] = React.useState(STEP.CHOICE);  // vedi steps.js
  const [serviceIds, setServiceIds] = React.useState([]);
  const [dayIdx, setDayIdx] = React.useState(0);
  const [operatorId, setOperatorId] = React.useState(null); // null = "prima disponibile"
  const [slot, setSlot] = React.useState(null);         // SlotOut {start, assignment}
  const [slots, setSlots] = React.useState(null);       // null = loading
  const [booking, setBooking] = React.useState(false);
  const [booked, setBooked] = React.useState(null);     // AppointmentOut on success
  const [ident, setIdent] = React.useState({ first_name: '', last_name: '', phone: '' });
  const [otp, setOtp] = React.useState('');
  // Il codice via SMS di chi prenota senza sessione: i rifiuti noti sotto il
  // campo, gli altri errori nel toast (vedi useOtpFlow).
  const otpFlow = useOtpFlow({ phone: ident.phone, t, fireToast, otherErrors: 'toast' });
  const { error: otpErr, setError: setOtpErr, codeSurelySent } = otpFlow;
  const [blocked, setBlocked] = React.useState(false);  // numero già in anagrafica: vedi registerAndOtp
  const todayKey = useTodayKey();
  // ricalcolata quando cambia il giorno: vedi useTodayKey
  // eslint-disable-next-line react-hooks/exhaustive-deps -- todayKey è il motivo del ricalcolo
  const days = React.useMemo(() => nextDays(14), [todayKey]);

  React.useEffect(() => { if (catError) errToast(catError, fireToast, t); }, [catError]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Gift card «a trattamento» già pagate: il servizio regalato si prenota senza
   * pagare nulla, e va detto prima di scegliere, non alla cassa. */
  const [giftCards, setGiftCards] = React.useState([]);
  React.useEffect(() => {
    if (!session) { setGiftCards([]); return undefined; }
    let alive = true;
    getWallet()
      // Solo le carte che la cassa applica a lei (isSpendable, la regola di
      // gift_index): quella che ho COMPRATO per un'altra persona non è un mio
      // regalo, mentre quella «a trattamento» comprata per me senza
      // destinataria sì — filtrando su `received` qui mancava, e la cassa
      // poi la applicava (16-07).
      .then((w) => { if (alive) setGiftCards(giftServiceCards(w.gift_cards)); })
      .catch(() => { if (alive) setGiftCards([]); });
    return () => { alive = false; };
  }, [session]);
  const giftFor = (serviceId) => giftCards.find((g) => g.gift_service_id === serviceId) || null;
  // «Regalo di …» solo per la carta ricevuta: su quella comprata per sé il
  // nome di chi l'ha pagata è il suo.
  const giftFrom = (g) => (g && g.received && g.buyer_name) || '';
  const giftedSelected = serviceIds.map(giftFor).filter(Boolean);

  const allSvcs = React.useMemo(
    () => (cats || []).flatMap((c) => c.services.map((s) => ({ ...s, catName: c.name_it }))),
    [cats],
  );
  const svcs = serviceIds.map((id) => allSvcs.find((s) => s.id === id)).filter(Boolean);
  const s = svcs[0];
  // Lavoro + posa: è il tempo che la cliente passa in salone (C4, 09-07).
  const dur = svcs.reduce((sum, sv) => sum + svcMinutes(sv), 0);
  const price = svcs.reduce((sum, sv) => sum + Number(sv.price || 0), 0);
  const toggleSvc = (id) => setServiceIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  const items = serviceIds.map((id) => ({ service_id: id, operator_id: operatorId }));

  /* ---- stylist picker (step 1): solo chi può svolgere TUTTI i servizi scelti ----
   * `items` manda la stessa operatrice su ogni voce, quindi chi ne sa fare solo
   * una non può prendere la visita: il ripiego «chi sa fare il primo servizio»
   * la proponeva lo stesso e il backend rispondeva con una lista vuota, senza
   * spiegazioni. Risultato: quattordici chip di fila con «Nessun orario libero»
   * e nessun modo di capire perché. */
  const eligibleOperators = React.useMemo(() => {
    if (!operators || !serviceIds.length) return [];
    return operators.filter((op) => serviceIds.every((id) => op.service_ids.includes(id)));
  }, [operators, serviceIds]);
  // Nessuna le fa tutte: si prenota solo con «Prima disponibile», che il
  // backend assegna servizio per servizio. Va detto, non lasciato indovinare.
  const splitVisit = Boolean(operators && serviceIds.length > 1 && !eligibleOperators.length);
  const selectedOperator = eligibleOperators.find((op) => op.id === operatorId) || null;
  // Aggiungendo un servizio dopo aver scelto l'operatrice, quella scelta poteva
  // non essere più valida: restava selezionata e svuotava tutti i giorni.
  React.useEffect(() => {
    if (operatorId !== null && !eligibleOperators.some((op) => op.id === operatorId)) setOperatorId(null);
  }, [eligibleOperators, operatorId]);

  /* ---- availability fetch (step 1) ----
   * Ogni richiesta ha un numero di sequenza: se l'utente cambia giorno prima
   * che la risposta arrivi, la risposta superata viene ignorata (altrimenti
   * con due risposte fuori ordine comparivano gli orari del giorno precedente). */
  const slotsReq = React.useRef(0);
  const loadSlots = React.useCallback(async (dIdx) => {
    const seq = ++slotsReq.current;
    setSlots(null);
    setSlot(null);
    try {
      // Da loggata si passa dall'endpoint personale: quello pubblico è limitato
      // a 120 richieste l'ora per (salone, IP), e dietro il wi-fi del salone o
      // un CGNAT la griglia si svuotava per tutte insieme. Stessa risposta,
      // senza il contatore condiviso.
      const list = session
        ? await getAvailability({ date: toDateStr(days[dIdx]), items })
        : await getPublicAvailability({ salon: SALON_SLUG, date: toDateStr(days[dIdx]), items });
      if (seq !== slotsReq.current) return;
      setSlots(list);
    } catch (err) {
      if (seq !== slotsReq.current) return;
      setSlots([]);
      errToast(err, fireToast, t);
    }
  }, [days, session, JSON.stringify(items)]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (step === STEP.TIME) loadSlots(dayIdx); }, [step, dayIdx, loadSlots]);

  /* ---- creazione dell'appuntamento, a prova di secondo tentativo ----
   * Con la rete ballerina il primo POST può essere ANDATO A BUON FINE e la
   * risposta perdersi: la cliente vede un errore, ritocca «Conferma» e si
   * ritrova due appuntamenti (il backend non rifiuta due prenotazioni della
   * stessa cliente sullo stesso orario, e con «Prima disponibile» il secondo
   * prende un'altra operatrice, occupando due slot). Prima di riprovare LA
   * STESSA prenotazione si va a vedere se l'appuntamento esiste già: stesso
   * orario E stessi servizi. Col solo orario, il taglio già fissato alle 10:00
   * passava per la manicure appena tentata alle 10:00, e dopo un primo POST
   * perso per strada (rete, 502 durante un deploy) compariva «Fatto!» per una
   * manicure che non esisteva (16-08).
   * La via più pulita — una chiave di idempotenza inviata col POST — richiede
   * un campo nuovo nello schema del backend: vedi rapporto. */
  const postedFor = React.useRef(null);
  const findBooked = async (startIso, ids) => {
    try {
      const data = await getAppointments();
      return (data?.upcoming || []).find((a) => sameBooking(a, startIso, ids)) || null;
    } catch { return null; }
  };
  const createAppointmentOnce = async () => {
    const attempt = slot.start + '|' + [...serviceIds].sort((a, b) => a - b).join(',');
    if (postedFor.current === attempt) {
      const existing = await findBooked(slot.start, serviceIds);
      if (existing) return existing;
    }
    postedFor.current = attempt;
    return createAppointment({ items, start: slot.start });
  };

  /* La prenotazione, uguale da «Conferma» con la sessione e dopo il codice
   * via SMS: il 409 vuol dire che l'orario l'ha appena preso un'altra, e si
   * torna agli orari, ricaricati. */
  const book = async () => {
    try {
      const appt = await createAppointmentOnce();
      setBooked(appt);
      setStep(STEP.DONE);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toastSlotTaken(fireToast, t);
        setStep(STEP.TIME);
        loadSlots(dayIdx);
      } else {
        errToast(err, fireToast, t);
      }
    }
  };

  /* ---- confirm booking ---- */
  const confirm = async () => {
    if (booking || !slot) return;
    setBooking(true);
    try {
      await book();
    } finally {
      setBooking(false);
    }
  };

  /* Invio del codice. `request-otp` risponde 200 anche sui numeri sconosciuti —
   * e deve farlo: il 404 di prima era un oracolo, bastava ciclare i numeri per
   * farsi la rubrica del salone. Quindi da qui non si capisce se la cliente è
   * nuova: si va sempre al passo del codice, e chi non ha ancora un profilo se
   * lo crea da lì con `registerAndOtp`, senza perdere la prenotazione scelta. */
  const sendBookingOtp = async () => {
    setOtpErr(null);
    setBlocked(false);
    setOtp('');   // il codice vecchio è già invalido: lasciarlo nel campo faceva
                  // fallire la conferma subito dopo il «Reinvia codice»
    const phone = ident.phone.trim();
    if (!ident.first_name.trim() || !ident.last_name.trim() || !isPlausiblePhone(phone)) {
      setOtpErr(t('Controlla il numero di telefono', 'Check the phone number'));
      return;
    }
    setBooking(true);
    try {
      if (await otpFlow.request()) setStep(STEP.OTP);
    } finally { setBooking(false); }
  };

  /* «È la prima volta? Registrati» del passo del codice: nome e cognome li
   * abbiamo già dal passo precedente, quindi qui non si chiede niente in più. */
  const registerAndOtp = async () => {
    setOtpErr(null);
    setBlocked(false);
    setOtp('');
    setBooking(true);
    try {
      const res = await otpFlow.register({
        first_name: ident.first_name.trim(),
        last_name: ident.last_name.trim(),
        phone: ident.phone.trim(),
        lang,
      });
      // «Numero già registrato»: o la scheda c'è ed è attiva (il codice
      // chiesto poco fa è davvero partito) oppure è disattivata e da qui non
      // si entra. Si dicono entrambe le cose, e la prenotazione resta dov'è.
      if (res === 'blocked') setBlocked(true);
    } finally { setBooking(false); }
  };

  /* verifica OTP → sessione → crea appuntamento */
  const verifyAndBook = async () => {
    setOtpErr(null);
    if (otp.length !== 6 || booking) return;
    setBooking(true);
    // 1) verifica OTP → crea la sessione. Il codice è monouso: se la sessione
    // c'è già (prenotazione fallita al primo tentativo) non si riverifica,
    // altrimenti il secondo tocco direbbe «codice non valido».
    if (!session && !(await otpFlow.verify(otp))) {
      setBooking(false);
      return;
    }
    // 2) sessione creata → crea l'appuntamento
    try {
      await book();
    } finally { setBooking(false); }
  };

  return {
    step, setStep, cats, serviceIds, toggleSvc, dayIdx, setDayIdx, operatorId, setOperatorId, slot, setSlot, slots,
    booking, booked, ident, setIdent, otp, setOtp, otpErr, codeSurelySent, blocked, days,
    giftFor, giftFrom, giftedSelected, svcs, s, dur, price, eligibleOperators, splitVisit, selectedOperator,
    confirm, sendBookingOtp, registerAndOtp, verifyAndBook,
  };
}
