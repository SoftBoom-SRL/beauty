# Revisore 13 — agenda React: dettaglio, nuova prenotazione, gruppi, ricerca cliente
Conteggio: 3 ALTO, 9 MEDIO, 13 BASSO. Probe (non cancellato, su richiesta dell'orchestratore): `backend/apps/agenda/tests_probe_13_fe_agenda.py`.

### [ALTO] 13-01 «Sposta qui» alla stessa ora e nella stessa colonna di un altro giorno non sposta niente (proprio dove l'ombra dice «qui»)
- File: `frontend/apps/dashboard/src/sections/agenda/index.jsx:277` (guardia di moveAppt), `:367-376` (moveOpenApptHere), `:824`; `DayGrid.jsx:632-655` (ombra «HH:MM · qui», pointer-events none)
- Stato: CONFERMATO (percorso ripercorso: clic sull'ombra → menu → «Sposta qui» → moveAppt ritorna alla riga 277 senza chiamare il server; probe test_same_time_other_day_move_payload: la stessa richiesta, se partisse, riuscirebbe)
- Difetto: `startMin === fromMin && !reassigned` confronta solo minuti e operatrice, non il giorno; da «Sposta qui» si arriva con un appuntamento di un altro giorno alla stessa ora/colonna → nessuna richiesta, nessun avviso, il pannello si riapre (sembra una conferma).
- Scenario: Maria martedì 10:00 con Anna chiede «giovedì stessa ora»; si sfoglia a giovedì, clic sull'ombra «10:00 · qui» → «Sposta qui»: resta martedì. Martedì no-show, giovedì non prenotata.
- Correzione: includere il giorno nel confronto (o POST move diretto con isoAtMin(date, startMin) quando il giorno cambia).

### [ALTO] 13-02 L'anteprima dell'annullamento promette «Caparra trattenuta» sotto le 24 h, ma dal gestionale la caparra viene sempre rimborsata (anche su Stripe, in automatico)
- File: `ApptDetailModal.jsx:91-92, 502`; `sections/agenda/lib.js:233-240`; backend `apps/agenda/services.py:1567-1575` (late = by_client and …), `settle_deposit_refund` (1620+)
- Stato: CONFERMATO (probe test_dashboard_late_cancel_refunds_paid_deposit: caparra pagata, annullamento dal gestionale 2 h prima → «refund_due», cancelled_late False)
- Difetto: la passata del 18/09 ha tolto la penale agli annullamenti del salone; il pannello calcola ancora `lateCancel` e scrive «Caparra trattenuta €X». Correzione rimasta a metà.
- Scenario: la cliente disdice per telefono 2 h prima; la reception legge «Caparra trattenuta» e conferma; il server rimborsa la caparra sulla carta. Il salone perde la caparra (con «No-show» l'avrebbe tenuta).
- Correzione: allineare cancelSteps (sempre «da rimborsare») o offrire «annullata dalla cliente» trattata come by_client.

### [ALTO] 13-03 Il pannello di dettaglio non si aggiorna quando l'appuntamento cambia altrove: i suoi comandi ripartono dalla copia vecchia e disfano o raddoppiano le modifiche
- File: `ApptDetailModal.jsx:27` (appt copiato una volta), `165-181` (applyMove manda sempre start dalla copia), `366-401` (PUT con lista completa); `index.jsx:269-357, 483-506` (drag/stacco/resize non toccano il pannello), `627-631` («Indietro» attivo col pannello aperto); nessun ascolto live nel pannello
- Stato: CONFERMATO (probe test_stale_panel_put_readds_split_service: dopo uno stacco il PUT con la lista vecchia rimette il servizio nella visita, e l'appuntamento staccato resta)
- Difetto: la griglia accanto resta interattiva (e il pannello invita a trascinare), ma `appt` si aggiorna solo con le risposte del pannello; drag, stacchi, resize, undo della barra e altre postazioni non arrivano.
- Scenario: (a) trascino il blocco aperto dalle 10 alle 14, poi «Passa a Bea» → move con start 10:00: lo spostamento è disfatto. (b) stacco la piega alle 16, poi nel pannello allungo il colore e salvo → la piega torna nella visita a prezzo di listino ed esiste anche alle 16: pagata due volte. (c) servizio aggiunto da una collega sparisce al mio Salva.
- Correzione: ricaricare GET /appointments/{id} su eventi live e dopo i gesti della griglia; controllo di versione (updated_at) sul PUT.

### [MEDIO] 13-04 Riassegnare gli appuntamenti di un'operatrice disattivata risponde «Not Found» (pannello e trascinamento)
- File: backend `apps/agenda/api.py:584` (`salon_get(Operator, …, from_operator_id, active=True)`); `ApptDetailModal.jsx:179`, `index.jsx:285`, WeekView commitMove
- Stato: CONFERMATO (probe test_reassign_from_inactive_operator_with_from_operator_id: con from_operator_id inattiva → 404; senza → 200)
- Difetto/Scenario: dopo il 18/09 il client manda sempre from_operator_id; la colonna `inactive` esiste apposta per riassegnare, ma ogni drag o «Passa a» fallisce. Regressione.
- Correzione: non richiedere active=True per from_operator (o ometterlo se coincide con la principale).

### [MEDIO] 13-05 Le modifiche ai servizi non salvate spariscono con qualunque altro gesto del pannello (e «Incassa» fattura i servizi vecchi)
- File: `ApptDetailModal.jsx:122` (effetto su [appt] che rifà editItems), `42, 59, 182, 743` (setAppt), `549` (Incassa con appt salvato), `416-417`; `DayGrid.jsx:397` (riclic sul blocco → pannello rimontato)
- Stato: CONFERMATO (percorso ripercorso)
- Scenario: aggiungo «Piega» senza salvare e premo «›» (o invio link caparra, «Passa a») → la riga sparisce; oppure premo subito «Incassa» → conto senza la piega. Solo commitItemStart salva prima.
- Correzione: riapplicare/salvare le modifiche in sospeso prima di ogni setAppt; Incassa salva prima.

### [MEDIO] 13-06 «Annulla» dell'avviso di uno spostamento dal pannello rifà la strada al contrario con force: «Forzato» per sempre, visite miste riassegnate male, secondo messaggio alla cliente
- File: `ApptDetailModal.jsx:185-192` (undoFn = applyMove inverso con force: true); confronto `index.jsx:292-301`
- Stato: CONFERMATO (probe test_panel_undo_of_hand_over_is_not_the_original: Manicure(op1)+Gel(op2), «Passa a op2» poi undo del pannello → entrambi a op1, forced=True)
- Difetto: non passa da POST /undo: marca forced, from_operator sbagliato su visite divise, l'evento trattenuto viene aggiornato invece che soppresso (alla cliente parte «spostato» all'orario di sempre), voce in più nella pila.
- Correzione: undoFn → POST /api/agenda/undo (come la griglia) e poi setAppt fresco.

### [MEDIO] 13-07 «Sposta qui» e l'ombra usano la copia dell'appuntamento di quando si è aperto il pannello: dopo «Passa a»/± mandano l'operatrice di partenza sbagliata
- File: `index.jsx:362-366` (openAppt = modal.props.appointment), `367-376`, `824-829`
- Stato: CONFERMATO (probe test_sposta_qui_with_stale_from_operator: dopo op1→op2, «Sposta qui» da Carla con from=op1 → 200 ma resta a op2)
- Scenario: Maria passa a Bea dal pannello; a giovedì clic nello slot libero di Carla → avviso «Spostato a Carla», in realtà resta a Bea (se occupata, forzata sopra la sua cliente). Ombra e sottotitolo mostrano ora/colonna vecchie.
- Correzione: aggiornare le props del modale con la risposta o rileggere l'appuntamento prima di calcolare fromOp/fromMin.

### [MEDIO] 13-08 Con il drawer «Nuova prenotazione» aperto, un clic in vista settimana (o su un blocco esistente) lo sostituisce: cliente, servizi e nota persi
- File: `index.jsx:190-194, 673` (WeekView onNewAppt → openModal nuovo), `728` (onOpenAppt senza guardia), `699-704/733-736` (scelta orario solo in vista giorno); `WeekView.jsx:331-360`; `DayGrid.jsx:397`
- Stato: CONFERMATO (percorso ripercorso: ogni openModal ha id nuovo e rimonta)
- Scenario: al telefono scelgo cliente, due servizi e nota, passo alla settimana e clicco mercoledì 11:00 → drawer vuoto.
- Correzione: con modal 'newappt' aperto, in settimana chiamare setAgendaPick; non aprire il dettaglio al clic su un blocco.

### [MEDIO] 13-09 Nel drawer il servizio risulta «Regalo» (prezzo barrato) anche con carte scadute o intestate a un'altra persona: in cassa il regalo non c'è
- File: `NewApptModal.jsx:40-49` (filtro locale), `409-414`; backend `apps/agenda/api.py:125-160` (gift_index esclude scadute, saldo 0, recipient_name scritto)
- Stato: CONFERMATO (confronto dei filtri; /marketing/gift-cards?status=active include scadute)
- Scenario: Maria ha regalato una manicure a «Giulia» (nome a mano) o ha una carta scaduta; prenotando per Maria il drawer dice «Regalo · Maria», in cassa niente precompilato o carta rifiutata. Fix backend del 18/09 non riportato qui.
- Correzione: stessa regola di gift_index (recipient_name vuoto, balance > 0, non scaduta) o endpoint che la riusi.

### [MEDIO] 13-10 Esc nella ricerca cliente chiude tutto il drawer (nuova prenotazione o gruppo)
- File: `ClientPicker.jsx:104-115` (Esc senza preventDefault; mini-form senza gestore); `NewApptModal.jsx:92-96`, `GroupBookingDrawer.jsx:36-44`
- Stato: CONFERMATO (l'evento sale a window con defaultPrevented false)
- Scenario: quattro righe di gruppo compilate, nella quinta Esc per chiudere la tendina → drawer chiuso, righe perse.
- Correzione: e.preventDefault() su Esc con tendina aperta o nel mini-form.

### [MEDIO] 13-11 Gli orari del drawer non seguono le altre postazioni: uno slot preso nel frattempo resta «libero» e il 409 fa forzare sopra l'altra cliente
- File: `NewApptModal.jsx:99-135` (dayRows/availability mai ricaricati), `229-237` (409 → create(true))
- Stato: PLAUSIBILE (dipende dalla finestra fra apertura e «Crea»)
- Scenario: A tiene selezionate le 10:00 di Anna per due minuti al telefono, B prenota Laura alle 10:00; A crea → Maria sopra Laura, senza che nessuno l'abbia deciso. (La riprova con force è voluta; il difetto sono i dati non freschi.)
- Correzione: ricaricare disponibilità/giornata sugli eventi live; se l'orario era fra i liberi, al 409 ricaricare invece di forzare.

### [MEDIO] 13-12 Orario «non fra gli slot»: si forza già al primo tentativo e i servizi su «Prima disponibile» vanno alla prima operatrice in ordine anche se occupata
- File: `NewApptModal.jsx:119-131, 243-252, 208-214`; backend `apps/agenda/services.py:586-589` (force senza operatrice → prima abilitata senza verificare chi è libera)
- Stato: CONFERMATO (probe test_forced_create_first_available_takes_busy_operator: op1 occupata, op2 libera → assegnata a op1)
- Scenario: taglio su Anna (incastro voluto) + colore «Prima disponibile»: colore su Bea occupata invece che su Carla libera; orario a mano fuori griglia (10:10) libero → segnato «Forzato».
- Correzione: provare prima senza force; nel backend preferire un'abilitata libera anche con force (come resolve_items_edit).

### [BASSO] 13-13 Salvataggio servizi (e resize in griglia) → 400 se l'operatrice di una riga esistente non è più abilitata o è disattivata; la riga non mostra chi la ha
- File: `ApptDetailModal.jsx:370-381, 901-924`; `index.jsx:483-490`; backend `services.py:711-718`
- Stato: CONFERMATO (probe test_put_items_fails_when_existing_operator_lost_skill: 400; senza operator_id il server riassegna la riga)
- Correzione: accettare l'operatrice già assegnata sulle righe esistenti; mostrarla nel pannello.

### [BASSO] 13-14 Orari nel fuso del dispositivo: scadenza caparra nel pannello e date del feed
- File: `ApptDetailModal.jsx:708` (toLocaleString senza timeZone); `shell/Topbar.jsx:138`
- Stato: CONFERMATO (lettura)
- Correzione: salonTzOpts / fmtTime + fmtDateIt.

### [BASSO] 13-15 Anteprime no-show/annullamento con deposit_amount invece di deposit_credit
- File: `lib.js:220, 226, 238-241`
- Stato: CONFERMATO (lettura) — con rimborso parziale 10/30 mostra €30 invece di €20.

### [BASSO] 13-16 «Nuovo cliente» dal pulsante diviso apre la prenotazione su oggi, non sul giorno guardato
- File: `sections/clienti/modals/NewClientModal.jsx:89-91` (prefill senza agendaDate)
- Stato: CONFERMATO

### [BASSO] 13-17 «Riprogramma»: su 409 chiede un secondo clic citando «Sposta comunque» che non esiste; disponibilità calcolata sulle durate di listino, non su quelle della visita
- File: `ApptDetailModal.jsx:993-1018, 1033-1035`
- Stato: CONFERMATO (lettura)

### [BASSO] 13-18 L'orario scelto a mano o fra le alternative torna all'orario cliccato in agenda (forzato) quando si cambiano i servizi
- File: `NewApptModal.jsx:119-131`
- Stato: CONFERMATO (lettura)

### [BASSO] 13-19 Drawer «Nuova prenotazione» e «Gruppo» non restringono l'area di lavoro: coprono le ultime colonne in modalità scelta orario; «Gruppo» col dettaglio aperto si apre nascosto dietro
- File: `NewApptModal.jsx:257-269`, `GroupBookingDrawer.jsx:92-118`, `DkPanel.jsx:27-34`, `desktop.css:27-29`, `index.jsx:639, 854-856`
- Stato: CONFERMATO (lettura del layout, stesso z-index 120)

### [BASSO] 13-20 Risposte in volo che chiudono il pannello aperto nel frattempo; X del gruppo attiva durante la creazione
- File: `ApptDetailModal.jsx:416-417, 424-435`, `NewApptModal.jsx:227-228`, `GroupBookingDrawer.jsx:109`
- Stato: PLAUSIBILE (serve un clic durante la risposta; closeModal è globale)

### [BASSO] 13-21 Importi: «€0» senza decimali (fmtMoney) e «− Gratis» nelle righe del margine
- File: `lib.js:55`; `ApptDetailModal.jsx:776, 782`
- Stato: CONFERMATO (lettura)

### [BASSO] 13-22 Ricerca cliente: accenti/apostrofo tipografico non trovano; Invio prima della risposta apre «Nuovo cliente»; errore di rete = «Nessun cliente trovato»
- File: backend `apps/clients/api.py:131-156`; `ClientPicker.jsx:59, 110-113`
- Stato: CONFERMATO (lettura; icontains su PostgreSQL sensibile agli accenti)

### [BASSO] 13-23 Nota di una visita chiusa (o senza permesso agenda) modificabile ma non salvabile; il testo rimanda a un pulsante che non c'è
- File: `ApptDetailModal.jsx:755-762, 522`
- Stato: CONFERMATO (lettura)

### [BASSO] 13-24 «Mostra margine» resta quello di prima del salvataggio dei servizi
- File: `ApptDetailModal.jsx:209-215`
- Stato: CONFERMATO (lettura)

### [BASSO] 13-25 «Copia link caparra» nell'avviso: la conferma «Link copiato» non compare mai e la copia non è verificata
- File: `NewApptModal.jsx:218-226`; `packages/shared/src/ui/useToastHost.js:16-20` (onUndo esegue undoFn e poi setToast(null))
- Stato: CONFERMATO (lettura)

Aree controllate senza reperti: rimontaggio per modal.id (niente stato di A dentro B); debounce e risposte fuori ordine in ClientPicker; doppio invio in NewAppt/ClientPicker/Gruppo/applyMove/saveChanges; riprova con force solo su 409 (nel backend i 409 di create/move/PUT/split/restore sono solo disponibilità/chiusura, il 400 di idoneità non viene forzato); servizio aggiunto alla stessa operatrice della visita; payload di applyMove (isoAtMin, operatrice solo se cambia); fuso in ogni orario inviato; link caparra nella risposta di creazione; precompilazione cassa con deposit_credit; DkPanel e body.dk-with-panel; agendaPick con nonce; tasti N/⌘Z con modale aperto; gruppo che non si interrompe su una riga fallita; correzioni I1, I2, I3, I5, I7, I8, I9 del 18/09 presenti.
