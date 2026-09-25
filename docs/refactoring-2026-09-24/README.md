# Refactoring del 24/09/2026

Obiettivo: rendere il codice più facile da modificare, migliorare e mantenere,
senza cambiare niente di quello che vedono il salone, le clienti e Yourang.

Chi deve lavorare sul codice parte da [`docs/SVILUPPO.md`](../SVILUPPO.md), che
descrive la struttura di oggi. Qui c'è cosa è cambiato rispetto a prima, come
è stato verificato che il comportamento non cambiasse e cosa resta da fare.

| File | Cosa |
|---|---|
| questo | il rapporto |
| [`BUG-SOSPETTI.md`](BUG-SOSPETTI.md) | i possibili bug trovati lungo la strada: non corretti durante il refactoring, corretti subito dopo (commit per commit in fondo al file) |
| [`MAPPA-TEST.md`](MAPPA-TEST.md) | dove è finita ogni classe di test dei vecchi `tests.py` e `tests_caccia22_*.py` |

## 1. In breve

Prima i moduli più usati erano anche i più lunghi: per cambiare una regola
della caparra bisognava orientarsi in un `services.py` di 3347 righe; i test
stavano in file intitolati alle cacce ai bug; le stesse righe (unire
intervalli, euro in centesimi, la sede predefinita, il nome dell'operatrice, il
messaggio d'errore di una chiamata) erano copiate in più app; mancavano lint e
CI.

| Prima | Dopo |
|---|---|
| `agenda/services.py`, 3347 righe | package `agenda/services/`: 17 moduli per argomento, il più lungo 550 righe |
| `agenda/api.py`, 1411 righe | package `agenda/api/`: 8 moduli per risorsa, più `presenters.py` per la forma delle risposte |
| `clients/api.py`, 1326 righe | 509, più `fields`, `labels`, `search`, `profiles`, `importer`, `records`, `history`, `hook` |
| `sales/api.py`, 1031 righe | 262, più `serializers`, `checkout`, `deposits`, `stripe_webhooks`, `reports` |
| `accounts/api.py`, 951 righe | package `accounts/api/` (staff, squadra, clienti), più `sessions`, `team`, `provisioning` |
| `marketing/api.py` 912 e `services.py` 753 | `api.py` 604 e sette moduli: `codes`, `coupons`, `gift_cards`, `loyalty`, `communications`, `consent`, `wallet` |
| agenda della dashboard: `index.jsx` 1122, `ApptDetailModal.jsx` 1448, `DayGrid.jsx` 1126, `WeekView.jsx` 735 | 346, 524, 457, 331, più `agendaApi.js`, `lib/`, `hooks/`, `grid/`, `parts/`, `month/`, `modals/detail/`, `modals/newappt/` |
| `ctx.jsx` della dashboard, 381 righe | 150, più `app/` (cataloghi, feed live, sede attiva, colori) |
| web app: `Prenota.jsx` 736 righe | `screens/prenota/`, più `api/client.js`, `hooks/`, `lib/`, `components/` |
| test del backend in `tests.py` e `tests_caccia22_*.py`, 1244 | `apps/<app>/tests/test_<argomento>.py`, 1307 (gli stessi 1244 più quelli degli aiuti comuni) |
| test del frontend, 258 | 434 |
| nessun lint né CI | ESLint (JSX e regole degli hook), ruff, CI su ogni pull request e su `main` |

Il lavoro sta sul branch `claude/exciting-bohr-5ch9g7`: 218 commit, uniti per
area con un merge ciascuno («Unisci: …»). **Non è su `main`**: un push su
`main` va in produzione.

## 2. Cosa non è cambiato

- **API**: stesse rotte, parametri, schemi e risposte. L'istantanea del contratto
  (`/api/openapi.json` con gli schemi espansi) è stata confrontata dopo ogni
  integrazione ed è identica. Alla fine cambiano solo sei descrizioni che
  citavano funzioni interne spostate. Cambiano anche 55 `operationId` su 202,
  quelli di agenda e accounts, perché django-ninja li ricava dal modulo della
  vista e le due app ora hanno un package `api/`: il frontend non li usa.
- **Database**: nessuna migrazione.
- **Invariati** anche le variabili d'ambiente, i nomi dei logger (un test ne
  controlla uno), i tipi e il contenuto degli eventi per Yourang e le chiavi di
  idempotenza.
- **Comportamento**: nessun bug è stato corretto di nascosto. Quelli trovati
  sono in [`BUG-SOSPETTI.md`](BUG-SOSPETTI.md): corretti subito dopo il
  refactoring, uno per commit con il test che lo riproduce (i commit sono in
  fondo a quel file).
- Le sole correzioni riguardano **test** che fallivano a certe ore, non il codice:
  - cinque test degli insight, rossi il primo del mese fra mezzanotte e le 2 e
    nelle prime ore dell'anno;
  - un test della disdetta registrata dallo staff, rosso dalle 15:30 alle 6;
  - quattro test trovati facendo girare la suite con l'orologio spostato: le
    pause «di oggi» fra mezzanotte e le 2, due visite che dopo le 22:30
    scavalcavano la mezzanotte, la data del consenso nella prima ora
    dell'anno;
  - il test del cambio dell'ora, che usava il 28/03/2027 fisso: da quella
    mattina sarebbe fallito per sempre.

## 3. Dove sta cosa adesso

La mappa completa, app per app, è in [`docs/SVILUPPO.md`](../SVILUPPO.md) §1.
Le novità principali:

**Backend**
- `common/`: aiuti che prima erano copiati nelle app.
  - `permissions.has_scope`, `schemas.OkOut`;
  - `ratelimit.enforce` / `enforce_public`;
  - `money` (`to_cents`, `from_cents`, `CENT`, `MAX_MONEY`);
  - `intervals.merge_intervals`;
  - `testing/`: gli aiuti comuni ai test.
- `core`: `services.get_salon_by_slug` e `default_location`, più tre moduli nuovi:
  - `outbox` (consegna degli eventi a Yourang);
  - `livefeed` (chi vede quale evento del feed live);
  - `validation`.
- `agenda`: `services/` e `api/` sono package.
  - Si importa dal sottomodulo (`from apps.agenda.services.locking import lock_salon`): la radice non ri-esporta niente.
  - La forma delle risposte sta in `presenters.py`, il «torna indietro» in `undo.py`.
- Le altre app hanno i moduli di dominio elencati nella tabella sopra. In più:
  - `inventory`: `orders`, `csv_load`;
  - `staff`: `operators`, `stats`;
  - `insights`: `periods`;
  - `integrations`: `oauth`, `webhooks`, `constants`;
  - `config/unfold.py`.
- `Operator.full_name` sostituisce le quattro copie che componevano il nome dell'operatrice.

**Frontend**
- `@youty/shared`:
  - `apiErrors.js`: `ApiError`, `apiErrorText`, `toastApiError`, il messaggio d'errore di una chiamata, prima copiato in ogni sezione;
  - `format.js`: `fmtEurOrZero`, `fmtEurNoFree`;
  - `labels.js`: `nameIn`, mesi e giorni;
  - `styles/base.css`.
- Dashboard:
  - `src/api/`: un modulo per dominio, e le sezioni non chiamano più `api.*` direttamente;
  - `app/`: i pezzi del contesto;
  - `hooks/` e `ui/`.
- Agenda della dashboard: logica pura in `lib/`, testabile con `node --test`; griglie, pannelli e modali in sottocartelle.
- Web app clienti: `api/client.js`, `routes.js`, `hooks/` (OTP, appuntamenti, catalogo), `screens/prenota/` (un file per passo e `usePrenota.js`).

**Strumenti**
- `.github/workflows/ci.yml`: sul backend ruff, `check`, migrazioni, test; sul frontend lint, test, build.
- [`tools/smoke/`](../../tools/smoke/README.md): un giro deterministico nel browser (103 passi fra dashboard e web app) che confronta due versioni schermata per schermata. Serve per i cambiamenti larghi, che i test non coprono nel JSX.
- `backend/common/tests/test_imports.py` controlla che ogni `from … import …` del progetto si risolva, anche quelli dentro le funzioni: un nome spostato non arriva più in produzione come 500.
- `tools/test_a_ora.py` lancia la suite del backend con l'orologio spostato (la sera, a mezzanotte, a capodanno…), per scovare i test che passano solo a certe ore.
- [`CLAUDE.md`](../../CLAUDE.md): le regole in breve per chi lavora con un assistente AI.

## 4. Come è stato verificato

Il lavoro è stato diviso in pacchetti che non toccavano gli stessi file, ognuno
su un branch suo. Dopo ogni integrazione:

- **Suite e controlli**: suite completa del backend, ruff, `manage.py check`,
  `makemigrations --check`, istantanea del contratto HTTP; lint, test e build del
  frontend.
- **Impronta dei test**: per ogni test, l'impronta del sorgente del metodo e dei
  suoi `setUp`. Un test spostato è rimasto lo stesso test. Dove l'impronta
  cambia, cambia solo una riga di import (controllato riga per riga) o la
  funzione chiamata, che è lo stesso oggetto con il nome nuovo.
- **Patch dei test**: ogni `mock.patch` è stata ripuntata sul modulo che
  chiama il nome. Poi è stata provata sabotando il codice: il test deve
  fallire. Così sono venute fuori alcune patch «mute», che con `create=True`
  passavano anche se il nome non esisteva più: quelle della scheda cliente ora
  puntano al modulo giusto. I test ancora ciechi sono in
  [`BUG-SOSPETTI.md`](BUG-SOSPETTI.md).
- **Test di fumo nel browser** (`tools/smoke`): 103 passi, 75 nella dashboard e
  28 nella web app, confrontati con la versione di partenza. Per ogni schermata
  si confrontano testo, campi, errori, chiamate API e screenshot: identici,
  anche sulla versione finale.
- **Suite con l'orologio spostato** (`tools/test_a_ora.py`): la suite completa
  è stata lanciata con l'ora del processo spostata su 17 momenti:
  - pomeriggio, sera, le 23:45 e le 23:55, dopo mezzanotte, notte e alba;
  - una domenica, il primo del mese, l'ultimo dell'anno e capodanno;
  - la notte del ritorno all'ora solare e il mattino del passaggio all'ora legale;
  - giugno 2027, gennaio 2028 e luglio 2029.

  Ha trovato cinque dei test elencati nel §2: i quattro che dipendevano
  dall'ora e quello del cambio dell'ora. Corretti quelli, la versione finale
  è verde in tutti e 17 i momenti.

## 5. Cosa resta da fare

Proposte, non fatte per restare nel perimetro o perché il guadagno non valeva il
rischio:

**Backend**
- `integrations/sync.py` (868 righe) e `sales/stripe_service.py` (754) sono
  ancora lunghi. Prima di dividere `sync.py` vanno ripuntati una trentina di
  righe di test e cinque patch.
- Duplicati fra app ancora da unire:
  - l'avviso «scheda archiviata», in `clients/hook.py` e `accounts/api/client.py`, con la stessa chiave;
  - la regola «di chi è una gift card pagata», in
    `agenda.services.deposits.spendable_gift_cards` e in `marketing.wallet.client_wallet`;
  - `sales.stripe_service.OPEN_APPOINTMENT_STATUSES`, che è `Appointment.OPEN_STATUSES`;
  - il payload degli eventi della caparra fra agenda e sales.
- Nomi fuorvianti non cambiati, perché i test li importano e il guadagno non
  valeva il rischio:
  - `_lock_and_reload`, che risponde anche 400;
  - in `agenda/services/freed_slots.py`, `free_slot_event`, `_emit_freed_slot`,
    `_sync_freed_slots` ed `emit_with_freed_slots`: dal nome non si capisce in
    cosa differiscono.
- Piccoli aiuti mai creati: `User.display_name`, le costanti degli allegati in
  `common.media`, serializzatori pubblici fra app al posto dei nomi `_privati`
  (`agenda.presenters._appointment_out` usato da clients).

**Frontend**
- Hook comuni per le mutazioni e le liste paginate (`useMutation`, `usePagedList`) e per la ricerca clienti.
- File dai nomi ambigui: `lib.jsx`, `bits.jsx`, `parts.jsx` e i tre `ClientPicker`.
- Lo stato morto del feed live (`unread`, `version`, `markRead`).
- Righe compatte di settimana e mese: si somigliano, ma i campi differiscono.

**Test**
- Alcuni ruoli di prova si chiamano come quelli di sistema («Manager», «Front
  desk»): in [`BUG-SOSPETTI.md`](BUG-SOSPETTI.md), sezione Test.
