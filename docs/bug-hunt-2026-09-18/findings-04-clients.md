# Bug hunt — apps/clients + common/phone.py

## [D1] Import CSV: il match per email scatta anche quando la riga ha un suo telefono → più persone fuse in una sola scheda
- **Gravità**: alto
- **Dove**: backend/apps/clients/services.py:188-190 (fallback email), 203-204 (sovrascrittura telefono), 233-234 (`by_email` popolata anche dalle righe appena create)
- **Cosa**: `client = by_phone.get(phone_key(phone)) if phone else None` e poi `if client is None and email: client = by_email.get(email.lower())`. Il fallback per email vale anche per le righe che hanno un telefono proprio e semplicemente non corrispondono a nessuno: la riga viene trattata come «cliente già esistente» e sovrascrive nome, cognome, email e perfino il telefono (riga 203-204) della scheda trovata per email. L'intenzione documentata è l'opposto (docstring riga 130-133, test `test_import_matches_by_email_when_no_phone_match` usa `phone: ""`, l'avviso del frontend dice «senza telefono: verrà cercato per email»).
- **Scenario**: file esportato da un gestionale che mette lo stesso indirizzo su tutte le schede senza email (`info@salone.it`, `noreply@…`) — oppure madre e figlia con la stessa email. Riga 1 crea la cliente A e registra `by_email["info@salone.it"] = A`. Riga 2 ha un telefono nuovo (nessun match su `by_phone`), trova A per email, entra nel ramo update e riscrive nome/cognome/email di A e, poiché la sua chiave telefono non è in `by_phone`, anche `A.phone`. Idem per le righe 3…250. Alla fine esiste UNA scheda con i dati dell'ultima riga; la risposta è `{"created": 1, "updated": 249, "skipped": 0, "errors": []}` e la modale mostra «1 nuovo · 249 aggiornati». 249 clienti non sono mai stati creati e nessun errore lo segnala.
- **Fix**: usare `by_email` solo quando la riga non ha telefono; in ogni caso non riscrivere mai `client.phone` su un match per email.

## [D2] `normalize_phone` antepone il prefisso anche a un numero già internazionale senza «+» → cliente doppia e numero non raggiungibile
- **Gravità**: alto
- **Dove**: backend/common/phone.py:44-51 (`digits = default_cc + s`)
- **Cosa**: una stringa che non inizia per `+` né per `00` riceve sempre `39` davanti. `"393331234567"` (forma E.164 senza il più, usatissima negli export e in WhatsApp) diventa `"+39393331234567"`, con `phone_key` `39393331234567`, diverso da quello della stessa persona salvata come `+393331234567`. La regola corretta esiste già nel frontend, che la dichiara obbligatoriamente allineata al backend: `packages/shared/src/phone.js:107-119` («Un numero nazionale italiano non supera le 11 cifre: oltre, è un numero internazionale salvato senza "+"»).
- **Scenario**: import di un CSV la cui colonna telefono contiene `39 333 1234567` (il frontend invia le cifre così come sono, `cleanPhone` toglie solo i separatori). La cliente esiste già come `+393331234567`: `find_client_by_phone` non la trova, nasce una seconda scheda con numero `+39393331234567`. Da quel momento: promemoria WhatsApp e OTP verso un numero inesistente, login dell'app cliente che non riaggancia la scheda storica, e la dashboard che — usando `splitPhone` — mostra quel valore come `+39 393 331 234 567`. Il modale di import segnala persino «stesso telefono della riga N» (la sua `phoneKey` toglie il 39) mentre il backend crea comunque due schede.
- **Fix**: in `normalize_phone`, prima di anteporre `default_cc`, se le cifre iniziano già con un country code noto e superano la lunghezza massima nazionale (>11 cifre per l'Italia) trattarle come internazionali, come fa `splitPhone`.

## [D3] Campi senza validazione di lunghezza/valori ammessi → 500 dal database e dati fuori dalle scelte
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:481 e 539-541 (`visibility`), 156-171 (`_client_payload` non valida `lang`, `email`, `reliability`, le lunghezze), 66 e 82-84 (categorie); schemi in backend/apps/clients/schemas.py:18-21, 68-87, 154-162
- **Cosa**: gli schemi ninja dichiarano `str` nudi e nessun endpoint applica `full_clean()`, quindi il valore arriva intatto a colonne `varchar` corte. Su Postgres questo è `DataError` non gestita (nessun exception handler in config/api.py) → HTTP 500. Quando il valore ci sta, resta scritto un valore fuori dalle `choices` del modello.
- **Scenario**: `POST /api/clients/{id}/notes {"text":"x","visibility":"da-condividere"}` → `ClientNote.visibility` è `varchar(10)` → 500. `PUT /api/clients/{id}` con `"lang":"italiano"` → `varchar(2)` → 500. `POST /api/clients/categories {"name":"<61 caratteri>"}` o `{"color":"rgb(255,0,0)"}` (colonne 60 e 7) → 500. Con valori più corti passa di tutto: `visibility:"shared"` è ammesso a mano in api.py:515 pur non essendo una scelta del modello, `lang:"xx"`, `reliability:5000`, `email:"non-una-email"` finiscono in archivio.
- **Fix**: vincolare gli schemi (`Literal[...]`, `constr(max_length=…)`, `EmailStr`, `conint(ge=0, le=100)`) e togliere `"shared"` dalla whitelist di `create_note_with_files`.

## [D4] `create_sheet` scrive `appointment_id` senza validarlo: FK di un altro salone, 500 su id inesistente, scheda invisibile nello storico
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:603-620 (`TechnicalSheet.objects.create(client=client, author=ctx.user, **data.dict())`)
- **Cosa**: `TechnicalSheetIn.appointment_id` finisce diritto nella create. Le note fanno il controllo (`_appointment_for`, api.py:431-439, verifica salone e cliente); le schede tecniche no.
- **Scenario**: `POST /api/clients/12/sheets {"appointment_id": 99999, ...}`. Se l'appuntamento non esiste → violazione di chiave esterna non gestita → 500. Se esiste ma è di un altro salone o di un'altra cliente → la scheda viene salvata con quel collegamento e sparisce dallo storico: `client_history` la mette in `sheets_by_appt` (api.py:386-388), quell'appuntamento non è fra quelli della cliente, e il ramo `if not sh.appointment_id` (riga 412) non la ripesca.
- **Fix**: `appointment=_appointment_for(ctx, client, data.appointment_id)` e passare il resto dei campi escludendo `appointment_id`.

## [D5] N+1 nello storico cliente: due query in più per ogni visita, più la query vendite eseguita due volte
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:285 e 396 (`_appointment_out(a)` senza indice regali), 370-378 (stessa `Sale.objects.filter` due volte)
- **Cosa**: `apps/agenda/api.py:181-184` — quando `gifts_by_client` è `None`, `_appointment_out` chiama `gift_index(appointment.salon, [appointment.client_id])`, cioè una query su `GiftCard` per ogni appuntamento; in più `appointment.salon` non è in `select_related` (solo `client` e `operator`), quindi ogni iterazione fa anche una SELECT sul salone.
- **Scenario**: apertura della scheda di una cliente con 80 visite (`/history` e `/appointments`, entrambe chiamate dal profilo): oltre 160 query aggiuntive per richiesta.
- **Fix**: calcolare una volta `gifts = gift_index(ctx.salon, [client.id])` e passarlo a `_appointment_out(a, gifts)`, aggiungere `"salon"` a `select_related`, materializzare le vendite in una sola lista.

## [D6] Il rate limit del form pubblico usa il contatore su cache (non atomico), non `common.ratelimit`
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:717-725 (`cache.get` / `cache.set`)
- **Cosa**: è lo schema leggi-poi-scrivi che `common/ratelimit.py:1-12` documenta come rotto («due richieste simultanee contavano per una») e che il resto degli endpoint pubblici ha già abbandonato in favore di `ratelimit.hit()`. `public_hook` duplica anche `client_ip` (api.py:654-665).
- **Scenario**: uno script che invia 200 richieste in parallelo a `/api/clients/public/hook` legge quasi sempre lo stesso `hits`: il contatore avanza di poche unità e il tetto di 20/ora non ferma il flood (ogni richiesta crea una `Client` e un evento outbox).
- **Fix**: `ratelimit.hit(f"hook:{salon.id}:{ratelimit.client_ip(request)}", HOOK_MAX_PER_WINDOW, HOOK_WINDOW_SECONDS)`.

## [D7] Doppio invio del form pubblico (o due creazioni contemporanee) → IntegrityError non gestita, 500
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:728-745; stesso schema in 180-181 e 211-214
- **Cosa**: controllo di esistenza e inserimento non sono nella stessa transazione né protetti da `get_or_create`; la violazione di `uniq_client_salon_phone` non è intercettata.
- **Scenario**: la cliente tocca due volte «Invia»: entrambe le richieste non trovano la scheda, entrambe creano, la seconda viola il vincolo → 500 su un endpoint che per progetto deve rispondere sempre 200 (salta la logica di non-oracolo). Idem per due addetti che salvano la stessa nuova cliente: 500 invece del 400 «Telefono già registrato».
- **Fix**: `transaction.atomic()` + cattura di `IntegrityError` con rilettura via `find_client_by_phone`.

## [D8] Identificativi Stripe scrivibili da `ClientIn` + `consents` libero: si può agganciare la carta di un'altra cliente a una scheda
- **Gravità**: medio
- **Dove**: backend/apps/clients/schemas.py:82-85 e 45-48, api.py:204-214
- **Cosa**: `PUT /api/clients/{id}` accetta e salva `stripe_customer_id` / `stripe_payment_method_id` e un `consents` libero. `GET /api/clients/` (api.py:126, senza `require_scope`) restituisce quegli identificativi per tutta l'anagrafica. `stripe_account_id` non è in `ClientIn`: per un salone sull'account di piattaforma (`""` da entrambe le parti) `ensure_customer` (apps/sales/stripe_service.py:134-135) considera valida la coppia iniettata e non la rigenera.
- **Scenario**: un addetto con permesso «clients» copia `stripe_customer_id`/`stripe_payment_method_id` della cliente A sulla scheda B insieme a `consents: {"card_charge": true}`, segna B come no-show e lancia l'addebito: il PaymentIntent parte sulla carta di A (stripe_service.py:344-365).
- **Fix**: togliere i tre campi Stripe da `ClientIn` e validare `consents` su un set chiuso di chiavi booleane.

## [D9] La ricerca clienti non trova né il nome completo né un telefono formattato
- **Gravità**: medio
- **Dove**: backend/apps/clients/api.py:138-144
- **Cosa**: filtro campo per campo (`first_name__icontains | last_name__icontains | phone__icontains | email__icontains`); il telefono in archivio è E.164 senza separatori mentre l'interfaccia lo mostra formattato.
- **Scenario**: «Sofia Ricci» nella ricerca in alto (`apps/dashboard/src/sections/clienti/index.jsx:35` passa la stringa grezza) → nessun risultato. «+39 333 123 4567» come appare sulla scheda → nessun risultato (in archivio c'è `+393331234567`). Si crea un doppione e si riceve «Telefono già registrato per un altro cliente» senza capire perché.
- **Fix**: spezzare `q` in parole in AND su nome/cognome e cercare anche `phone_key__contains=phone_key(q)`.

## [D10] Import: tutte le righe con un telefono privo di cifre finiscono sulla stessa scheda
- **Gravità**: medio
- **Dove**: backend/apps/clients/services.py:188 e 232
- **Cosa**: la mappa pre-caricata esclude le chiavi vuote (riga 149) ma la riga 232 le reinserisce; `phone_key("n/d") == ""` (verificato).
- **Scenario**: `POST /api/clients/import` con `{"first_name":"Anna","phone":"n/d"}`, `{"first_name":"Bea","phone":"-"}`, `{"first_name":"Carla","phone":"nessuno"}` → 1 creata, 2 aggiornate: Anna diventa Carla, Bea e Carla non esistono, nessun errore. Non raggiungibile dalla modale del gestionale (`cleanPhone` svuota quei valori), lo è da qualunque altro chiamante dell'API.
- **Fix**: non memorizzare chiavi vuote e rifiutare a monte un telefono senza cifre.

## [D11] Il form pubblico «risveglia» in silenzio una scheda disattivata e il contatto si perde
- **Gravità**: basso
- **Dove**: backend/apps/clients/api.py:728 (`find_client_by_phone` senza `active_only`), 756-773
- **Cosa**: `delete_client` è una disattivazione. Il hook trova anche le schede disattivate, aggiorna i consensi, non emette `client.created`, non mette l'etichetta «Da form» e lascia `is_active=False`.
- **Scenario**: una cliente cancellata ricompila il modulo: 200, nessun evento SSE, scheda fuori da tutte le liste (il gestionale filtra `is_active=true`) e dalle audience marketing (`marketing/services.py:329`). Contatto perso benché il consenso sia stato registrato.
- **Fix**: riattivare la scheda e trattarla come nuovo lead, oppure usare `active_only=True`.

## [D12] Spesa e vendite della cliente leggibili senza il permesso «sales»
- **Gravità**: basso
- **Dove**: backend/apps/clients/api.py:193-201 (`get_client`, nessun `require_scope`) e 344-425 (`client_history`, solo scope «clients»)
- **Cosa**: `get_client` restituisce `visits`, `total_spent`, `last_visit`; `client_history` include `_sale_out` con i totali di ogni visita. `GET /api/sales/` è invece protetto da `require_scope(ctx, "sales")` (apps/sales/api.py:228).
- **Scenario**: un ruolo con il solo permesso «clienti» (o senza permessi, per `get_client`) legge la spesa totale della cliente e l'incasso di ogni visita.
- **Fix**: includere quei dati solo se `ctx.is_owner or "sales" in ctx.scopes`.

## [D13] `PUT /api/clients/{id}` azzera i consensi quando il corpo non li contiene
- **Gravità**: basso
- **Dove**: backend/apps/clients/schemas.py:82 (`consents: dict = {}`), api.py:209-214
- **Cosa**: `ClientIn` è un corpo completo con default e `_client_payload` riversa tutto sul modello: una PUT che ometta `consents` lo sostituisce con `{}`, perdendo `privacy`, `privacy_at`, `marketing_at`, `card_charge`. Idem `is_active` (default `True`: riattiva una scheda disattivata) e `reliability` (torna a 100).
- **Scenario**: qualunque chiamante diverso dalla dashboard che aggiorni solo il telefono cancella la prova del consenso privacy (GDPR) e fa uscire la cliente dalle audience. Oggi è mitigato solo da `helpers.js:32-56`, che rispedisce sempre l'oggetto intero.
- **Fix**: rendere `consents`/`is_active`/`reliability` opzionali e applicarli solo se presenti.

## [D14] Import senza tetto di righe e cache di deduplica non aggiornata dopo un cambio di telefono
- **Gravità**: basso
- **Dove**: backend/apps/clients/schemas.py:108-111, services.py:203-204
- **Cosa**: (a) `rows` non ha limite: ogni riga fa 2-5 query in un savepoint dentro un'unica richiesta sincrona (la dashboard si autolimita a 250 per blocco, l'API no). (b) quando la scheda trovata cambia telefono la nuova chiave non entra in `by_phone`: una riga successiva con quel numero prova a creare e viene respinta dal vincolo di unicità, con messaggio SQL grezzo negli `errors`.
- **Fix**: limitare `rows` (es. 1000) e aggiornare `by_phone` dopo la riassegnazione del telefono.
