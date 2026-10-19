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
- **Limiti dei campi**: gli schemi di ingresso portano i limiti delle colonne
  (`max_length`, `ge`/`le`, importi fino a `common.money.MAX_MONEY`): un valore
  fuori limite è un 422 con il nome del campo, non un 500 di PostgreSQL. Nei
  filtri una data scritta bene ma inesistente (`2026-02-30`) è un 400 «Data non
  valida: usa il formato YYYY-MM-DD».
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
  `agenda.services.messages.emit_appointment_event`, che li TRATTIENE per
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

Li riceve ogni salone nuovo, anche quello nato da «Accedi con Yourang»; per i
saloni già creati così la migrazione `accounts 0006` crea quelli che mancano
(solo i mancanti, per nome; non tocca i ruoli esistenti).

**Endpoint staff** (prefisso /api/auth)
- POST `/staff/login` {email, password} → {access, refresh, user:{id,email,name}, salon:{id,name,slug}, scopes, is_owner}. Usa `common.auth.create_staff_tokens`. Se l'utente ha più membership prende la prima (v1 mono-salone).
- POST `/staff/refresh` {refresh} → nuovi token (verifica typ staff_refresh).
- GET `/me` (staff_auth) → utente + salone + scopes + is_owner.
- GET `/members` (scope team) → membri con ruolo. POST `/members/{id}/role` {role_id} (scope team).
  DELETE `/members/{id}` (scope team; vietato rimuovere l'owner → 400).
- CRUD `/roles` (scope team; i ruoli is_system non sono eliminabili → 400).
- POST `/invitations` {email, role_id, operator_id?} (scope team) → crea invito (annulla
  quello ancora aperto alla stessa email), manda la mail col link `<FRONTEND_ORIGIN>/invito/<token>`
  se la posta è configurata (API Mailgun con `MAILGUN_API_KEY`/`MAILGUN_DOMAIN`, o SMTP con `EMAIL_HOST`), `emit_event(salon,"team.invitation",{…, accept_url, email_sent})`
  + log. Risponde col link e `email_sent`. GET `/invitations` (scope team): codice e link solo a chi
  può concedere quel ruolo. POST `/invitations/{id}/resend` (rimanda e rinnova 7 giorni),
  DELETE `/invitations/{id}` (annulla).
- GET `/invitations/preview?token=` (no auth, tetto per IP): salone, ruolo, email, stato,
  `has_account`/`has_password`.
- POST `/invitations/accept` {token, password, first_name?, last_name?} (no auth) → account
  nuovo (nome e password) o esistente con quell'email (la sua password) + Membership con
  il ruolo dell'invito, scheda Staff collegata se l'invito la porta → token di login.
- POST `/invitations/accept-session` {token} (staff auth, email dell'account = email
  dell'invito): per chi entra con Yourang → sessione nel salone dell'invito.

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
- `Client`: salon FK, first_name, last_name, phone blank (unico per salone
  quando c'è, comunque scritto: `phone_key`; "" = la cliente un numero suo non
  ce l'ha, e allora niente OTP né accesso all'app), contact_client FK a sé
  SET_NULL null (`dependents`: «si contatta tramite», la scheda col numero a
  cui vanno i messaggi di chi non ne ha uno), email blank,
  wa bool default True, lang it/en default it, categories M2M ClientCategory blank,
  reliability int default 100 (0–100, calcolata: vedi sotto), origin char blank (Instagram, Google…),
  birthday date null/blank, since date null/blank,
  consents JSON default dict ({privacy, marketing, card_charge} bool),
  whatsapp_reminders bool default True,
  stripe_customer_id char blank, stripe_payment_method_id char blank,
  deposit_always bool default False, is_active bool default True.
  property `full_name`; property `contact_phone` (il numero a cui scrivere: il
  suo, altrimenti quello di `contact_client`, un livello solo, altrimenti "").
  Regole del contatto (`profiles.resolve_contact`): stesso salone, non sé
  stessa, attiva, con un numero suo, che non passi a sua volta da un'altra; chi
  fa da contatto non può passare da un'altra né togliersi il numero.
- `ClientNote`: client FK, text, visibility private/ai (TextChoices), author FK user null, created_at.
- `TechnicalSheet` (scheda tecnica, sola lettura una volta creata): client FK,
  appointment FK "agenda.Appointment" null/blank, category char (nail/hair/viso/extra…),
  treatment char, zone char blank, products text blank, params JSON default dict,
  outcome text blank, duration_hold char blank, advice text blank, protocol text blank,
  next_step char blank, photo ImageField null/blank, author FK user null, created_at.

**Service** (`clients.services`)
- Visite = GIORNI (fuso del salone) con almeno una visita chiusa o un passaggio
  al banco (`visit_days`): due appuntamenti in contemporanea con due operatrici
  sono una visita. Le vendite fatte solo di gift card o pacchetti
  (`line_type` gift_card/package) non sono visite; spesa senza caparre né
  penali no-show. `client_stats(client)` → {visits, total_spent, last_visit}.
  Contano allo stesso modo lo storico (`counts.visits`) e le statistiche
  dell'operatrice (clienti di oggi, visite delle clienti servite).
- Affidabilità calcolata: 100 − 25 per ogni giorno con un no-show − 10 per ogni
  giorno con un annullamento tardivo (`cancelled_late`, e non già no-show)
  negli ultimi 12 mesi (dallo stesso giorno di un anno fa), fra 0 e 100
  (`reliability_basis`). `recompute_reliability(client)` la salva (UPDATE della
  sola colonna, log `client.updated` con `fields: ["reliability"]` se cambia):
  la chiamano no-show, annullamento tardivo e «torna indietro» dell'agenda e
  l'evento Yourang che arriva già no-show. Non è scrivibile dall'API.
- `client_facts(client) -> dict`: {reliability (calcolata ora, non la colonna),
  categories:[nomi], total_spent, visits (giorni), noshow_count,
  latecancel_count (giorni, di sempre), deposit_always}. Campi mancanti → 0/[].

**Comando** `python manage.py recompute_reliability [--salon ID]`: ricalcola
l'affidabilità di tutte le schede (una query per salone, un UPDATE per
punteggio; log `client.reliability_recomputed` con `{changed}`). Da lanciare
dopo un import di visite da un altro gestionale e da programmare una volta al
giorno: un no-show di tredici mesi fa esce dalla finestra senza che nessun
gesto lo dica (la scheda aperta si corregge da sola, la lista no).

**Endpoint staff** (/api/clients)
- GET `/` (paginate) filtri: q (nome/telefono/email; un numero trova anche le
  schede senza telefono che passano da quel numero, mai le altre senza
  telefono), category_id, reliability_min/max, is_active. Ogni riga
  (`ClientListOut`) ha `contact` e `amount_due` (debito, null senza «vendite»).
- GET `/counts` (staff_auth) → `{active, categories: [{id, count}]}`: le schede
  attive e quante per etichetta, in una risposta (la sezione Clienti), con lo
  stesso filtro per salone della lista.
- Modifica ed eliminazione di un'etichetta avvengono sotto il lock del salone,
  come il salvataggio di regole caparra e automazioni che la citano:
  un'etichetta (o una regola, o un'automazione) sparita nel frattempo è un 404.
- GET `/categories` + CRUD (scope clients). GET `/{id}` → dettaglio + computed
  {visits (giorni), total_spent, last_visit, amount_due (`sales.dues`); a
  zero/null con `stats_hidden` senza «vendite»}, `dependents` (le schede attive
  che si contattano tramite lei), `reliability_basis` {no_shows,
  late_cancellations, since}. Ogni `ClientOut` ha `contact` {id, full_name,
  phone} o null. POST/PUT (scope clients, log): telefono facoltativo,
  `contact_client_id` (null sul PUT = scollega), `reliability` ignorato. Un
  numero già di un'altra scheda: 409 `archived_client_id` se archiviata (alla
  creazione; 400 in modifica), 400 {detail, phone_holder_id,
  phone_holder_name, contact_allowed} se attiva.
  DELETE (scope clients) → soft: is_active=False + log `client.deleted`; chi si
  contattava tramite lei perde il collegamento → {ok, unlinked_dependents:
  [{id, full_name, phone}]} (e un `client.updated` per ognuna).
- POST `/import` {rows:[{first_name,last_name,email,phone,…,name_index}]} (scope
  clients) → upsert per telefono (poi email, poi per nome fra le schede senza
  numero, la n-esima omonima con `name_index`); le righe senza telefono entrano
  senza numero; un numero già in rubrica con un altro nome di battesimo → scheda
  senza telefono collegata a chi ha il numero (avviso). Ritorna {created,
  updated, skipped, linked, errors, warnings}. Log.
- Note: GET/POST/DELETE `/{id}/notes` (scope clients).
- Schede tecniche: GET `/{id}/sheets`, POST `/{id}/sheets` (scope clients, log).
  NESSUN endpoint update/delete (read-only dopo il salvataggio).

**Tests**: import upsert, client_facts con dati minimi, immutabilità scheda
(nessuna rotta update), schede senza telefono e contatto (`test_no_phone`),
visite per giorno (`test_history_stats`), affidabilità e comando
(`test_reliability`).

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
  active bool default True, order int default 0, is_addon bool default False.
  `is_addon` = aggiuntivo: si fa DURANTE un altro servizio (nail art durante la manicure,
  massaggio ai piedi durante la pedicure). In agenda aggiunge il prezzo, non il tempo
  (vedi §7, «Aggiuntivi»); `duration_min` resta la durata indicativa di listino (≥ 1).
- `Package`: salon FK, name, description blank, price Decimal, active bool default True,
  validity_days int null (giorni per usare le sedute dalla vendita; null = senza scadenza).
- `PackageItem`: package FK related_name="items", service FK, qty int default 1
  (= sedute di quel servizio nel pacchetto).

**Endpoint** (/api/catalog)
- GET `/categories` + CRUD (scope pricing) + POST `/categories/reorder` {ids:[...]}.
- GET `/services?category_id=&active=` + CRUD (scope pricing).
  Su cambio prezzo → log `service.price_changed` con {old, new}. `is_addon` nel PUT:
  assente = invariato (come `color`), nel POST assente = falso.
- GET `/packages` + CRUD (scope pricing) — items nested nel payload
  {items:[{service_id, qty}]}, ricreati a ogni update; `validity_days` 1–3650 o null.
  Nel PUT `items` e `validity_days` assenti = invariati (null = senza scadenza).
- Pubblici (no auth, per la web app prima del login): GET `/public/services?salon=slug`
  → categorie ordinate con servizi attivi {id, name_it, name_en, duration_min, soak_min,
  price, is_addon}; GET `/public/packages?salon=slug` → {id, name, description, price,
  validity_days, items:[{service_id, name_it, name_en, soak_min, qty}]}. L'app cliente
  non prenota un aggiuntivo da solo: lo offre come «Aggiungi» dopo il servizio principale.
- Un pacchetto venduto in cassa diventa una gift card a sedute per servizio
  (`marketing.credits.create_package_credits`, vedi §10), che scade dopo
  `validity_days` dalla vendita.

**Tests**: reorder, package con items, validità delle sedute, endpoint pubblico.

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

**services/** — un package, un modulo per argomento (la mappa è in
`docs/SVILUPPO.md` §1.1); si importa dal sottomodulo, la radice non ri-esporta niente.
- `availability.get_free_slots(salon, date, items, location=None) -> list[dict]`
  items = [{"service_id": int, "operator_id": int|None}] (None = qualsiasi idonea).
  Griglia da settings.AGENDA_SLOT_STEP_MIN (15'). Un orario t è valido se i servizi si
  concatenano in sequenza da t e per ciascuno esiste un'operatrice idonea
  (in `service.operators`) libera per l'intera finestra: dentro `staff.services.shift_windows`,
  senza sovrapposizioni con Appointment (status non in cancelled/no_show) né Pause.
  Ritorna [{"start": iso, "assignment": [{"service_id", "operator_id"}]}].
- `deposits.compute_deposit(salon, client, total_price) -> Decimal`:
  se client.deposit_always → prima regola attiva qualunque; altrimenti prima
  `core.DepositRule` attiva (per priority) le cui conditions matchano
  `clients.services.client_facts(client)`; pct → percentuale del totale, fixed → importo. 0 se nessuna.
- `appointments.create_appointment(salon, client, items, start, *, via, actor=None, flexible=False)`:
  transazione; rivalida che lo slot sia libero (altrimenti HttpError 409
  "Orario non più disponibile"); snapshot durata/prezzo dal servizio; operator principale =
  operatrice del primo item; calcola deposito → deposit_status required/none;
  log + emit `appointment.created` (payload: client nome/telefono/lang, servizi, start ISO, deposito).
- `freed_slots.free_slot_event(appointment)`: emit `slot.freed` {start, duration_min, operator_id,
  matching_waitlist: [entry_id...]} — waitlist attive compatibili per servizio+operatrice
  (mai quelle per un aggiuntivo).

**Aggiuntivi** (`services/addons.py`; servizi `catalog.Service.is_addon`)
- La voce (`AppointmentService`) di un aggiuntivo ha `duration_min = 0` e `soak_min = 0`:
  aggiunge il prezzo (conto, caparra, margine: niente manodopera) ma non il tempo, non
  allunga la visita e non occupa nessuno slot (né di chi la fa né nella ricerca). Le voci
  NUOVE lo sono se il servizio è un aggiuntivo; quelle già sulla visita restano come sono
  state concordate (una nail art prenotata a 15' prima del flag resta di 15').
- Si appoggia al servizio PRIMA di lei: un aggiuntivo non può essere la prima voce (422
  «Un aggiuntivo va dopo il servizio a cui si appoggia») e una visita non può essere di
  soli aggiuntivi (422 «Un aggiuntivo va insieme a un servizio»). Vale per creazione
  (dashboard, app, assistente vocale), modifica, ricerca degli orari (anche pubblica) e
  lista d'attesa (nessuna iscrizione per un aggiuntivo). Il 422 non si supera con `force`.
- Chi lo fa: l'operatrice indicata, se idonea (400 altrimenti, come ogni servizio); senza
  indicazione chi fa il servizio a cui si appoggia, se lo sa fare, altrimenti la prima idonea.
  Nessuna verifica di libertà né di turno: non occupa tempo. Ricerca e conferma scelgono
  allo stesso modo.
- Modifica (PUT): la durata di un aggiuntivo resta 0 qualunque `duration_min`/`soak_min`
  arrivi; lo 0 è ammesso solo per lui (su un altro servizio: 422).
- Spostamento: gli aggiuntivi seguono la loro colonna come ogni voce (idoneità compresa).
- Stacco (`/split`): un servizio si stacca INSIEME agli aggiuntivi che gli vengono dietro
  (le righe di chi aveva il servizio passano all'operatrice di arrivo); un aggiuntivo da
  solo no (422 «Un aggiuntivo non si stacca da solo: …»). Se servizio e aggiuntivi sono
  tutta la visita → 400 «usa Sposta». Il tempo lasciato in mezzo diventa attesa dopo
  l'ultimo servizio CON tempo prima del pezzo staccato.
- Messaggi a Yourang: l'aggiuntivo compare fra i `services` con `duration_min: 0`.

Gli endpoint stanno in `api/`, un modulo per risorsa (`agenda_views`, `appointments`,
`undo_routes`, `pauses`, `waitlist`, `availability`, `client_app`); la forma delle
risposte in `presenters.py`.

**Endpoint staff** (/api/agenda)
- GET `/day?date=YYYY-MM-DD&location_id=` → per ogni operatrice attiva:
  {operator, windows di turno, appointments:[{...items, client{...}}], pauses}.
- GET `/week?start=YYYY-MM-DD` → per giorno: conteggi + appuntamenti compatti.
- POST `/appointments` {client_id, items, start, flexible?} (scope agenda) → create_appointment via dashboard.
- POST `/appointments/import` {visits:[{first_name,last_name,phone,email,start,note?,
  items:[{service_id,operator_id,duration_min,price?}]}], location_id?} (scope agenda) → visite di un
  altro gestionale, già abbinate a listino e staff (`services/importer.py`). Cliente per telefono (senza
  numero: email, poi nome), creata se manca. Durata e prezzo del file; nessuna caparra e nessun evento
  verso Yourang; fuori turno o sovrapposta entra `forced`. Ritorna {created, duplicates, skipped,
  clients_created, errors, warnings}; log `appointment.imported`.
- POST `/appointments/{id}/move` {start, operator_id?} (scope agenda) → rivalida slot,
  sposta (anche items stesso delta), log + emit `appointment.moved` + free_slot_event sul vecchio orario.
  La scadenza di una caparra richiesta si ricalcola sull'orario nuovo (anche con
  «Indietro» e con lo stacco del primo servizio).
- POST `/appointments/{id}/check-in` (scope agenda) → status checked_in, log, emit `appointment.checked_in`.
- POST `/appointments/{id}/start` (scope agenda) → status in_progress.
- POST `/appointments/{id}/no-show` {reason} (scope agenda) → status no_show,
  deposit paid→forfeited, cancel_reason, log, emit `appointment.no_show`, free_slot_event.
  Con la caparra ancora «richiesta» il link di pagamento si ritira (messaggi non
  ancora partiti annullati, sessione Stripe chiusa); «Indietro» ne manda uno nuovo.
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
  `items[].duration_min` da 1 a 720; 0 solo per un aggiuntivo (vedi «Aggiuntivi»).
  Se modifica o stacco liberano tempo, `slot.freed` lo annuncia come lo
  spostamento (nei match anche chi aspettava il servizio tolto o staccato). Se la
  caparra da pagare scende a 0 € diventa «nessuna», senza scadenza e con il link
  chiuso; il rilascio automatico non tocca le caparre richieste a 0 €.
- GET `/appointments/{id}/margin` → stima margine: revenue = Σ item.price;
  supplier_cost/product_cost da Service (snapshot corrente); labor = Σ(duration/60 × operator.hourly_cost);
  → {revenue, supplier_cost, product_cost, labor_cost, margin, margin_pct}.
- CRUD `/pauses` (scope agenda).
- GET `/undo` (scope agenda) → i gesti che CHI CHIEDE può ancora annullare
  (`agenda.UndoEntry`, ultimi 20, finestra di 10 minuti, solo i propri).
  POST `/undo` {entry_id?} → rimette le cose com'erano (`agenda.undo.perform`):
  ripristina l'istantanea, cancella ciò che il gesto aveva creato e ferma i
  messaggi non ancora partiti; 409 se nel frattempo qualcuno ha toccato le
  stesse righe o il conto è passato in cassa. Anche per una pausa: 409 se il
  tempo che riprende è stato occupato da una visita o da un'altra pausa.
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
  deposit_deducted Decimal default 0, amount_due Decimal default 0 (quanto la
  cliente deve ancora: 0 = saldato), created_by FK user null, created_at.
  Conto unico: le altre visite chiuse con la vendita la puntano con
  `Appointment.paid_in_sale` (related_name `covered_appointments`).
- `SaleLine`: sale FK related_name="lines", operator FK "staff.Operator" null/blank,
  line_type service/product/gift_card/package, service FK null, product FK "inventory.Product" null,
  gift_card FK "marketing.GiftCard" null (venduta), package FK "catalog.Package" null
  (venduto), qty int default 1, unit_price Decimal,
  discount_pct int default 0, is_gift bool default False, amount Decimal
  (= qty×unit_price×(1−discount/100), 0 se is_gift).
- `Payment`: sale FK related_name="payments", method cash/card/other/gift_card,
  amount Decimal, gift_card FK null (usata come pagamento), created_at (quando è
  arrivato il denaro: al conto la data della vendita, per un saldo il giorno del saldo).

**Servizi**
- `finalize_sale(..., allow_due=False)` core condiviso checkout/POS, in transazione:
  calcola amounts; total = Σ amounts; per gift_card in pagamento →
  `marketing.gift_cards.redeem_gift_card(salon, code, amount)` (import nella funzione;
  con `sessions` > 1 nel pagamento anche `sessions=`);
  valida Σ payments == total − deposit_deducted (tolleranza 0.01, altrimenti 422
  "I pagamenti non corrispondono al totale"). Con `allow_due` e una cliente i
  pagamenti possono essere meno del dovuto: la differenza va in `amount_due`; più
  del dovuto → 422 "I pagamenti superano il totale da pagare"; senza cliente →
  422 "Per lasciare un conto da saldare scegli la cliente". Crea Sale/lines/payments
  (i pagamenti con la data della vendita);
  righe product (anche is_gift) → `inventory.services.deduct_stock_for_sale(sale)`;
  righe gift_card vendute → `marketing.gift_cards.create_gift_card(...)` (con
  `gift_service_id` e `sessions` è una carta «a trattamento»; `kind` gift | prepaid,
  con prepaid la destinataria è la cliente stessa e serve la cliente);
  righe package (`package_id`, del salone e attivo, prezzo di default quello del
  pacchetto, sconto e omaggio ammessi, qty spezzata in righe da 1, serve la cliente) →
  `marketing.credits.create_package_credits(salon, package, client, amount=line.amount,
  sale, line, paid_method=<primo metodo>, actor)`: le sedute della cliente;
  `marketing.loyalty.accrue_loyalty(sale)`; log `sale.created`.
- `settle_sale(salon, sale_id, payments)`: lock del salone, poi della vendita;
  aggiunge i pagamenti con la data di adesso e riduce `amount_due` (400 se già
  saldato, 422 se si paga più di quanto resta); log `sale.settled`.
- `reports.cash_movements(salon, start, end)`: il denaro entra quando arriva.
  `due_left` = parte delle vendite del periodo non pagata nel periodo (dovuto
  ancora aperto + saldi arrivati dopo), `settled` = pagamenti del periodo per
  vendite di prima, `gift_card_redeemed` = pagamenti con gift card del periodo,
  `package_sold`. Lo usano il riepilogo di oggi e i KPI degli insight
  (`cash_in` = venduto + caparre incassate − gift card − caparre detratte
  − caparre restituite − due_left + settled).
- Stripe (`stripe_service.py`): `_client()` → HttpError(503, "Stripe non configurato") se
  manca STRIPE_SECRET_KEY; `ensure_customer(client)`, `create_setup_intent(client)`,
  link di pagamento della caparra, rimborsi, `charge_full_amount(appointment)` (off-session sul
  payment method salvato; richiede consents.card_charge → altrimenti 400). È il gateway:
  tutte e sole le chiamate a Stripe. Gli eventi in arrivo da Stripe li gestisce
  `stripe_webhooks.py`, la chiusura del conto `checkout.py`, la caparra vista dalla cassa
  `deposits.py`, riepilogo e storico `reports.py`.

**Endpoint staff** (/api/sales)
- POST `/checkout/{appointment_id}` (scope sales)
  body {blocks:[{operator_id, lines:[{line_type, service_id?, product_id?, package_id?, qty,
  unit_price, discount_pct?, is_gift?, value?, recipient_name?, gift_service_id?, sessions?,
  kind?}]}], payments:[{method, amount, gift_card_code?, sessions?}], coupon_code?,
  leave_due?, extra_appointment_ids?} →
  finalize_sale(kind=checkout, deposit_deducted = caparre ancora in cassa, allow_due=leave_due);
  appuntamento → closed; emit `visit.completed` {client, services, total};
  response: sale + breakdown per operatrice.
  Già incassato (400): la visita ha la sua vendita o `paid_in_sale`.
  Conto unico: `extra_appointment_ids` (al più 10) sono altre visite della stessa
  cliente, nello stesso giorno del salone, non annullate né no-show, non già
  incassate, diverse dalla principale (altrimenti 400; 404 se non sono del salone);
  rilette sotto gli stessi lock. Le loro righe le manda il frontend nei blocchi, con
  la loro operatrice. Si detrae la somma delle caparre ancora in cassa di tutte le
  visite; l'eccedenza torna alla cliente ripartita sulle visite (la principale per
  prima) senza restituire a nessuna più di quanto ha versato. Dopo la vendita la
  principale è `closed` e le altre `closed` con `paid_in_sale` = la vendita, ognuna
  col suo `appointment.closed`. `visit.completed` è uno solo, per la visita
  principale, con i servizi di tutto il conto.
- GET `/checkout/{appointment_id}/other-visits` (scope sales) → [AppointmentOut]: le
  altre visite aperte della cliente nello stesso giorno, ancora da incassare (la
  sezione «Altre visite oggi» della cassa).
- POST `/pos` (scope sales) {client_id?, blocks, payments, coupon_code?, leave_due?} →
  finalize_sale(kind=pos). Vendita gift card dal POS: line_type gift_card con {value,
  recipient_name?} (o a trattamento: gift_service_id, sessions, kind); pacchetto:
  line_type package con {package_id}.
- POST `/{id}/settle` (scope sales) {payments:[…]} → settle_sale; response: dettaglio vendita.
- GET `/dues?client_id=` (scope sales) → {client_id, amount_due, sales:[SaleOut]}: i
  conti da saldare della cliente, dal più vecchio.
- GET `/` (paginate, scope sales) filtri: kind, date_from/to (data inesistente → 400), q (nome cliente), operator_id,
  due (solo i conti da saldare);
  response include KPI header {revenue, count, items_count, due_total} sul filtro corrente.
  SaleOut porta `amount_due`; ogni pagamento la sua `created_at`.
- GET `/{id}` → dettaglio con righe (anche `package_id`/`package_name`), pagamenti e
  `covered_appointment_ids` (conto unico).
- GET `/today-summary` (staff_auth) → {total, count, checkout_total, pos_total,
  gift_card_sold, package_sold, gift_card_redeemed, deposit_used, deposit_cashed,
  deposit_refunded, due_left, settled, cash_in} di oggi (il box dell'agenda): il
  venduto per data della vendita, `cash_in` il denaro arrivato oggi (vedi `cash_movements`).
- POST `/appointments/{appointment_id}/charge-no-show` (scope sales) → charge_full_amount, log.
  Solo su appuntamenti no_show; un solo addebito per appuntamento (no_show_payment_intent_id +
  idempotency key Stripe), il secondo tentativo → 409.
- POST `/client/setup-intent` (client_auth) → create_setup_intent (salvataggio carta dall'app):
  nei metadata `salon_id` e l'account firmato (`acct`), come per i pagamenti, e il
  webhook riconosce l'account allo stesso modo.
- POST `/stripe/webhook` (no auth) → firma OBBLIGATORIA (503 senza STRIPE_WEBHOOK_SECRET, 400 se non valida);
  payment_intent.succeeded con metadata.appointment_id e metadata.kind=deposit → deposit_status
  required→paid (una sola volta, importo ≥ caparra) + deposit_payment_intent_id + log;
  kind=no_show non tocca la caparra (log sale.no_show_paid);
  `deposit.paid` ha la stessa forma online e con l'incasso al banco: i campi
  dell'appuntamento, come gli altri eventi dell'agenda, più `amount`;
  setup_intent.succeeded → salva payment_method sul cliente.
  Caparra pagata per un appuntamento che non c'è più → rimborso e una sola riga
  `deposit.orphan_payment` (prima «in corso», poi l'esito; la chiamata a Stripe è
  fuori dalla transazione). Mentre un'altra consegna sta rimborsando, 503 «Rimborso
  della caparra in corso: riprova tra poco», così Stripe ritenta; una riga ferma
  «in corso» da più di 10 minuti si riprende con la stessa chiave di idempotenza.

**Tests**: finalize_sale ok e mismatch pagamenti → errore; sconto/omaggio amounts;
deposito detratto; today-summary; conti da saldare e saldi (`test_dues`); conto
unico (`test_single_bill`); pacchetti, trattamenti già pagati e sedute (`test_prepaid`).

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
- GET `/products/{id}/movements` + GET `/movements` (storico globale, paginate, filtri kind/date;
  data inesistente → 400).
- CRUD `/suppliers` (la propagazione ai prodotti è automatica via FK).
- GET `/orders`; POST `/orders/generate` → generate_draft_orders;
  PUT `/orders/{id}` {lines:[{id, qty_ordered}]} (la stessa riga due volte → 400 «La stessa
  riga d'ordine compare più volte»); POST `/orders/{id}/send` {method} →
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
  Trattamenti già pagati: gift_service FK null (carta «a trattamento»), kind
  gift (regalo) / prepaid (già pagato dalla cliente stessa) / package (sedute di un
  pacchetto: package FK, package_line FK alla SaleLine), sessions_total e
  sessions_left (1/1 per le carte a importo); `session_value` = saldo ÷ sedute
  rimaste per difetto, l'ultima seduta prende il resto.
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
Moduli: `codes.py` (codici e mascheramento), `coupons.py`, `gift_cards.py`, `credits.py`
(sedute dei pacchetti), `loyalty.py`, `communications.py`, `consent.py`, `wallet.py`.
- `gift_cards.create_gift_card(salon, value, *, gift_service=None, buyer_client=None,
  recipient_client=None, recipient_name="", paid=False, paid_method="", sold_by=None,
  sale=None, cash_in=True, kind="gift", sessions=1, package=None, package_line=None,
  expires_at=None)` → GiftCard (usata anche da sales). Valore fra 0 e MAX_MONEY (zero solo
  per un trattamento), sedute 1–100 e solo con `gift_service`.
- `gift_cards.redeem_gift_card(salon, code, amount, sessions=1)`: select_for_update; attiva,
  non scaduta, pagata, balance ≥ amount (altrimenti HttpError 422 con messaggio); scala
  balance, status redeemed se 0. Sulle carte a più sedute toglie `sessions` sedute e
  all'ultima azzera saldo e carta. Ritorna la card. Log `giftcard.redeemed`.
- `gift_cards.sell_gift_card(...)`: la vendita dallo staff (kind gift o prepaid; con
  `gift_service` valore = prezzo × sedute; prepaid = acquirente e destinataria la stessa
  cliente). `has_remaining_q()`: carte con saldo o con sedute di un trattamento ancora da
  fare — la regola di agenda (`spendable_gift_cards`), caparra e portafoglio.
- `credits.create_package_credits(salon, *, package, client, amount, sale=None, line=None,
  paid_method="", actor=None, expires_at=None)`: una carta kind=package per servizio del
  pacchetto (sedute = qty), importo diviso in proporzione al listino, scadenza
  `validity_days` dalla vendita. La chiama la cassa per le righe «package».
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
  Un coupon intestato si lega solo a una vendita della stessa cliente: su quella
  di un'altra, o senza cliente, 422 «Coupon riservato a un altro cliente:
  intestalo alla vendita» (come in cassa).
- GET `/gift-cards?status=&payment_status=&kind=&q=&client_id=` + KPI {sold_total,
  redeemed_total, outstanding} sulle carte filtrate; `q` cerca anche trattamento e
  pacchetto. Ogni carta porta kind, sessions_total, sessions_left, session_value,
  package_id, package_name.
  POST `/gift-cards` (creazione/vendita manuale: se paid → vendita in cassa e log
  incasso) con `kind` gift | prepaid e `sessions` (1–100, solo con gift_service_id: il
  valore diventa prezzo × sedute). prepaid = acquirente e destinataria la stessa
  cliente (422 senza cliente o con due clienti diverse); package → 422 (nasce solo
  dalla vendita del pacchetto in cassa).
  POST `/gift-cards/{id}/mark-paid` {method}. `paid_method`/`method` è uno dei metodi
  della cassa (`cash`, `card`, `other`, `gift_card`; "" = non indicato), al massimo
  20 caratteri; altrimenti 422 «Metodo di pagamento non valido».
- In agenda (`appt.gifts`, `agenda.presenters._gifts_out`) ogni trattamento già pagato
  che copre un servizio della visita: {gift_card_id, code, service_id, service_name,
  balance, from_name, kind, sessions_total, sessions_left, session_value, package_name,
  expires_at}. La caparra si calcola al netto: una carta a sedute copre una riga per
  seduta rimasta, per intero; una carta a una seduta fino al suo saldo.
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
- GET `/client/wallet` → {gift_cards (recipient o buyer, attive, non scadute; con
  `spendable`, `received`, `from_name` e, per i trattamenti già pagati, kind,
  sessions_total, sessions_left, session_value, package_name), coupons (attivi del
  cliente), loyalty:[{program, points, threshold, progress_pct}]}.
- POST `/client/gift-cards` {value, recipient_name?} → gift card unpaid
  (pagamento in salone; Stripe checkout in fase 2) → response con code.

**Tests**: redeem_gift_card (scala e blocca oltre saldo), accrue_loyalty soglia → coupon
origin=loyalty, validate_coupon scaduto, send communication → outbox event; carte a
sedute, pacchetti venduti, già pagato dallo staff, KPI e portafoglio (`test_credits`).

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
  con la definizione completa — Yourang si sincronizza da qui). Create e update
  salvano sotto il lock del salone; un PUT su un'automazione eliminata nel
  frattempo → 404 «Automazione non trovata».
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
  resta nel sessionStorage della finestra che avvia il flusso. Se Yourang non
  risponde (discovery) → 503 «Yourang non risponde: riprova tra qualche minuto»,
  senza salvare lo state; a ogni avvio si cancellano gli state scaduti.
  `/login/start` ha un tetto per IP: 30 avvii ogni 15 minuti, poi 429.
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
- Assistente vocale (prenotazioni al telefono, `voice.py`): l'agente Yourang usa
  tre strumenti esterni con `Authorization: Bearer <chiave del salone>` (a
  database solo l'sha256, `Salon.voice_api_key_hash`; chiave assente o sbagliata
  → 401). GET `/voice/services` → `[{id, name, category, duration_min, price}]`
  (il listino pubblico); GET `/voice/availability?date=YYYY-MM-DD&services=12,15`
  → `{success, date, date_label, times: ["HH:MM"]}` (gli orari dell'app, sede
  predefinita); POST `/voice/appointments` `{date, time, services, customer_name,
  customer_phone, notes}` → `{success, appointment_id, date, date_label, time,
  services, deposit_amount}`. Cliente trovata o creata dal telefono, prenotazione
  con `create_appointment` (`created_via=yourang`, caparra, conferma). Esiti per
  l'agente sempre 200: `{success: false, error: "unavailable", message,
  alternatives}` o `error: "invalid_request"`. Lo stesso orario ripetuto entro 10
  minuti restituisce l'appuntamento già creato. Chiave: GET `/voice/key` →
  `{active, created_at}`, POST → `{key, created_at}` (in chiaro una volta sola,
  la precedente smette di valere), DELETE la revoca; solo titolare.
