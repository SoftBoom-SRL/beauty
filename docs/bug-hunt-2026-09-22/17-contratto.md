# Revisore 17 — contratto fra frontend e backend

Indagine interrotta su richiesta dell'orchestratore: formato breve. I probe restano in
`backend/apps/agenda/tests_probe_17contratto.py`, `backend/apps/sales/tests_probe_17contratto.py`,
`backend/apps/clients/tests_probe_17contratto.py` (da cancellare), più lo script `scratchpad/r17/round.mjs`.

### [MEDIO] 17-01 Riassegnare un appuntamento dalla colonna di un'operatrice disattivata risponde 404 «Not Found»
- File: `backend/apps/agenda/api.py:583-584` (`salon_get(Operator, …, data.from_operator_id, active=True)`); chiamanti `frontend/apps/dashboard/src/sections/agenda/index.jsx:275-285`, `WeekView.jsx:285-287`, `modals/ApptDetailModal.jsx:178-181`
- Stato: CONFERMATO (probe `tests_probe_17contratto.Probe17MoveFromInactive.test_drag_from_inactive_column_exact_frontend_payload`: con `from_operator_id` 404, senza 200)
- Difetto: il frontend manda sempre `from_operator_id` = colonna di partenza; se è un'operatrice disattivata (colonna «Non più in team», mostrata apposta per riassegnare) il server la cerca fra le sole attive.
- Scenario: Laura lascia il salone con appuntamenti futuri; trascinandone uno sulla colonna di Giulia (giorno o settimana) o usando «Passa a» nel pannello → toast «Not Found», il blocco torna indietro. Regressione della modifica `from_operator_id`.
- Correzione: cercare `from_operator` senza `active=True` (basta che sia del salone), oppure ometterlo quando coincide con l'operatrice principale.

### [MEDIO] 17-02 Centesimi arrotondati diversamente da cassa (float) e server (Decimal HALF_UP): vendita rifiutata
- File: `frontend/apps/dashboard/src/sections/pos/lib.js:4,45-49,97-102` (`round2`, `lineAmount`, `couponDiscount`) contro `backend/apps/sales/services.py:33-40,213` e `backend/apps/marketing/services.py:387-401`
- Stato: CONFERMATO (probe `apps.sales.tests_probe_17contratto.test_pos_global_discount_two_lines` → 422; `round.mjs`: 7% delle righe scontate e 1,75% dei coupon % differiscono di un centesimo)
- Difetto: 19,99 −50% vale 9,99 in JS e 10,00 sul server (idem 9,50/10,50/21,50 −15%). Con due righe così il dovuto del frontend è 2 centesimi sotto il totale del server: 422 «I pagamenti non corrispondono al totale»; digitare l'importo giusto è bloccato da `paymentsError` (tolleranza 0,011 sul dovuto sbagliato).
- Scenario: POS, sconto globale 50% su shampoo 19,99 e balsamo 17,99 → la vendita non si chiude in nessun modo. Con una sola riga passa ma i pagamenti registrati differiscono di 1 centesimo dal totale.
- Correzione: calcolare in centesimi interi con arrotondamento half-up come il server (o farsi dare il totale dal server prima dell'incasso).

### [MEDIO] 17-03 Cassa bloccata se la caparra supera il totale scontato, che il server ora accetta
- File: `frontend/apps/dashboard/src/sections/pos/modals/SellModal.jsx:149-153,175,310,471-473` contro `backend/apps/sales/services.py:196-202` e `backend/apps/sales/api.py` (`settle_deposit_excess`)
- Stato: CONFERMATO (probe `test_checkout_deposit_above_discounted_total`: il server risponde 200 con pagamento 0,00)
- Difetto: `dueOk = due >= 0` spegne «Incassa» con «rimuovi qualche omaggio»; il backend dal 18/09 detrae fino al totale e registra l'eccedenza da rimborsare.
- Scenario: visita 50 €, caparra pagata 30 €, coupon fedeltà 25 € o sconto 50% → dovuto −5 → impossibile chiudere il conto senza togliere lo sconto spettante.
- Correzione: con `due < 0` mandare pagamento 0 e lasciare al server detrazione e rimborso dell'eccedenza.

### [MEDIO] 17-04 Storico cliente: per chi non ha «vendite» ogni visita chiusa risulta «non incassato»
- File: `backend/apps/clients/api.py:500-512` (`can_read_sales` → `sale: None`) contro `frontend/apps/dashboard/src/sections/clienti/tabs/StoricoTab.jsx:177-178`
- Stato: CONFERMATO (probe `apps.clients.tests_probe_17contratto`: status `closed`, `sale: None`, nessun flag)
- Difetto: il server nasconde la vendita senza dirlo (manca l'equivalente di `stats_hidden`); la UI tratta `null` come non pagato.
- Scenario: ruolo di sistema «Operatrice» (agenda+clients) apre lo storico: tutte le visite «Completato · non incassato».
- Correzione: aggiungere `sales_hidden` alla risposta (o per voce) e mostrare «importo riservato» invece di «non incassato».

### [MEDIO] 17-05 «Annulla» del pannello fa uno spostamento forzato al contrario invece del torna indietro
- File: `frontend/apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx:187-196` (undoFn → `applyMove(..., { force: true })`) contro `index.jsx:293-298` (`undoLast` → `POST /api/agenda/undo`)
- Stato: CONFERMATO (probe `Probe17PanelUndo`: pannello → in coda `appointment.moved` + `slot.freed`, `forced=True`; griglia → coda vuota, `forced=False`)
- Difetto: il toast del pannello rifà la strada al contrario: il messaggio trattenuto non sparisce ma diventa «spostato» all'ora di prima, la lista d'attesa riceve uno slot liberato, la visita resta marcata forzata e nello storico annullabile entra un gesto in più.
- Scenario: dal pannello si sposta di un quarto d'ora e si preme subito «Annulla» → la cliente riceve comunque un WhatsApp di spostamento.
- Correzione: usare `POST /api/agenda/undo` anche dal pannello (come la griglia).

### [MEDIO] 17-06 «Sposta qui» alla stessa ora su un altro giorno non fa niente
- File: `frontend/apps/dashboard/src/sections/agenda/index.jsx:270-277` (`moveAppt` esce se `startMin === fromMin && !reassigned`, senza guardare la data), `:367-376`, `:823-824`
- Stato: CONFERMATO (percorso ripercorso: nessuna POST parte)
- Difetto: `moveOpenApptHere` riusa `moveAppt`, che confronta solo i minuti del giorno.
- Scenario: appuntamento martedì 10:00 aperto nel pannello, si sfoglia a giovedì (compare l'ombra alle 10:00 nella colonna della stessa operatrice), clic lì → «Sposta qui» → nessuna chiamata, il pannello si riapre invariato.
- Correzione: nel ramo «altro giorno» passare da `moveApptToDate` o includere la data nel confronto.

### [MEDIO] 17-07 Operatrice disattivata: la disponibilità propone un'altra operatrice, lo spostamento tiene quella disattivata (A13 incompleto)
- File: `backend/apps/agenda/services.py:278-291` (ripiego su altre idonee in `get_free_slots`) contro `:1259-1279` (`move_appointment` senza `operator` tiene le operatrici delle righe); `api.py` `client_move_appointment`; `ApptDetailModal.jsx` `RescheduleFlow` (`move` manda solo `start`)
- Stato: CONFERMATO (probe `Probe17ClientMoveInactive`: senza turni → 409 «orario appena preso»; turni rimasti (soft delete) → 200 ma la visita resta sull'operatrice disattivata)
- Difetto: `assignment` dello slot proposto non viene applicato allo spostamento.
- Scenario: la cliente sposta dall'app la visita con un'operatrice uscita: o riceve 409 all'infinito, o la visita finisce sulla colonna «Non più in team» (e per 17-01 non si riesce più a riassegnarla trascinando).
- Correzione: nello spostamento cliente/Riprogramma riassegnare le righe dell'operatrice non attiva secondo l'assegnazione calcolata.

### [BASSO] 17-08 Viste settimana e mese non si aggiornano su `deposit.*` (M1 corretto solo nella vista giorno)
- File: `frontend/apps/dashboard/src/sections/agenda/WeekView.jsx:57-59`, `MonthView.jsx:52` (regex senza `deposit`)
- Stato: CONFERMATO (lettura)
- Scenario: la cliente paga la caparra online: in settimana/mese resta il pallino «caparra da versare» finché non arriva un altro evento.
- Correzione: aggiungere `deposit` (e `sale`) alle regex live.

### [BASSO] 17-09 Nuova prenotazione: «Regalo» con regole diverse da `gifts[]` del server
- File: `frontend/apps/dashboard/src/sections/agenda/modals/NewApptModal.jsx:44-46` contro `backend/apps/agenda/api.py:124-160` (`gift_index`)
- Stato: CONFERMATO (lettura)
- Difetto: il drawer conta anche carte con destinataria scritta a mano (`recipient_name`), scadute (`expires_at`) o a saldo zero; il server no.
- Scenario: carta-trattamento comprata da X «per Maria» (senza scheda): prenotando X il servizio appare barrato «Regalo», ma in cassa non viene proposto.
- Correzione: stesse condizioni di `gift_index` (o leggere i regali dal server).

### [BASSO] 17-10 Modificare/ridimensionare una visita con una riga di un'operatrice disattivata → 400 «Operatrice non idonea», anche con force
- File: `backend/apps/agenda/services.py:676-704` (`operator_by_id` solo attive) ← `index.jsx:480-486` (`resizeItem` rimanda l'operator_id di ogni riga), `ApptDetailModal.jsx` `saveChanges`
- Stato: CONFERMATO (probe `test_resize_in_inactive_column`: 400 con e senza force)
- Scenario: visita a due operatrici, una uscita: allungare il servizio dell'altra o aggiungere un trattamento risponde «non idonea» (messaggio fuorviante).
- Correzione: accettare l'operatrice già sulla riga esistente anche se disattivata.

### [BASSO] 17-11 Scope «insights» assegnabile ma ignorato (M6 non corretto)
- File: `backend/apps/insights/api.py:28-58` (`require_owner`), `backend/common/permissions.py:17`, `frontend/apps/dashboard/src/sections/impostazioni/RolesDrawer.jsx:20`
- Stato: CONFERMATO (lettura)
- Scenario: il titolare spunta «Analisi dati» per il Manager: nessun effetto.
- Correzione: usare `require_scope(ctx, "insights")` oppure togliere lo scope dall'elenco.

### [BASSO] 17-12 Errori 422 di validazione in inglese e senza il nome del campo
- File: `frontend/packages/shared/src/api.js:58-70` (`readableDetail` prende solo il primo `msg`); casi raggiungibili: textarea motivazione no-show/annullo senza `maxLength` (`ApptDetailModal.jsx:444-446`, `ReasonIn` max 255), attesa fra servizi senza tetto (`commitItemStart`, `ItemEditIn.soak_min` le=720), campi scheda tecnica/cliente oltre la colonna
- Stato: CONFERMATO (lettura)
- Scenario: nota del no-show lunga → «String should have at most 255 characters» e il no-show non viene registrato.
- Correzione: tradurre/indicare il campo (usare `loc`) o un exception handler 422 in `config/api.py`; `maxLength` sugli input.

### [BASSO] 17-13 Errori della prima sincronizzazione Yourang ancora invisibili (H17 incompleto)
- File: `backend/apps/integrations/api.py:38-47,148`, `login.py:155`, `schemas.py` (`StatusOut` senza `last_error`); `frontend/.../impostazioni/index.jsx:82,216`
- Stato: CONFERMATO (lettura)
- Scenario: sync parziale al collegamento → la dashboard dice «Connesso», l'errore resta solo a database.
- Correzione: esporre `last_error` in `StatusOut` e mostrarlo.

### [BASSO] 17-14 App cliente, schermata Gift card: il saldo somma carte da pagare e carte regalate ad altri
- File: `frontend/apps/client-app/src/screens/GiftCard.jsx:33,72-76` contro `Wallet.jsx:54-57`
- Stato: CONFERMATO (lettura)
- Scenario: comprata dall'app una carta da 50 € (da pagare in salone) → «Saldo gift card €50 · spendibili in salone».
- Correzione: stesse esclusioni di Wallet (`payment_status`, `received`).

### [BASSO] 17-15 Istanti dell'API letti col fuso del dispositivo
- File: `ApptDetailModal.jsx:708` (scadenza caparra con ora), `fedelta/CouponSub.jsx:78,138`, `fedelta/modals/CouponEditModal.jsx:28` (T23:59 locale), `fedelta/GiftSub.jsx:27`, `fedelta/LoyaltyMembersDrawer.jsx:63`, `impostazioni/TeamDrawer.jsx:166`, `agenda/lib.js` `wlRank` (`getDay()` su `appt.start`)
- Stato: CONFERMATO (lettura)
- Scenario: postazione su un altro fuso: «entro le 10:30» mostrato un'ora prima; coupon che scade a mezzanotte del dispositivo.
- Correzione: `salonTzOpts`/`toDateStr(iso)`/`dateTimeLocalToIso`.

### [BASSO] 17-16 Carico merce: un prodotto nuovo con SKU verrebbe creato col nome uguale allo SKU
- File: `frontend/apps/dashboard/src/sections/magazzino/RestockModal.jsx:65` (`name: l.sku ? '' : l.name`) contro `backend/apps/inventory/api.py` `load_csv` (`name=row.name or row.sku`)
- Stato: PLAUSIBILE (non verificato se una riga nuova possa avere lo SKU compilato)
- Correzione: mandare sempre anche il nome.

Aree controllate senza reperti: tutte le 201 rotte registrate contro le 256 chiamate `api.*` (nessuna rotta inesistente, nessun metodo sbagliato, slash finali corretti); enum di stato appuntamento, caparra, lista d'attesa, causali di scarico, metodi di pagamento, audience comunicazioni, eventi automazioni, scope ruoli; formati data (`YYYY-MM-DD` in query, ISO con `Z` da `isoAtMin`/`toISOString`, slot con offset); decimali come stringhe; paginazione (`items`/`count`, limit massimo infinito, `list_sales` 1–200 rispettato); `PUT /appointments/{id}` con `force` e `soak_min` (None = invariato); `POST /move` senza `from_operator_id` quando non si riassegna; `GET/POST /agenda/undo` (forme `UndoOut`/`UndoResultOut`, 404/409 gestiti); `automation_delay_seconds` (lettura/scrittura, range 0–600, solo titolare); `gifts[]` e `service_id` nel payload settimana; SSE (ticket, 503 → polling, cache DB condivisa); 401/refresh, 404 non più usato da `request-otp`, 400 di registrazione → schermata «blocked»; PUT completi di operatrice/servizio/cliente (`toClientIn`, `exclude_unset`); import clienti (blocchi da 250, righe 0-based); comunicazioni (invio solo da bozza, `scheduled_at: null` esplicito). Rotte senza chiamanti (funzioni non esposte, non segnalate): `/auth/me`, `/auth/invitations/accept`, `/clients/{id}/appointments`, `/sales/appointments/{id}/charge-no-show`, `/sales/client/setup-intent`, `/marketing/client/marketing-consent`, `DELETE /core/settings/logo`, `DELETE /integrations/yourang/connection`. Nota: `WalletTab.jsx` scorre fino a 25 pagine di iscritte invece di usare il filtro `client_id` ora presente (lento, non rotto).

## Rotte verificate

| Rotta | Chiamanti frontend | Esito |
|---|---|---|
| GET /agenda/day | agenda/index.jsx, NewApptModal | OK |
| GET /agenda/week · /agenda/range | WeekView, MonthView | OK (17-08) |
| POST /agenda/appointments | NewApptModal, GroupBookingDrawer | OK |
| POST /agenda/appointments/{id}/move | index.jsx, WeekView, ApptDetailModal, RescheduleFlow | 17-01, 17-05, 17-06, 17-07 |
| POST …/split · …/restore · GET …/{id} · …/margin | index.jsx, WeekView, ApptDetailModal | OK |
| PUT /agenda/appointments/{id} (force, soak_min) | index.jsx resizeItem, ApptDetailModal | OK (17-10, 17-12) |
| POST …/check-in · start · no-show · cancel | ApptDetailModal | OK (17-12) |
| POST …/deposit-cashed · deposit-refunded | ApptDetailModal | OK (17-15) |
| GET/POST /agenda/undo | index.jsx, WeekView | OK |
| GET /agenda/released · pauses POST/PUT/DELETE | index.jsx | OK |
| GET /agenda/waitlist · POST …/contacted | index.jsx, ApptDetailModal, WaitlistModal, FreedSlotModal, ClientProfile | OK |
| GET /agenda/availability | NewApptModal, GroupBookingDrawer, RescheduleFlow | OK (17-07) |
| /agenda/client/* · /agenda/public/availability | Prenota, Sposta, Annulla, Waitlist*, Profilo, lib.jsx | OK (17-07) |
| POST /sales/checkout/{id} · /sales/pos | SellModal, CartTab | 17-02, 17-03 |
| GET /sales/ · /sales/{id} · /sales/today-summary | HistoryTab, agenda/index.jsx | OK |
| POST deposit-link (staff/cliente) · stripe/connect/* | ApptDetailModal, client lib.jsx, PaymentsDrawer, StripeConnectPopup | OK |
| GET /core/salon · PUT /core/settings · POST logo | ctx.jsx, Automazioni, BookingsOptim, Brand, Hours, Payments, Reasons | OK |
| /core/locations · /core/deposit-rules | LocationsPage, DepositRules | OK |
| /core/activity · activity/feed · stream-ticket + SSE · outbox/status | ActivityLogPage, ctx.jsx, impostazioni | OK (17-08) |
| GET /core/public/branding | client ctx.jsx | OK |
| /auth/staff/* · members · roles · invitations | staffAuth, PasswordDrawer, TeamDrawer, RolesDrawer | OK (17-11) |
| /auth/client/* | clientAuth, AuthFlow, Prenota, Profilo | OK |
| /clients/ CRUD · import · history · notes · sheets · categories · public/hook | clienti/*, ClientPicker (agenda/fedeltà/pos), BulkImportModal, TechSheet, Hook | OK (17-04, 17-12) |
| /staff/* · public/operators | ctx.jsx, StaffPage, AbsenceCalendar, NewOperatorModal, servizi, client lib.jsx | OK |
| /catalog/* (+ reorder, public) | servizi, CategoriesManagerModal, StaffPage, client lib/Pacchetti | OK |
| /inventory/* | magazzino/*, pos/useProductCatalog | OK (17-16) |
| /marketing/coupons · gift-cards · loyalty · communications | fedelta/*, WalletTab, NewApptModal, pos/lib.js, comunicazioni/* | OK (17-09) |
| /marketing/client/wallet · client/gift-cards | Wallet, GiftCard, Prenota, Profilo | OK (17-14) |
| /automations/* | automazioni/index.jsx, Builder | OK |
| /insights/* | insight/index.jsx, profile | OK (17-11) |
| /integrations/yourang/status · oauth/* | impostazioni/index.jsx, OAuthPopup | OK (17-13) |
