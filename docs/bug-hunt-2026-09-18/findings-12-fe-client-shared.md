# App cliente + pacchetto condiviso — 2 alti, 6 medi, 9 bassi

## [K1] Cliente disattivata: login e prenotazione in vicolo cieco — ALTO
- Dove: client-app/src/screens/auth/AuthFlow.jsx:24-53, screens/Prenota.jsx:133-159
- Cosa: entrambi trattano il 404 di request-otp come "numero sconosciuto" e passano a register. Ma request-otp cerca solo clienti ATTIVI (accounts/api.py:107-112) mentre register cerca fra tutti (accounts/api.py:481) e risponde "Numero gia registrato".
- Scenario: scheda disattivata dalla titolare. La cliente prova a entrare: "Numero non registrato" -> compila i dati -> "Numero gia registrato", all'infinito. In Prenota perde servizio, giorno e ora gia scelti.

## [K2] Il selettore operatrice propone chi non puo fare tutti i servizi -> nessun orario per 14 giorni — ALTO
- Dove: client-app/src/screens/Prenota.jsx:79-84, 76
- Cosa: il fallback filtra su chi sa fare il PRIMO servizio, ma items applica lo stesso operator_id a ogni voce; il backend con un'operatrice non idonea restituisce [] senza spiegazioni.
- Scenario: Taglio + Manicure, nessuna le fa entrambe: tutti e 14 i chip dicono "Nessun orario libero" e nulla indica la causa.

## [K3] La striscia dei giorni e calcolata sul calendario del telefono, non del salone — MEDIO
- Dove: client-app/src/screens/lib.jsx:183-186 (nextDays), 194-208 (useTodayKey). todayStr() esiste apposta e non viene usata.
- Scenario: cliente a Los Angeles: il primo chip e un giorno gia chiuso per il salone ed esce sempre vuoto. Da Tokyo la striscia parte da domani e gli orari di oggi spariscono.

## [K4] La scadenza della caparra e mostrata nell'ora del dispositivo — MEDIO
- Dove: client-app/src/screens/lib.jsx:51-60 (DepositDue), senza salonTzOpts.
- Scenario: scadenza 10:30 del salone mostrata come 09:30: la cliente paga tardi convinta di essere in tempo e perde lo slot.

## [K5] fmtEur perde i centesimi — MEDIO
- Dove: packages/shared/src/format.js:4-7. fmtEur(12.9) -> "12,9"; fmtEur(9.999) -> "9,999". Coinvolge Prenota, Wallet, GiftCard, Pacchetti, Annulla, Home.

## [K6] "Esci" da una schermata personale riapre subito il login — MEDIO
- Dove: client-app/src/Utility.jsx:18-22, App.jsx:44-46. Il toast "Sei uscita" compare insieme alla pagina di accesso a schermo pieno.

## [K7] La navigazione bloccata perde la destinazione e l'intera prenotazione — MEDIO
- Dove: App.jsx:46, ctx.jsx:78-89, screens/Prenota.jsx:455. openAuth e sempre chiamata senza callback: authResume e codice morto.

## [K8] Un secondo tentativo dopo una risposta persa puo creare un appuntamento doppio — MEDIO
- Dove: screens/Prenota.jsx:112-130, 178-190. Nessuna chiave di idempotenza; il backend non controlla sovrapposizioni per cliente.
- Scenario: rete instabile, appuntamento creato ma risposta persa; la cliente riconferma e con "Prima disponibile" il secondo POST assegna l'altra operatrice: due conferme, due slot occupati.

## [K9] Sposta: a mezzanotte i giorni scivolano ma gli orari no — BASSO
- Dove: screens/Sposta.jsx:40-49 (manca days nelle dipendenze).

## [K10] Disponibilita su endpoint pubblico rate-limited per IP anche da loggata — BASSO
- Dove: screens/Prenota.jsx:97-100. 120 richieste/ora per (salone, IP): dietro il wi-fi del salone o CGNAT la griglia si svuota per tutti.

## [K11] "Chiama per prenotare" e un pulsante morto se il salone non ha un numero — BASSO
- Dove: screens/Pacchetti.jsx:92-96 (Home.jsx:44-49 gestisce invece il caso).

## [K12] default_lang del salone ignorato: l'app apre sempre in italiano — BASSO
- Dove: ctx.jsx:26-40, App.jsx:18. La chiave yt.lang non e namespacizzata per salone.

## [K13] Il testo "24h" sulle politiche di annullamento e cablato — BASSO
- Dove: screens/Home.jsx:160-162, Annulla.jsx:78-81 vs CLIENT_MOVE_CANCEL_MIN_HOURS.

## [K14] isPlausiblePhone accetta numeri che il backend non normalizza — BASSO
- Dove: packages/shared/src/phone.js:168-172 (6 cifre contro le 7 del backend).
- Scenario: 4 cifre digitate -> registrazione riuscita, scheda con telefono inesistente, SMS a spese del salone, cliente bloccata sullo schermo OTP.

## [K15] Una rimozione in corso blocca in silenzio le altre righe — BASSO
- Dove: screens/Waitlist.jsx:21-23, 72-75.

## [K16] Scadenze gift card e coupon sull'orologio del dispositivo — BASSO
- Dove: screens/Wallet.jsx:9-14 (usata anche da GiftCard.jsx:112).

## [K17] "Reinvia codice" lascia nel campo il codice vecchio, ormai invalido — BASSO
- Dove: screens/auth/AuthFlow.jsx:167-170, screens/Prenota.jsx:511-512.

## Nota
- packages/shared/test/format.test.js non asserisce comportamenti sbagliati: gli 8 test sul fuso del salone sono corretti. Non copre pero fmtEur, dove sta K5.
