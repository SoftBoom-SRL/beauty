# Bug sospetti (24/09/2026)

Sono i possibili difetti trovati durante il refactoring del 24/09/2026 e nelle
ricognizioni che l'hanno preparato. Durante il refactoring non sono stati
corretti, perché doveva lasciare invariato il comportamento: sono stati
annotati qui.

**Stato**: tutte le voci confermate sono state corrette subito dopo, il
24/09/2026, un commit per voce, ognuna con il test che la riproduce. Commit e
note sono in [«Stato delle correzioni»](#stato-delle-correzioni), in fondo.
Lì ci sono anche le voci 58–62, trovate mentre si correggeva. Le schede qui
sotto descrivono il difetto com'era prima della correzione.

Posizioni e verifiche si riferiscono al codice dopo il refactoring (commit
`69bb7fc`). Ogni voce è stata controllata leggendo il codice; dove non bastava,
con una prova rapida su SQLite fatta su una copia del backend. La numerazione è
quella dell'elenco raccolto durante il lavoro: i numeri che mancano nelle
sezioni per area sono in fondo, fra i «Non confermati».

Priorità: **alta** = soldi, dati o messaggi sbagliati alle clienti; **media** =
errore 500 o comportamento sbagliato visibile; **bassa** = cosmetico,
prestazioni o test.

In tutto: 46 voci confermate (tre solo in parte), 10 non confermate, più una
voce nuova trovata durante la verifica (57).

## Riepilogo

| N. | Titolo | Area | Priorità |
|---|---|---|---|
| 1 | Il no-show lascia pagabile il link della caparra | Agenda | alta |
| 2 | Il «caparra pagata» del webhook non porta le preferenze WhatsApp | Agenda | alta |
| 3 | Modifica e stacco accorciano la visita senza avvisare la lista d'attesa | Agenda | media |
| 4 | Dopo uno spostamento il messaggio porta la scadenza vecchia della caparra | Agenda | media |
| 5 | Una caparra scesa a 0 € resta «richiesta» e fa liberare il posto | Agenda | alta |
| 6 | «Indietro» su una pausa la rimette sopra una visita prenotata nel frattempo | Agenda | media |
| 7 | Ogni modifica riscrive nel registro «caparra superiore alla visita» | Agenda | bassa |
| 8 | Carta salvata: nessun filtro per salone, e scartata se l'account Stripe cambia | Cassa e marketing | media |
| 9 | Le modifiche ai programmi fedeltà non arrivano al feed live | Cassa e marketing | bassa |
| 10 | Pagamento orfano: due righe nel registro se intent e sessione arrivano insieme | Cassa e marketing | bassa |
| 11 | Riscatto manuale del coupon senza controllo sulla cliente | Cassa e marketing | bassa |
| 12 | Metodo di pagamento della gift card senza limite di lunghezza | Cassa e marketing | media |
| 13 | Colori controllati con `$`: `#AABBCC\n` passa e fa 500 | Cassa e marketing | media |
| 14 | I saloni creati con «Accedi con Yourang» non hanno i ruoli di sistema | Account e integrazioni | media |
| 15 | Una data impossibile nei filtri di cassa e magazzino fa 500 | Account e integrazioni | media |
| 16 | OAuth Yourang: lo «state» si salva prima della chiamata a Yourang e non si cancella mai | Account e integrazioni | media |
| 17 | Il logger dell'API account è fuori da «youty»: le righe INFO non si vedono | Account e integrazioni | bassa |
| 20 | Ricerca clienti: «Anna 3» trova tutta la rubrica | Clienti e magazzino | media |
| 21 | Campi senza limite contro colonne strette: 500 | Clienti e magazzino | media |
| 22 | L'etichetta «Da form» si cerca distinguendo le maiuscole | Clienti e magazzino | bassa |
| 23 | Import: un'etichetta nata in una riga rifiutata fa rifiutare anche le righe dopo | Clienti e magazzino | media |
| 24 | Tre `CategoryIn`/`CategoryOut` si sovrascrivono nello schema OpenAPI | Clienti e magazzino | bassa |
| 25 | Bozza d'ordine: la stessa riga due volte fa 500 | Clienti e magazzino | media |
| 26 | Eliminare un'etichetta: controllo e cancellazione non sono atomici | Clienti e magazzino | bassa |
| 27 | Riordino delle categorie del listino non atomico | Clienti e magazzino | bassa |
| 29 | Due sedi predefinite possibili passando dall'admin | Clienti e magazzino | bassa |
| 31 | Senza rete l'app mostra «Failed to fetch» invece di «Errore di rete» | App clienti | bassa |
| 32 | Sposta: dopo un 409 gli orari di un giorno possono finire sotto un altro | App clienti | media |
| 33 | Gift card e lista d'attesa: l'errore compare sulla schermata successiva | App clienti | bassa |
| 34 | Profilo: cambio lingua durante un salvataggio, il server resta sulla lingua vecchia | App clienti | alta |
| 35 | Prenota: dopo un 409 la disponibilità si chiede due volte | App clienti | bassa |
| 39 | Magazzino: se i dati comuni non arrivano, nessun avviso | Dashboard | bassa |
| 41 | Gift card in cassa: «€12.5» invece di «€12,50» | Dashboard | bassa |
| 42 | La scorciatoia N è promessa ovunque ma funziona solo in agenda | Dashboard | bassa |
| 43 | Clienti: a ogni evento si rifanno tutti i conteggi delle etichette | Dashboard | bassa |
| 44 | Impostazioni: l'esito del collegamento Yourang nella lingua di prima | Dashboard | bassa |
| 46 | Comunicazioni: cambiando filtro resta per un attimo la lista vecchia | Dashboard | bassa |
| 47 | «Copia»: toast «Copiato» anche quando la copia non riesce | Dashboard | bassa |
| 48 | Pinch e ⌘-rotella non zoomano la vista settimana | Agenda (dashboard) | media |
| 49 | Gesto riuscito, ricarica fallita: compare un errore | Agenda (dashboard) | media |
| 50 | Clic per prenotare: la settimana arrotonda, il giorno tronca | Agenda (dashboard) | bassa |
| 51 | Vista giorno: nessuna riserva su `window` per il rilascio del trascinamento | Agenda (dashboard) | bassa |
| 52 | Nuovo appuntamento: i pulsanti degli orari si rimontano a ogni disegno | Agenda (dashboard) | bassa |
| 54 | Ruoli di prova con i nomi dei ruoli di sistema | Test | bassa |
| 55 | `CatalogueRaceTests` azzera solo una parte di `FakeHttp` | Test | bassa |
| 56 | `test_processing_failure_asks_for_a_retry` passa anche con la sostituzione muta | Test | bassa |
| 57 | (nuovo) L'avvio pubblico di «Accedi con Yourang» scrive una riga a ogni chiamata, senza limite | Account e integrazioni | media |

## Agenda (backend)

### 1. Il no-show lascia pagabile il link della caparra

- **Dove**: `backend/apps/agenda/services/transitions.py`, `mark_no_show`. A
  confronto: `cancel_appointment` nello stesso file e
  `release_for_unpaid_deposit` in `backend/apps/agenda/services/deposit_holds.py`.
- **Cosa succede**: annullamento e rilascio automatico, se la caparra è ancora
  «richiesta», ritirano i messaggi del link non ancora partiti
  (`_withdraw_deposit_messages`) e chiudono la sessione Stripe
  (`close_deposit_link_after_commit`). `mark_no_show` non fa nessuna delle due
  cose. Il link resta pagabile finché Stripe non chiude la sessione: fino a 24
  ore quando la scadenza della caparra non si può usare (per esempio in un
  salone senza termine per la caparra). Esempio: visita alle 10:00 con 20 € di
  caparra non pagata; alle 10:20 la reception segna il no-show; alle 18:00 la
  cliente apre il link e paga.
- **Effetto**: il webhook trova la visita in no-show, segna la caparra «da
  rimborsare» e la restituisce (`apply_deposit_payment` in
  `backend/apps/sales/deposits.py`, poi `settle_deposit_refund`). La cliente
  paga e viene rimborsata; il salone perde le commissioni Stripe.
- **Priorità**: alta.
- **Direzione**: in `mark_no_show`, con la caparra «richiesta», fare le stesse
  due chiamate dell'annullamento.

### 2. Il «caparra pagata» del webhook non porta le preferenze WhatsApp

- **Dove**: `backend/apps/sales/stripe_webhooks.py`,
  `on_payment_intent_succeeded` (ramo `outcome == "paid"`). A confronto:
  `mark_deposit_cashed` in `backend/apps/agenda/services/deposit_holds.py`, che
  usa `_event_payload` di `backend/apps/agenda/services/messages.py`.
- **Cosa succede**: l'evento `deposit.paid` del pagamento online è scritto a
  mano: `appointment_id`, `client_id`, `client_name`, `phone`, `lang`, `amount`,
  `start`. Mancano `whatsapp_reminders` e `wa` (e anche fine, servizi e
  operatrice). Quello dell'incasso al banco ha tutto `_event_payload`, ma non
  ha `amount`. Stesso evento, due forme diverse.
- **Effetto**: per le caparre pagate online Yourang non sa se la cliente ha
  spento i promemoria WhatsApp o non usa WhatsApp. Se ne fa un messaggio, può
  scriverle su un canale che lei ha rifiutato. Chi legge `amount` lo trova solo
  nel pagamento online.
- **Priorità**: alta, se Yourang manda un messaggio alla cliente su
  `deposit.paid`.
- **Direzione**: un solo payload (`_event_payload` più `amount`), usato da
  tutti e due i punti.

### 3. Modifica e stacco accorciano la visita senza avvisare la lista d'attesa

- **Dove**: `backend/apps/agenda/services/appointments.py`, `edit_appointment` e
  `split_appointment`, che emettono con `emit_appointment_event`.
  `move_appointment`, nello stesso file, usa `emit_with_freed_slots`.
- **Cosa succede**: lo spostamento annuncia con `slot.freed` il tempo che si è
  liberato; la modifica dei servizi e lo stacco no. Esempio: visita 10:00–12:00
  (colore, posa, piega). Si toglie la piega, o la si stacca su un altro giorno:
  11:30–12:00 si libera, ma non parte nessun `slot.freed`.
- **Effetto**: le clienti in lista d'attesa non sanno del posto libero; il
  salone perde l'occasione di riempirlo.
- **Priorità**: media.
- **Direzione**: in `edit_appointment` e `split_appointment` emettere con
  `emit_with_freed_slots`, passando gli intervalli di prima e di dopo, come fa
  `move_appointment`.

### 4. Dopo uno spostamento il messaggio porta la scadenza vecchia della caparra

- **Dove**: `backend/apps/agenda/services/appointments.py`, `move_appointment`.
  La scadenza si ricalcola solo in `process_deposit_holds`
  (`_effective_deposit_due`), in `backend/apps/agenda/services/deposit_holds.py`.
- **Cosa succede**: `deposit_due_at` non supera mai l'inizio della visita.
  Spostando la visita la colonna resta com'era, e `appointment.moved` parte con
  la scadenza di prima. Si riallinea alla lettura successiva dell'agenda o al
  cron, quando il messaggio è già stato composto. Esempio: prenotata lunedì alle
  18 per martedì alle 10, con 24 ore di termine: scadenza martedì alle 10.
  Spostata a giovedì, la scadenza vera diventa martedì alle 18; il messaggio
  dice martedì alle 10.
- **Effetto**: se il messaggio di spostamento mostra la scadenza, la cliente
  legge un termine sbagliato. Anche la risposta dell'API allo spostamento porta
  il dato vecchio.
- **Priorità**: media. Motivo: il dato è secondario nel messaggio e il rilascio
  usa comunque la scadenza giusta.
- **Direzione**: ricalcolare `deposit_due_at` dentro `move_appointment` (stessa
  regola di `_effective_deposit_due`) prima di emettere l'evento.

### 5. Una caparra scesa a 0 € resta «richiesta» e fa liberare il posto

- **Dove**: `backend/apps/agenda/services/deposits.py`,
  `shrink_deposit_to_total` (chiamata da `edit_appointment` e
  `split_appointment`). Gli effetti: `mark_deposit_cashed` e
  `process_deposit_holds` in `backend/apps/agenda/services/deposit_holds.py`,
  `ensure_deposit_link` in `backend/apps/sales/stripe_service.py`.
- **Cosa succede**: se la visita scende a 0 € (il listino ammette servizi a
  0 €), la caparra non pagata scende a 0 € ma resta «richiesta», con la sua
  scadenza. Esempio: colore 60 € più consulenza 0 €, caparra di 30 € richiesta;
  si toglie il colore. L'incasso al banco risponde 400 «Nessuna caparra da
  incassare su questo appuntamento»; alla scadenza `process_deposit_holds`
  libera lo stesso l'appuntamento. In più il link vecchio da 30 € non si chiude:
  il rinnovo passa da `ensure_deposit_link`, che con importo 0 esce subito,
  prima di chiudere la sessione precedente.
- **Effetto**: la cliente riceve «posto liberato, caparra non versata» per una
  caparra che non c'è, e la visita esce dall'agenda. Se intanto paga il link
  vecchio, i 30 € le tornano in automatico e il salone perde le commissioni.
- **Priorità**: alta.
- **Direzione**: quando la caparra da pagare arriva a 0, portarla a «nessuna»,
  togliere la scadenza (`clear_deposit_hold`) e chiudere il link
  (`close_deposit_link_after_commit`).

### 6. «Indietro» su una pausa la rimette sopra una visita prenotata nel frattempo

- **Dove**: `backend/apps/agenda/undo.py`, `_restore_pause` (chiamata da
  `perform`). Per gli appuntamenti c'è `_ensure_slot_free`.
- **Cosa succede**: annullando la cancellazione o lo spostamento di una pausa,
  la pausa torna dov'era senza nessun controllo. Esempio: alle 12:55 la
  reception toglie la pausa di Laura delle 13:00; alle 12:58 una cliente prenota
  dall'app proprio alle 13:00 con Laura; alle 13:02 la reception preme
  «Indietro» (la finestra è di 10 minuti): la pausa torna sopra la visita.
- **Effetto**: pausa e visita sovrapposte in agenda, senza un avviso;
  l'operatrice può credersi in pausa con una cliente in arrivo. Trascinando una
  pausa a mano, invece, la griglia segnala la sovrapposizione.
- **Priorità**: media.
- **Direzione**: in `_restore_pause` controllare, come fa `_ensure_slot_free`,
  che il tempo ripreso sia libero, e rispondere 409 se non lo è.

### 7. Ogni modifica riscrive nel registro «caparra superiore alla visita»

- **Dove**: `backend/apps/agenda/services/deposits.py`,
  `shrink_deposit_to_total` (ramo della caparra pagata), chiamata da
  `edit_appointment` a ogni modifica che porta `items`.
- **Cosa succede**: se la caparra pagata supera il totale, ogni modifica che
  manda la lista dei servizi scrive di nuovo `deposit.excess`, anche se servizi
  e prezzi non cambiano. La dashboard manda sempre la lista quando si allunga
  un servizio in griglia (`resizeItem`). Esempio: caparra di 50 € su una visita
  scesa a 40 €; tre ritocchi di durata danno tre righe «10 € tornano alla
  cliente».
- **Effetto**: righe doppie nel registro attività, che sembrano eccedenze
  diverse. I soldi non cambiano: il conto calcola l'eccedenza da sé.
- **Priorità**: bassa.
- **Direzione**: scrivere la riga solo quando l'eccedenza cambia rispetto a
  prima della modifica.

## Cassa, pagamenti, marketing

### 8. Carta salvata: nessun filtro per salone, e scartata se l'account Stripe cambia

- **Dove**: `backend/apps/sales/stripe_service.py`, `create_setup_intent`;
  `backend/apps/sales/stripe_webhooks.py`, `on_setup_intent_succeeded`.
- **Cosa succede**: il SetupIntent porta nei metadata solo `client_id`. Il
  webhook filtra per `salon_id` solo se c'è, quindi il filtro non si applica
  mai. Poi confronta l'account dell'evento con quello attuale del salone e, se
  è diverso, scarta la carta. I pagamenti hanno l'account firmato nei metadata
  (`acct`, vedi `account_token`); le carte no. Esempio: la cliente salva la
  carta dall'app mentre il titolare collega Stripe; l'evento arriva
  dall'account di prima e la carta viene ignorata, con un solo avviso nel log
  del server.
- **Effetto**: la cliente crede di aver salvato la carta, e il salone non può
  addebitarle un no-show. Il filtro per salone manca come difesa in più (oggi
  lo copre il controllo sull'account).
- **Priorità**: media. Motivo: in gioco ci sono soldi, ma in una finestra rara.
- **Direzione**: mettere `salon_id` e `acct` nei metadata del SetupIntent e
  riconoscere l'account come fa `_salon_account_recognised`.

### 9. Le modifiche ai programmi fedeltà non arrivano al feed live

- **Dove**: `backend/apps/core/livefeed.py`, `LIVE_FEED_SCOPES` (il filtro è
  `startswith`, in `feed_page` e nello stream di `backend/apps/core/views.py`).
  Gli eventi nascono in `backend/apps/marketing/api.py`:
  `create_loyalty_program`, `update_loyalty_program`, `delete_loyalty_program`.
- **Cosa succede**: gli eventi si chiamano `loyalty_program.created`,
  `.updated`, `.deleted`, ma la mappa ha solo il prefisso `loyalty.`, e
  `loyalty_program.…` non comincia con `loyalty.`. Il Wallet della scheda
  cliente li aspetta
  (`frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx`).
- **Effetto**: un programma rinominato o eliminato su una postazione resta
  com'era sulle altre fino al ricaricamento.
- **Priorità**: bassa.
- **Direzione**: aggiungere il prefisso `loyalty_program.` con lo stesso
  permesso di `loyalty.`.

### 10. Pagamento orfano: due righe nel registro se intent e sessione arrivano insieme

- **Dove**: `backend/apps/sales/stripe_webhooks.py`, `_orphan_deposit_payment`.
- **Cosa succede**: la funzione controlla se la riga `deposit.orphan_payment`
  c'è già, poi rimborsa, poi la scrive, senza lock. Stripe manda
  `payment_intent.succeeded` e `checkout.session.completed` quasi insieme:
  tutte e due le richieste passano il controllo. Il rimborso usa la stessa
  chiave di idempotenza, quindi i soldi tornano una volta sola.
- **Effetto**: due righe «Caparra pagata per un appuntamento che non esiste
  più» per lo stesso pagamento. Se Stripe rifiuta la seconda richiesta perché
  la stessa chiave è ancora in uso, la seconda riga può dire «da rimborsare a
  mano» anche se il rimborso c'è.
- **Priorità**: bassa.
- **Direzione**: fare controllo e scrittura sotto lo stesso lock (per esempio
  quello del salone).

### 11. Riscatto manuale del coupon senza controllo sulla cliente

- **Dove**: `backend/apps/marketing/api.py`, `redeem_coupon`. Il controllo c'è
  in `validate_coupon` (`backend/apps/marketing/coupons.py`), usato dalla cassa.
- **Cosa succede**: l'endpoint segna il coupon come usato e lo lega alla
  vendita `sale_id`, di qualunque cliente sia. Esempio: il buono di Maria
  legato alla vendita di Anna. La dashboard («Segna come utilizzato» in
  `frontend/apps/dashboard/src/sections/fedelta/modals/CouponEditModal.jsx`)
  non manda `sale_id`: succede solo da API.
- **Effetto**: nessuno sconto indebito (l'endpoint non sconta niente), ma
  storico del coupon e della vendita incoerenti.
- **Priorità**: bassa.
- **Direzione**: con `sale_id`, rifiutare la vendita di un'altra cliente, con
  lo stesso messaggio della cassa.

### 12. Metodo di pagamento della gift card senza limite di lunghezza

- **Dove**: `backend/apps/marketing/schemas.py`, `GiftCardIn.paid_method` e
  `MarkPaidIn.method`; la colonna `GiftCard.paid_method` (`max_length=20`) in
  `backend/apps/marketing/models.py`; le scritture in
  `backend/apps/marketing/gift_cards.py` (`create_gift_card`, `cash_gift_card`).
- **Cosa succede**: gli schemi accettano qualunque stringa. Una gift card
  creata «pagata», o segnata pagata, con un metodo di 21 caratteri arriva al
  database, e PostgreSQL rifiuta la riga. La cassa invece controlla il metodo
  sulle scelte di `Payment.Method`, e l'incasso della caparra al banco ha
  `max_length=20`.
- **Effetto**: 500 invece di 422. Dalla dashboard (menu a scelta) non capita:
  serve una richiesta scritta a mano o da un'integrazione. Passa anche un
  valore corto ma inventato («bonifico»): resta sulla carta, mentre in cassa il
  pagamento diventa «other».
- **Priorità**: media.
- **Direzione**: limitare il campo e validarlo sulle scelte di
  `Payment.Method`, come fa la cassa.

### 13. Colori controllati con `$`: `#AABBCC\n` passa e fa 500

- **Dove**: `backend/apps/core/validation.py`, `_BRAND_COLOR_RE` (colore del
  brand nelle impostazioni); `backend/apps/marketing/loyalty.py`, `_HEX_COLOR`
  (colore del programma fedeltà).
- **Cosa succede**: con `re.match`, `$` accetta anche un a capo finale:
  «#AABBCC\n» supera il controllo (provato) e arriva al database, dove la
  colonna è di 7 caratteri, e PostgreSQL rifiuta la riga. Non vale per
  l'etichetta cliente (`CategoryIn` in `backend/apps/clients/schemas.py`): lì
  controlla il `pattern` di pydantic, che l'a capo lo rifiuta (provato).
  `backend/common/validation.py` usa già `\Z`.
- **Effetto**: 500 invece di un errore di validazione; su SQLite il colore con
  l'a capo viene salvato. Dalla dashboard non capita.
- **Priorità**: media.
- **Direzione**: `\Z` al posto di `$` (o `fullmatch`), oppure
  `common.validation.require_hex_color`.

## Account, core, integrazioni

### 14. I saloni creati con «Accedi con Yourang» non hanno i ruoli di sistema

- **Dove**: `backend/apps/integrations/login.py`, `_provision_salon`. A
  confronto: `create_salon_foundation` in `backend/apps/accounts/provisioning.py`
  (usata da `create_salon` e `seed_demo`), che chiama `ensure_default_roles`.
- **Cosa succede**: il salone nasce con sede, impostazioni e titolare, ma senza
  i ruoli Manager, Front desk e Operatrice.
- **Effetto**: in Impostazioni › Team l'elenco dei ruoli è vuoto; per invitare
  una collega (l'invito chiede un ruolo) il titolare deve prima crearne uno a
  mano. Il salone è diverso da tutti gli altri.
- **Priorità**: media.
- **Direzione**: chiamare `ensure_default_roles` in `_provision_salon`, o
  passare da `create_salon_foundation`.

### 15. Una data impossibile nei filtri di cassa e magazzino fa 500

- **Dove**: `backend/apps/sales/reports.py`, `sales_history`;
  `backend/apps/inventory/api.py`, `_filter_movements`.
- **Cosa succede**: `parse_date` di Django solleva `ValueError` per una data
  scritta bene ma inesistente (provato con «2026-02-30»). Esempio:
  `GET /api/sales/?date_from=2026-02-30`. Le altre letture di date
  (`backend/apps/core/api.py`, `_parse_date` in `backend/apps/insights/api.py`,
  `backend/apps/agenda/api/params.py`) lo gestiscono già.
- **Effetto**: 500 invece di «Data non valida». Dai campi data della dashboard
  non capita; succede con una richiesta scritta a mano o da un'integrazione.
- **Priorità**: media.
- **Direzione**: la stessa gestione di `insights/api.py` (400 «Data non
  valida: usa il formato YYYY-MM-DD»).

### 16. OAuth Yourang: lo «state» si salva prima della chiamata a Yourang e non si cancella mai

- **Dove**: `backend/apps/integrations/oauth.py`, `start_flow` (che chiama
  `build_authorize_url` e quindi `_discovery` in
  `backend/apps/integrations/client.py`); endpoint `oauth_start` e
  `oauth_login_start` in `backend/apps/integrations/api.py`.
- **Cosa succede**: `start_flow` crea la riga `YourangOAuthState` e solo dopo
  chiede a Yourang il documento di discovery (se non è già in memoria). Se
  Yourang non risponde, l'errore di rete arriva fino all'utente. Le righe dei
  flussi mai conclusi (popup chiuso, errore) restano per sempre: si cancellano
  solo in `consume_state`.
- **Effetto**: 500 su «Collega Yourang» e «Accedi con Yourang» quando Yourang è
  irraggiungibile, con una riga orfana; la tabella cresce senza fine (vedi
  anche la voce 57).
- **Priorità**: media.
- **Direzione**: costruire l'URL prima di salvare la riga, rispondere 503 se
  Yourang non risponde, e cancellare gli state scaduti (per esempio nel job
  `flush_outbox`, che pulisce già altre tabelle).

### 17. Il logger dell'API account è fuori da «youty»: le righe INFO non si vedono

- **Dove**: `backend/apps/accounts/api/client.py` e
  `backend/apps/accounts/api/staff.py`, `logging.getLogger("apps.accounts.api")`;
  la configurazione `LOGGING` in `backend/config/settings.py`.
- **Cosa succede**: la configurazione stampa gli INFO solo sotto «youty»; il
  resto passa dalla radice, che è a WARNING. La riga `logger.info`
  «request-otp: codice non inviato» di `client_request_otp` non esce mai. I
  WARNING invece si vedono.
- **Effetto**: nessuna traccia di quando il codice non parte perché la cliente
  ha raggiunto il suo tetto; diagnosi più difficile.
- **Priorità**: bassa.
- **Direzione**: rinominare in `youty.accounts` e aggiornare il test che legge
  il nome (`test_many_requests_are_still_reported` in
  `backend/apps/accounts/tests/test_client_auth.py`, con
  `assertLogs("apps.accounts.api")`).

## Clienti, magazzino, catalogo, staff

### 20. Ricerca clienti: «Anna 3» trova tutta la rubrica

- **Dove**: `backend/apps/clients/search.py`, `search_filter` (usato dalla lista
  clienti in `backend/apps/clients/api.py`, e quindi dai selettori cliente della
  dashboard).
- **Cosa succede**: la chiave telefonica si calcola sull'intera ricerca e si
  mette in OR con il resto. Da «Anna 3» esce la chiave «3» (provato), e
  risponde ogni scheda con un 3 nel numero. I cellulari italiani, salvati come
  +39 3…, lo contengono tutti; lo stesso vale per «9».
- **Effetto**: aggiungendo una cifra al nome la lista mostra quasi tutte le
  clienti invece di restringere; al banco si rischia di scegliere la persona
  sbagliata.
- **Priorità**: media.
- **Direzione**: usare la chiave telefonica solo quando la ricerca è un numero
  (tolti spazi e simboli restano solo cifre), oppure solo sulle parole che sono
  numeri.

### 21. Campi senza limite contro colonne strette: 500

- **Dove**:
  - `backend/apps/inventory/schemas.py`: `SupplierIn` (`vat_number` contro 20
    caratteri; anche `name` 120, `phone` 40, `address` 255, `sdi_pec` 120) e
    `ProductIn` (`purchase_discount_pct` e `vat_rate` contro
    `PositiveSmallIntegerField`; anche `name` 160, `sku` 60, `brand` 120,
    `package_unit` 20);
  - `backend/apps/catalog/schemas.py`: `ServiceIn` (`name_it` e `name_en`
    contro 120 caratteri; `order` contro `PositiveIntegerField`);
  - `backend/apps/staff/schemas.py`: `OperatorIn` e `OperatorPatchIn`
    (`role_title` contro 120; anche `first_name` e `last_name` 80) e
    `AbsenceIn` (`note` contro 255).
- **Cosa succede**: né gli schemi né le funzioni che scrivono
  (`create_supplier`/`update_supplier`, `save_product`,
  `create_service`/`update_service`, `save_operator`,
  `create_absence`/`update_absence`) controllano questi valori. Esempio: nella
  scheda fornitore si scrive «IT01234567890 sede di Milano» come partita IVA (il
  campo della dashboard non ha limite): PostgreSQL rifiuta la riga. Un valore
  negativo (sconto fornitore, ordine del servizio) è rifiutato dal vincolo ≥ 0
  anche su SQLite (provato).
- **Effetto**: 500 invece di un errore che dice quale campo correggere.
- **Priorità**: media.
- **Direzione**: limiti nello schema (`max_length`, `ge`/`le`), come già per
  `description_it` o `duration_min`.

### 22. L'etichetta «Da form» si cerca distinguendo le maiuscole

- **Dove**: `backend/apps/clients/hook.py`, `mark_as_hook_lead`
  (`get_or_create(name=HOOK_LABEL)`). Le altre scritture confrontano senza
  maiuscole: `label_payload` in `backend/apps/clients/labels.py`, `category_for`
  dell'import.
- **Cosa succede**: se nel salone c'è già «da form» o «DA FORM» (creata o
  rinominata dal titolare), il primo contatto dal modulo pubblico non la trova
  e crea una seconda etichetta «Da form». Il vincolo del database (salone,
  nome) distingue le maiuscole, quindi la creazione riesce.
- **Effetto**: due etichette che differiscono solo per le maiuscole, cosa che
  l'interfaccia vieta. I contatti nuovi finiscono sulla seconda, e le
  condizioni (che confrontano senza maiuscole) le vedono tutte e due.
- **Priorità**: bassa.
- **Direzione**: cercarla con `name__iexact` prima di crearla.

### 23. Import: un'etichetta nata in una riga rifiutata fa rifiutare anche le righe dopo

- **Dove**: `backend/apps/clients/importer.py`, `import_rows` (`category_for` e
  `category_cache`; nell'`except` si ripristinano solo `by_phone` e `by_email`).
- **Cosa succede**: una riga crea l'etichetta nuova «VIP» dentro il suo
  savepoint, poi il database rifiuta la riga (per esempio per un carattere
  nullo nella nota, che PostgreSQL non accetta). Il savepoint annulla anche
  l'etichetta, ma la cache la tiene. Le righe seguenti con «VIP» ricevono
  un'etichetta che non esiste più, e il database le rifiuta. Prova su SQLite
  (su una copia): tre righe con «VIP», la prima rifiutata; risultato: tutte e
  tre rifiutate, le ultime due con «FOREIGN KEY constraint failed».
- **Effetto**: clienti valide non importate, con un motivo incomprensibile nel
  riepilogo.
- **Priorità**: media. Motivo: il primo rifiuto è raro, ma l'effetto è a
  cascata.
- **Direzione**: ripristinare anche `category_cache` nell'`except`, come
  `by_phone` e `by_email`.

### 24. Tre `CategoryIn`/`CategoryOut` si sovrascrivono nello schema OpenAPI

- **Dove**: le classi `CategoryIn` e `CategoryOut` di
  `backend/apps/clients/schemas.py`, `backend/apps/inventory/schemas.py` e
  `backend/apps/catalog/schemas.py`; lo schema è `/api/openapi.json`.
- **Cosa succede**: django-ninja dà ai componenti il nome della classe, quindi
  per ogni nome ne resta uno solo. Nello schema generato rimane quello con
  `name`, `color`, `order`: `/api/catalog/categories` risulta documentato con
  `name` invece di `name_it` e `name_en`.
- **Effetto**: documentazione pubblica sbagliata per il listino. Il
  comportamento non cambia.
- **Priorità**: bassa (solo documentazione).
- **Direzione**: nomi diversi per app (per esempio `ServiceCategoryIn`,
  `ProductCategoryIn`, `ClientCategoryIn`), sapendo che cambia l'istantanea del
  contratto OpenAPI.

### 25. Bozza d'ordine: la stessa riga due volte fa 500

- **Dove**: `backend/apps/inventory/orders.py`, `update_draft_order`.
- **Cosa succede**: ogni voce si legge per conto suo, quindi la stessa riga
  diventa due oggetti. Con `[{id: 5, qty_ordered: 0}, {id: 5, qty_ordered: 3}]`
  il primo la cancella, il secondo prova a salvarla con `update_fields`, e
  Django solleva `DatabaseError` «Save with update_fields did not affect any
  rows» (provato).
- **Effetto**: 500. La dashboard (`OrderCard.jsx`) toglie già i doppioni:
  succede solo con una richiesta scritta a mano.
- **Priorità**: media.
- **Direzione**: rifiutare con 400 le voci con lo stesso `id`.

### 26. Eliminare un'etichetta: controllo e cancellazione non sono atomici

- **Dove**: `backend/apps/clients/labels.py`, `delete_label` (da
  `delete_category` in `backend/apps/clients/api.py`).
- **Cosa succede**: la funzione controlla che nessuna regola caparra o
  automazione citi l'etichetta, poi la cancella, senza transazione né lock. Se
  nel frattempo un'altra postazione salva una regola che la cita, l'etichetta
  sparisce lo stesso. `update_label`, invece, fa tutto in una transazione.
- **Effetto**: una regola caparra o un'automazione che cita un'etichetta che
  non c'è più, e non scatta per nessuna, senza avviso: proprio il caso che il
  controllo vuole evitare. La finestra è stretta.
- **Priorità**: bassa.
- **Direzione**: controllo e cancellazione nella stessa transazione, sotto un
  lock preso anche da chi salva regole e automazioni.

### 27. Riordino delle categorie del listino non atomico

- **Dove**: `backend/apps/catalog/services.py`, `set_category_order` (da
  `reorder_categories` in `backend/apps/catalog/api.py`).
- **Cosa succede**: ogni categoria si salva per conto suo, fuori da una
  transazione. Due riordini insieme (due postazioni, un doppio invio) si
  mescolano; un errore a metà lascia l'ordine in parte nuovo e in parte vecchio.
- **Effetto**: categorie in un ordine che nessuno ha scelto, anche nel listino
  dell'app clienti.
- **Priorità**: bassa.
- **Direzione**: `transaction.atomic` con un lock sulle categorie del salone.

### 29. Due sedi predefinite possibili passando dall'admin

- **Dove**: `backend/apps/core/admin.py`, `LocationAdmin`; il modello `Location`
  in `backend/apps/core/models.py` non ha vincoli. L'API lo impedisce con
  `_make_only_default` in `backend/apps/core/api.py`.
- **Cosa succede**: da /admin/ si può segnare «predefinita» una seconda sede.
  `default_location` (`backend/apps/core/services.py`) prende `.first()` senza
  ordinamento.
- **Effetto**: l'app clienti può lavorare sulla sede sbagliata, e su PostgreSQL
  non è garantito quale delle due vinca. Si sistema salvando di nuovo la sede
  dalla dashboard.
- **Priorità**: bassa (solo da admin).
- **Direzione**: un vincolo unico condizionato (una sola `is_default=True` per
  salone), con la sua migrazione, oppure la stessa pulizia nel salvataggio
  dell'admin.

## Web app clienti (frontend)

### 31. Senza rete l'app mostra «Failed to fetch» invece di «Errore di rete»

- **Dove**: `frontend/apps/client-app/src/hooks/useOtpFlow.js`, `other` (usata
  dall'accesso in `screens/auth/AuthFlow.jsx`);
  `frontend/apps/client-app/src/screens/Hook.jsx`, invio del modulo;
  `frontend/apps/client-app/src/ctx.jsx`, `loadBrand`.
- **Cosa succede**: senza rete `fetch` fallisce con un `TypeError` che porta il
  testo del browser («Failed to fetch», su Safari «Load failed»). Questi punti
  mostrano `err.message` quando c'è, quindi quel testo. In `ctx.jsx` il ripiego
  è `'Errore'`, senza traduzione, e compare sotto «Impossibile caricare il
  salone» (`App.jsx`).
- **Effetto**: la cliente legge un messaggio tecnico in inglese, anche con
  l'app in italiano.
- **Priorità**: bassa.
- **Direzione**: `apiErrorText` di `@youty/shared` (il messaggio del server se è
  arrivata una risposta, altrimenti «Errore di rete»).

### 32. Sposta: dopo un 409 gli orari di un giorno possono finire sotto un altro

- **Dove**: `frontend/apps/client-app/src/screens/Sposta.jsx`, `confirm` (ramo
  del 409).
- **Cosa succede**: dopo il 409 gli orari si rileggono con
  `getAvailability(...).then(setSlots)`, senza la guardia che ha l'effetto di
  caricamento. Se la cliente tocca un altro giorno mentre la rilettura è in
  corso e la risposta vecchia arriva dopo, sotto il giorno B restano gli orari
  del giorno A. Ogni orario porta la data intera: toccandone uno, la visita si
  sposta al giorno A.
- **Effetto**: appuntamento spostato in un giorno diverso da quello scelto a
  schermo; lo mostra solo la schermata finale.
- **Priorità**: media. Motivo: il danno è serio, ma serve una sequenza precisa.
- **Direzione**: la stessa guardia dell'effetto, o ricaricare cambiando una
  chiave che l'effetto ascolta.

### 33. Gift card e lista d'attesa: l'errore compare sulla schermata successiva

- **Dove**: `frontend/apps/client-app/src/screens/GiftCard.jsx` e
  `frontend/apps/client-app/src/screens/Waitlist.jsx`, `load`.
- **Cosa succede**: il caricamento non ha guardia. Se la cliente esce dalla
  schermata prima della risposta e la chiamata fallisce, il toast «Errore di
  rete» compare dove si trova in quel momento. Le altre schermate usano
  `useApiData`, che la guardia ce l'ha.
- **Effetto**: un errore che non c'entra con la schermata aperta.
- **Priorità**: bassa.
- **Direzione**: passare da `useApiData` (`hooks/useApiData.js`).

### 34. Profilo: cambio lingua durante un salvataggio, il server resta sulla lingua vecchia

- **Dove**: `frontend/apps/client-app/src/screens/Profilo.jsx`, pulsanti della
  lingua e `saveMe`.
- **Cosa succede**: il pulsante cambia subito la lingua a schermo (`setLang`) e
  poi chiama `saveMe`, che esce senza fare niente se c'è già un salvataggio in
  corso. Esempio: la cliente tocca EN e subito dopo IT; l'app è in italiano, sul
  server resta «en». Se invece il salvataggio fallisce, la lingua a schermo non
  torna indietro.
- **Effetto**: conferme e promemoria WhatsApp arrivano in una lingua diversa da
  quella che la cliente vede e ha scelto, e lei non ha modo di accorgersene.
- **Priorità**: alta.
- **Direzione**: salvare sempre la lingua (dopo il salvataggio in corso) e
  riportare quella a schermo se il salvataggio fallisce.

### 35. Prenota: dopo un 409 la disponibilità si chiede due volte

- **Dove**: `frontend/apps/client-app/src/screens/prenota/usePrenota.js`,
  `book` e l'effetto che carica gli orari al passo `STEP.TIME`.
- **Cosa succede**: dopo il 409 `book` fa `setStep(STEP.TIME)` e chiama
  `loadSlots`; il cambio di passo fa ripartire anche l'effetto, che la chiama
  di nuovo. La prima risposta viene scartata dal numero di sequenza.
- **Effetto**: una richiesta in più; senza sessione pesa sul tetto
  dell'endpoint pubblico (120 l'ora per salone e IP).
- **Priorità**: bassa (prestazioni).
- **Direzione**: lasciare la rilettura al solo effetto.

## Dashboard

### 39. Magazzino: se i dati comuni non arrivano, nessun avviso

- **Dove**: `frontend/apps/dashboard/src/sections/magazzino/index.jsx`,
  `loadShared`, chiamata con `silent = true` sia al montaggio sia da
  `refreshShared`.
- **Cosa succede**: il toast d'errore di `loadShared` non parte mai, perché
  nessuno la chiama con `silent = false`. Se il primo caricamento fallisce,
  categorie, fornitori e catalogo restano vuoti senza spiegazione.
- **Effetto**: indicatori a zero e menu di fornitori e categorie vuoti nei
  moduli, senza sapere perché.
- **Priorità**: bassa.
- **Direzione**: al montaggio chiamarla non silenziosa; restare silenziosi solo
  nelle riletture dal feed live.

### 41. Gift card in cassa: «€12.5» invece di «€12,50»

- **Dove**: `frontend/apps/dashboard/src/sections/pos/lines.js`, `giftLineName`
  (usata da `checkoutGiftLine` e `counterGiftLine`).
- **Cosa succede**: il nome della riga è `'Gift card · €' + value`, e `value` è
  un numero: 12,50 € diventa «€12.5», 1.000 € diventa «€1000».
- **Effetto**: importo scritto male nella riga del carrello e del check-out
  (solo a video: il nome non va al server).
- **Priorità**: bassa.
- **Direzione**: formattare con `fmtEur` nella lingua dell'interfaccia.

### 42. La scorciatoia N è promessa ovunque ma funziona solo in agenda

- **Dove**: `frontend/apps/dashboard/src/shell/Topbar.jsx` (il suggerimento
  «Nuova prenotazione (N)» del pulsante Prenota); il tasto lo gestisce solo
  `frontend/apps/dashboard/src/sections/agenda/hooks/useAgendaShortcuts.js`.
- **Cosa succede**: il suggerimento compare su ogni pagina, ma fuori
  dall'agenda il tasto N non fa niente.
- **Effetto**: una promessa dell'interfaccia non mantenuta.
- **Priorità**: bassa.
- **Direzione**: gestire N nella shell, o mostrare il suggerimento solo in
  agenda.

### 43. Clienti: a ogni evento si rifanno tutti i conteggi delle etichette

- **Dove**: `frontend/apps/dashboard/src/sections/clienti/index.jsx`, l'effetto
  dei conteggi per etichetta (dipende da `refreshKey`).
- **Cosa succede**: ogni `client.created`, `client.updated`, `client.deleted`,
  `client.imported` o `client_category.*` fa ripartire una richiesta per
  «Attivi» e una per ogni etichetta, oltre alla lista. Con 10 etichette sono 12
  richieste per evento, su ogni postazione aperta sulla sezione.
- **Effetto**: carico inutile su server e rete nelle ore di punta.
- **Priorità**: bassa (prestazioni).
- **Direzione**: un endpoint che dà tutti i conteggi in una risposta, o
  ricalcolarli solo quando cambiano le etichette.

### 44. Impostazioni: l'esito del collegamento Yourang nella lingua di prima

- **Dove**: `frontend/apps/dashboard/src/sections/impostazioni/index.jsx`,
  `usePopupMessage(YOURANG_MSG, …)` con dipendenze `[isOwner]`.
- **Cosa succede**: la funzione che mostra il toast si registra con il `t` del
  momento e non si aggiorna al cambio lingua. La lingua si cambia proprio in
  questa pagina: si passa da IT a EN, poi «Collega Yourang», e il toast dice
  «Yourang collegato». `PaymentsDrawer.jsx` ha lo stesso schema, ma lì non
  capita: il pannello si apre dopo la scelta della lingua ed è modale.
- **Effetto**: un avviso nella lingua sbagliata.
- **Priorità**: bassa.
- **Direzione**: mettere `t` fra le dipendenze, o leggere la funzione più
  recente da un ref (come fa `useLatest`).

### 46. Comunicazioni: cambiando filtro resta per un attimo la lista vecchia

- **Dove**: `frontend/apps/dashboard/src/sections/comunicazioni/index.jsx`,
  `fetchList`.
- **Cosa succede**: la risposta superata viene scartata, ma il suo `finally`
  spegne comunque il caricamento. Se si cambia filtro mentre una richiesta è in
  volo, quella vecchia toglie lo scheletro e a schermo resta la lista del
  filtro di prima finché non arriva la nuova.
- **Effetto**: per un momento il filtro dice «Bozze» e la lista mostra le
  campagne inviate.
- **Priorità**: bassa.
- **Direzione**: spegnere il caricamento solo se la richiesta è ancora
  l'ultima (`req.isLatest`).

### 47. «Copia»: toast «Copiato» anche quando la copia non riesce

- **Dove**: `frontend/apps/dashboard/src/sections/impostazioni/lib.jsx`,
  `CopyField` (link dell'app clienti, link del modulo contatti, token d'invito
  in `TeamDrawer.jsx`); lo stesso schema in
  `frontend/apps/dashboard/src/sections/automazioni/controls.jsx`,
  `DkCopyField` (URL del webhook).
- **Cosa succede**: la promessa di `navigator.clipboard.writeText` non viene
  attesa. Se la copia è rifiutata (permesso negato, pagina non sicura, niente
  clipboard) resta una rejection non gestita, e il toast di successo parte lo
  stesso. L'agenda ha già `copyText`
  (`frontend/apps/dashboard/src/sections/agenda/modals/rules.js`), che attende
  l'esito e prova un ripiego.
- **Effetto**: il titolare incolla quello che aveva negli appunti prima, per
  esempio al posto del link d'invito per una collega.
- **Priorità**: bassa.
- **Direzione**: usare `copyText` e mostrare l'esito vero.

## Agenda (dashboard)

### 48. Pinch e ⌘-rotella non zoomano la vista settimana

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/hooks/useGridZoom.js`
  (l'effetto che registra il listener `wheel`) e
  `frontend/apps/dashboard/src/sections/agenda/WeekView.jsx` (lo scheletro
  quando `days === null`).
- **Cosa succede**: il listener si registra una volta sola, dopo il primo
  disegno, sul contenitore che c'è in quel momento. In settimana il primo
  disegno è lo scheletro, che non ha il ref: il listener non si aggancia mai,
  perché `onZoom` e `scrollRef` non cambiano. Anche il cambio di settimana passa
  dallo scheletro e rimonta il contenitore. In vista giorno funziona, perché lì
  lo scheletro lo disegna la pagina e non `DayGrid`.
- **Effetto**: in settimana il pinch del trackpad ingrandisce tutta la pagina
  del browser invece della griglia.
- **Priorità**: media.
- **Direzione**: registrare il listener con un ref a funzione, o far dipendere
  l'effetto dalla griglia pronta.

### 49. Gesto riuscito, ricarica fallita: compare un errore

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/hooks/useAgendaMutations.js`,
  `splitItem`, `movePause`, `resizePause`, `deletePause`, `resizeItem`,
  `addBreak`.
- **Cosa succede**: dopo la scrittura riuscita, e spesso dopo il toast di
  successo, `await fetchDay()` sta nello stesso `try`: se la ricarica fallisce,
  il `catch` mostra l'errore come se il gesto non fosse riuscito. `moveAppt`
  invece ricarica con `.catch`.
- **Effetto**: la reception vede «Errore di rete» e rifà il gesto: una seconda
  pausa, o un secondo stacco che il server rifiuta. Il toast del gesto
  riuscito, con il suo «Annulla», sparisce.
- **Priorità**: media.
- **Direzione**: ricaricare fuori dal `try`, o con `.catch` come in `moveAppt`.

### 50. Clic per prenotare: la settimana arrotonda, il giorno tronca

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/WeekView.jsx`,
  `minutesFrom` (`Math.round`);
  `frontend/apps/dashboard/src/sections/agenda/DayGrid.jsx`, `onColumnClick`
  (`Math.floor`).
- **Cosa succede**: con fasce da 30 minuti, un clic alle 10:50 in vista giorno
  apre le 10:30 (la fascia cliccata), in vista settimana le 11:00.
- **Effetto**: la prenotazione parte da un orario diverso da quello cliccato, e
  le due viste si comportano in modo diverso.
- **Priorità**: bassa.
- **Direzione**: la stessa regola nelle due viste (la fascia sotto il
  puntatore, come in vista giorno).

### 51. Vista giorno: nessuna riserva su `window` per il rilascio del trascinamento

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/DayGrid.jsx` (chiama
  `useGridDrag` senza `windowUpRef`);
  `frontend/apps/dashboard/src/sections/agenda/hooks/useGridDrag.js`.
- **Cosa succede**: `WeekView` passa `windowUpRef` e ascolta `pointerup` e
  `pointercancel` anche su `window`; `DayGrid` no. Tutte e due catturano il
  puntatore, quindi la differenza conta solo dove la cattura non è supportata o
  si perde.
- **Effetto**: in quei casi il blocco resta attaccato al puntatore dopo il
  rilascio.
- **Priorità**: bassa.
- **Direzione**: passare `windowUpRef` anche da `DayGrid`.

### 52. Nuovo appuntamento: i pulsanti degli orari si rimontano a ogni disegno

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/modals/newappt/TimeStep.jsx`,
  `SlotChip` (definito dentro `TimeStep`).
- **Cosa succede**: `SlotChip` è un componente nuovo a ogni render, quindi
  React rimonta tutti i pulsanti degli orari a ogni disegno (lo dice anche il
  commento nel codice).
- **Effetto**: chi usa la tastiera perde il fuoco dopo ogni scelta; lavoro
  inutile a ogni aggiornamento del pannello.
- **Priorità**: bassa.
- **Direzione**: portare `SlotChip` fuori da `TimeStep`, con i dati che servono
  passati come props.

## Test

### 54. Ruoli di prova con i nomi dei ruoli di sistema

- **Dove**: 27 chiamate a `Role.objects.create` con `name` «Manager», «Front
  desk» o «Operatrice», nei test di agenda, accounts, automations, clients,
  core, marketing, sales e staff (per esempio `backend/apps/agenda/tests/base.py`,
  `backend/apps/sales/tests/test_sales.py`).
- **Cosa succede**: i test creano ruoli con i nomi di quelli di sistema ma con
  altri permessi (un «Manager» con la sola agenda). Il nome del ruolo è unico
  nel salone: oggi i test passano perché i saloni di prova nascono senza ruoli
  di sistema.
- **Effetto**: se una base di test passasse da `create_salon_foundation` (o da
  `ensure_default_roles`), questi test si romperebbero con un
  `IntegrityError`; e chi li legge crede di provare il ruolo vero.
- **Priorità**: bassa (test).
- **Direzione**: nomi di prova diversi da quelli di sistema.

### 55. `CatalogueRaceTests` azzera solo una parte di `FakeHttp`

- **Dove**: `backend/apps/integrations/tests/test_sync.py`,
  `CatalogueRaceTests`; `FakeHttp` in `backend/apps/integrations/tests/base.py`.
- **Cosa succede**: lo stato di `FakeHttp` sta sulla classe (`instances`,
  `contacts`, `missing_route`); il test riassegna solo `instances`, e gli altri
  campi restano quelli lasciati dal test precedente. Oggi è innocuo: la sync del
  catalogo non tocca i contatti.
- **Effetto**: un test il cui esito può dipendere dall'ordine, se un giorno
  legge quei campi.
- **Priorità**: bassa (test).
- **Direzione**: azzerare tutto lo stato di `FakeHttp` in un `setUp`, o con un
  metodo `reset` della classe.

### 56. `test_processing_failure_asks_for_a_retry` passa anche con la sostituzione muta

- **Dove**: `backend/apps/integrations/tests/test_webhook.py`,
  `WebhookRouteTests.test_processing_failure_asks_for_a_retry`.
- **Cosa succede**: il test sostituisce `apps.integrations.sync.import_event`
  con un errore e si aspetta 503. Oggi la sostituzione arriva al codice
  (`webhooks.dispatch` chiama `sync.import_event` attraverso il modulo), e il
  test si accorge se si toglie il 503 (provato su una copia). Ma non controlla
  che il finto sia stato chiamato: su una copia in cui `webhooks.py` importa il
  nome direttamente (`from .sync import import_event`) il test passa lo stesso,
  perché anche la vera `import_event` fallisce nel test («Nessun refresh token:
  riconnessione necessaria»).
- **Effetto**: se cambia il modo in cui il webhook chiama la sync, il test
  resta verde senza provare più niente. È la regola di `CLAUDE.md`: verificare
  che il mock sia stato chiamato.
- **Priorità**: bassa (test).
- **Direzione**: `with patch(...) as fake:` e poi `fake.assert_called_once()`.

## Trovati durante la verifica

### 57. (nuovo) L'avvio pubblico di «Accedi con Yourang» scrive una riga a ogni chiamata, senza limite

- **Dove**: `backend/apps/integrations/api.py`, `oauth_login_start`
  (`auth=None`), che chiama `start_flow` in `backend/apps/integrations/oauth.py`.
- **Cosa succede**: l'endpoint è pubblico e ogni chiamata crea una riga
  `YourangOAuthState`. Gli altri endpoint pubblici che scrivono (registrazione,
  richiesta del codice, modulo contatti) hanno un tetto per IP
  (`backend/common/ratelimit.py`); questo no, e le righe mai usate non si
  cancellano (voce 16). Uno script che lo chiama in ciclo riempie la tabella.
- **Effetto**: una tabella che chiunque può far crescere senza fine.
- **Priorità**: media.
- **Direzione**: un tetto per IP sull'avvio del login, insieme alla pulizia
  degli state scaduti della voce 16.

## Non confermati

- **13 (in parte)**: l'etichetta cliente (`CategoryIn` in
  `backend/apps/clients/schemas.py`) non è toccata: il `pattern` di pydantic
  rifiuta «#AABBCC\n» (provato).
- **18**: in `backend/common/auth.py` (`StaffAuth`) un token senza `sub` o
  `salon` darebbe `KeyError`, ma serve un token «staff» firmato con la chiave
  del server, e `create_staff_tokens` mette `sub` e `salon` da sempre: non
  raggiungibile. Il rinnovo (`backend/apps/accounts/api/staff.py`) usa già
  `.get()`: si può allineare quando si tocca il file.
- **19**: l'avviso «scheda archiviata» è scritto due volte
  (`notify_archived_client` in `backend/apps/clients/hook.py`,
  `_notify_archived_client` in `backend/apps/accounts/api/client.py`), ma la
  stessa chiave e la stessa finestra sono volute (un avviso al giorno fra app e
  modulo); i testi cambiano solo per dire da dove arriva la richiesta, e il
  payload solo per `source: "hook"`, che nessuno legge. È una duplicazione da
  unificare, non un bug.
- **28**: `public_branding` (`backend/apps/core/api.py`) non ha un tetto per IP,
  ma legge solo dati pubblici e non scrive niente; un tetto costerebbe una
  scrittura a ogni apertura dell'app. È una scelta, non un difetto.
- **30**: `to_cents(None)` in Stripe non esiste più: la copia di
  `stripe_service` è stata sostituita da `common.money.to_cents`, che vale 0
  per `None`, e i due chiamanti controllano prima che l'importo sia maggiore di
  zero.
- **36**: il `toFixed(2)` della gift card nell'app non riceve mai tre decimali:
  `NumInput` (`frontend/packages/shared/src/ui/NumInput.jsx`) tronca l'importo
  a due decimali mentre si scrive.
- **37**: il riepilogo di `GroupBookingDrawer.jsx` senza ripiego su `name_it` si
  vede solo a gruppo creato, quando ogni voce ha già `service_name` dal server:
  il ramo con `name_en` non si raggiunge.
- **38**: «€NaN» di `fmtEurNoFree` (le famiglie `money` ed `eur0`): nessun
  chiamante passa un importo mancante (campi obbligatori dell'API, valori
  calcolati, `|| 0` o condizioni `> 0`; l'`eur0` del magazzino passa da `num`).
- **40**: `AnalystDrawer` è davvero salvato già costruito nello stato
  (`frontend/apps/dashboard/src/shell/Shell.jsx`), ma il pannello è modale e la
  lingua si cambia solo da Impostazioni: con il pannello aperto non si può
  cambiare.
- **44 (in parte)**: `PaymentsDrawer.jsx` non è toccato, perché si apre dopo la
  scelta della lingua ed è modale.
- **45**: i KPI della pagina Profilo non ripartono in pratica: la lingua si
  cambia solo da Impostazioni, e intanto la sezione Profilo non è montata (la
  shell ne monta una alla volta).
- **53**: `weekGhostSpans` non ordina per `order`, ma il server manda già i
  servizi in ordine (`Meta.ordering` di `AppointmentService`), quindi il
  risultato è giusto.
- **56 (in parte)**: `RegisterSalonCapTests` e `RegisterDoubleSubmitTests` non
  sono ciechi: sostituiscono i nomi in `apps.accounts.api.client`, dove il
  codice li legge, e su una copia falliscono se si toglie il tetto per salone,
  se lo si conta prima del controllo sul numero, o se si toglie la gestione
  dell'`IntegrityError`.

## Trovati durante le correzioni

### 58. Nuova prenotazione: «selezionato» sull'orario non più scelto

- **Dove**: `frontend/apps/dashboard/src/sections/agenda/modals/newappt/TimeStep.jsx`,
  pannello verde dell'orario chiesto.
- **Cosa succedeva**: cliccato in agenda un orario libero (10:00) e scelto un altro
  da «Altri orari» (10:30), il pannello diceva ancora «10:00–10:30 · Disponibile ·
  selezionato»; la prenotazione partiva comunque alle 10:30.
- **Priorità**: bassa.

### 59. Import: un'etichetta di oltre 60 caratteri fa rifiutare le righe

- **Dove**: `backend/apps/clients/importer.py`, `category_for`.
- **Cosa succedeva**: si cercava il nome intero ma si creava quello troncato a 60
  caratteri; alla riga successiva con la stessa etichetta la creazione ripartiva e
  il database la rifiutava («UNIQUE constraint failed»).
- **Priorità**: media.

### 60. Modifica di un'etichetta in gara con la sua cancellazione

- **Dove**: `backend/apps/clients/labels.py`, `update_label`.
- **Cosa succedeva**: il `save()` completo, arrivato dopo la cancellazione da
  un'altra postazione, ricreava l'etichetta.
- **Priorità**: bassa.

### 61. Altri campi senza limite contro colonne strette (stessa classe della 21)

- **Dove**: schemi di catalogo, magazzino, staff ed etichette: nomi di categorie e
  pacchetti, `reason` di carico e scarico, `order` delle etichette, importi e
  quantità decimali.
- **Cosa succedeva**: un valore oltre la colonna arrivava al database, 500 su
  PostgreSQL invece di 422.
- **Priorità**: media.

### 62. Messaggi di 422 con il nome inglese del campo

- **Dove**: `frontend/packages/shared/src/apiErrors.js`, `FIELD_LABELS`.
- **Cosa succedeva**: per i campi limitati nelle voci 21 e 61 (unità, quantità per
  confezione, sconto, soglia, ordine) il messaggio mostrava il nome inglese.
- **Priorità**: bassa.

## Stato delle correzioni

Tutte sul branch `claude/exciting-bohr-5ch9g7`, 24/09/2026. Il test di ogni
commit riproduce il difetto: fallisce sul codice di prima e passa dopo.

| N. | Commit | Note |
|---|---|---|
| 1 | `bbcd4d8` | «Indietro» su un no-show con caparra da pagare manda un link nuovo |
| 2 | `36e81b0` | `deposit.paid` ha gli stessi campi online e al banco; si sono solo aggiunti campi |
| 3 | `e614c32`, `d766bcc` | fra i match c'è anche chi aspettava il servizio tolto o staccato |
| 4 | `43f49d6`, `bd968d6` | vale anche per «Indietro» e per lo stacco del primo servizio |
| 5 | `3cf4b61`, `dcbba65`, `b330d70` | «Indietro» la rimette richiesta con una scadenza nuova; il rilascio salta le righe già a 0 € |
| 6 | `610aeda` | limite: una pausa lasciata apposta sopra una visita non si rimette con «Indietro» (409) |
| 7 | `d704b8b` | |
| 8 | `1d761ed` | i SetupIntent creati prima del deploy non hanno `acct`: si confrontano come prima |
| 9 | `cc07b51` | |
| 10 | `9467e35`, `7daf7a3`, `5a72643`, `acd71f4` | rimborso fuori dal lock; una riga «in corso» ferma da più di 10 minuti si riprende; nel frattempo il webhook risponde 503 e Stripe riprova |
| 11 | `c379327`, `d678667` | anche una vendita senza cliente, come in cassa |
| 12 | `39b28c5` | «gift_card» resta un metodo ammesso per pagare una gift card: scelta di prodotto |
| 13 | `92f7323`, `cffa308` | |
| 14 | `a7aa52d`, `4ac08c4` | migrazione `accounts 0006` per i saloni già esistenti: crea solo i ruoli mancanti, all'indietro non li toglie |
| 15 | `db4ed73` | una data nel formato sbagliato resta ignorata, come prima |
| 16 | `0fd0806` | |
| 17 | `b272c23` | il logger si chiama ora `youty.accounts` |
| 20 | `f4e9f39` | |
| 21 | `b62c10b` | vedi anche la 61 |
| 22 | `4472e89` | |
| 23 | `a46a9b8` | |
| 24 | `d6765e1` | cambiano i nomi dei componenti OpenAPI, non le forme |
| 25 | `cf80722` | |
| 26 | `eb75052`, `fae3622` | i salvataggi da /admin/ di regole e automazioni non prendono il lock |
| 27 | `018eae1` | |
| 29 | `10cde54` | |
| 31 | `04f1225` | |
| 32 | `e37b8e6` | |
| 33 | `cd87988` | |
| 34 | `3acd758` | |
| 35 | `28738f0` | |
| 39 | `ff729d5` | |
| 41 | `def6851` | |
| 42 | `3c6044f` | il tasto N prenota da ogni sezione, come il pulsante |
| 43 | `bd02803` | endpoint nuovo `GET /api/clients/counts` |
| 44 | `b6b6653` | |
| 46 | `1c1be72` | |
| 47 | `c5d57c1` | `copyText` ora sta in `@youty/shared` |
| 48 | `403b994` | |
| 49 | `d0fc821` | |
| 50 | `3ce4cfb` | |
| 51 | `9821e90` | |
| 52 | `c13bc0b` | |
| 54 | `c8a69e3` | lo controlla `common/tests/test_role_names.py` |
| 55 | `f3f94b8` | |
| 56 | `a994a9b` | |
| 57 | `aa75c18` | 30 avvii ogni 15 minuti per IP |
| 58 | `0d8cb2f` | |
| 59 | `6dfc9d3` | |
| 60 | `d54d8de` | |
| 61 | `142dfb2` | |
| 62 | `54203d7` | |

Restano fuori, per scelta: la 19 (l'avviso «scheda archiviata» scritto in due
posti, da unificare) e le altre voci «Non confermati».
