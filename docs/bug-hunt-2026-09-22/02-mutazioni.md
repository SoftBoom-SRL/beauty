# Revisore 02 — ciclo di vita dell'appuntamento (formato breve, interrotto su richiesta dell'orchestratore)

Probe: `backend/apps/agenda/tests_probe_02_mutazioni.py` (lasciato su disco come richiesto; ogni test asserisce il comportamento corretto e FALLISCE).

### [ALTO] 02-01 Riducendo la caparra alla nuova visita si perde quanto la cliente ha versato
- File: `backend/apps/agenda/services.py:1181` (`shrink_deposit_to_total`, chiamata a 1158 e 1383), `models.py:143` (`deposit_credit`), `services.py:1706-1728`, `sales/api.py:186,215`
- Stato: CONFERMATO (P03ShrinkThenStripeRefund, 2 test)
- Difetto: con caparra PAGATA, lo stacco/modifica riscrive `deposit_amount` (= importo versato) col nuovo totale. Il checkout non vede più l'eccedenza (settle_deposit_excess riceve 0, mentre `finalize_sale` ormai detrae solo fino al totale e la rimborserebbe da sé); se lo staff rimborsa su Stripe l'eccedenza come dice il registro, `deposit_credit = amount − rimborsato` la sottrae una seconda volta.
- Scenario: visita 80, caparra 70 pagata; si stacca il servizio da 50 → caparra 30, «40 da rimborsare». Rimborso 40 su Stripe → credito 0, al checkout la cliente ripaga 30. Senza rimborso manuale i 40 restano al salone senza traccia.
- Correzione: non toccare `deposit_amount`; lasciare al checkout la detrazione fino al totale e il rimborso dell'eccedenza.

### [ALTO] 02-02 Staccare un servizio fa slittare gli altri della visita (l'anteprima dice di no) e col 409→force li mette sopra un'altra cliente
- File: `backend/apps/agenda/services.py:1372-1426` (`split_appointment`); `frontend/apps/dashboard/src/sections/agenda/DayGrid.jsx:458`, `index.jsx:351`
- Stato: CONFERMATO (P16SplitShiftsTheRest)
- Difetto: tolto l'item, la catena si ricompatta dall'inizio: i servizi dopo quello staccato anticipano. L'anteprima del trascinamento li mostra fermi; il 409 della catena residua fa ritentare con force.
- Scenario: 10:00 A(op1) 11:00 B(op1) 11:30 C(op2), op2 ha Anna alle 11:00. Si trascina B alle 15: C passa alle 11:00, forzato sopra Anna.
- Correzione: conservare le posizioni (sommare durata+posa dell'item tolto alla posa del precedente, o spostare lo start se era il primo).

### [ALTO] 02-03 «Torna indietro» cancella anche il messaggio di uno spostamento precedente fuso nello stesso evento
- File: `backend/apps/agenda/services.py:946-970` (`revert_held_events`), `901-934` (`emit_appointment_event`)
- Stato: CONFERMATO (P17UndoEatsEarlierMessages ×2, P07MergedEvents.test_move_cancel_undo_still_tells_the_client_about_the_move)
- Difetto: l'undo supersede tutti gli eventi trattenuti, anche quelli che portano gesti precedenti (moved fuso con resize/check-in, o moved soppresso dal cancel).
- Scenario: conferma già partita; sposta 10→15, allunga il servizio (o check-in, o annulla), ⌘Z sull'ultimo gesto: l'appuntamento resta alle 15 ma alla cliente non parte nulla, si presenta alle 10.
- Correzione: dopo il ripristino, se lo stato differisce dall'ultimo comunicato, emettere il fallback invece di sopprimere tutto.

### [ALTO] 02-04 La scadenza caparra tagliata sull'inizio non segue lo spostamento: la visita spostata viene liberata all'ora vecchia
- File: `backend/apps/agenda/services.py:1795-1823` (`schedule_deposit_hold` chiamata solo in create/restore), `1221-1301` (`move_appointment`), `1918-1966`
- Stato: CONFERMATO (P02HoldAfterMove)
- Difetto: `deposit_due_at = min(now+hold, start)`; spostando più avanti resta la scadenza = vecchio inizio.
- Scenario: hold 24 h, prenotazione per fra 2 ore (scadenza = inizio), la cliente chiede di spostare a martedì prossimo: all'ora vecchia l'appuntamento viene annullato, «posto liberato» alla cliente, slot.freed.
- Correzione: ricalcolare la scadenza nello spostamento (min(creazione+hold, nuovo inizio)).

### [MEDIO] 02-05 Riassegnare dalla colonna di un'operatrice disattivata risponde 404
- File: `backend/apps/agenda/api.py:584` (`from_operator = salon_get(..., active=True)`); chiamanti `index.jsx:285`, `WeekView.jsx:295`, `ApptDetailModal.jsx:179`
- Stato: CONFERMATO (P01InactiveColumn)
- Difetto: la colonna orfana esiste «così si possono riassegnare», ma ogni gesto manda `from_operator_id` = operatrice disattivata e il server la cerca fra le attive. Regressione successiva al 9991cb5.
- Correzione: cercare `from_operator` senza `active=True` (basta che sia del salone).

### [MEDIO] 02-06 Dopo la riduzione della caparra «richiesta» il link resta all'importo vecchio e il webhook incassa di più registrando di meno
- File: `backend/apps/agenda/services.py:1181` (link non rigenerato), `sales/api.py:631-658`, `sales/services.py:413`
- Stato: CONFERMATO (P04ShrinkWhileRequired)
- Scenario: caparra 70 richiesta con link inviato, stacco → 30; la cliente paga 70: stato «pagata», vendita-caparra 30, 40 mai registrati né restituiti.
- Correzione: chiudere/rigenerare la sessione quando cambia l'importo; nel webhook trattare l'eccedenza (rimborso o registro).

### [MEDIO] 02-07 Undo di una creazione: il link caparra resta pagabile e il pagamento di un appuntamento sparito viene ignorato
- File: `backend/apps/agenda/undo.py:240-258` (`_delete_appointment`), `sales/api.py:513-515`
- Stato: CONFERMATO (P11UndoCreateWithDepositLink ×2)
- Scenario: prenotazione con caparra (link partito subito), ⌘Z: appuntamento cancellato, sessione Stripe aperta; la cliente paga → webhook «appointment None» → return: soldi incassati, nessun rimborso né traccia.
- Correzione: `expire_deposit_checkout` prima di cancellare; nel webhook rimborsare/loggare i pagamenti senza appuntamento.

### [MEDIO] 02-08 L'undo rimette l'appuntamento sopra una cliente prenotata nel frattempo
- File: `backend/apps/agenda/undo.py:204-237,343-346`
- Stato: CONFERMATO (P22UndoOntoANewBooking)
- Scenario: sposta 10→15, l'app (o la lista d'attesa) prenota Anna alle 10, ⌘Z: due clienti con op1 alle 10, nessun avviso.
- Correzione: rivalidare lo slot nel ripristino (409 come per le righe toccate).

### [MEDIO] 02-09 No-show accettato dopo check-in, a trattamento in corso e prima dell'orario
- File: `backend/apps/agenda/services.py:1511-1521` (`_ensure_open` ammette checked_in/in_progress, nessun controllo su start); `ApptDetailModal.jsx:561-565`
- Stato: CONFERMATO (P05NoShowStates ×2)
- Scenario: cliente in poltrona (in corso) o visita di domani segnata no-show: caparra trattenuta, no-show nello storico (regole caparra future), slot.freed.
- Correzione: no-show solo da `confirmed` e con start già passato.

### [MEDIO] 02-10 Anteprima dell'annullamento dal banco: «caparra trattenuta» sotto le 24 h, ma il server la rimborsa
- File: `frontend/apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx:92,502`, `lib.js:237`; `backend/apps/agenda/services.py:1567`
- Stato: CONFERMATO (lettura dei due lati; il backend con by_client=False non trattiene mai)
- Scenario: il salone annulla a 2 ore: la timeline dice «Caparra trattenuta €X», confermato l'annullamento parte il rimborso Stripe.
- Correzione: in dashboard `late` sempre falso per l'annullamento dello staff (o far dire al server l'esito).

### [MEDIO] 02-11 Rimborso della caparra: la vendita-caparra resta nell'incasso
- File: `backend/apps/agenda/services.py:1620-1652,1762-1780`; `sales/services.py:510-520`
- Stato: CONFERMATO (P21RefundLeavesTheTill: cash_in 20 dopo il rimborso)
- Scenario: caparra 20 in contanti, il salone annulla, «rimborsata»: il riepilogo del giorno conta ancora 20 € entrati (vale anche per i rimborsi Stripe e l'eccedenza al checkout).
- Correzione: registrare il rimborso come movimento negativo (o stornare la vendita-caparra).

### [MEDIO] 02-12 slot.freed per orari già passati (ogni no-show)
- File: `backend/apps/agenda/services.py:2067-2106` (`free_slot_event`), chiamate a 1321, 1533, 1602
- Stato: CONFERMATO (P06FreedSlot.test_no_show_does_not_announce_a_past_slot)
- Scenario: no-show segnato a metà mattina: la lista d'attesa riceve la proposta di uno slot già iniziato/finito (idem annullamenti/spostamenti a posteriori).
- Correzione: non emettere se start+durata ≤ adesso (o tagliare all'adesso).

### [MEDIO] 02-13 slot.freed dello spostamento descrive male cosa si è liberato
- File: `backend/apps/agenda/services.py:1320-1321,2078-2100`
- Stato: CONFERMATO (P06FreedSlot.test_a_quarter_hour_nudge…, P19FreedSlotWrongOperator)
- Difetto: annuncia l'intera visita al vecchio orario anche per un ritocco di 15' (ancora occupato); dopo un cambio di colonna (from_operator) indica l'operatrice principale e non quella liberata, e i match usano le operatrici NUOVE.
- Correzione: annunciare solo la parte davvero liberata, per l'operatrice di partenza.

### [MEDIO] 02-14 Fusione eventi: il messaggio di spostamento porta l'orario intermedio o perde `old_start`
- File: `backend/apps/agenda/services.py:926-933` (`keep.payload = payload`)
- Stato: CONFERMATO (P07MergedEvents.test_two_moves…, test_move_then_resize…)
- Scenario: conferma partita; 10→11→12 entro il ritardo: «spostato dalle 11 alle 12» (la cliente sapeva le 10). Sposta e poi allunga: l'evento moved resta senza `old_start`.
- Correzione: nella fusione conservare l'`old_start` del primo spostamento trattenuto.

### [BASSO] 02-15 Spostamento dall'app con operatrice disattivata: orario proposto e poi rifiutato (409)
- File: `backend/apps/agenda/api.py:1138`, `services.py:1259-1279` (non riassegna), `get_free_slots:281-286`
- Stato: CONFERMATO (P12ClientMoveInactiveOperator). Correzione di A13 incompleta: la disponibilità propone altre operatrici, lo spostamento tiene quella uscita.

### [BASSO] 02-16 Sollecito caparra immediato per le prenotazioni a ridosso
- File: `backend/apps/agenda/services.py:1968`
- Stato: CONFERMATO (P15ImmediateReminder). Con scadenza tagliata sull'inizio `remind_at = due − (hold − reminder)` cade nel passato: link e sollecito insieme.

### [BASSO] 02-17 Rilascio automatico mentre uno spostamento è trattenuto: «posto liberato» e poi «spostato»
- File: `backend/apps/agenda/services.py:1913` (emit_event diretto, nessuna fusione)
- Stato: CONFERMATO (P20ReleaseWhileMoveHeld)

### [BASSO] 02-18 GET /agenda/released senza require_scope("agenda")
- File: `backend/apps/agenda/api.py:611`
- Stato: CONFERMATO (P13ReleasedScope: ruolo solo «inventory» → 200 con nomi e telefoni)

### [BASSO] 02-19 Check-in accettato da «in corso»: lo stato torna indietro e l'evento riparte
- File: `backend/apps/agenda/services.py:1462-1466`
- Stato: CONFERMATO (P24CheckInBackwards)

### [BASSO] 02-20 Modifica (PUT) accanto alla stessa cliente: la visita diventa «forzata»
- File: `backend/apps/agenda/services.py:664` (resolve_items_edit senza ignore_client_id), `1140-1151`
- Stato: CONFERMATO (P23EditSameClientOverlap)

### [BASSO] 02-21 Rimborso parziale «pending»: tutta la caparra diventa «rimborso in corso», credito 0
- File: `backend/apps/agenda/services.py:1713-1714`
- Stato: CONFERMATO (P25PartialPendingRefund)

### [BASSO] 02-22 Undo del no-show accettato dopo l'addebito no-show
- File: `backend/apps/agenda/undo.py:300-306,343-346`
- Stato: CONFERMATO (P10UndoNoShowAfterCharge) ma oggi l'endpoint charge-no-show non ha un pulsante in dashboard: cliente addebitata, appuntamento confermato con Sale → checkout «già incassato».

### [BASSO] 02-23 `_lock_and_reload` rilegge senza lock di riga: webhook caparra e rilascio automatico (select_for_update di riga) non si escludono con lock_salon
- File: `backend/apps/agenda/services.py:805-820`, `sales/api.py:587`, `services.py:1952`
- Stato: PLAUSIBILE (finestra di pochi ms): annullamento che riscrive «richiesta» sopra un pagamento appena registrato; spostamento dopo il rilascio.

### [BASSO] 02-24 Riprogramma dal pannello: disponibilità senza escludere la visita e con le durate di listino
- File: `backend/apps/agenda/api.py:961-970`, `ApptDetailModal.jsx:992-998`
- Stato: PLAUSIBILE (lettura): orari proposti che poi danno 409 → «Sposta comunque» forzato.

### [BASSO] 02-25 Fuso del dispositivo: scadenza caparra nel pannello e giorno nella classifica lista d'attesa
- File: `ApptDetailModal.jsx:708` (toLocaleString senza timeZone), `agenda/lib.js:164` (`getDay()` su ISO)
- Stato: CONFERMATO (lettura)

Aree controllate senza reperti: update_fields di tutte le mutazioni, _lock_and_reload in edit/move/split/check-in/start/no-show/cancel/cash, annullare un appuntamento chiuso, spostare/ripristinare un auto_released (bloccati), doppio ripristino, record_deposit_refund con lock, mark_deposit_cashed + pagamento online (duplicato rimborsato), fuso nelle scadenze backend, isolamento fra saloni negli endpoint del perimetro.
