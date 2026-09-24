// steps.js — i passi della prenotazione, con i numeri di sempre.
// I numeri contano: «indietro» fa step - 1 (codice → dati → riepilogo →
// orario → servizio → scelta), e da -1 si esce alla home. La fine è 9, fuori
// dalla sequenza: da lì non si torna indietro.
export const STEP = Object.freeze({
  CHOICE: -1,   // prenotare nell'app o i pacchetti
  SERVICE: 0,   // i servizi dal listino pubblico
  TIME: 1,      // operatrice, giorno e orario (GET …/availability)
  REVIEW: 2,    // riepilogo; con la sessione si prenota da qui
  DETAILS: 3,   // senza sessione: nome, cognome, telefono
  OTP: 4,       // senza sessione: il codice via SMS, poi la prenotazione
  DONE: 9,      // prenotato (POST /api/agenda/client/appointments)
});

/** Le etichette della barra dei passi SERVICE, TIME e REVIEW ([it, en]). */
export const STEP_INFO = [['Servizio', 'Service'], ['Giorno e ora', 'Day & time'], ['Conferma', 'Confirm']];
