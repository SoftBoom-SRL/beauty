# Revisore 01 — motore di disponibilità (1 alto, 6 medi, 7 bassi)

Probe in `backend/apps/agenda/tests_probe_disponibilita.py` (NON cancellato, su richiesta dell'orchestratore).

### [ALTO] 01-01 Forzando con «Prima disponibile» la visita va alla prima operatrice idonea anche se è occupata e una collega è libera
- File: `backend/apps/agenda/services.py:586-589` (resolve_items, ramo `elif force`); confronto con `resolve_items_edit` 725-738, che invece prova prima le libere; `frontend/apps/dashboard/src/sections/agenda/modals/NewApptModal.jsx:119-129, 230-235, 243-249`
- Stato: CONFERMATO (probe ForceFirstEligibleProbe: Giulia occupata 10-11, Marta libera, create force 10:10 → Giulia)
- Difetto: con force e operator_id null non si guarda la libertà: `next(op for op in operators if idonea)`.
- Scenario: nuova prenotazione con «Prima disponibile» e orario a mano (o cella cliccata di chi non fa il servizio, o qualunque 409 che la dashboard riprova da sola con force) → doppia prenotazione su Giulia mentre Marta è libera, senza avvisi.
- Correzione: anche forzando, scegliere prima un'idonea libera e ripiegare sulla prima idonea solo se nessuna lo è (come resolve_items_edit).

### [MEDIO] 01-02 Stessa cliente + «Prima disponibile»: il servizio finisce sull'operatrice già impegnata con lei, mentre la ricerca proponeva la collega libera
- File: `backend/apps/agenda/services.py:140-141` (_busy_map ignore_client_id), 590-602, 1045-1048; `api.py:565`; `NewApptModal.jsx:139-143, 397/406` («farà Marta»)
- Stato: CONFERMATO (probe SameClientAutoAssignProbe: slot 10:00 assignment Marta, creato su Giulia, forced=False)
- Difetto: con client_overlap_ok la mappa degli occupati ignora TUTTI gli appuntamenti della cliente anche nell'assegnazione automatica; get_free_slots invece no. Quello che la ricerca propone non è quello che la conferma scrive.
- Scenario: Anna ha manicure con Giulia alle 10; si aggiunge pedicure alle 10 «Prima disponibile»: la bozza dice «farà Marta», l'appuntamento nasce su Giulia sovrapposto. Aggravante: il cliente segnaposto Yourang senza telefono (phone="") è condiviso da persone diverse.
- Correzione: in auto-assegnazione cercare prima con la mappa completa e ignorare la stessa cliente solo come ripiego (o solo con operatrice indicata).

### [MEDIO] 01-03 Il ripiego «cerca fra le altre idonee» (correzione A13) propone orari che la conferma rifiuta
- File: `backend/apps/agenda/services.py:278-288` (get_free_slots) vs 577-580 (resolve_items → 400) e 1259-1279/782-790 (move tiene l'operatrice originale); `api.py:1127-1139`; `staff/api.py:453-480` (operatrici pubbliche di tutte le sedi); `client-app/src/screens/Sposta.jsx:88-100`
- Stato: CONFERMATO (probe OtherLocationOperatorProbe: 37 slot, POST → 400 «Operatrice non idonea»; InactiveOperatorMoveProbe: slot pomeridiani con Marta → 409; slot mattutino → spostato ma resta su Giulia disattivata)
- Difetto: con operatrice richiesta fuori organico/sede la ricerca assegna altre operatrici, ma né la creazione né lo spostamento cliente usano l'assegnazione proposta.
- Scenario: salone a due sedi, la cliente sceglie una stilista dell'altra sede → vede orari, ogni conferma 400. Operatrice disattivata: «Sposta» dall'app → «Questo orario è appena stato preso» a ripetizione, oppure la visita resta sulla collega che non c'è più.
- Correzione: o niente ripiego nella ricerca, o far applicare l'assegnazione proposta a create/move (move cliente con riassegnazione delle voci di operatrici non attive/fuori sede).

### [MEDIO] 01-04 «Consigliati» (agenda_fill=max_revenue, default) ignora la posa: nasconde l'orario perfetto e consiglia quello che lascia un buco morto
- File: `backend/apps/agenda/services.py:370-378` (_gap_edges usa solo gli intervalli hard), 318-340 (segmenti senza la posa della catena), 381-421, 424-432 (smart_slots)
- Stato: CONFERMATO (probe RecommendedSoak15Probe: posa altrui fino alle 9:45 → 9:45 non consigliato, 10:00 consigliato con 15' morti; OwnPosaProbe: colore la cui posa arriva esatta alla cliente dopo → non consigliato, 9:45 con 15' morti consigliato; catena colore(posa 20)+taglio: 0 consigliati → filtro spento)
- Difetto: la posa (che la disponibilità automatica non vende mai) viene contata come spazio libero nel calcolo dei buchi.
- Scenario: salone di parrucchiere in modalità ottimizzata: l'app cliente non mostra gli orari attaccati alla fine di una posa e propone quelli che frammentano; per colore+piega nessun orario è consigliato e si mostrano tutti.
- Correzione: in _gap_edges/_slot_is_recommended trattare come occupati anche gli intervalli di posa (altrui e della catena).

### [MEDIO] 01-05 «Riprogramma» dello staff cerca con il listino di oggi e contando la visita stessa come occupata
- File: `backend/apps/agenda/api.py:961-970` (niente exclude_appointment_id/keep_service_ids), 81-100 (_parse_items_param scarta durate e posa); `ApptDetailModal.jsx:998, 1004-1016`
- Stato: CONFERMATO (probe StaffRescheduleProbe: 10:00/10:30 non proposti, 12:00 proposto → move 409; StaffRescheduleRetiredServiceProbe: 404 «Servizio non più disponibile» mentre lo spostamento passa)
- Difetto: l'endpoint staff non supporta ciò che l'endpoint cliente fa (snapshot durate/posa/buco, esclusione della visita, servizi ritirati).
- Scenario: spostare di mezz'ora una visita allungata a 90': l'orario non compare; se ne sceglie uno proposto → 409 → «puoi forzare» → sovrapposizione reale con la cliente dopo.
- Correzione: `exclude_appointment_id` anche sull'endpoint staff, con piano costruito dallo snapshot come in client_availability.

### [MEDIO] 01-06 Le visite di un'operatrice disattivata non si riassegnano: trascinamento e «Passa a» → 404, modifica → 400
- File: `backend/apps/agenda/api.py:583-584` (from_operator con active=True); `index.jsx:285`, `WeekView.jsx:295`, `ApptDetailModal.jsx:179`; `services.py:714-718` + 171 (resolve_items_edit vede solo attive)
- Stato: CONFERMATO (probe InactiveOperatorStaffProbe: move con from_operator_id → 404, senza → 200; PUT con voce sull'inattiva → 400 anche forzando)
- Difetto: la colonna «inattiva» esiste per riassegnare, ma la dashboard manda sempre from_operator_id = colonna di partenza, che l'API cerca fra le attive.
- Scenario: l'operatrice lascia il salone; trascinando i suoi appuntamenti su una collega il blocco torna indietro con «Not Found»; allungarli dà «Operatrice non idonea».
- Correzione: cercare from_operator senza filtro active; in resolve_items_edit ammettere l'operatrice già sulla voce anche se disattivata (come keep_service_ids).

### [MEDIO] 01-07 Caparra chiesta su un trattamento già pagato con gift card
- File: `backend/apps/agenda/services.py:1050-1051`, 458-489 (compute_deposit sul totale pieno); `client-app/src/screens/Prenota.jsx:696-706`
- Stato: CONFERMATO (probe DepositOnGiftedServiceProbe: taglio regalato, regola «Prima visita» 30% → caparra 9,00 required, e la risposta elenca la gift che lo copre)
- Difetto: il totale per la caparra include i servizi coperti da gift card attive e pagate.
- Scenario: la destinataria di un regalo (tipicamente nuova → regola «Prima visita») prenota: l'app dice «In salone non pagherai questa parte» e poi chiede la caparra; con la scadenza caparra attiva, se non paga il posto si libera da solo.
- Correzione: calcolare la caparra sul totale al netto dei servizi coperti dalle gift «a trattamento» della cliente.

### [BASSO] 01-08 La posa può finire nella chiusura di pranzo (orari spezzati) e, senza orari configurati, oltre il turno
- File: `backend/apps/agenda/services.py:312-313` (closing = max), 497-513 (`if not bounds: return`)
- Stato: CONFERMATO (probe LunchClosureProbe: orari 9-13/15-19, colore 30'+60' alle 12:30 proposto e creato, fine 14:00)
- Scenario: la cliente resta col colore in testa a serranda abbassata fra le 13 e le 15.
- Correzione: la fine della catena deve stare nella fascia di apertura in cui comincia (o fino all'ultimo turno se orari non configurati).

### [BASSO] 01-09 Prenotazioni importate da Yourang non si allungano né si riassegnano (segnaposto senza operatrici idonee)
- File: `backend/apps/integrations/sync.py:322-340`; `services.py:714-718`, 1262-1264
- Stato: CONFERMATO (probe YourangPlaceholderProbe: PUT durata 400 anche forzando, riassegnazione 400; solo la nota passa)
- Scenario: una prenotazione arrivata da Yourang non si può allungare trascinando il bordo: «Operatrice non idonea per il servizio selezionato».
- Correzione: esentare il servizio segnaposto dal controllo di idoneità (o renderlo idoneo per tutte).

### [BASSO] 01-10 Spostamento dall'app impossibile se l'operatrice della visita ha perso quel servizio fra le competenze
- File: `backend/apps/agenda/services.py:278-280, 289-290` vs move 1259-1279 (nessun controllo)
- Stato: CONFERMATO (probe NotEligibleAnymoreProbe: disponibilità 0 slot, move diretto 200)
- Scenario: il titolare toglie «Colore» a una junior: le sue clienti con colore già fissato non trovano più un orario in nessun giorno.
- Correzione: per le voci esistenti della visita spostata non richiedere l'idoneità attuale (come fa lo spostamento).

### [BASSO] 01-11 La conferma dall'app è più larga della ricerca: con operatrice scelta (e in ogni spostamento) si entra nella posa altrui
- File: `backend/apps/agenda/services.py:575` (allow_soak = requested is not None, anche per l'app), 786-789 (_validate_segments sempre allow_soak=True, usato da client move); `api.py:1114-1122, 1138`
- Stato: CONFERMATO (probe ClientIntoSoakProbe: 10:30 non proposto, POST app con operator_id → 200, senza → 409)
- Scenario: corsa fra la lista caricata e una prenotazione dello staff, o richiesta diretta: la cliente finisce nella posa di un'altra, cosa che il codice riserva allo staff. (Stesso canale: orari fuori griglia o non consigliati accettati.)
- Correzione: dall'app (via=app / allow_past=False) validare sempre con allow_soak=False.

### [BASSO] 01-12 Il PUT non conosce client_overlap_ok: allungare un servizio sovrapposto alla stessa cliente marca la visita «forzata»
- File: `backend/apps/agenda/services.py:664`, 1140-1151
- Stato: CONFERMATO (probe EditSameClientProbe: 409 poi forced=True)
- Correzione: passare ignore_client_id anche in resolve_items_edit dai gesti dello staff.

### [BASSO] 01-13 Regole caparra per etichetta legate al NOME: rinominare l'etichetta spegne la regola in silenzio
- File: `backend/apps/clients/services.py:59-61`; `common/conditions.py:22-26`; `impostazioni/lib.jsx:167`; `clients/api.py:79-94`
- Stato: CONFERMATO (probe CategoryRenameProbe: caparra 10,00 → 0,00 dopo il rename)
- Correzione: condizioni per id di etichetta, o aggiornare le regole al rename.

### [BASSO] 01-14 `duration_min` senza tetto nel PUT: un refuso passa forzando da solo e blocca il giorno dopo
- File: `backend/apps/agenda/schemas.py:46`; `services.py:691-695`, 1147-1151
- Stato: CONFERMATO (probe HugeDurationProbe: 6000' → 409 → forzato 200, fine 4 giorni dopo, 0 slot il giorno seguente)
- Correzione: `Field(None, ge=1, le=24*60)` come per posa e listino.

Aree controllate senza reperti: ora legale 2026-10-25 e 2027-03-28 (slot diurni con offset giusti, ora inesistente scartata, aritmetica a minuti di parete coerente con isoAtMin del frontend; resta imprecisa solo di notte); coda dopo mezzanotte di appuntamenti e pause; _within_windows/fusione turni/pause pranzo/_week_index (coerente col frontend); assenze intere e giorni di chiusura; step validato 15/20/30 e allineamento griglia; completezza del greedy sequenziale; isolamento multi-salone (servizi, operatrici, exclude_appointment_id); annullati/no-show/auto_released liberano lo slot; lock_salon/_lock_and_reload su create/move/PUT/split/restore; compute_deposit (priorità, deposit_always, tetto al totale, regole malformate ignorate; arrotondamento half-even solo stilistico); resolve_items_edit con voci aggiunte/tolte/riordinate (prezzo e posa concordati mantenuti); client_overlap_ok non apre sovrapposizioni fra clienti diverse sui percorsi con operatrice indicata.
