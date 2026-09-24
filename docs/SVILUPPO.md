# Guida allo sviluppo

Per chi deve cambiare il codice: dove sta cosa, le regole che valgono ovunque,
come si fanno le modifiche più comuni e cosa verificare prima di un push.
Il contratto delle API per app è in [`backend/SPEC.md`](../backend/SPEC.md), la
produzione in [`DEPLOY.md`](../DEPLOY.md), le convenzioni del frontend in
[`frontend/README.md`](../frontend/README.md).

## 1. Mappa

```
backend/                 Django 5.2 + django-ninja, una sola API per dashboard e web app
  config/                settings (+ unfold.py: navigazione dell'admin), urls, api.py (monta i router)
  common/                aiuti senza dominio, usati da tutte le app (vedi §1.2)
  apps/<app>/            un'app di dominio per cartella (vedi §1.1)
frontend/                npm workspaces
  apps/dashboard/        gestionale staff (vedi frontend/README.md)
  apps/client-app/       web app delle clienti, white-label su /<slug-del-salone>
  packages/shared/       @youty/shared: client API, sessioni, date/soldi, telefoni, UI di base
docs/                    indice in docs/README.md: rapporti delle cacce, prototipo, manuale
tools/smoke/             test di fumo nel browser: confronta due versioni schermata per schermata
tools/test_a_ora.py      la suite del backend con l'orologio spostato (sera, mezzanotte, capodanno…)
```

### 1.1 Com'è fatta un'app del backend

Ogni app segue gli stessi strati. Chi legge un endpoint sa dove cercare il resto.

| File | Cosa contiene | Cosa NON contiene |
|---|---|---|
| `models.py` | modelli, `TextChoices`, costanti legate a un campo | logica che tocca altri modelli |
| `schemas.py` | schemi ninja di ingresso e uscita | logica. I docstring degli schemi e degli endpoint **sono** la descrizione pubblicata in OpenAPI: cambiarli cambia la documentazione delle API |
| `api.py` (o il package `api/`) | gli endpoint: autenticazione e permessi, lettura dell'oggetto del salone con `salon_get`, conversione schema → dict, scelta della risposta e dei codici d'errore | regole di dominio, transazioni lunghe, query complesse |
| `services.py` e moduli fratelli | le regole: calcoli, scritture, transazioni, eventi | dettagli HTTP (niente `request`) |
| `presenters.py` / `serializers.py` | la forma delle risposte, quando la usano più endpoint o altre app | |
| `management/commands/` | i comandi (`flush_outbox`, `sync_yourang`, `process_deposit_holds`, `seed_demo`, `create_salon`, `check_phone_duplicates`) | la logica: sta nei moduli di dominio, il comando la chiama |
| `tests/` | `base.py` (basi e aiuti comuni ai test dell'app) e `test_<argomento>.py` | |

Le app, con i moduli di dominio principali:

- **core** — salone, sedi, impostazioni, regole della caparra, registro attività.
  `services.py` (`log_activity`, `emit_event`, `get_salon_by_slug`,
  `default_location`), `outbox.py` (consegna degli eventi a Yourang: claim,
  invio, tentativi, scadenze), `livefeed.py` (chi vede quale evento del feed
  live, forma dell'evento, polling), `validation.py` (validazione delle
  impostazioni), `views.py` (lo stream SSE).
- **accounts** — utenti staff, ruoli, inviti, accesso delle clienti con OTP.
  `api/` diviso per pubblico (`staff.py`, `team.py`, `client.py`),
  `sessions.py` (validità della sessione staff, permessi, payload di sessione:
  una sola implementazione), `team.py` (regole su ruoli e inviti),
  `provisioning.py` (fondazione di un salone nuovo).
- **clients** — anagrafica. `services.py` (`client_facts`, `client_stats`: il
  contratto usato da agenda e automazioni), `fields.py` (campi della scheda e
  consensi), `profiles.py` (creazione, modifica, archivio), `search.py`
  (ricerca senza accenti), `importer.py` (import CSV), `labels.py`
  (etichette), `records.py` (note, allegati, schede tecniche), `history.py`
  (storico unificato), `hook.py` (form pubblico dei contatti).
- **staff** — operatrici. `services.py` (disponibilità: `shift_windows`,
  `opening_windows`), `operators.py` (scheda, turni, assenze), `stats.py` (KPI).
- **catalog** — servizi, categorie, pacchetti; `services.py` (righe dei
  pacchetti, ordine delle categorie, listino pubblico).
- **agenda** — appuntamenti, disponibilità, pause, lista d'attesa, caparre,
  «torna indietro». `services/` è un package, un modulo per argomento:
  `timegrid` (minuti e istanti), `locking` (lock salone → riga),
  `occupancy` (chi è occupato quando), `availability` (ricerca degli orari),
  `resolution` (assegnazione delle operatrici a una prenotazione),
  `appointments` (creare, modificare, spostare, dividere), `transitions`
  (arrivo, inizio, no-show, annullamento), `deposits` / `deposit_holds` /
  `refunds` / `refund_ledger` (caparra, scadenze, rimborsi), `messages` /
  `freed_slots` / `undo_messages` (messaggi a Yourang, annunci alla lista
  d'attesa), `pauses`, `waitlist`, `margin`. `undo.py` è il registro del
  «torna indietro», `presenters.py` la forma delle risposte, `api/` un modulo
  per risorsa.
- **sales** — cassa. `services.py` (l'unico che scrive vendite, righe e
  pagamenti), `checkout.py` (chiusura del conto di un appuntamento),
  `deposits.py` (la caparra vista dalla cassa), `stripe_service.py` (il
  gateway Stripe: tutte e sole le chiamate a Stripe), `stripe_webhooks.py`
  (gli eventi che arrivano da Stripe), `reports.py` (riepilogo di giornata e
  storico), `serializers.py`.
- **marketing** — `codes.py` (codici e mascheramento), `coupons.py`,
  `gift_cards.py`, `loyalty.py`, `communications.py`, `consent.py`,
  `wallet.py` (il portafoglio della cliente).
- **inventory** — `services.py` (movimenti di magazzino), `orders.py` (ordini
  ai fornitori), `csv_load.py` (carico da CSV).
- **automations** — regole eseguite da Yourang; `services.py` (definizione e
  invio).
- **insights** — KPI e grafici; `periods.py` (periodi e intervalli di date).
- **integrations** — Yourang: `oauth.py` (flusso OAuth con nonce e state),
  `connection.py` (collegamento, token, webhook), `login.py` («Accedi con
  Yourang»), `webhooks.py` (smistamento degli eventi in arrivo), `sync.py`
  (sincronizzazione di contatti, catalogo, eventi), `client.py` (client HTTP).

### 1.2 `backend/common/`

| Modulo | Cosa |
|---|---|
| `auth.py` | JWT, `staff_auth` / `client_auth`, `StaffContext` / `ClientContext` |
| `permissions.py` | `SCOPES`, `require_scope`, `require_owner`, `has_scope` (per decidere cosa mostrare) |
| `ratelimit.py` | contatori su database: `hit`, `enforce` (429), `enforce_public` (per IP sugli endpoint pubblici) |
| `schemas.py` | `OkOut` (`{"ok": true}`) |
| `money.py` | `CENT`, `MAX_MONEY`, `to_cents`, `from_cents` |
| `intervals.py` | `merge_intervals` (turni, aperture, occupazioni) |
| `validation.py` | colore esadecimale, validazione delle categorie |
| `phone.py` | normalizzazione dei telefoni in E.164, `phone_key` |
| `media.py` | upload e URL firmati dei file |
| `conditions.py` | valutatore delle condizioni E/O (regole caparra, automazioni) |
| `utils.py` | `salon_get`, `human_code` |
| `testing/` | aiuti comuni ai test (vedi §3.7) |

## 2. Regole che valgono ovunque

- **Un salone per richiesta.** Ogni modello di primo livello ha la FK `salon`;
  ogni query filtra per `ctx.salon`. Un oggetto per id si legge con
  `salon_get(Model, ctx, pk)`, che dà 404 se è di un altro salone.
- **Permessi.** Gli endpoint staff hanno `auth=staff_auth`; le scritture
  chiedono uno scope (`require_scope(ctx, "agenda")`); il titolare li ha tutti.
  Per decidere cosa mostrare si usa `has_scope`: un dato nascosto esce come
  `null` con un `*_hidden: true`, mai come 0.
- **Errori.** `raise HttpError(4xx, "messaggio in italiano")`: il messaggio
  arriva così com'è all'utente.
- **Conflitti.** Chi salva una copia vecchia manda `expected_updated_at` e
  riceve 412; uno slot occupato è 409 (la dashboard può riprovare con
  `force`). I lock seguono sempre l'ordine salone → riga
  (`agenda.services.locking`).
- **Transazioni.** Non c'è `ATOMIC_REQUESTS`: ogni scrittura che deve essere
  atomica ha il suo `transaction.atomic`. Le chiamate esterne (Stripe, Yourang)
  stanno fuori dalla transazione o in `transaction.on_commit`.
- **Soldi.** `DecimalField(max_digits=10, decimal_places=2)`, mai float;
  `common.money` per centesimi e tetto. Dove serve `ROUND_HALF_UP` lo si
  scrive accanto a `quantize`. Nel frontend si conta in centesimi interi.
- **Tempo.** Datetime sempre con fuso; ciò che vede il salone è nel fuso del
  salone. Nel frontend le date passano dagli aiuti di
  `@youty/shared/format.js` (`salonDateParts`, `toDateStr`, `todayStr`,
  `isoAtMin`, …), mai dal fuso del dispositivo.
- **Registro attività e feed live.** Ogni mutazione rilevante chiama
  `log_activity(salon, type, summary, actor=…, payload=…)`. Chi vede quale
  tipo di evento nel feed live della dashboard lo decide `LIVE_FEED_SCOPES` in
  `core/livefeed.py`: un tipo che non vi compare non arriva a nessuno.
- **Eventi per Yourang (outbox).** Il backend non manda messaggi: accoda
  eventi con `core.services.emit_event`; gli eventi di un appuntamento passano
  da `agenda.services.messages.emit_appointment_event`, che li trattiene per il
  ritardo di sicurezza e li fonde per oggetto (`coalesce_key`). Li consegna il
  worker `flush_outbox` (motore in `core/outbox.py`).
- **Import fra app.** I modelli di altre app si importano in testa. Le
  FUNZIONI di altre app che i test sostituiscono (`shift_windows`,
  `client_facts`, `stripe_service.*`, …) si importano dentro la funzione che le
  usa, così vengono cercate a ogni chiamata. Non si ri-esporta un nome da un
  altro modulo per comodità: una `mock.patch` sul nome ri-esportato non tocca
  il codice che usa l'originale. Per lo stesso motivo i package `services/` e
  `api/` dell'agenda non ri-esportano niente dalla radice: si importa dal
  sottomodulo (`from apps.agenda.services.locking import lock_salon`).
- **Lingue.** Campi testo bilingui `name_it` / `name_en`; nel frontend ogni
  testo è `t('italiano', 'English')`.

## 3. Ricette

### 3.1 Un endpoint nuovo

1. Lo schema di ingresso e di uscita in `schemas.py` (il docstring diventa la
   descrizione in OpenAPI). Per `{"ok": true}` c'è `common.schemas.OkOut`.
2. La regola nel modulo di dominio dell'argomento (o in uno nuovo, fratello di
   `services.py`), con la transazione se serve.
3. L'endpoint in `api.py` (o nel modulo giusto di `api/`): permesso,
   `salon_get`, chiamata al servizio, risposta. Tutti i metodi di uno stesso
   percorso stanno nello stesso router, altrimenti Django risponde 405.
4. `log_activity` / `emit_event` se la mutazione va nel registro o a Yourang.
5. Il test in `tests/test_<argomento>.py`.
6. Nel frontend, la funzione nel modulo API del dominio
   (`apps/dashboard/src/api/<dominio>.js`, per l'agenda `agendaApi.js`; per la
   web app `apps/client-app/src/api/client.js`).
7. `backend/SPEC.md`, se cambia il contratto.

### 3.2 Un campo nuovo in un modello

1. Il campo in `models.py`, poi `python manage.py makemigrations <app>`.
2. Nome della migrazione descrittivo (`NNNN_<cosa>`); per il lavoro di una
   tornata, il suo prefisso (`NNNN_caccia22_<area>_<cosa>`).
3. Una migrazione di dati usa `apps.get_model(...)` e ricopia dentro di sé
   l'algoritmo che le serve (il codice vivo cambierà). Deve andare su
   PostgreSQL 16 in produzione, anche se i test girano su SQLite.
4. Un push su `main` fa il deploy e lancia `migrate`: una migrazione
   irreversibile o lunga va segnalata in DEPLOY.md.

### 3.3 Un tipo di evento nuovo

1. Chi lo produce chiama `emit_event(salon, "<area>.<cosa>", payload,
   coalesce_key=…)` (gli eventi dell'appuntamento: `emit_appointment_event`).
   Il docstring di `emit_event` elenca i posti da aggiornare.
2. Se l'evento invecchia (un promemoria non ha senso dopo l'appuntamento),
   la sua regola di scadenza va in `EXPIRY_FIELDS` / `EXPIRY_AGES` in
   `core/outbox.py`.
3. Se è un'attività che la dashboard deve vedere dal vivo, il suo prefisso va
   in `LIVE_FEED_SCOPES` (`core/livefeed.py`) con lo scope che serve per
   vederlo.
4. L'elenco degli eventi in `backend/SPEC.md` §1.

### 3.4 Un permesso nuovo

`SCOPES` in `common/permissions.py`, i ruoli di sistema in
`accounts/services.py` (`DEFAULT_ROLES`), le etichette nella gestione dei ruoli
della dashboard (`sections/impostazioni/RolesDrawer.jsx`), e `hasScope(...)`
nella dashboard dove si mostra o nasconde qualcosa.

### 3.5 Una schermata della dashboard

- Una sezione nuova: il modulo in `sections/<sezione>/index.jsx`, la voce in
  `sections/registry.js` (caricamento pigro) e nel menu in
  `shell/Sidebar.jsx`.
- Dati dal server: funzioni del modulo API del dominio, lette con gli hook di
  `src/hooks/` (`useResource` per un caricamento con la guardia contro le
  risposte arrivate tardi, `useLatestRequest` per le ricerche, `useDebounced`).
- Errori: `toastApiError(err, fireToast, t)` da `@youty/shared`.
- Modali e drawer: `ui/DkModal`, `ui/DkDrawer`, `ui/DkPanel`; il tasto Esc
  passa dallo stack unico di `ui/layers.js` (`useEscLayer`).
- Dal contesto (`useDash()`): sessione, `hasScope`, cataloghi di base,
  `openModal`, `fireToast`, `live` per gli aggiornamenti dalle altre
  postazioni.
- La logica che si può provare senza DOM va in un modulo `.js` puro accanto al
  componente, con il suo test.

### 3.6 Una schermata della web app clienti

Lo schermo in `screens/`, la voce in `routes.js` (`personal: true` se serve la
sessione, `nav` per la barra in basso), le chiamate in `api/client.js` lette con
`hooks/useApiData`, le parti comuni in `components/`, le funzioni pure in
`lib/`.

### 3.7 Un test

**Backend.** Nel modulo dell'argomento, `apps/<app>/tests/test_<argomento>.py`
(il riferimento del reperto nel docstring della classe, se ce n'è uno). Le basi
e gli aiuti comuni ai test di un'app stanno nel suo `tests/base.py`; quelli
comuni a tutte le app in `common/testing` (`aware`, `post_json`, `put_json`,
`bearer`, `client_bearer`, `staff_context`). `tests/__init__.py` resta vuoto.

- `mock.patch` va sul modulo in cui il codice sotto test cerca il nome (quello
  che lo chiama), non su quello che lo definisce. Una patch su un percorso che
  il codice non legge non sostituisce niente e il test resta verde senza
  provare nulla: quando si patcha, conviene anche verificare che il mock sia
  stato chiamato.
- I nomi dei ruoli di prova non devono essere quelli dei ruoli di sistema
  («Manager», «Front desk», «Operatrice»): `ensure_default_roles` li
  adotterebbe.
- Un test non deve dipendere dall'ora in cui gira. Date e ore di prova nel
  fuso del salone (`aware(giorno, ora)`, `timezone.localdate()`,
  `timezone.localtime()`), mai `timezone.now().replace(hour=…)`, che è UTC: fra
  mezzanotte e le 2 la sua data è ancora ieri. Niente «adesso + N ore» per una
  visita che poi va rivalidata contro i turni: la sera finisce fuori turno o
  oltre la mezzanotte. Per il «mese in corso» vedi `_mid_period` in
  `insights/tests/test_kpis.py`. Per provare: `tools/test_a_ora.py
  2026-10-01T00:30 apps.<app>` lancia i test con l'orologio spostato.

**Frontend.** `node --test`: si provano i moduli puri (`.js`), che si possono
importare senza DOM. `@youty/shared` nei test è sostituito da
`frontend/test/shared-shim.mjs` (le funzioni pure vere, un `api` finto che
registra le chiamate): un aiuto nuovo di shared va esportato anche lì.
`apps/dashboard/test/grid-harness.mjs` monta i componenti della griglia
d'agenda con un React finto (con `expand` per i sotto-componenti senza hook);
`apps/client-app/test/load.mjs` fa lo stesso per hook e schermi della web app.

## 4. Prima di un push

```sh
# backend (dalla cartella backend/, con il venv attivo)
pip install -r requirements.txt -r requirements-dev.txt   # la prima volta
ruff check .
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test --noinput --parallel auto

# frontend (dalla cartella frontend/)
npm ci                # la prima volta
npm run lint
npm test
npm run build
```

La CI (`.github/workflows/ci.yml`) esegue gli stessi controlli sulle pull
request e sui push su `main`. Un push su `main` fa partire il deploy su Coolify
(anche con la CI rossa): si arriva su `main` solo con i controlli verdi.

Per un cambiamento che tocca molte schermate, il test di fumo di
[`tools/smoke/`](../tools/smoke/README.md) confronta la versione nuova con quella
di partenza schermata per schermata, con le chiamate API di ciascuna.

## 5. Scrivere nel progetto

- Commenti e docstring in italiano, e spiegano il **perché**: lo scenario che
  si rompeva, il vincolo da non dimenticare. I commenti citano i reperti delle
  cacce ai bug con il loro identificativo (`(13-02)`, `B21`, «contratto C7»):
  si risale al rapporto da [`docs/README.md`](README.md).
- Messaggi di commit in italiano: cosa non andava per chi usa il prodotto (o per
  chi mantiene il codice), poi cosa cambia.
- Stile: quello del codice intorno, scritto a mano. Niente formattatori
  automatici (`ruff format`, Prettier) sul codice esistente; il lint (`ruff
  check`, ESLint) cerca errori, non stile.
- Un bug trovato mentre si fa altro si corregge in un commit suo, con il test
  che lo riproduce: mescolato a uno spostamento di codice non si verifica più.
