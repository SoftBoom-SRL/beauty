# Revisore 16: app delle clienti e pacchetto condiviso (1 alto, 4 medi, 7 bassi)

Probe lasciati al loro posto su richiesta dell'orchestratore: `backend/apps/agenda/tests_probe_16_fe_cliente.py`, `backend/apps/accounts/tests_probe_16_fe_cliente.py`; script node/python in `scratchpad/r16/` (probe_phone.mjs + probe_phone.py, probe_phoneinput.mjs, probe_tz.mjs).

### [ALTO] 16-01 Il tetto OTP per salone si riempie con numeri inventati e blocca l'accesso a tutte le clienti
- File: `backend/apps/accounts/api.py:670-701` (`OTP_MAX_PER_SALON = 60` su 15 min, contato PRIMA della ricerca e anche per i numeri inesistenti); analogo `REGISTER_MAX_PER_SALON` 60/h in `client_register` (:596-625)
- Stato: CONFERMATO (probe `apps.accounts.tests_probe_16_fe_cliente`: 60 richieste su numeri inventati da 3 IP, 20 ciascuno cioè sotto il tetto per IP → la cliente vera, da un quarto IP, riceve 429)
- Difetto/Scenario: bastano 3 indirizzi e 240 richieste l'ora per tenere fuori dall'app, senza sosta, ogni cliente del salone che deve fare l'accesso (anche per prenotare da anonima). Lo stesso blocco scatta senza nessun attacco durante un picco reale: una campagna WhatsApp «prenota dall'app» con più di 60 richieste di codice in 15 minuti. La cliente legge «Troppi codici richiesti», e le prenotazioni si perdono.
- Correzione: contare nel tetto per salone solo i codici davvero emessi (numeri esistenti), o alzarlo e affiancargli una difesa diversa.

### [MEDIO] 16-02 PhoneInput: il «+» battuto sparisce e il prefisso battuto a mano diventa doppio
- File: `frontend/packages/shared/src/ui/PhoneInput.jsx:75-94` (onNumber), `phone.js:132-139` (joinPhone)
- Stato: CONFERMATO (simulazione tasto per tasto in `r16/probe_phoneinput.mjs`)
- Difetto: il «+» da solo non viene riconosciuto e viene tolto dalle cifre. Chi scrive il numero col prefisso ottiene «+39 39…». Lo stesso succede incollando «(+39) 333…» o «393331234567»: la regola «più di 11 cifre = già internazionale», che hanno sia phone.js sia il backend, qui non si applica.
- Scenario: «+39 333 1234567» battuto a mano diventa «+39393331234567»; «+44 7911 123456» diventa «+39447911123456». Tutti e due passano isPlausiblePhone. L'accesso fallisce in silenzio («se il numero è registrato…»). La registrazione crea una scheda fantasma con un numero inesistente e il codice non arriva mai. Lo stesso vale per lo staff che inserisce una cliente dalla dashboard.
- Correzione: in onNumber tenere il «+» iniziale nel buffer, finché il prefisso non viene riconosciuto (come già si fa per «00»), e applicare l'euristica >11 cifre + prefisso noto anche alle cifre battute o incollate.

### [MEDIO] 16-03 GiftCard: il «Saldo gift card… spendibili in salone» somma anche le carte ancora da pagare
- File: `frontend/apps/client-app/src/screens/GiftCard.jsx:33-34, 71-76, 94-113`
- Stato: CONFERMATO (lettura: la correzione spendable/pending c'è solo in `Wallet.jsx:50-57`)
- Scenario: la cliente compra dall'app una gift card da 50 € per un'amica (nasce unpaid). Torna sulla pagina e legge «Saldo gift card €50,00 · 1 carte attive · spendibili in salone», ma la cassa rifiuta la carta. Nelle righe manca anche l'etichetta «Da pagare in salone».
- Correzione: stesso calcolo di Wallet.jsx (escludere le unpaid dal totale ed etichettarle).

### [MEDIO] 16-04 Un'operatrice di un'altra sede compare nel selettore: mostra gli orari di una collega, poi 400 alla conferma
- File: `backend/apps/staff/api.py:454-482` (public_operators non filtra per sede); `backend/apps/agenda/services.py:276-285` (la disponibilità ripiega in silenzio su altre operatrici), `:577-580` (la creazione risponde 400); `frontend/apps/client-app/src/screens/Prenota.jsx:92-95, 690`
- Stato: CONFERMATO (probe `Probe16Sedi`: l'operatrice della sede «Mare» è nel selettore, 31 slot tutti assegnati all'altra operatrice, POST → 400 «Operatrice non idonea per il servizio selezionato»)
- Scenario: in un salone con due sedi la cliente sceglie Marta, vede orari liberi e un riepilogo «Operatrice: Marta». Alla conferma riceve un errore incomprensibile e con Marta non può prenotare.
- Correzione: public_operators filtrato su `_operators_qs(salon, default_location(salon))`.

### [MEDIO] 16-05 La Home della cliente loggata non si aggiorna mai: «Oggi/Domani», caparra e dati restano quelli del caricamento
- File: `frontend/apps/client-app/src/screens/Home.jsx:84-92`, `lib.jsx:169-179` (useClientAppointments senza refetch), `lib.jsx:240-248` (relLabel), `lib.jsx:58-68,65-68` (DepositDue non guarda la scadenza)
- Stato: PLAUSIBILE (percorso letto; dipende da un'app lasciata aperta nel browser)
- Scenario: alle 23 la Home dice «Domani alle 10:00». La mattina dopo la stessa pagina, ripresa senza ricaricare, dice ancora «Domani» per un appuntamento che è oggi, e la cliente rischia di mancarlo. Dopo la scadenza della caparra, «Paga ora» apre ancora il link vecchio: il pagamento arriva dopo il rilascio e diventa refund_due, mentre il toast di ritorno dice «Ci vediamo in salone».
- Correzione: useTodayKey e ricarica al ritorno in primo piano anche in HomeLogged/Prenotazioni; in DepositDue nascondere «Paga ora» a scadenza passata.

### [BASSO] 16-06 Spostamento e annullamento dall'app restituiscono alla cliente la nota interna dello staff
- File: `backend/apps/agenda/api.py:1127-1148` (e la creazione, :1108-1124), che usano `_appointment_out` (con `note`, `forced`, `created_via`, `cancel_reason`); l'elenco cliente `_client_appointment_out` (:982-1009) la omette apposta
- Stato: CONFERMATO (probe `test_client_move_response_hides_staff_note`: nella risposta del move compare la nota scritta dallo staff)
- Correzione: rispondere con `_client_appointment_out` negli endpoint cliente.

### [BASSO] 16-07 «Carta mia» nell'app (`received`) non coincide con la regola del backend (gift_index)
- File: `frontend/apps/client-app/src/screens/Wallet.jsx:54-56`, `Prenota.jsx:60-66`; `backend/apps/marketing/api.py:633-645`, `backend/apps/agenda/api.py:125-165`
- Stato: CONFERMATO (lettura)
- Scenario: una carta pagata, comprata per la madre, entra nel «Credito utilizzabile» della compratrice e, allo stesso tempo, in quello della destinataria: lo stesso credito contato due volte. Al contrario, una carta «a trattamento» comprata per sé non ha `received` e Prenota non dice «Coperto da gift card», mentre la cassa la applica.
- Correzione: esporre dal backend un flag «spendibile da me» con la stessa regola di gift_index.

### [BASSO] 16-08 findBooked può scambiare un altro appuntamento allo stesso orario per quello appena tentato
- File: `frontend/apps/client-app/src/screens/Prenota.jsx:146-163`
- Stato: PLAUSIBILE
- Scenario: la cliente ha già il taglio alle 10:00 e prenota la manicure alle 10:00. Il primo POST fallisce prima di arrivare al server (rete o 502 durante un deploy), lei riprova e findBooked trova il taglio: compare «Fatto!», ma la manicure non esiste.
- Correzione: confrontare anche i servizi (o usare una chiave di idempotenza).

### [BASSO] 16-09 «Esci» dal Profilo riapre subito la schermata di accesso (K6 corretto solo in Utility)
- File: `frontend/apps/client-app/src/screens/Profilo.jsx:130-131`, `App.jsx:44-57`
- Stato: CONFERMATO (lettura: logout() su una vista personale → il gate apre l'overlay di accesso con la ripresa sul Profilo; nessun toast)
- Correzione: setView('home') prima di logout(), come in Utility.jsx.

### [BASSO] 16-10 AuthFlow: con Invio parte request-otp anche per un numero non plausibile
- File: `frontend/apps/client-app/src/screens/auth/AuthFlow.jsx:135` (onEnter controlla solo `phone.trim()`, mentre il pulsante richiede isPlausiblePhone)
- Stato: CONFERMATO (lettura)
- Scenario: numero a metà + Invio → si passa alla schermata «Se il numero +39333 è registrato…» e si consuma il tetto per IP e per salone (vedi 16-01).

### [BASSO] 16-11 phone.js e phone.py divergono su due casi di testo grezzo
- File: `frontend/packages/shared/src/phone.js:113-119, 137` vs `backend/common/phone.py:30-55`
- Stato: CONFERMATO (`r16/probe_phone.py`, 70 casi: 11 differenze, tutte su input poco realistici)
- Difetto: con più zeri dopo il prefisso («+49 00151…») il frontend li toglie tutti, il backend uno solo. Con 12 o più cifre senza «+» e un prefisso fuori dalla lista corta del backend («380501234567», «971…», «86…») il frontend lo legge come internazionale, il backend antepone il 39. Conta solo per i valori legacy visualizzati e per la chiave fra import e app.

### [BASSO] 16-12 Coupon in percentuale arrotondato nel portafoglio
- File: `frontend/apps/client-app/src/screens/Wallet.jsx:23-27` (`Math.round(value)`)
- Stato: PLAUSIBILE (la dashboard crea percentuali intere; un premio fedeltà discount_pct con decimali si leggerebbe 12,5% → «13%»)

Aree controllate senza reperti:
- Fuso del salone in nextDays/useTodayKey/dayStripLabel/fmtDayMed/relLabel/DepositDue/fmtExpiry e isoAtMin/toDateStr/addDays sul cambio dell'ora (probe_tz.mjs con 5 fusi del dispositivo, fra cui Tokyo, Atene e Santiago).
- fmtEur sempre con due decimali.
- Flusso OTP e registrazione senza il 404 (AuthFlow e Prenota funzionano: codice → «Registrati» → register → verify).
- clientAuth namespacizzato per slug e 401 → uscita.
- staffAuth: refresh single-flight, rilettura da localStorage fra schede, tolleranza di 20 s sul backend, logout con timeout.
- api.js: 204, JSON non valido, readableDetail, signal.
- Doppio tocco su conferma (guardia booking + pulsante disabilitato).
- Più servizi (eligibleOperators/splitVisit) e slot consigliati filtrati lato server (smart_slots).
- Sposta: `days` nelle dipendenze, ricarica dopo 409, exclude_appointment_id.
- Spostamento o annullamento di un appuntamento già annullato: rifiutati da `_ensure_open` (probe verdi).
- Regola delle 24 ore applicata dal server, con i testi basati su cancelMinHours.
- Ritorno da Stripe (?deposit) e webhook «pagata dopo il rilascio» → refund_due.
- URL dell'informativa privacy validato, nessun HTML iniettato, guardia su VITE_API_URL.
