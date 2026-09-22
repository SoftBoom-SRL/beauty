# 04 — API dell'agenda (api.py, schemas.py, models.py, admin.py)

5 medi, 6 bassi. Nessun critico o alto: niente accessi fra saloni né fra clienti dello stesso salone.
Tutti i reperti sono confermati da probe (`backend/apps/agenda/tests_probe_04_agenda_api.py`, NON cancellato su richiesta dell'orchestratore).

### [MEDIO] 04-01 Riassegnare gli appuntamenti di un'operatrice disattivata risponde 404: `from_operator_id` deve essere attiva
- File: `backend/apps/agenda/api.py:583-584` (`salon_get(Operator, ctx, data.from_operator_id, active=True)`); frontend `dashboard/src/sections/agenda/index.jsx:275-285`, `DayGrid.jsx:438`, `WeekView.jsx:295`, `modals/ApptDetailModal.jsx:176-179`
- Stato: CONFERMATO (probe `test_move_reassign_from_inactive_operator`: stessa richiesta 404 con `from_operator_id`, 200 senza)
- Difetto: da 0f7d39a tutti i gesti di riassegnazione mandano `from_operator_id`, cioè la colonna di PARTENZA. Il backend la carica con `active=True`, come la destinazione. Ma la vista giorno mostra apposta la colonna di un'operatrice disattivata «finché ha qualcosa dentro, così si possono riassegnare» (api.py:321-324), e la settimana ha la colonna «Non più in team». Da lì la partenza è per forza un'operatrice inattiva: `get_object_or_404` risponde 404 «Not Found». Prima di 0f7d39a la richiesta portava solo `operator_id` e funzionava.
- Scenario: Laura lascia il salone e viene disattivata. Ha ancora appuntamenti di un solo servizio nei prossimi giorni. La reception trascina il blocco dalla colonna di Laura a quella di Giulia (griglia giorno o settimana), oppure cambia operatrice dal pannello di dettaglio (applyMove manda `from_operator_id: base.operator_id`). In tutti e tre i casi compare il toast «Not Found» e il blocco torna dov'era. Resta solo la strada del pannello, cambiando l'operatrice riga per riga e salvando.
- Correzione: caricare la colonna di partenza senza `active=True` (basta `salon_get(Operator, ctx, data.from_operator_id)`). Solo la destinazione deve essere attiva.

### [MEDIO] 04-02 Vista giorno: il servizio di un'operatrice disattivata che non è la principale della visita non ha colonna e sparisce dalla griglia
- File: `backend/apps/agenda/api.py:321-339` (`orphan_ids` preso solo da `appointments_by_operator` e `pauses_by_operator`); frontend `DayGrid.jsx:662` (ogni blocco-servizio si disegna solo nella colonna di `item.operator_id`)
- Stato: CONFERMATO (probe `test_day_secondary_item_of_inactive_operator`: visita con op1+op3, op3 disattivata → colonne [op1, op2], nessuna per op3)
- Difetto: le colonne «orfane» si aggiungono solo per l'operatrice PRINCIPALE degli appuntamenti e per chi ha pause. Ogni appuntamento compare una volta, nella riga della principale, ma i suoi servizi si disegnano nella colonna di chi li esegue. Se il secondo servizio è di un'operatrice disattivata (o, col filtro sede, di un'operatrice di un'altra sede), quella colonna non esiste e il blocco non viene disegnato da nessuna parte. La settimana invece lo mostra, perché disegna la visita intera.
- Scenario: visita di Sofia alle 10: piega con Giulia, poi colore con Laura, che nel frattempo è stata disattivata. In vista giorno si vede solo la piega. Il colore delle 11 non c'è, nessuno lo riassegna e la cliente si presenta per un trattamento che in agenda non esiste. È esattamente il caso che il blocco orfani voleva evitare.
- Correzione: raccogliere gli id orfani anche da `item.operator_id` di ogni appuntamento del giorno (gli items sono già prefetchati) e aggiungere quelle colonne con `inactive` calcolato.

### [MEDIO] 04-03 App cliente: per spostare una visita di un'operatrice uscita la ricerca propone gli orari di un'altra, la conferma valida sulla vecchia
- File: `backend/apps/agenda/api.py:1039-1077` e `1128-1139`; `services.py:281-286` (ripiego «fra le altre idonee») contro `services.move_appointment` / `_validate_segments` (servizi lasciati alle operatrici scritte sulla visita)
- Stato: CONFERMATO (probe `test_client_move_when_operator_left`: slot 15:00 proposto con `assignment` sulla nuova operatrice, POST move 15:00 → 409; move 11:00 → 200 con la visita ancora sull'operatrice disattivata)
- Difetto: `client_availability` con `exclude_appointment_id` costruisce il piano dalle operatrici della visita. Quando l'operatrice non è più in organico, `get_free_slots` cerca apposta fra le altre idonee. `client_move_appointment` però chiama `move_appointment` senza operatrice: i servizi restano a quella disattivata e la validazione usa i SUOI turni (rimasti a database) e la SUA agenda. Viola l'invariante documentata «quello che la ricerca propone, la conferma deve accettarlo».
- Scenario: Laura è disattivata ma le sono rimasti i turni del mattino. La cliente apre «Sposta» e vede anche il pomeriggio, perché è libera Marta. Sceglie le 15: risposta 409, «Questo orario è appena stato preso», la lista si ricarica con le stesse 15, e il giro si ripete. Se sceglie un orario del mattino lo spostamento riesce, ma la visita resta assegnata a Laura, che non lavora più lì. La cliente riceve la conferma e nessuna operatrice attiva ha l'appuntamento in colonna.
- Correzione: nello spostamento dall'app, riassegnare le voci la cui operatrice non è più prenotabile (inattiva o fuori sede) con la stessa scelta greedy della ricerca, oppure accettare l'`assignment` dello slot. In alternativa, niente ripiego nella ricerca.

### [MEDIO] 04-04 App cliente, salone con più sedi: la stilista di un'altra sede non è prenotabile, ma la ricerca propone orari (di un'altra) e la conferma risponde 400
- File: `backend/apps/agenda/services.py:278-288` (ramo `elif requested:` usato anche per le prenotazioni nuove); `api.py:1039-1077`, `1086-1105`, `1109-1124`; `backend/apps/staff/api.py:455-480` (`public_operators` elenca le operatrici di tutte le sedi); `client-app/src/screens/Prenota.jsx:84`
- Stato: CONFERMATO (probe `test_client_availability_other_location_stylist`: 31 slot con `assignment` su op1 per una stilista di «Nord», POST → 400 «Operatrice non idonea per il servizio selezionato»)
- Difetto: l'app prenota sempre sulla sede predefinita, ma la scelta della stilista mostra le operatrici attive di tutte le sedi. Se la cliente sceglie una stilista che non è in `_operators_qs(salon, sede predefinita)`, `get_free_slots` non restituisce `[]`: ripiega in silenzio sulle altre idonee. La prenotazione manda però `operator_id` della stilista scelta, e `resolve_items` la rifiuta con un 400.
- Scenario: salone con due sedi. La cliente sceglie «Lia» (sede Nord): vede la griglia piena di orari, sceglie le 10, e a ogni conferma riceve «Operatrice non idonea per il servizio selezionato». Con quella stilista non riuscirà mai a prenotare, e non capisce perché.
- Correzione: il ripiego deve valere solo per lo spostamento (con `exclude_appointment_id`). Per una prenotazione nuova, con un'operatrice indicata fuori sede, `[]`. E/o filtrare `public_operators` sulla sede su cui prenota l'app.

### [MEDIO] 04-05 `GET /agenda/released` senza `require_scope`: nomi e telefoni delle clienti a chi non ha l'agenda
- File: `backend/apps/agenda/api.py:610-617`
- Stato: CONFERMATO (probe `test_released_requires_agenda_scope`: ruolo con solo `inventory` → `/day` 403, `/released` 200 con cliente e telefono)
- Difetto: è l'unica rotta staff dell'agenda senza controllo di scope. Restituisce `AppointmentOut` completi (nome, telefono, servizi, caparra, nota) degli appuntamenti liberati negli ultimi 90 giorni. In più fa girare `process_deposit_holds`, che scrive.
- Scenario: il titolare crea un ruolo «Magazzino» o «Contabile» senza agenda né clienti. Chi lo ha chiama `/api/agenda/released?days=90` e ottiene l'elenco delle clienti con il loro numero.
- Correzione: `require_scope(ctx, "agenda")` in testa, come nelle altre viste.

### [BASSO] 04-06 Sposta e annulla dall'app cliente rispondono con la scheda dello staff: la nota interna arriva alla cliente
- File: `backend/apps/agenda/api.py:1139`, `1148` (e `1124`): `_appointment_out` invece di `_client_appointment_out`
- Stato: CONFERMATO (probe `test_client_responses_do_not_leak_staff_note`: la risposta di move e cancel contiene `"note": "Cliente morosa: chiedere prima il saldo"`)
- Difetto: le rotte `/client/...` restituiscono lo schema staff `AppointmentOut`, che contiene `note`, la nota scritta dal salone («preferisce il tono più freddo…», avvisi, appunti sulla cliente), più `forced`, `created_via` e `cancel_reason`. La forma cliente `_client_appointment_out` esiste già e la nota l'ha tolta apposta.
- Scenario: la cliente sposta l'appuntamento dall'app. La risposta, visibile a chiunque apra gli strumenti del browser, riporta l'annotazione interna che lo staff ha scritto su di lei.
- Correzione: usare `_client_appointment_out` (o uno schema cliente) per create/move/cancel lato cliente. Il frontend dell'app non legge i campi staff.

### [BASSO] 04-07 Vista giorno con filtro sede: una pausa di un'operatrice di un'altra sede le apre una colonna
- File: `backend/apps/agenda/api.py:305-309` (pause non filtrate per sede) e `327-339`
- Stato: CONFERMATO (probe `test_day_location_filter_pause_of_other_location`: vista «Centro» con la colonna di «Lia Nord», `inactive: false`)
- Difetto: con `location_id` le operatrici e gli appuntamenti sono filtrati, le pause no. Una pausa di un'operatrice di un'altra sede finisce in `pauses_by_operator`, lei diventa «orfana» e compare come colonna attiva, con i suoi turni.
- Scenario: salone con due sedi. In sede Nord qualcuno aggiunge una pausa a Lia. In sede Centro compare una colonna «Lia» con finestre libere. Trascinandoci un appuntamento, lo spostamento va a buon fine (move non controlla la sede) e la visita del Centro finisce a un'operatrice che lavora altrove. Da lì in poi il PUT su quella visita risponde 400 «Operatrice non idonea».
- Correzione: con il filtro sede prendere solo le pause delle operatrici della sede (o senza sede), `Q(operator__location__isnull=True) | Q(operator__location_id=location_id)`.

### [BASSO] 04-08 App cliente: con la stilista scelta si prenota e si sposta sopra la posa di un'altra cliente
- File: `backend/apps/agenda/services.py:575` (`allow_soak = requested is not None`) e `786-789` (`_validate_segments` sempre `allow_soak=True`), raggiunti da `api.py:1114-1122` e `1138`
- Stato: CONFERMATO (probe `test_client_booking_on_other_soak`: 10:30 non proposto dalla ricerca; POST con operatrice → 200; «prima disponibile» → 409)
- Difetto: sovrapporsi alla posa altrui è documentato come «decisione dello staff, mai automatica». Ma `resolve_items` lo concede a chiunque indichi un'operatrice, e lo spostamento lo concede sempre. Le rotte cliente non distinguono: l'app manda `operator_id` appena la cliente sceglie una stilista.
- Scenario: la cliente sceglie Giulia alle 10:30. Mentre conferma, la reception mette un colore a Giulia alle 10:00, con la posa fino alle 11. La conferma passa lo stesso, mentre con «prima disponibile» sarebbe stata rifiutata. Lo stesso vale per uno spostamento su un orario vecchio o per una richiesta costruita a mano.
- Correzione: passare dal chiamante un `allow_soak` esplicito, vero solo per le rotte staff, e usarlo in `resolve_items` e `_validate_segments`.

### [BASSO] 04-09 Walk-in e appuntamenti registrati a posteriori: il link della caparra parte per una visita già cominciata
- File: `backend/apps/agenda/api.py:567` (`_maybe_deposit_link` sempre dopo la creazione staff) con `services.py:1050-1068` (caparra calcolata anche su orari passati) e `1819-1820` (nessuna scadenza se `start <= now`)
- Stato: CONFERMATO (probe `test_deposit_link_for_walk_in_now`: creazione alle ore-5 min → `deposit_status: required`, `deposit_due_at: null`, evento `deposit.payment_link` in outbox)
- Difetto: lo staff può registrare un appuntamento già iniziato (walk-in inserito all'orario corrente, o una visita passata). La regola caparra si applica lo stesso e `ensure_deposit_link` manda il link di pagamento alla cliente. Siccome l'orario è già passato, la caparra resta «richiesta» senza scadenza e il pallino in agenda non si spegne più.
- Scenario: con la regola «nuove clienti 30%», la reception inserisce alle 10:07 una cliente entrata senza appuntamento, sullo slot delle 10:00. Mentre è sulla poltrona le arriva su WhatsApp la richiesta di pagare la caparra «per confermare». Il denaro non si perde, perché al checkout la sessione viene chiusa e un eventuale pagamento tardivo si rimborsa, ma il messaggio è sbagliato.
- Correzione: niente caparra (o almeno niente link) quando `start <= now` al momento della creazione.

### [BASSO] 04-10 PUT: un servizio aggiunto senza operatrici abilitate risponde 409, e il ritentativo forzato ripete 409 «Orario non più disponibile»
- File: `backend/apps/agenda/services.py:724-740` (ramo automatico di `resolve_items_edit`); frontend `ApptDetailModal.jsx:389-395`
- Stato: CONFERMATO (probe `test_put_new_item_without_eligible_operator`: 409 senza force e 409 con force)
- Difetto: il frontend si regola sui codici: 409 vuol dire riprovare con force, 400 vuol dire idoneità. In creazione, un servizio senza operatrici abilitate dà 400 «Nessuna operatrice abilitata al servizio selezionato» (services.py:586-589). In modifica il caso finisce nel 409 di disponibilità anche con `force=True`. Il pannello di dettaglio aggiunge il servizio con `operator_id: null` quando nessuna è abilitata (ApptDetailModal.jsx:291), riprova forzando e mostra «Orario non più disponibile».
- Scenario: servizio nuovo a listino a cui non è ancora stata abilitata nessuna operatrice (o abilitate solo in un'altra sede). Lo si aggiunge alla visita e si salva. L'avviso dice che l'orario è occupato, e si cerca invano un buco libero.
- Correzione: senza operatrici idonee, 400 con lo stesso messaggio della creazione, prima di provare la libertà.

### [BASSO] 04-11 Date di calendario inesistenti, anni limite e durate senza tetto danno 500 invece di 400
- File: `backend/apps/agenda/api.py:61-65` (`parse_date` SOLLEVA `ValueError` sulle date ben formate ma inesistenti, non restituisce None), `375`, `539`; `schemas.py:46` (`ItemEditIn.duration_min` senza limiti, a differenza di `soak_min`)
- Stato: CONFERMATO (probe `test_invalid_calendar_date_is_400`: 500 su `/day?date=2026-02-30`, `/week?start=2026-13-01`, `/range?end=2026-09-31`, `/pauses?date=2026-04-31`, `/week?start=9999-12-30`, `/client/availability?date=2026-02-29`, `/public/availability?date=2027-02-29`)
- Difetto: `django.utils.dateparse.parse_date` restituisce None solo per il formato sbagliato. Per «2026-02-30» solleva `ValueError`, che nessuno cattura: 500, anche sull'endpoint pubblico senza autenticazione. Con anni al limite (9999-12-xx) `timedelta` va in `OverflowError`. `duration_min` nel PUT non ha un massimo. Il pannello non lo limita (ApptDetailModal.jsx:297-298), e dopo il 409 il ritentativo con force lo scrive lo stesso: un «600» battuto al posto di «60» diventa una visita di 10 ore. Valori enormi (>2^31, o somme oltre l'anno 9999) finiscono in un 500 (DataError su PostgreSQL / OverflowError in `appointment.end`).
- Scenario: un link o un bookmark con una data sbagliata, o uno script sull'endpoint pubblico, dà 500 e riempie i log di errori. Un refuso nella durata blocca l'agenda dell'operatrice per l'intera giornata.
- Correzione: in `_parse_day` catturare `ValueError` e limitare l'anno (es. 2000–2100) → 400. `ItemEditIn.duration_min: Field(None, ge=1, le=12*60)` come la posa.

Aree controllate senza reperti:
- **Accessi fra saloni e fra clienti.** Ogni id che arriva dal client passa da `salon_get` (appuntamento, cliente attiva, operatrice, sede, pausa, voce di lista d'attesa) oppure viene cercato dentro la visita o nello storico di chi chiama: `item_id` dello stacco, `items[].id` del PUT, `entry_id` dell'undo. Le rotte cliente filtrano sempre con `client=ctx.client`, compresa `exclude_appointment_id`. `ClientAuth` usa il salone della cliente.
- **Scope.** `require_scope("agenda")` c'è su tutte le altre rotte staff, e `sales` su caparra incassata e rimborsata.
- **App cliente.** Non può forzare né impostare `note`, `flexible` o sede; non prenota né sposta nel passato; il limite delle 24 ore vale su sposta e annulla; niente undo per i gesti della cliente.
- **Correzioni del 18/09 (B1–B13).** Verificate:
  - PUT con `_lock_and_reload` + `update_fields`;
  - prezzo e posa concordati conservati;
  - tetto di 12 voci su create, PUT e `items=`;
  - `max_length` su motivo, nota della pausa e metodo;
  - intervallo di 42 giorni;
  - validatore sui datetime senza fuso in tutti gli schemi di input;
  - `deposit.` nel feed live;
  - evento emesso dalla modifica;
  - log ed evento sull'uscita dalla lista d'attesa;
  - admin con `raw_id_fields` e `list_select_related`.
- **PUT con force.** Prova prima senza forzare, forza solo sul 409 e non forza mai l'idoneità (salvo 04-10).
- **move con `from_operator_id`** fra operatrici attive: idoneità controllata e principale aggiornata solo se cambia mano la sua colonna.
- **Viste giorno, settimana, mese e «da richiamare».** Il numero di query resta costante passando da 3 a 30 appuntamenti con servizi su due operatrici (11 / 6 / 9 / 3).
- **Fuso.** `__date` e `localtime` sono coerenti nel fuso del salone; non ci sono `date.today()` né `now` naive.
- **Forma delle risposte.** I campi nullable corrispondono agli schemi (`deposit_due_at`, `location_id`, operatrice della lista d'attesa). `deposit_credit` è esposto. `gifts[]` contiene solo carte attive, pagate, non scadute e legate ai servizi della visita.
- **Modelli.** Le lunghezze dei campi reggono i valori delle scelte; l'etichetta dell'undo è troncata a 160 caratteri e `log_activity` tronca il sommario; `makemigrations --check` non trova modifiche per l'agenda.
