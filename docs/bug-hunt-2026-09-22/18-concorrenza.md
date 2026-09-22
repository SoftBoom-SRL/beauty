# Revisore 18 — concorrenza e integrità dei dati

Probe (non cancellato su richiesta dell'orchestratore): `backend/apps/agenda/tests_probe_18concorrenza.py`
(`.venv/bin/python manage.py test apps.agenda.tests_probe_18concorrenza`, stampa gli esiti con prefisso [D1], [D2], …).

### [ALTO] 18-01 «Torna indietro» su una creazione con caparra: il link di pagamento resta vivo e il pagamento finisce nel nulla
- File: `backend/apps/agenda/undo.py:240-258` (`_delete_appointment` non chiude la sessione Checkout), `backend/apps/agenda/api.py:567` (`_maybe_deposit_link` subito dopo la create), `backend/apps/sales/stripe_service.py:347` (`deposit.payment_link` mai trattenuto né fuso), `backend/apps/sales/api.py:513-515` (webhook: appuntamento non trovato → `return` muto)
- Stato: CONFERMATO (probe [D1]: evento link `pending`, `Session.expire` mai chiamata, webhook 200 senza rimborso né riga di registro)
- Difetto: la conferma è trattenuta 30 s e sparisce con l'undo, ma il link caparra parte subito e la sessione Stripe resta aperta; l'appuntamento viene cancellato fisicamente.
- Scenario: regola caparra attiva, Stripe configurato; il banco crea l'appuntamento sulla cliente sbagliata e preme «Annulla». La cliente riceve solo il link, paga 15 €: incasso su Stripe senza appuntamento, senza vendita, senza log, senza rimborso.
- Correzione: in `_delete_appointment` chiamare `expire_deposit_checkout` (a lock rilasciato) e rifiutare/marcare; nel webhook, pagamento per appuntamento inesistente → rimborso automatico e log.

### [ALTO] 18-02 `phone_key` scritta con l'algoritmo del 17/09 e mai ricalcolata dopo la modifica di `normalize_phone` (9991cb5)
- File: `backend/apps/clients/migrations/0006_backfill_phone_key.py` (importa il codice vivo di `common.phone`, girata col vecchio algoritmo), `backend/common/phone.py:30-75` (nuova regola `_already_international`), `backend/common/phone.py:128-135` (il ripiego in memoria guarda solo `phone_key=""`), `backend/apps/clients/models.py:95-104`
- Stato: CONFERMATO nel meccanismo (probe [PK]); la diffusione dipende da quante schede pre-17/09 hanno il numero salvato grezzo «39…» senza «+» (formato tipico degli export)
- Difetto: per «393331234567» la chiave salvata è «39393331234567», quella calcolata oggi «393331234567»: nessuna migrazione le riallinea.
- Scenario: la cliente importata prima del 17/09 chiede l'OTP → `find_client_by_phone` → None, nessun codice parte; si registra di nuovo → seconda scheda (200); poi archiviare/modificare la scheda vecchia ricalcola la chiave e urta `uniq_client_salon_phone_key` → IntegrityError (500 su `DELETE /api/clients/{id}`, 400 «telefono già registrato» sul PUT, 500 sul webhook Stripe che salva quella scheda).
- Correzione: migrazione dati che ricalcola `phone_key` di tutte le schede (segnalando i conflitti), e `check_phone_duplicates` che confronti anche la colonna salvata.

### [MEDIO] 18-03 Undo del no-show dopo l'addebito della carta: l'appuntamento torna confermato con la vendita no-show attaccata e il conto non si chiude più
- File: `backend/apps/agenda/undo.py:281-306` (controlla solo `closed` e lo snapshot, non vendite né `no_show_payment_intent_id`), `backend/apps/sales/services.py:421-433`, `backend/apps/sales/api.py:181`
- Stato: CONFERMATO (probe [D2]: undo 200, stato confirmed, 1 vendita legata, checkout 400 «già incassato»)
- Scenario: no-show segnato, addebito no-show, la cliente arriva in ritardo e si preme «Annulla»: carta addebitata, visita confermata, cassa bloccata.
- Correzione: in `perform` rifiutare (409) se l'appuntamento ha `sale`/`deposit_sale` o un PaymentIntent no-show, come già fa `_delete_appointment`.

### [MEDIO] 18-04 La fusione degli eventi trattenuti perde informazione verso la cliente e la lista d'attesa
- File: `backend/apps/agenda/services.py:916-933` (terminale sostituisce gli eventi trattenuti; fusione riscrive tutto il payload), `:946-970` (`revert_held_events` scarta il terminale senza ripristinare ciò che aveva sostituito), `:2102-2103` (`free_slot_event` sostituisce lo slot liberato precedente)
- Stato: CONFERMATO (probe [D3] e [MM])
- Scenario A: conferma già partita (10:00) → sposto alle 15:00 (trattenuto) → «annulla» per sbaglio (sostituisce lo spostamento) → «torna indietro» (sostituisce l'annullamento): appuntamento alle 15:00, nessun evento da consegnare, la cliente sa 10:00.
- Scenario B: 10→11→12 entro la trattenuta: parte «spostato dalle 11:00» (la cliente sapeva 10:00) e slot.freed solo per le 11:00; le 10:00 libere non vengono mai proposte alla lista d'attesa.
- Correzione: conservare `old_start` del primo evento fuso; in `revert_held_events` dopo un terminale riemettere lo stato ripristinato; slot.freed: sostituire solo se lo slot è tornato occupato.

### [MEDIO] 18-05 L'outbox non rispetta l'ordine per oggetto: un evento in ritentativo parte dopo uno più recente dello stesso appuntamento/automazione
- File: `backend/apps/core/management/commands/flush_outbox.py:192-211`, `backend/apps/core/services.py:106-112` (`attempts=0`: gli eventi in ritentativo non si fondono)
- Stato: CONFERMATO (probe [E2]: ordine di consegna moved 15:00 → created 10:00)
- Scenario: Yourang giù un minuto: la conferma fallisce e va in attesa; lo spostamento successivo parte per primo quando Yourang torna; poi arriva la conferma vecchia → l'ultimo messaggio dice l'orario sbagliato. Stesso effetto su `automation.updated` (una disattivazione superata da una definizione vecchia).
- Correzione: non consegnare un evento se esiste un evento più vecchio con la stessa `coalesce_key` (o stesso oggetto) ancora pending/in ritentativo.

### [MEDIO] 18-06 PUT dell'appuntamento con id di riga non più esistenti: i servizi vengono riprezzati dal listino senza errore
- File: `backend/apps/agenda/services.py:1152-1153` (ogni modifica cancella e ricrea le righe con id nuovi), `backend/apps/agenda/undo.py:226-236` (anche ogni undo), `backend/apps/agenda/services.py:675-721` (`previous=None` → prezzo e posa di listino), `frontend/apps/dashboard/src/sections/agenda/index.jsx:486-490`
- Stato: CONFERMATO (probe [ID]: dopo la modifica di A, il ridimensionamento di B con id vecchi porta il prezzo da 50 a 70 e la posa da 0 a 20)
- Scenario: una collega modifica (o annulla un gesto su) la visita; l'altra postazione, con la vista di pochi secondi prima, allunga il servizio: prezzo concordato perso, buco fra servizi cambiato.
- Correzione: id che non appartiene alla visita → 409 (vista vecchia) invece di «servizio nuovo»; oppure aggiornare le righe esistenti invece di ricrearle.

### [MEDIO] 18-07 Salvataggi completi e decisioni su copie lette a inizio richiesta (classe)
- File: `backend/apps/marketing/api.py:131-148` (`update_coupon`: `save()` completo), `backend/apps/clients/api.py:306` (`update_client` + corpo completo di `toClientIn`: consensi, etichette, `is_active`, `reliability` della copia del frontend; riscrive anche `stripe_*` scritti dal webhook), `backend/apps/accounts/api.py:743` (`client_update_me`), `backend/apps/clients/services.py:247`, `backend/apps/core/api.py:218,259` (impostazioni e logo: riscrivono `stripe_account_id`), `backend/apps/catalog/api.py:212` (`yourang_item_id` della sync), `backend/apps/integrations/login.py:147`, `backend/apps/integrations/api.py:139`, `backend/apps/marketing/api.py:562`, `backend/apps/agenda/services.py:1761-1780` (`mark_deposit_refunded` senza lock né rilettura), `backend/apps/automations/api.py:210` (toggle su copia)
- Stato: CONFERMATO per il coupon (probe [CP], interleaving simulato: il buono consumato in cassa torna `active` e riutilizzabile); PLAUSIBILE per gli altri (finestra di pochi ms, o di minuti per il corpo completo del frontend)
- Correzione: `save(update_fields=[…])` con i soli campi del payload; coupon: UPDATE filtrato su `status=active`.

### [BASSO] 18-08 `lock_salon()` con FOR UPDATE: deadlock con chi blocca un appuntamento e poi committa righe legate al salone
- File: `backend/apps/agenda/services.py:193` e `backend/apps/inventory/services.py:24` (FOR UPDATE, non NO KEY UPDATE); controparti che bloccano prima l'appuntamento: `backend/apps/sales/api.py:166` (checkout), `:587` (webhook caparra), `backend/apps/agenda/services.py:1687` (`record_deposit_refund`), `:1952` (rilascio caparra, il join FOR UPDATE blocca appuntamento→cliente→salone)
- Stato: PLAUSIBILE (semantica PostgreSQL 16 di produzione; SQLite dei test non lo vede)
- Difetto: le FK di Django su Postgres sono DEFERRABLE INITIALLY DEFERRED: al COMMIT chi ha inserito Sale/ActivityLog/OutboxEvent prende FOR KEY SHARE sul salone, incompatibile col FOR UPDATE di `lock_salon`.
- Scenario: checkout (lock riga X) in corso mentre una collega sposta/modifica/annulla X (lock salone → UPDATE X): X aspetta il salone al commit, la mutazione aspetta X → deadlock → 500 a uno dei due (idem webhook caparra, rilascio caparra sulla GET agenda, «Genera ordini» contro una vendita di prodotto).
- Correzione: ordine di lock uniforme (tutti prendono `lock_salon` prima della riga), oppure `select_for_update(no_key=True)` sul salone PIÙ `select_for_update` dell'appuntamento in `_lock_and_reload` (altrimenti torna la scrittura su copia vecchia).

### [BASSO] 18-09 Worker outbox: `_claim` non ricontrolla la scadenza e `deliver_event` invia il payload letto prima del claim
- File: `backend/apps/core/management/commands/flush_outbox.py:161-180`, `:114-153`; fusione in `backend/apps/agenda/services.py:930-932`
- Stato: CONFERMATO con interleaving simulato (probe [E]: parte 10:00 invece di 15:00, a db il payload fuso viene riscritto con quello vecchio)
- Scenario: una fusione prende il lock un attimo prima della scadenza e committa dopo che il worker ha letto la lista: il worker aspetta il lock, poi invia la copia vecchia ignorando la trattenuta allungata.
- Correzione: nel claim filtrare anche `_due(now)` e rileggere `payload`/`event_type` dopo il claim.

### [BASSO] 18-10 Cursore del feed live su id autoincrementale: eventi committati fuori ordine saltati per sempre
- File: `backend/apps/core/views.py:189-196`, `backend/apps/core/api.py:405-418`
- Stato: PLAUSIBILE (Postgres: id assegnato all'INSERT, visibile al COMMIT)
- Scenario: il checkout scrive `sale.created` (id 100) e committa pochi ms dopo; nel frattempo un log in autocommit (id 101) è già visibile; lo stream legge 101, cursore 101: il 100 non arriva mai, nemmeno col controllo di coerenza a 30 s (stesso cursore).
- Correzione: rileggere una finestra di sicurezza (id > cursore − N o created_at recenti) deduplicando lato client.

### [BASSO] 18-11 `ensure_customer` non idempotente: due Customer Stripe e carta sul cliente sbagliato
- File: `backend/apps/sales/stripe_service.py:152-185`, `backend/apps/sales/api.py:788-815` (il webhook non verifica il `customer` del SetupIntent)
- Stato: CONFERMATO nel meccanismo (probe [ST]: SetupIntent per cus_B e cus_A, a db resta cus_A)
- Scenario: doppio tocco su «salva carta» (o salvataggio carta e addebito no-show insieme): la carta si aggancia a un customer diverso da quello salvato → addebito no-show rifiutato da Stripe.
- Correzione: lock della riga cliente (o idempotency key per cliente) e salvare nel webhook anche il customer.

### [BASSO] 18-12 Registrazione dall'app: doppio invio = 500 (correzione L20 del 18/09 incompleta)
- File: `backend/apps/accounts/api.py:596-609`
- Stato: CONFERMATO (probe [REG]: IntegrityError non gestita)
- Scenario: doppio tocco su «Registrati», o registrazione mentre la stessa persona compila il form pubblico: la seconda richiesta esplode (create_client e public_hook invece la gestiscono).
- Correzione: `transaction.atomic()` + `except IntegrityError` → 400 «numero già registrato».

### [BASSO] 18-13 `cancel_event` (Yourang) annulla con `queryset.update` saltando la logica di dominio
- File: `backend/apps/integrations/sync.py:513-515`
- Stato: PLAUSIBILE
- Scenario: evento cancellato su Yourang dopo che il salone ha chiuso il conto: l'appuntamento chiuso e incassato diventa «annullato», nessun slot.freed, nessun registro/SSE, eventi trattenuti non sostituiti (a differenza di `_merged_status` in import).
- Correzione: passare da `cancel_appointment` (o almeno filtrare gli stati aperti).

### [BASSO] 18-14 `replace_shifts`: cancella-e-ricrea senza lock, due salvataggi concorrenti raddoppiano i turni
- File: `backend/apps/staff/api.py:337-351`
- Stato: PLAUSIBILE (Postgres READ COMMITTED: il secondo DELETE non vede le righe inserite dal primo)
- Scenario: due schermate salvano i turni della stessa operatrice: restano entrambe le serie, sovrapposte, cosa che `_reject_overlapping_shifts` vieta (pausa pranzo che sparisce).
- Correzione: `select_for_update` sulla riga dell'operatrice prima del delete.

### [BASSO] 18-15 Primo accesso Yourang non atomico: due accessi simultanei della stessa org → 500
- File: `backend/apps/integrations/login.py:116-147`
- Stato: PLAUSIBILE
- Scenario: doppio clic su «Accedi con Yourang» al primo accesso: slug salone/utente/vincolo org in corsa → IntegrityError non gestita.
- Correzione: transazione con lock (o gestione dell'IntegrityError rileggendo la connessione).

Aree controllate senza reperti: `select_for_update` fuori transazione (nessuna occorrenza: `held_events(lock=True)`, `lock_salon`, tutti i `select_for_update` stanno dentro `atomic`); `select_for_update` su join nullable (nessuno; il join di `process_deposit_holds` è INNER); correzioni 9991cb5 L1 (checkout riletto sotto lock), L2, L3 (fedeltà con lock e F()), L4 (gift card), L5 (rimborsi), L7 (restore), L14 (coupon in cassa), L16 (claimed_at), L20 per create_client e hook; `get_or_create` con vincoli (gestiti); `ratelimit.hit` atomico; rotazione refresh token con UPDATE condizionale; `_apply_deposit_payment` idempotente; `process_deposit_holds` (rilascio con rilettura, sollecito con UPDATE condizionale); `flush_outbox` in parallelo con sé stesso (claim condizionale, stale claims); chiamate Stripe tutte fuori dalle transazioni; doppio «Annulla» sullo stesso gesto (il secondo trova lo stato cambiato → 409); migrazioni integrations 0004, sales 0002/0003, core 0006/0009, agenda 0009/0010 (nessun vincolo che fallisce sui dati, a parte 18-02).
