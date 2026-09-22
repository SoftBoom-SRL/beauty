# Reperti revisore 03 — torna indietro e messaggi trattenuti

Probe (non cancellati, come da istruzioni dell'orchestratore): `backend/apps/agenda/tests_probe_03_undo_outbox.py`.

### [ALTO] 03-01 «Torna indietro» butta via anche le modifiche precedenti ancora trattenute: lo spostamento che resta in vigore non viene mai comunicato
- File: `backend/apps/agenda/services.py:946-970` (`revert_held_events`), chiamata da `backend/apps/agenda/undo.py:352-355`; fusione in `services.py:916-935`.
- Stato: CONFERMATO (probe `UndoDropsEarlierHeldChanges`, 3 test falliti: nessun evento in coda dopo l'undo).
- Difetto: `revert_held_events` presume che l'evento trattenuto appartenga solo al gesto annullato e lo supera. Ma è la fusione di più gesti (sposta+sposta, sposta+modifica, sposta+check-in, sposta+stacco), e un annullamento aveva già superato lo spostamento precedente.
- Scenario: conferma «alle 10» partita da giorni; trascino alle 14, poi per sbaglio alle 16, premo «Indietro»: torna alle 14 ma non parte niente, Yourang e la cliente restano sulle 10 (promemoria sbagliato). Uguale con «sposta → modifica → Indietro» e «sposta → annulla → Indietro».
- Correzione: salvare nella UndoEntry lo stato degli eventi trattenuti fusi/superati dal gesto e ripristinarlo, oppure confrontare lo stato ripristinato con l'ultimo payload consegnato e rimandare se diverso.

### [ALTO] 03-02 Annullare una creazione con caparra online cancella l'appuntamento ma lascia aperto il link di pagamento già inviato: se la cliente paga, i soldi spariscono senza traccia
- File: `backend/apps/agenda/undo.py:240-259` (`_delete_appointment` accetta `required`), `undo.py:318-339`; `backend/apps/agenda/api.py:218-228` (link mai trattenuto); `backend/apps/sales/api.py:512-515` (appuntamento inesistente → `return` silenzioso).
- Stato: CONFERMATO (probe `UndoCreateWithDepositLink`: undo 200, `expire_deposit_checkout` mai chiamato, pagamento scartato senza log).
- Difetto: l'undo cancella la riga senza chiudere la Checkout Session né rifiutarsi; il webhook ignora i pagamenti per appuntamenti inesistenti.
- Scenario: inserita alle 10 invece che alle 11, «Indietro», reinserita alle 11: la cliente ha due link, paga il primo → 30 € incassati su Stripe, nessuna vendita né rimborso, la caparra del nuovo resta «richiesta» e allo scadere il posto viene liberato.
- Correzione: chiudere la sessione (on_commit) o annullare invece di cancellare quando c'è `deposit_checkout_session_id`; loggare/rimborsare i pagamenti orfani nel webhook.

### [MEDIO] 03-03 «Torna indietro» su un no-show già addebitato passa: il conto in cassa non viene visto
- File: `backend/apps/agenda/undo.py:44` (`_FROZEN_STATUSES` solo CLOSED), `undo.py:300-306`; istantanea senza `no_show_payment_intent_id`; `backend/apps/sales/services.py:421-433`, `backend/apps/sales/api.py:182`.
- Stato: CONFERMATO (probe `UndoNoShowAfterCharge`: 200, stato confirmed, vendita no-show ancora agganciata).
- Difetto: l'addebito no-show crea una Sale agganciata ma non cambia campi dell'istantanea; l'undo rimette «confermato» (e caparra trattenuta → pagata) lasciando la vendita.
- Scenario: no-show addebitato, la cliente arriva, «Indietro»: al checkout «Appuntamento già incassato», la visita non si chiude più.
- Correzione: 409 anche se l'appuntamento ha una `sale` o un `no_show_payment_intent_id`.

### [MEDIO] 03-04 La fusione di `slot.freed` annuncia lo slot sbagliato e perde quello davvero liberato
- File: `backend/apps/agenda/services.py:2067-2106` (`free_slot_event` supera ogni slot.freed trattenuto dell'appuntamento), chiamato da `:1320`, `:1532`, `:1601`, `:1914`.
- Stato: CONFERMATO (probe `FreedSlotMerge`: dopo 10→14→16 resta solo lo slot delle 14).
- Difetto: chiave per appuntamento, non per slot: il secondo gesto rimpiazza l'annuncio dello slot originale con la posizione intermedia.
- Scenario: appuntamento delle 10 spostato alle 14 e poi alle 16 (o spostato e poi annullato): la lista d'attesa sente «libero alle 14» (libero anche prima), mai le 10.
- Correzione: conservare `start/operator_id` dello slot.freed già trattenuto; sopprimerlo solo se l'appuntamento torna lì.

### [MEDIO] 03-05 Il salone annulla una prenotazione fatta dall'app entro la trattenuta: alla cliente non arriva nulla
- File: `backend/apps/agenda/services.py:916-924`, `:973-981`; `backend/apps/agenda/api.py:1108-1124`.
- Stato: CONFERMATO (probe `StaffCancelsAppBookingWithinHold`).
- Difetto: «conferma non partita = la cliente non sa niente» è falso per `created_via=app` (lei ha visto la conferma a schermo) e per chi ha già ricevuto il link caparra (mai trattenuto).
- Scenario: Sofia prenota dall'app, la reception annulla subito (operatrice malata): nessun messaggio, Sofia si presenta; con caparra ha un link valido per un appuntamento annullato.
- Correzione: azzerare senza avvisare solo per appuntamenti nati al banco senza link caparra inviato.

### [MEDIO] 03-06 Il messaggio di spostamento fuso porta l'orario «di prima» sbagliato o non lo porta
- File: `backend/apps/agenda/services.py:926-935` (`keep.payload = payload`), `:1315-1319`; rettifica tardiva `services.py:960-963` + `undo.py:48-55`.
- Stato: CONFERMATO sul payload (probe `MovedPayloadAfterMerge`, 3 test); effetto sul testo PLAUSIBILE (dipende dal modello Yourang).
- Difetto: 10→14→16 dà `old_start`=14 (mai comunicato); sposta+modifica/check-in dà un `moved` senza `old_start`; l'undo tardivo di uno spostamento manda `moved` senza `old_start`.
- Scenario: la cliente sapeva «ore 10», riceve «spostato dalle 14 alle 16».
- Correzione: conservare il primo `old_start` nella fusione e usare l'orario comunicato nella rettifica.

### [MEDIO] 03-07 L'«Annulla» del pannello di dettaglio rifà lo spostamento al contrario forzandolo
- File: `frontend/apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx:186-192`.
- Stato: CONFERMATO (probe `PanelUndoIsAReverseForcedMove`: `moved` fantasma 14→10 in coda, `forced=True`, slot.freed delle 14).
- Difetto: unico «Annulla» dell'agenda non portato sul «torna indietro» del server: messaggio «spostato» alla cliente per un appuntamento mai mosso, flag forzato permanente, slot mai occupato annunciato, voce in più nello storico.
- Scenario: dal pannello 10→14, poi «Annulla» nel toast.
- Correzione: usare `POST /api/agenda/undo` come la griglia e rileggere il pannello.

### [BASSO] 03-08 Corsa worker/fusione: il worker spedisce il payload vecchio e sovrascrive quello fuso
- File: `backend/apps/core/management/commands/flush_outbox.py:161-180` (`_claim` non ricontrolla la scadenza), `:114-158` (spedisce e risalva `event.payload` letto prima).
- Stato: CONFERMATO come logica (probe `ClaimVersusMerge`); finestra reale stretta.
- Difetto/scenario: correzione in commit mentre il worker legge l'evento appena scaduto: parte l'orario vecchio e la correzione viene cancellata.
- Correzione: `_due(now)` nel filtro del claim e rilettura dopo il claim.

### [BASSO] 03-09 Passare a «Subito» con eventi trattenuti: la correzione scavalca la conferma vecchia, che parte per ultima
- File: `backend/apps/agenda/services.py:911-913`, `:2102`.
- Stato: CONFERMATO (probe `DelaySwitchedOffWithHeldEvents`).
- Difetto/scenario: con ritardo 0 non si guardano i trattenuti: parte subito `moved` 16:00 e 30 s dopo `created` 10:00, ultima parola sbagliata per Yourang.
- Correzione: fondere/liberare i trattenuti della chiave anche con ritardo 0.

### [BASSO] 03-10 Smoke e2e step 11 (slot.freed non trovato per #9): smoke rimasto indietro rispetto alla trattenuta; resta un caso vero stretto per la lista d'attesa
- File: `backend/scripts/e2e_smoke.py:524-545`; `backend/apps/agenda/services.py:1596-1602`, `:973-981`; `backend/apps/agenda/tests.py:2935`, `:2945`.
- Stato: CONFERMATO (log e2e: tutto a 18:59:56, «outbox superseded 1 eventi ([3])» alla cancel di #9; probe `AppCancelWithinHold`).
- Diagnosi: #9 prenotato dall'app e annullato pochi istanti dopo con la conferma ancora trattenuta: per regola voluta la cancel la supera e `slot.freed` non si emette. Il payload, quando emesso, porta ancora `appointment_id`/`matching_waitlist`. I test unitari usano `_no_automation_delay()`, lo smoke no: va aggiornato (es. `automation_delay_seconds: 0` via `PUT /api/core/settings` all'inizio).
- Caso vero residuo: chi si iscrive in lista d'attesa MENTRE lo slot appare occupato (come fa lo smoke) non viene mai avvisata se la prenotazione è annullata entro la trattenuta.

### [BASSO] 03-11 Il rilascio per caparra non pagata non supera gli eventi trattenuti: «posto liberato» e poi «spostato»
- File: `backend/apps/agenda/services.py:1881-1915` (`emit_event("appointment.released_unpaid")` diretto); analoghi `deposit.paid` `:1876`, `visit.completed` `sales/api.py:225`.
- Stato: CONFERMATO per il rilascio (probe `ReleaseWhileAMoveIsHeld`); PLAUSIBILE per gli altri.
- Difetto/scenario: spostamento pochi secondi prima della scadenza caparra: parte il rilascio, poi il `moved` → per Yourang l'appuntamento annullato è vivo alla nuova ora.
- Correzione: far passare il rilascio da `emit_appointment_event` come evento terminale.

### [BASSO] 03-12 L'undo di un gesto già comunicato libera uno slot senza avvisare la lista d'attesa
- File: `backend/apps/agenda/undo.py:318-340`; `backend/apps/agenda/services.py:946-963`.
- Stato: CONFERMATO (probe `UndoFreesASlotSilently`).
- Difetto/scenario: conferma partita, «Indietro» dopo 3 minuti: la cliente riceve l'annullamento, la lista d'attesa non sa che il posto è libero.
- Correzione: emettere `free_slot_event` quando la rettifica è necessaria.

### [BASSO] 03-13 L'undo ricrea le righe servizio con id nuovi: una modifica dal pannello rimasto aperto riprezza la visita a listino
- File: `backend/apps/agenda/undo.py:224-236`; `backend/apps/agenda/services.py:684-686`, `:707`; `ApptDetailModal.jsx:370-381`.
- Stato: CONFERMATO (probe `StaleItemIdsAfterUndo`: 50 € → 65 €).
- Difetto/scenario: pannello aperto dopo «Sposta qui» + «Annulla»; si allunga un servizio e si salva con gli id vecchi → trattati come servizi nuovi, prezzo del listino attuale.
- Correzione: ripristinare le righe in place o con lo stesso id; rileggere il pannello dopo l'undo.

### [BASSO] 03-14 «Torna indietro» su un annullamento con caparra rimborsata da Stripe dà la colpa a una collega
- File: `backend/apps/agenda/undo.py:305-306`; `backend/apps/agenda/services.py:1616`.
- Stato: CONFERMATO (probe `UndoCancelAfterAutomaticRefund`: 409 «Qualcuno ha già cambiato…»).
- Difetto/scenario: il rimborso automatico avviato dall'annullamento stesso fa rifiutare l'undo (giusto) con un motivo falso; stesso messaggio per link pagato o rilascio automatico.
- Correzione: 409 che dice cosa è successo davvero.

### [BASSO] 03-15 L'«Annulla» dei toast usa una chiusura vecchia: con «Indietro» o ⌘Z un attimo prima si annullano due gesti
- File: `frontend/apps/dashboard/src/sections/agenda/index.jsx:300, 345, 392, 452, 475` (`undoFn: () => undoLast()`), `:222-225`, `:631`.
- Stato: PLAUSIBILE (ripercorso nel codice).
- Difetto/scenario: il toast tiene l'`undoLast` con `undoing=false`; «Indietro» poi «Annulla» durante la richiesta → secondo `POST /undo` senza id: annulla anche il gesto precedente o dà un 409 falso. L'«Annulla» senza id annulla l'ultima voce della persona, non quella del toast.
- Correzione: guardia con ref, chiudere il toast all'avvio, passare l'id della voce.

### [BASSO] 03-16 Le voci di «torna indietro» scadute restano per sempre per chi non fa più gesti
- File: `backend/apps/agenda/undo.py:152-166`.
- Stato: CONFERMATO (lettura: nessun'altra pulizia).
- Difetto/scenario: istantanee con note, prezzi e nome cliente cancellate solo al gesto successivo della stessa persona nello stesso salone.
- Correzione: purga periodica (es. in `flush_outbox` accanto a `purge_delivered`).

Aree controllate senza reperti: isolamento per persona e per salone di GET/POST `/undo` (entry_id cercato solo nel proprio storico); finestra di 10 minuti coerente fra `stack()` e `perform()`, tetto 20 voci; istantanee normalizzate (UTC, decimali) senza falsi conflitti in create/move/edit/split/cancel/no-show/check-in/start/pause; 409 su conto chiuso, su vendita dell'appuntamento creato e su modifica di una collega; doppio POST `/undo` sulla stessa voce (409); supersede vs claim del worker per gli eventi finali (lock di riga + UPDATE condizionale); eventi con attempts>0 o in `sending` mai fusi; tetto MAX_HOLD_FACTOR; ritardo 0; range 0–600 e `require_owner` sull'impostazione, DelaySetting in Automazioni; OTP e link di pagamento mai ritardati; ⌘Z ignorato in input/textarea/select/contentEditable e con modale o drawer di gruppo aperti; doppio clic su «Annulla» del toast (si smonta al primo clic) e su «Indietro» (disabilitato durante l'undo); migrazioni core 0009 e agenda 0010 coerenti coi modelli; purga dei `superseded`.
