# Revisione contratto API client ↔ server (prefisso M)

Metodo: estratte tutte le rotte registrate (`backend/config/api.py` + i 12 `backend/apps/*/api.py`,
196 coppie metodo+percorso) e tutte le chiamate del frontend (248 siti `api.get/post/put/patch/del/postForm`
in `frontend/apps/dashboard/src`, `frontend/apps/client-app/src`, `frontend/packages/shared/src`),
poi confrontate una a una. **Nessuna rotta inesistente e nessun metodo HTTP sbagliato**: tutte le
chiamate risolvono, slash finali compresi (`/api/clients/`, `/api/staff/`, `/api/sales/`,
`/api/automations/`). Anche gli enum principali combaciano (stati appuntamento, stati caparra,
metodi di pagamento, causali di scarico, preferenze lista d'attesa, tipi di assenza, scope dei ruoli,
weekday 0 = lunedì su entrambi i lati). Quanto segue è ciò che resta rotto.

---

## [M1] Gli eventi `deposit.*` non arrivano mai al feed live della dashboard
- **Gravità**: alto
- **Dove**: `frontend/apps/dashboard/src/sections/agenda/index.jsx:78` (e `MonthView.jsx:57`, `WeekView.jsx:53`, `ctx.jsx:113`) ↔ `backend/apps/core/views.py:64-69` (`LIVE_FEED_PREFIXES`) e `backend/apps/sales/api.py:511-519`
- **Cosa**: il webhook Stripe scrive nel registro `deposit.paid` (e `deposit.reminder`, `deposit.refunded`, `deposit.refund_due`, `deposit.duplicate_payment`). `LIVE_FEED_PREFIXES` elenca `appointment. pause. waitlist. slot. visit. client. client_category. sale. service. package. category. operator. product. stock. order. supplier. coupon. giftcard. loyalty. communication. automation. settings.` — `deposit.` non c'è. Lo stesso elenco filtra sia lo stream SSE (`event_generator`, views.py:109) sia il polling di riserva (`GET /api/core/activity/feed`, `core/api.py:259`), quindi l'evento non raggiunge il client per nessuna delle due vie. Nota: anche `loyalty_program.*` è escluso, perché `"loyalty_program.".startswith("loyalty.")` è falso.
- **Scenario**: la cliente paga la caparra dal link Stripe → l'appuntamento passa a `deposit_status="paid"` sul server, ma in agenda resta il pallino arancione «caparra richiesta» e la scheda continua a offrire «invia sollecito», finché non arriva un altro evento (uno spostamento, una vendita) o finché qualcuno non ricarica la pagina. La campanella delle notifiche non mostra mai «Acconto pagato», che invece compare nel Registro attività (che non filtra per prefisso).
- **Fix**: aggiungere `"deposit."` (e `"loyalty_program."`, `"deposit_rule."`) a `LIVE_FEED_PREFIXES` in `backend/apps/core/views.py:64`, e includere `deposit` nelle regex di sottoscrizione dell'agenda.

## [M2] Cliente archiviata: `request-otp` risponde 404, ma la registrazione che il 404 innesca risponde 400
- **Gravità**: medio
- **Dove**: `frontend/apps/client-app/src/screens/auth/AuthFlow.jsx:29-31` e `frontend/apps/client-app/src/screens/Prenota.jsx:145-153` ↔ `backend/apps/accounts/api.py:107-112` e `backend/apps/accounts/api.py:477-478`
- **Cosa**: `_client_by_phone` cerca con `find_client_by_phone(..., active_only=True)` e alza 404 «Numero non registrato»; il frontend interpreta quel 404 come «numero sconosciuto» e passa alla registrazione. `client_register` però cerca con `find_client_by_phone(salon, phone)` **senza** `active_only` e alza 400 «Numero di telefono già registrato». I due endpoint usano due definizioni diverse di «esiste».
- **Scenario**: il salone archivia una cliente (`DELETE /api/clients/{id}` → `is_active=False`). La cliente apre la web app, inserisce il numero → «Numero non registrato», compila nome e cognome → «Numero di telefono già registrato». Nessuna via d'uscita dall'app: lo stesso vicolo cieco si ripresenta anche nel wizard di prenotazione (`sendBookingOtp`).
- **Fix**: allineare le due ricerche (stesso `active_only`), o far rispondere a `client_register` un 409 dedicato che il frontend traduce in «contatta il salone».

## [M3] Gli errori di validazione 422 hanno `detail` come lista: il client li mostra come JSON grezzo
- **Gravità**: medio
- **Dove**: `frontend/packages/shared/src/api.js:81-86` ↔ `backend/config/api.py` (nessun `@api.exception_handler`) + default di django-ninja `_default_validation_error` → `{"detail": exc.errors}` con status 422
- **Cosa**: `api.js` estrae il messaggio con `data.detail || data.message` e, se non è una stringa, fa `JSON.stringify(message)`. Gli `HttpError` del codice applicativo mandano `detail` come stringa (bene), ma gli errori di schema pydantic mandano `detail` come **array di dizionari**. Ogni toast d'errore costruito con `err.message` (praticamente tutti: `toastErr`, `errMsg`, `errToast`) finisce per stampare il payload pydantic.
- **Scenario**: Servizi → modifica servizio → durata «2000» min (il `DurationInput` di `sections/servizi/parts.jsx:45` impone solo un minimo, nessun massimo; `SvcEditModal.jsx:63` fa solo `Math.max(5, …)`), mentre `ServiceIn.duration_min` è `Field(..., ge=1, le=1440)` (`backend/apps/catalog/schemas.py:54`). Salvando, il toast mostra `[{"type":"less_than_equal","loc":["body","data","duration_min"],"msg":"Input should be less than or equal to 1440",...}]` invece di un messaggio leggibile.
- **Fix**: registrare in `backend/config/api.py` un `exception_handler(ValidationError)` che ritorni `{"detail": "<msg leggibile>"}`, oppure gestire in `api.js` il caso `Array.isArray(data.detail)` prendendo il primo `msg`.

## [M4] `reason` di no-show/cancellazione senza limite di lunghezza: 500 invece di un errore leggibile
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx:187-189` e `:218` (textarea senza `maxLength`) ↔ `backend/apps/agenda/schemas.py:63-64` (`ReasonIn.reason: str = ""`), `backend/apps/agenda/models.py:77` (`cancel_reason = CharField(max_length=255)`), `backend/apps/agenda/services.py:1065` e `:1101`
- **Cosa**: il frontend compone `fullReason = label + ' — ' + reasonNote` da una textarea libera. Lo schema non pone limiti e i servizi assegnano il valore al campo senza troncarlo. Su PostgreSQL (produzione Coolify) oltre 255 caratteri il salvataggio alza `DataError` → 500; su SQLite passa silenziosamente, quindi non si vede in sviluppo.
- **Scenario**: l'operatrice segna un no-show e scrive 200 caratteri di spiegazione nella nota: il no-show **non viene registrato**, il toast mostra la pagina d'errore HTML di Django (il body non-JSON finisce in `err.message`) e l'appuntamento resta «confermato». Stesso problema, su altri campi, per `ClientIn.first_name/last_name` (`max_length=80`) e `origin`, non troncati in `_client_payload` (`backend/apps/clients/api.py:156-172`).
- **Fix**: `reason: str = Field("", max_length=255)` in `ReasonIn` (e `max_length` sui campi testo di `ClientIn`), più `maxLength` sulla textarea.

## [M5] Wallet cliente (staff): i coupon si cercano per nome invece che per `client_id`, e la pagina viene troncata
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx:2-5, 25-26, 39-40` ↔ `backend/apps/marketing/api.py:51-73` (`list_coupons` ha `client_id`) e `:367-376` (`list_loyalty_accounts`, paginato)
- **Cosa**: il commento in testa al file dice «The marketing endpoints have no by-client filter», ma `GET /api/marketing/coupons` accetta `client_id` (il file lo usa già correttamente per le gift card, riga 30). Il codice chiede invece `?q=<ultima parola del nome>&limit=100` e poi filtra lato client con `x.client_id === c.id`; la risposta è paginata (`@paginate(LimitOffsetPagination)`), quindi tutto ciò che sta oltre i primi 100 risultati sparisce senza segnalazione. Stesso schema per la fedeltà: `?limit=200` sugli account del programma e `.find(a => a.client_id === c.id)` lato client.
- **Scenario**: in un salone con più di 100 coupon che contengono «Rossi» nel codice o nel nome, la scheda di Maria Rossi mostra «Nessun coupon» pur avendone uno attivo. Con un programma fedeltà di oltre 200 iscritte, il saldo punti della cliente risulta vuoto.
- **Fix**: usare `params: { client_id: c.id }` sui coupon (ed eliminare il filtro lato client); per la fedeltà aggiungere un parametro `client_id` a `list_loyalty_accounts` invece di paginare alla cieca.

## [M6] Lo scope `insights` si può assegnare ma il backend non lo consulta mai
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/impostazioni/RolesDrawer.jsx:11-21` (riga 20) ↔ `backend/apps/insights/api.py:28, 38, 45, 52, 58` (tutti `require_owner`), `backend/common/permissions.py:17`
- **Cosa**: `SCOPES` in `common/permissions.py` dichiara `insights` e il pannello ruoli lo offre come casella «Analisi dati», ma nessun endpoint fa `require_scope(ctx, "insights")`: l'intero router usa `require_owner`. Coerentemente il frontend non chiama mai `hasScope('insights')` e blocca la sezione su `session?.is_owner` (`sections/insight/index.jsx:25`).
- **Scenario**: il titolare crea il ruolo «Manager» e spunta «Analisi dati»; la collega continua a vedere il lucchetto «Funzione riservata al titolare» e, forzando la rotta, riceve 403. Il permesso non fa nulla, in nessuna direzione.
- **Fix**: o sostituire `require_owner` con `require_scope(ctx, "insights")` nel router insights (e gate frontend su `hasScope('insights') || is_owner`), o togliere `insights` da `SCOPES` e dalla lista in `RolesDrawer`.

## [M7] Magazzino: lo snapshot di riferimento è limitato a 500 prodotti, senza accorgersene
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/magazzino/index.jsx:28-32` ↔ `backend/apps/inventory/api.py:71-72` (`@paginate(LimitOffsetPagination)`)
- **Cosa**: `loadShared` legge `GET /api/inventory/products?limit=500&include_inactive=true` e tiene solo `p?.items`, ignorando `p.count`. Lo snapshot alimenta il valore di magazzino, il conteggio «sotto soglia», l'elenco dei brand del filtro e il picker dello Scarico manuale.
- **Scenario**: con più di 500 articoli a catalogo il valore di magazzino e il badge «sotto soglia» in testata sono sottostimati e i prodotti oltre il 500° non compaiono nel picker dello scarico manuale, senza alcun avviso (il POS lo gestisce bene: `useProductCatalog.js` confronta `r.count` con i ricevuti e interroga il server sulla ricerca).
- **Fix**: confrontare `p.count` con `p.items.length` e, se maggiore, paginare o mostrare che le metriche sono parziali — come già fa `useProductCatalog`.

## [M8] La vista settimana non riceve `note`: l'anteprima al passaggio del mouse non la mostra mai
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/agenda/WeekView.jsx:269-272` (`hoverShape`) → `frontend/apps/dashboard/src/sections/agenda/DayGrid.jsx:705-710` (`ApptHoverCard` legge `a.note`) ↔ `backend/apps/agenda/api.py:392-417` (payload compatto di `GET /api/agenda/week`)
- **Cosa**: `ApptHoverCard` è condivisa fra vista giorno e vista settimana. Il payload di `/api/agenda/day` usa `_appointment_out` (AppointmentOut completo, `note` incluso), quello di `/api/agenda/week` è un dizionario compatto costruito a mano che espone `id, start, client_name, client_phone, operator_id, status, duration_min, total_price, forced, deposit_status, gifts, items[]` — senza `note`. `hoverShape` rimappa `client` e `total_duration_min` ma non può inventare la nota.
- **Scenario**: un appuntamento con nota («allergia alla tinta») mostra il riquadro giallo di avviso passando il mouse in vista giorno, e non lo mostra in vista settimana: `a.note` è `undefined` e il blocco è saltato in silenzio.
- **Fix**: aggiungere `"note": a.note` al dizionario di `agenda_week` in `backend/apps/agenda/api.py:396`.

## [M9] Workaround obsoleto sul riordino categorie: la rotta dedicata funziona
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/impostazioni/modals/CategoriesManagerModal.jsx:6-9` e `:86-98` ↔ `backend/apps/catalog/api.py:107-108`
- **Cosa**: il commento afferma che «POST /api/catalog/categories/reorder is currently shadowed by the /categories/{category_id} route (405) — backend bug reported». Non è vero: la rotta precedente è registrata con il converter `{int:category_id}` (django-ninja la traduce in `<int:category_id>`, regex `[0-9]+`), che non può matchare il segmento letterale `reorder`; Django prosegue e risolve `categories/reorder`. Il frontend fa invece una `PUT` per ogni categoria.
- **Scenario**: riordinare 12 categorie servizi genera 12 `PUT` in parallelo (12 voci `category.updated` nel registro attività invece di una `category.reordered`) e non è atomico: se una fallisce, l'ordine resta a metà — il `catch` ricarica e l'utente vede l'ordine tornare indietro senza capire perché.
- **Fix**: usare `POST ${base}/reorder` con `{ ids: [...] }` dove esiste (solo catalog), lasciando il fallback a PUT per clienti/magazzino; e rimuovere il commento.

## [M10] Funzionalità backend mai raggiunte dalle due app
- **Gravità**: basso
- **Dove**: `backend/apps/sales/api.py:276-302` (`POST /api/sales/appointments/{id}/charge-no-show`) e `:304-319` (`POST /api/sales/client/setup-intent`) ↔ nessun chiamante in `frontend/apps/dashboard/src` né `frontend/apps/client-app/src`
- **Cosa**: la ricerca sull'intero frontend non trova alcun riferimento a `charge-no-show` né a `setup-intent` (né a `GET /api/auth/me`, `GET /api/clients/{id}/appointments`, `POST /api/catalog/categories/reorder`). La catena «carta salvata → addebito no-show» è implementata lato server (`stripe_service.charge_full_amount`, log `sale.no_show_charged`, `Client.stripe_payment_method_id`, `deposit_always`) ma non ha nessun punto d'ingresso nell'interfaccia.
- **Scenario**: la timeline del no-show (`sections/agenda/lib.js:201-210`) si ferma a «Caparra trattenuta»; con caparra assente e carta registrata non c'è alcun pulsante per addebitare la visita, e l'app cliente non ha alcuna schermata per registrare la carta — quindi `stripe_payment_method_id` resta sempre vuoto e l'endpoint sarebbe comunque inutilizzabile.
- **Fix**: o esporre l'azione (pulsante «Addebita no-show» nel dettaglio + registrazione carta nell'app cliente), o rimuovere gli endpoint per non lasciare superficie non testata.

## [M11] I `Decimal` arrivano come stringhe JSON e in un punto finiscono a video così come sono
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/fedelta/CouponSub.jsx:13` ↔ `backend/apps/marketing/schemas.py:26` (`CouponOut.value: Decimal`), `backend/apps/marketing/models.py:31` (`DecimalField(decimal_places=2)`)
- **Cosa**: django-ninja serializza con `NinjaJSONEncoder` (estende `DjangoJSONEncoder`), che rende i `Decimal` come **stringhe** — il commento in `packages/shared/src/format.js:2` lo dice esplicitamente. Quasi ovunque il frontend fa `Number(...)`; qui no: `'-' + c.value + '%'` concatena la stringa grezza.
- **Scenario**: un coupon del 20% appare come «-20.00%» nella lista Promozioni → Coupon, mentre lo stesso coupon nella scheda cliente (`tabs/WalletTab.jsx:53`, che usa `Number(cp.value)`) appare come «-20%».
- **Fix**: `'-' + Number(c.value) + '%'` in `CouponSub.jsx:13`.
