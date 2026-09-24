# youty backend — SPEC (contratto di implementazione)

Backend Django per: **dashboard gestionale** (staff salone) + **web app cliente** (clienti finali).
Riferimento funzionale: `../docs/manuale-flussi.html`. Salone demo: The Parlour (Firenze).

**WhatsApp e l'esecuzione delle automazioni sono delegate alla piattaforma esterna Yourang**:
il backend NON invia messaggi; accoda eventi in `core.OutboxEvent` via `core.services.emit_event`.

## 0. Come è fatta un'app

Ogni app in `apps/<nome>/` ha gli stessi strati: `models.py`, `schemas.py`,
gli endpoint in `api.py` (o in un package `api/` con un modulo per risorsa, che
espone lo stesso `router`), la logica in `services.py` e nei moduli fratelli per
argomento, i test nel package `tests/` (`base.py` + `test_<argomento>.py`).
Le FK verso altre app sono stringhe (`models.ForeignKey("clients.Client", ...)`).
La mappa dei moduli di ogni app e le ricette (endpoint, campo, evento, test) sono
in [`../docs/SVILUPPO.md`](../docs/SVILUPPO.md). Le sezioni qui sotto descrivono il
contratto: modelli, regole di dominio ed endpoint di ciascuna app, con il modulo
in cui vivono le funzioni principali.

## 1. Convenzioni globali

- **Auth**: `from common.auth import staff_auth, client_auth`. Endpoint staff → `auth=staff_auth`,
  `request.auth` è `StaffContext(user, salon, membership, scopes, is_owner)`.
  Endpoint app cliente → `auth=client_auth`, `request.auth` è `ClientContext(client, salon)`.
  Endpoint cliente: prefisso path `/client/...` dentro il router della propria app.
- **Permessi**: `from common.permissions import require_scope, require_owner`.
  Scope: agenda, clients, sales, inventory, pricing, marketing, team, activity_log, insights.
  Le letture base richiedono solo staff_auth; le scritture richiedono lo scope indicato.
- **Multi-tenant**: ogni modello top-level ha `salon = FK("core.Salon")`. Ogni query filtra
  per `salon=ctx.salon` (helper: `common.utils.salon_get`). I figli ereditano il tenant dal padre.
- **Soldi**: `DecimalField(max_digits=10, decimal_places=2)`. Durate: minuti `int`.
  Orari dei turni: minuti da mezzanotte (`start_min`). Datetime: timezone-aware.
- **i18n**: campi testo bilingui come `name_it` + `name_en` (blank). Lingua cliente: `lang` it/en.
- **Choices**: `models.TextChoices` con valori inglesi snake_case.
- **Errori**: `raise HttpError(4xx, "messaggio in italiano")` (user-facing).
- **Liste lunghe**: `@paginate(LimitOffsetPagination)` (vedi core/api.py).
- **Registro attività**: ogni mutazione rilevante chiama
  `core.services.log_activity(salon, type, summary, actor=ctx.user, payload={...})`.
- **Outbox Yourang**: `core.services.emit_event(salon, event_type, payload)`.
  Eventi standard: `client.created`, `client.otp`, `client.marketing_consent`,
  `appointment.created`, `appointment.moved`, `appointment.updated`,
  `appointment.cancelled`, `appointment.no_show`, `appointment.checked_in`,
  `appointment.released_unpaid`, `slot.freed`, `deposit.payment_link`,
  `deposit.reminder`, `deposit.paid`, `deposit.paid_after_release`,
  `visit.completed`, `loyalty.reward`, `communication.send`,
  `communication.cancel`, `supplier.order`, `team.invitation`, `waitlist.deleted`,
  `automation.updated`, `automation.triggered`. Payload: id + dati utili a Yourang
  (nome cliente, telefono, lingua, orari ISO).
- **Ordine per oggetto**: gli eventi con la stessa `coalesce_key` partono
  nell'ordine in cui sono nati; uno aspetta che quelli più vecchi con la stessa
  chiave siano consegnati, falliti, sostituiti o scaduti (`flush_outbox`), ma
  non quelli soltanto trattenuti dal ritardo di sicurezza (mai tentati).
  Chiavi: `appointment:<id>` (anche caparra e `visit.completed`, che NON si
  fondono con i messaggi dell'appuntamento), `slot:<id>`, `automation:<id>`,
  `communication:<id>`.
- **Ritardo di sicurezza**: gli eventi dell'agenda passano da
  `agenda.services.emit_appointment_event`, che li TRATTIENE per
  `SalonSettings.automation_delay_seconds` (30 di serie, 0 = subito) con una
  `coalesce_key` per oggetto. Due eventi trattenuti sullo stesso appuntamento si
  fondono in uno solo: prenotare e correggere l'orario un istante dopo manda un
  messaggio, non due, e quello che «torna indietro» annulla non parte affatto.
  Gli eventi immediati (OTP, link di pagamento) NON si ritardano e non aspettano
  i messaggi trattenuti; aspettano solo quelli della stessa chiave in
  ritentativo.
- **Condizioni E/O** (deposito, automazioni): JSON `{"op":"and|or","rules":[{"field","cmp","value"}]}`,
  valutate con `common.conditions.evaluate(conditions, facts)`;
  facts standard da `apps.clients.services.client_facts(client)`.
- **Import cross-app**: i modelli in testa al modulo; le funzioni di altre app che i
  test sostituiscono con `mock.patch` si importano dentro la funzione, così si cercano a
  ogni chiamata (e la patch va sul modulo che le chiama).
- **Codici**: `common.utils.human_code(n)`.

## 2. Mount (config/api.py)

| App | Prefisso |
|---|---|
| accounts | /api/auth |
| core | /api/core |
| clients | /api/clients |
| staff | /api/staff |
| catalog | /api/catalog |
| agenda | /api/agenda |
| sales | /api/sales |
| inventory | /api/inventory |
| marketing | /api/marketing |
| automations | /api/automations |
| insights | /api/insights |
| integrations | /api/integrations |

---

## 3. apps/accounts — utenti staff, ruoli, inviti, login clienti

**Models**
- `User(AbstractUser)`: `username = None`, `email` unique = USERNAME_FIELD, `first_name/last_name`.
  Manager custom `UserManager` (create_user/create_superuser via email). REQUIRED_FIELDS = [].
- `Role`: salon FK, name, `scopes` JSONField (lista di scope), is_system bool. unique (salon, name).
- `Membership`: user FK, salon FK, role FK null/blank (il titolare può non avere ruolo),
  is_owner bool default False. unique (user, salon).
- `Invitation`: salon FK, email, role FK, token UUID auto, status pending/accepted/expired,
  expires_at (default: +7 giorni), created_at.
- `ClientOTP`: client FK ("clients.Client"), code (6 cifre), expires_at (+10 min), used bool.

**Service** `ensure_default_roles(salon)` → crea (se assenti) ruoli is_system:
- Manager: [agenda, clients, sales, inventory, pricing, marketing]
- Front desk: [agenda, clients, sales]
- Operatrice: [agenda, clients]

**Endpoint staff** (prefisso /api/auth)
- POST `/staff/login` {email, password} → {access, refresh, user:{id,email,name}, salon:{id,name,slug}, scopes, is_owner}. Usa `common.auth.create_staff_tokens`. Se l'utente ha più membership prende la prima (v1 mono-salone).
- POST `/staff/refresh` {refresh} → nuovi token (verifica typ staff_refresh).
- GET `/me` (staff_auth) → utente + salone + scopes + is_owner.
- GET `/members` (scope team) → membri con ruolo. POST `/members/{id}/role` {role_id} (scope team).
  DELETE `/members/{id}` (scope team; vietato rimuovere l'owner → 400).
- CRUD `/roles` (scope team; i ruoli is_system non sono eliminabili → 400).
- POST `/invitations` {email, role_id} (scope team) → crea invito + `emit_event(salon,"team.invitation",...)` + log. GET `/invitations` (scope team).
- POST `/invitations/accept` {token, password, first_name, last_name} (no auth) →
  crea User + Membership con ruolo dell'invito, status accepted → token di login.

**Endpoint cliente**
- POST `/client/register` {salon_slug, first_name, last_name, phone, email?, lang} (no auth) →
  crea Client (se telefono già esistente → 400) + emit `client.created` → invia OTP.
- POST `/client/request-otp` {salon_slug, phone} (no auth) → genera ClientOTP,
  `emit_event(salon, "client.otp", {phone, code, lang})` (Yourang lo consegnerà; in DEBUG logga il codice).
  Telefono sconosciuto → 404 "Numero non registrato". Max 3 OTP validi contemporanei → 429.
- POST `/client/verify-otp` {salon_slug, phone, code} → verifica non usato/non scaduto →
  `create_client_tokens(client)` → {access, client:{id, first_name, lang}}.
- GET `/client/me` (client_auth) → profilo. PUT `/client/me` {lang?, email?, whatsapp_reminders?}.

**Tests**: login staff, refresh, flusso OTP completo, ruoli default.

---

## 4. apps/clients — anagrafica clienti, etichette, note, schede tecniche

**Models**
- `ClientCategory`: salon FK, name, color (#hex), order int. (Etichette: Local, Expat, VIP…)
- `Client`: salon FK, first_name, last_name, phone (unique per salon), email blank,
  wa bool default True, lang it/en default it, categories M2M ClientCategory blank,
  reliability int default 100 (0–100), origin char blank (Instagram, Google…),
  birthday date null/blank, since date null/blank,
  consents JSON default dict ({privacy, marketing, card_charge} bool),
  whatsapp_reminders bool default True,
  stripe_customer_id char blank, stripe_payment_method_id char blank,
  deposit_always bool default False, is_active bool default True.
  property `full_name`.
- `ClientNote`: client FK, text, visibility private/ai (TextChoices), author FK user null, created_at.
- `TechnicalSheet` (scheda tecnica, sola lettura una volta creata): client FK,
  appointment FK "agenda.Appointment" null/blank, category char (nail/hair/viso/extra…),
  treatment char, zone char blank, products text blank, params JSON default dict,
  outcome text blank, duration_hold char blank, advice text blank, protocol text blank,
  next_step char blank, photo ImageField null/blank, author FK user null, created_at.

**Service** `client_facts(client) -> dict`: {reliability, categories:[nomi], total_spent (somma
Sale del cliente, import lazy di sales), visits (Sale count), noshow_count, latecancel_count
(da agenda.Appointment status/flag, import lazy), deposit_always}. Campi mancanti → 0/[].

**Endpoint staff** (/api/clients)
- GET `/` (paginate) filtri: q (nome/telefono/email), category_id, reliability_min/max, is_active.
- GET `/categories` + CRUD (scope clients). GET `/{id}` → dettaglio + computed
  {visits, total_spent, last_visit} (aggregati lazy da sales). POST/PUT (scope clients, log).
  DELETE (scope clients) → soft: is_active=False + log `client.deleted`.
- POST `/import` {rows:[{first_name,last_name,email,phone}]} (scope clients) →
  upsert per telefono (poi email); ritorna {created, updated}. Log.
- Note: GET/POST/DELETE `/{id}/notes` (scope clients).
- Schede tecniche: GET `/{id}/sheets`, POST `/{id}/sheets` (scope clients, log).
  NESSUN endpoint update/delete (read-only dopo il salvataggio).

**Tests**: import upsert, client_facts con dati minimi, immutabilità scheda (nessuna rotta update).

---

## 5. apps/staff — operatrici, turni, assenze

**Models**
- `Operator`: salon FK, location FK "core.Location" null/blank, user OneToOne
  "accounts.User" null/blank, first_name, last_name, color (#hex), role_title char blank,
  services M2M "catalog.Service" blank related_name="operators",
  hourly_cost Decimal default 0, cycle_weeks int default 1, active bool default True, order int default 0.
  property `initials`.
- `WeeklyShift`: operator FK related_name="shifts", week_index int default 0 (< cycle_weeks),
  weekday int 0=lunedì, start_min, end_min, break_start_min null, break_end_min null.
- `Absence`: operator FK related_name="absences", date_from, date_to,
  type vacation/holiday/other, note blank.

**Service** `shift_windows(operator, date) -> list[tuple[int,int]]`:
finestre lavorabili in minuti per quella data = turno del weekday
(week_index = numero settimana ISO % cycle_weeks) meno la pausa; [] se assente
(Absence che copre la data) o senza turno. È LA funzione usata dall'agenda.

**Endpoint** (/api/staff)
- GET `/` → operatrici attive con stato di oggi: {on_shift: bool, windows:[["09:00","13:00"]…],
  absence_type|null}, month_revenue (somma SaleLine dell'operatrice nel mese),
  today_clients (n. appuntamenti di oggi): i KPI stanno in `staff/stats.py`.
- CRUD operatrici (scope team, log). PUT `/{id}/shifts` {shifts:[{week_index,weekday,start_min,end_min,break_start_min?,break_end_min?}]} → sostituzione integrale del pattern (scope team).
- CRUD `/{id}/absences` (scope team).
- GET `/{id}/performance?months=6` → serie mensile {month, revenue, sales_count} da SaleLine (`stats.performance_series`).
- GET `/{id}/clients?q=` → clienti serviti (da appuntamenti passati, `stats.served_clients`) + storico vendite.

**Tests**: shift_windows (turno normale, pausa, assenza, cycle_weeks=2).

---

## 6. apps/catalog — categorie servizi, servizi, pacchetti

**Models**
- `ServiceCategory`: salon FK, name_it, name_en blank, color (#hex pastello), order int.
- `Service`: salon FK, category FK, name_it, name_en blank, duration_min int, price Decimal,
  product_cost Decimal default 0, supplier_cost Decimal default 0 (per stima margine),
  active bool default True, order int default 0.
- `Package`: salon FK, name, description blank, price Decimal, active bool default True.
- `PackageItem`: package FK related_name="items", service FK, qty int default 1.

**Endpoint** (/api/catalog)
- GET `/categories` + CRUD (scope pricing) + POST `/categories/reorder` {ids:[...]}.
- GET `/services?category_id=&active=` + CRUD (scope pricing).
  Su cambio prezzo → log `service.price_changed` con {old, new}.
- GET `/packages` + CRUD (scope pricing) — items nested nel payload
  {items:[{service_id, qty}]}, ricreati a ogni update.
- Pubblici (no auth, per la web app prima del login): GET `/public/services?salon=slug`
  → categorie ordinate con servizi attivi {id, name_it, name_en, duration_min, price};
  GET `/public/packages?salon=slug`.

**Tests**: reorder, package con items, endpoint pubblico.

---

## 7. apps/agenda — appuntamenti, pause, disponibilità, lista d'attesa (CUORE)

**Models**
- `Appointment`: salon FK, location FK null/blank, client FK "clients.Client",
  operator FK "staff.Operator" (principale), start DateTimeField,
  status TextChoices: confirmed / checked_in / in_progress / closed / no_show / cancelled,
  deposit_status TextChoices: none / required / paid / refund_due / refunded / forfeited,
  deposit_payment_intent_id / no_show_payment_intent_id (PaymentIntent Stripe, per rimborso e idempotenza),
  deposit_amount Decimal default 0, note text blank, flexible bool default False,
  created_via dashboard/app default dashboard, cancel_reason char blank,
  cancelled_late bool default False, created_at/updated_at.
  property `total_duration_min` (somma items), property `end` (start + durata),
  property `total_price`.
- `AppointmentService`: appointment FK related_name="items", service FK "catalog.Service",
  operator FK "staff.Operator" (chi esegue QUESTO servizio), duration_min int (snapshot),
  price Decimal (snapshot), order int default 0.
- `Pause`: salon FK, operator FK, start DateTimeField, duration_min int, note blank.
- `WaitlistEntry`: salon FK, client FK, service FK, operator FK null/blank (null = qualsiasi),
  preference TextChoices: morning / afternoon / weekend / any / exact,
  exact_days JSON default list (0=lun…6=dom), exact_time TimeField null/blank,
  status active/contacted/booked/expired default active, created_at.

**services.py**
- `get_free_slots(salon, date, items, location=None) -> list[dict]`
  items = [{"service_id": int, "operator_id": int|None}] (None = qualsiasi idonea).
  Griglia da settings.AGENDA_SLOT_STEP_MIN (15'). Un orario t è valido se i servizi si
  concatenano in sequenza da t e per ciascuno esiste un'operatrice idonea
  (in `service.operators`) libera per l'intera finestra: dentro `staff.services.shift_windows`,
  senza sovrapposizioni con Appointment (status non in cancelled/no_show) né Pause.
  Ritorna [{"start": iso, "assignment": [{"service_id", "operator_id"}]}].
- `compute_deposit(salon, client, total_price) -> Decimal`:
  se client.deposit_always → prima regola attiva qualunque; altrimenti prima
  `core.DepositRule` attiva (per priority) le cui conditions matchano
  `clients.services.client_facts(client)`; pct → percentuale del totale, fixed → importo. 0 se nessuna.
- `create_appointment(salon, client, items, start, *, via, actor=None, flexible=False)`:
  transazione; rivalida che lo slot sia libero (altrimenti HttpError 409
  "Orario non più disponibile"); snapshot durata/prezzo dal servizio; operator principale =
  operatrice del primo item; calcola deposito → deposit_status required/none;
  log + emit `appointment.created` (payload: client nome/telefono/lang, servizi, start ISO, deposito).
- `free_slot_event(appointment)`: emit `slot.freed` {start, duration_min, operator_id,
  matching_waitlist: [entry_id...]} — waitlist attive compatibili per servizio+operatrice.

**Endpoint staff** (/api/agenda)
- GET `/day?date=YYYY-MM-DD&location_id=` → per ogni operatrice attiva:
  {operator, windows di turno, appointments:[{...items, client{...}}], pauses}.
- GET `/week?start=YYYY-MM-DD` → per giorno: conteggi + appuntamenti compatti.
- POST `/appointments` {client_id, items, start, flexible?} (scope agenda) → create_appointment via dashboard.
- POST `/appointments/{id}/move` {start, operator_id?} (scope agenda) → rivalida slot,
  sposta (anche items stesso delta), log + emit `appointment.moved` + free_slot_event sul vecchio orario.
- POST `/appointments/{id}/check-in` (scope agenda) → status checked_in, log, emit `appointment.checked_in`.
- POST `/appointments/{id}/start` (scope agenda) → status in_progress.
- POST `/appointments/{id}/no-show` {reason} (scope agenda) → status no_show,
  deposit paid→forfeited, cancel_reason, log, emit `appointment.no_show`, free_slot_event.
  (L'addebito Stripe dell'intero importo è responsabilità di sales: qui solo evento+stato.)
- POST `/appointments/{id}/cancel` {reason, by_client?} (scope agenda) → status cancelled.
  Di serie annulla il SALONE: nessuna penale, deposit paid→refund_due. Con `by_client: true`
  la reception registra la disdetta della cliente (al telefono, al banco: l'app sotto le ore
  minime la manda dal salone) e valgono le regole dell'app: cancelled_late = start − now <
  settings.CLIENT_MOVE_CANCEL_MIN_HOURS ore, e se late deposit paid→forfeited, altrimenti
  paid→refund_due. Resta un gesto della postazione: entra in «torna indietro».
  Con refund_due, fuori transazione si tenta il rimborso Stripe
  (sales.stripe_service.refund_deposit) e solo se riesce → refunded, altrimenti resta
  refund_due (conferma manuale: POST /appointments/{id}/deposit-refunded, scope sales).
  Log, emit `appointment.cancelled` {…, reason, late, by_client}, free_slot_event.
- PUT `/appointments/{id}` {items?, note?} (scope agenda) → modifica trattamenti (snapshot nuovi), log.
- GET `/appointments/{id}/margin` → stima margine: revenue = Σ item.price;
  supplier_cost/product_cost da Service (snapshot corrente); labor = Σ(duration/60 × operator.hourly_cost);
  → {revenue, supplier_cost, product_cost, labor_cost, margin, margin_pct}.
- CRUD `/pauses` (scope agenda).
- GET `/undo` (scope agenda) → i gesti che CHI CHIEDE può ancora annullare
  (`agenda.UndoEntry`, ultimi 20, finestra di 10 minuti, solo i propri).
  POST `/undo` {entry_id?} → rimette le cose com'erano (`agenda.undo.perform`):
  ripristina l'istantanea, cancella ciò che il gesto aveva creato e ferma i
  messaggi non ancora partiti; 409 se nel frattempo qualcuno ha toccato le
  stesse righe o il conto è passato in cassa.
- GET `/waitlist` (scope agenda) → entries attive con cliente/servizio.
  POST `/waitlist/{id}/contacted` → status contacted, log.
- GET `/availability?date=&items=<JSON>` (staff_auth) → get_free_slots.

**Endpoint cliente** (client_auth)
- GET `/client/appointments` → futuri e passati (compatti).
- GET `/client/availability?date=&items=<JSON urlencoded>` → get_free_slots.
- POST `/client/appointments` {items, start} → create_appointment via app;
  response include deposit_amount e deposit_status.
- POST `/client/appointments/{id}/move` {start} → consentito solo se mancano ≥
  settings.CLIENT_MOVE_CANCEL_MIN_HOURS ore (altrimenti 400 con messaggio policy); rivalida slot.
- POST `/client/appointments/{id}/cancel` → stessa policy; oltre il limite → 400
  "Annullamento non consentito: contatta il salone" (la reception la registra poi con
  `by_client: true`). Non entra in «torna indietro».
- GET/POST/DELETE `/client/waitlist` {service_id, operator_id?, preference, exact_days?, exact_time?}.

**Tests**: get_free_slots (turni+overlap+idoneità), compute_deposit (regola pct),
create_appointment collision → 409, cancel late → deposito forfeited.

---

## 8. apps/sales — checkout, POS, pagamenti, Stripe

**Models**
- `Sale`: salon FK, location FK null/blank, kind checkout/pos, appointment OneToOne
  "agenda.Appointment" null/blank, client FK null/blank, total Decimal,
  deposit_deducted Decimal default 0, created_by FK user null, created_at.
- `SaleLine`: sale FK related_name="lines", operator FK "staff.Operator" null/blank,
  line_type service/product/gift_card, service FK null, product FK "inventory.Product" null,
  gift_card FK "marketing.GiftCard" null (venduta), qty int default 1, unit_price Decimal,
  discount_pct int default 0, is_gift bool default False, amount Decimal
  (= qty×unit_price×(1−discount/100), 0 se is_gift).
- `Payment`: sale FK related_name="payments", method cash/card/other/gift_card,
  amount Decimal, gift_card FK null (usata come pagamento).

**Servizi**
- `finalize_sale(...)` core condiviso checkout/POS, in transazione:
  calcola amounts; total = Σ amounts; per gift_card in pagamento →
  `marketing.gift_cards.redeem_gift_card(salon, code, amount)` (import nella funzione);
  valida Σ payments == total − deposit_deducted (tolleranza 0.01, altrimenti 422
  "I pagamenti non corrispondono al totale"); crea Sale/lines/payments;
  righe product (anche is_gift) → `inventory.services.deduct_stock_for_sale(sale)`;
  righe gift_card vendute → `marketing.gift_cards.create_gift_card(...)`;
  `marketing.loyalty.accrue_loyalty(sale)`; log `sale.created`.
- Stripe (`stripe_service.py`): `_client()` → HttpError(503, "Stripe non configurato") se
  manca STRIPE_SECRET_KEY; `ensure_customer(client)`, `create_setup_intent(client)`,
  link di pagamento della caparra, rimborsi, `charge_full_amount(appointment)` (off-session sul
  payment method salvato; richiede consents.card_charge → altrimenti 400). È il gateway:
  tutte e sole le chiamate a Stripe. Gli eventi in arrivo da Stripe li gestisce
  `stripe_webhooks.py`, la chiusura del conto `checkout.py`, la caparra vista dalla cassa
  `deposits.py`, riepilogo e storico `reports.py`.

**Endpoint staff** (/api/sales)
- POST `/checkout/{appointment_id}` (scope sales)
  body {blocks:[{operator_id, lines:[{line_type, service_id?, product_id?, qty, unit_price,
  discount_pct?, is_gift?}]}], payments:[{method, amount, gift_card_code?}]} →
  finalize_sale(kind=checkout, deposit_deducted = deposit se paid);
  appuntamento → closed; emit `visit.completed` {client, services, total};
  response: sale + breakdown per operatrice.
- POST `/pos` (scope sales) {client_id?, blocks, payments} → finalize_sale(kind=pos).
  Vendita gift card dal POS: line_type gift_card con {value, recipient_name?}.
- GET `/` (paginate, scope sales) filtri: kind, date_from/to, q (nome cliente), operator_id;
  response include KPI header {revenue, count, items_count} sul filtro corrente.
- GET `/{id}` → dettaglio con righe e pagamenti.
- GET `/today-summary` (staff_auth) → {total, count, checkout_total, pos_total} di oggi
  (il box dell'agenda).
- POST `/appointments/{appointment_id}/charge-no-show` (scope sales) → charge_full_amount, log.
  Solo su appuntamenti no_show; un solo addebito per appuntamento (no_show_payment_intent_id +
  idempotency key Stripe), il secondo tentativo → 409.
- POST `/client/setup-intent` (client_auth) → create_setup_intent (salvataggio carta dall'app).
- POST `/stripe/webhook` (no auth) → firma OBBLIGATORIA (503 senza STRIPE_WEBHOOK_SECRET, 400 se non valida);
  payment_intent.succeeded con metadata.appointment_id e metadata.kind=deposit → deposit_status
  required→paid (una sola volta, importo ≥ caparra) + deposit_payment_intent_id + log;
  kind=no_show non tocca la caparra (log sale.no_show_paid);
  setup_intent.succeeded → salva payment_method sul cliente.

**Tests**: finalize_sale ok e mismatch pagamenti → errore; sconto/omaggio amounts;
deposito detratto; today-summary.

---

## 9. apps/inventory — prodotti, fornitori, movimenti, ordini

**Models**
- `Supplier`: salon FK, name, email blank, phone blank, order_method email/whatsapp/pdf
  default email, address blank, vat_number blank, sdi_pec blank, notes blank.
- `ProductCategory`: salon FK, name, order int.
- `Product`: salon FK, name, sku blank, brand blank, category FK null/blank,
  usage TextChoices internal/retail/mixed, package_unit char blank (ml, pz…),
  package_qty Decimal default 1, supplier FK (obbligatorio, PROTECT),
  purchase_price Decimal default 0, purchase_discount_pct int default 0,
  sale_price Decimal default 0, vat_rate int default 22,
  stock_qty Decimal default 0 (denormalizzata, MAI modificata direttamente),
  min_threshold Decimal default 0, reorder_qty Decimal default 0, active bool default True.
  property `stock_state`: low se stock ≤ soglia, warning se ≤ soglia×1.5, ok.
- `StockMovement`: salon FK, product FK related_name="movements",
  kind TextChoices load/sale/internal_use/adjustment/transfer/return_supplier,
  qty Decimal (+ carico / − scarico), reason char blank, sale FK "sales.Sale" null/blank,
  order FK "inventory.PurchaseOrder" null/blank, invoice FileField null/blank,
  author FK user null, created_at.
- `PurchaseOrder`: salon FK, supplier FK, status draft/sent/received/partial default draft,
  sent_method blank, sent_at null, created_at. `PurchaseOrderLine`: order FK
  related_name="lines", product FK, qty_ordered Decimal, qty_received Decimal default 0.

**Servizi** — INTEGRITÀ: ogni variazione di stock passa da `apply_movement`.
- `apply_movement(product, kind, qty, *, reason="", sale=None, order=None, author=None, invoice=None)`:
  transazione + `select_for_update` sul prodotto; vieta stock negativo per gli scarichi
  (HttpError 422 "Giacenza insufficiente"); crea movimento e aggiorna stock_qty con F().
- `deduct_stock_for_sale(sale)`: per ogni riga product → apply_movement(kind=sale, qty=−qty).
- `orders.generate_draft_orders(salon, author)` (ordini ai fornitori in `orders.py`, carico da
  CSV in `csv_load.py`): prodotti attivi sotto soglia senza riga in ordini
  draft/sent → bozze raggruppate per fornitore, qty = reorder_qty (o soglia−stock se 0).

**Endpoint** (/api/inventory) — scritture scope inventory, log su tutto
- GET `/products` (paginate) filtri categoria/fornitore/brand/usage/stock_state/q;
  default ordering: sotto soglia prima. CRUD prodotti (DELETE → active=False).
- POST `/products/{id}/load` {qty, reason?, invoice?} e POST `/products/{id}/unload`
  {qty, kind: internal_use/adjustment/transfer, reason?} → apply_movement.
- POST `/load-csv` {rows:[{name|sku, qty, supplier_id?}], supplier_id?} → carico multiplo
  (match per sku poi nome; non sovrascrive: somma).
- GET `/products/{id}/movements` + GET `/movements` (storico globale, paginate, filtri kind/date).
- CRUD `/suppliers` (la propagazione ai prodotti è automatica via FK).
- GET `/orders`; POST `/orders/generate` → generate_draft_orders;
  PUT `/orders/{id}` {lines:[{id, qty_ordered}]}; POST `/orders/{id}/send` {method} →
  status sent + emit `supplier.order` {supplier, righe} + log;
  POST `/orders/{id}/receive` {lines:[{id, qty_received}]} → apply_movement load per riga,
  status received/partial (se discrepanze), response con discrepanze evidenziate.

**Tests**: apply_movement aggiorna stock e vieta negativi; generate_draft_orders raggruppa
per fornitore; receive con discrepanza → partial.

---

## 10. apps/marketing — coupon, gift card, fedeltà, comunicazioni

**Models**
- `Coupon`: salon FK, client FK "clients.Client" null/blank, code unique-per-salon
  (human_code(8)), kind percent/amount, value Decimal, origin manual/auto/loyalty,
  status active/redeemed/expired default active, expires_at null/blank,
  redeemed_at null, sale FK "sales.Sale" null/blank, created_at.
- `GiftCard`: salon FK, code (human_code(12)), initial_value, balance,
  buyer_client FK null/blank, recipient_client FK null/blank, recipient_name blank,
  payment_status paid/unpaid, paid_at null, paid_method blank,
  delivery_date null/blank, expires_at null/blank, status active/redeemed/expired, created_at.
- `LoyaltyProgram`: salon FK, name, type points/stamps/tiers/membership,
  earn_metric per_euro/per_visit/per_service, earn_ratio Decimal default 1,
  reward_type coupon_amount/discount_pct/free_service/free_product/gift_card,
  reward_value Decimal default 0, reward_service FK "catalog.Service" null/blank,
  threshold int, enrollment auto/request/paid default auto,
  points_expiry_months int default 0 (0 = mai), bonus JSON default dict
  ({birthday, referral, prebooking, review, double_days}), color (#hex), active bool.
- `LoyaltyAccount`: program FK related_name="accounts", client FK, points int default 0,
  joined_at. unique (program, client).
- `Communication`: salon FK, title, body, image ImageField null/blank, cta_label blank,
  cta_url blank, audience_type labels/clients, audience JSON default list
  (category ids o client ids), status draft/scheduled/sent default draft,
  scheduled_at null, sent_at null, created_at.

**Servizi**
Moduli: `codes.py` (codici e mascheramento), `coupons.py`, `gift_cards.py`, `loyalty.py`,
`communications.py`, `consent.py`, `wallet.py`.
- `gift_cards.create_gift_card(salon, value, *, buyer_client=None, recipient_name="", paid=False,
  paid_method="", sold_by=None, sale=None)` → GiftCard (usata anche da sales).
- `gift_cards.redeem_gift_card(salon, code, amount)`: select_for_update; attiva, non scaduta,
  balance ≥ amount (altrimenti HttpError 422 con messaggio); scala balance,
  status redeemed se 0; ritorna la card. Log `giftcard.redeemed`.
- `loyalty.accrue_loyalty(sale)`: se sale.client None → no-op. Per ogni programma attivo:
  account esistente o auto-creato se enrollment=auto; accrue per earn_metric
  (per_euro: floor(total×ratio); per_visit: ratio; per_service: ratio×n righe servizio);
  se points ≥ threshold → scala threshold + crea Coupon origin=loyalty
  (percent se discount_pct, altrimenti amount con value=reward_value) +
  emit `loyalty.reward` {client, program, coupon_code} + log.
- `coupons.validate_coupon(salon, code, client=None)` → coupon attivo non scaduto
  (e del cliente se client-bound), altrimenti HttpError 404/422.

**Endpoint staff** (/api/marketing) — scritture scope marketing, log
- CRUD `/coupons` (filtri origin/status/q) + POST `/coupons/{id}/redeem` {sale_id?} → redeemed.
- GET `/gift-cards` + KPI {sold_total, redeemed_total, outstanding};
  POST `/gift-cards` (creazione/vendita manuale: se paid → log incasso);
  POST `/gift-cards/{id}/mark-paid` {method}.
- CRUD `/loyalty-programs`; GET `/loyalty-programs/{id}/accounts` (paginate).
- CRUD `/communications`; POST `/communications/{id}/send` → risolve audience in
  client ids (labels → clienti con quelle categorie; consents.marketing True) →
  emit `communication.send` {title, body, cta, client_ids, langs per cliente} →
  status sent, sent_at. Scheduled: status scheduled con scheduled_at; l'evento
  resta TRATTENUTO in outbox fino a scheduled_at e arriva a Yourang ALLA data
  (scheduled_at ≈ adesso): Yourang lo invia subito. Modificare, riprogrammare o
  eliminare una programmata ferma l'evento ancora in coda; per quello che Yourang
  può avere già ricevuto si emette `communication.cancel`
  {communication_id, outbox_event_ids, scheduled_at} (idempotente: gli id sono
  quelli degli eventi `communication.send` consegnati, cioè la loro
  Idempotency-Key «outbox-<id>»; `scheduled_at` è la data dell'invio più lontano
  che annulla, e tiene valido l'annullamento fino a lì).
- Consenso marketing cambiato (scheda cliente o app): `client.marketing_consent`
  {client_id, phone, lang, marketing}; con marketing=false Yourang toglie la
  cliente anche dagli invii che ha già in mano.

**Endpoint cliente**
- GET `/client/wallet` → {gift_cards (recipient o buyer, attive, con balance),
  coupons (attivi del cliente), loyalty:[{program, points, threshold, progress_pct}]}.
- POST `/client/gift-cards` {value, recipient_name?} → gift card unpaid
  (pagamento in salone; Stripe checkout in fase 2) → response con code.

**Tests**: redeem_gift_card (scala e blocca oltre saldo), accrue_loyalty soglia → coupon
origin=loyalty, validate_coupon scaduto, send communication → outbox event.

---

## 11. apps/automations — regole (l'esecuzione è di Yourang)

**Models**
- `Automation`: salon FK, name, event TextChoices: new_client / appointment_created /
  appointment_upcoming / visit_completed / birthday / client_inactive / no_show / slot_freed,
  offset_direction before/after default after, offset_value int default 0,
  offset_unit minutes/hours/days default hours, send_time TimeField null/blank
  (null = subito), conditions JSON default dict (formato common.conditions),
  trigger_origin yourang/webhook default yourang, webhook_token UUID auto unique,
  message_preview text blank (sincronizzata da Yourang, sola lettura),
  active bool default True, created_at/updated_at.

**Endpoint** (/api/automations) — scritture scope marketing
- GET `/` ; POST/PUT/DELETE (su create/update: log + emit `automation.updated`
  con la definizione completa — Yourang si sincronizza da qui).
- POST `/{id}/toggle` → active on/off + emit `automation.updated`.
- GET `/events-catalog` (static): [{value, label_it, label_en}] per gli event sopra +
  operatori cmp disponibili + campi filtro standard (reliability, categories, total_spent,
  visits, noshow_count) — serve al costruttore UI.
- POST `/hook/{webhook_token}` (no auth): trigger esterno → log `automation.triggered` +
  emit `automation.triggered` {automation_id, payload ricevuto}. Token sconosciuto → 404.
  L'URL endpoint mostrato in dashboard (sola lettura) è `/api/automations/hook/<token>`.

**Tests**: CRUD + toggle emette outbox; webhook con token valido/invalido.

---

## 12. apps/insights — KPI e analisi (solo titolare)

Nessun modello. Tutti gli endpoint: `require_owner(ctx)`.
Periodi: `period=month|quarter|year` (+ opzionale `date=` ancora, default oggi) →
helper `periods.period_range(period, date)` → (start, end).

**Endpoint** (/api/insights)
- GET `/kpis?period=` → {
  revenue (Σ Sale.total), sales_count, avg_ticket,
  retail_revenue (Σ SaleLine product), appointments_count (closed),
  noshow_rate, cancel_rate (su appuntamenti del periodo),
  occupancy_pct (minuti prenotati closed+confirmed / minuti di turno da staff.shift_windows
  — calcolo per giorno del periodo, cap 100),
  return_rate (clienti con ≥2 appuntamenti closed nel periodo / clienti con ≥1),
  rebooking_rate (clienti con appuntamento closed nel periodo che hanno anche un
  appuntamento futuro ≥ oggi / totale), new_clients, returning_clients,
  avg_frequency (appuntamenti closed / clienti distinti),
  clients_by_category [{category, count}] }.
  Ogni KPI fallito per dati mancanti → 0, mai errore.
- GET `/revenue-series?period=&granularity=day|week|month` → [{date, revenue}].
- GET `/revenue-by-category?period=` → [{category (ServiceCategory name_it), revenue}]
  (righe service via service.category; righe product → "Prodotti").
- GET `/occupancy-by-weekday?period=` → [{weekday 0-6, occupancy_pct}].
- POST `/ask` {question} → HttpError(501, "Chiedi a Youty sarà disponibile nella fase 2").

**Tests**: period_range; kpis su dataset minimo (1 vendita, 1 appuntamento) senza eccezioni.

---

## 13a. apps/integrations — Yourang (OAuth diretto)

Il portale è il client OAuth di Yourang (OIDC + PKCE, vedi DEPLOY.md §8): token
del salone cifrati sulla connessione, segreto del webhook per salone.
- GET `/yourang/oauth/start` (staff, titolare) e GET `/yourang/oauth/login/start`
  (pubblico) → `{authorize_url, nonce}`. Lo `state` sta a database con il verifier
  PKCE (e, per il collegamento, salone e utente); il `nonce` (HMAC dello state)
  resta nel sessionStorage della finestra che avvia il flusso.
- POST `/yourang/oauth/exchange` `{code, state, nonce}`: il `nonce` si controlla
  prima di consumare lo state; senza, o non valido → 400. State sconosciuto,
  già usato o più vecchio di 10 minuti → 400. Il modo lo decide lo state (con
  salone → collegamento, senza → accesso), non la richiesta. Salone già collegato
  a un'altra organizzazione (o organizzazione già di un altro salone) → 409
  «scollegalo prima». `connect` → `{mode, status}` (webhook registrato di nuovo,
  prima sync in background); `login` → `{mode, session}`.
- «Accedi con Yourang» collega da solo un salone solo se chi entra ne è il
  titolare ed è l'unico suo senza connessione; su un'org già collegata non
  ridefinisce la connessione, salvo rimetterla in piedi se è senza token o in
  errore.
- GET `/yourang/status` → `{connected, status, connected_at, last_sync_at, scope,
  yourang_org_id, last_error}`; `last_error` "" se l'ultima sync è andata bene.
- Webhook in ingresso: firma col segreto del salone dell'`organization_id`;
  `contact.*` con `resource_id` riconcilia solo quel contatto. Gli annullamenti
  arrivati DA Yourang non vengono rimandati a Yourang come
  `appointment.cancelled`.
