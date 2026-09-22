# Revisore 08 — core, impostazioni, tempo reale, insight

Probe (NON ancora cancellati, come da istruzione dell'orchestratore): `backend/apps/core/tests_probe_08core.py`, `backend/apps/insights/tests_probe_08core.py`.

### [CRITICO] 08-01 seed_demo crea un superuser con password pubblica: /admin/ su tutti i saloni
- File: `backend/apps/core/management/commands/seed_demo.py:156-163`; `DEPLOY.md:320-331`; `frontend/apps/dashboard/src/LoginPage.jsx:117`
- Stato: CONFERMATO (probe ProbeSeedDemoSuperuser: login `sole@theparlour.it`/`theparlour`, `/admin/clients/client/` → 200 con le clienti di un ALTRO salone). Presenza in produzione PLAUSIBILE.
- Difetto/scenario: l'utente demo nasce `is_staff`+`is_superuser` con password nota (README, DEPLOY.md); DEPLOY.md §7 dice di lanciare seed_demo nel container di produzione «accanto ai dati reali» e la pagina di login di produzione mostra «Demo: sole@theparlour.it». Chiunque entra in /admin/ e legge/modifica tutti i saloni (clienti, vendite, OTP in outbox, membership, password).

### [ALTO] 08-02 seed_demo --reset cancella per slug anche un salone vero chiamato «The Parlour»
- File: `backend/apps/core/management/commands/seed_demo.py:143-150` (`_teardown` su `slug="the-parlour"`); `backend/apps/integrations/login.py:32-38`
- Stato: CONFERMATO (probe ProbeSeedResetWipesRealSalon: salone provisionato con «Accedi con Yourang» come «The Parlour» → slug `the-parlour`; `seed_demo --reset` lo elimina con tutte le clienti).
- Difetto/scenario: nessun controllo che il salone sia quello demo; DEPLOY.md presenta `--reset` come sicuro («non tocca gli altri saloni»). In produzione esiste un salone reale «The Parlour».

### [MEDIO] 08-03 Il checkout non produce eventi visibili all'agenda: le operatrici restano su «in corso»
- File: `backend/apps/sales/services.py:300` (solo `sale.created`), `backend/apps/sales/api.py:209-210` (status closed senza log), `backend/apps/core/views.py:84` (`sale.` solo scope sales); anche `backend/apps/integrations/sync.py:432,512-514` (import/cancellazione Yourang senza log_activity); `frontend/.../agenda/WeekView.jsx:57` non ascolta `sale.`
- Stato: CONFERMATO (probe ProbeCheckoutLiveEvent: scritto `['sale.created']`, consegnato al ruolo Operatrice `[]`).
- Scenario: la reception incassa → l'agenda dell'operatrice (ruolo di default agenda+clients) non si ricarica e mostra la visita ancora aperta finché non arriva un altro evento; prenotazioni/annullamenti da Yourang non arrivano a nessuna postazione.

### [MEDIO] 08-04 Rebooking dei periodi passati ~0%: le visite successive già chiuse vengono escluse
- File: `backend/apps/insights/services.py:416-426`
- Stato: CONFERMATO (probe ProbeRebooking: visita 20/8 chiusa + visita 10/9 chiusa → rebooking agosto 0.0 invece di 1.0).
- Scenario: `.exclude(... _CLOSED)` con riferimento = fine periodo scarta proprio chi è tornata; il periodo precedente risulta sempre peggiore del corrente (freccia di miglioramento inventata, il problema che F11 voleva chiudere). Regressione della passata 9991cb5.

### [MEDIO] 08-05 «Nuovi clienti»: tutta la rubrica importata conta come nuova, le clienti storiche non «di ritorno»
- File: `backend/apps/insights/services.py:302-306,430`; `backend/apps/clients/services.py:265-267`; `backend/apps/integrations/sync.py:159,367`
- Stato: CONFERMATO (probe ProbeNewClientsImport: 50 schede importate oggi → new_clients 50, returning 0 anche per la cliente storica tornata oggi).
- Scenario: import CSV / primo sync Yourang impostano `since=oggi`; il KPI conta `since` nel periodo senza guardare l'attività → mese/trimestre/anno dell'onboarding con migliaia di «nuove» e grafico 100% nuovi. Regressione introdotta in 9991cb5 (import + fallback insieme).

### [MEDIO] 08-06 Tassi no-show/cancellazioni diluiti dagli appuntamenti futuri del periodo
- File: `backend/apps/insights/services.py:391-398`
- Stato: CONFERMATO (probe ProbeNoShowDilution: 5 chiusi + 5 no-show passati + 10 futuri → 0.25 invece di 0.5).
- Scenario: il denominatore include i confermati futuri, che non possono ancora essere no-show: il periodo in corso appare sempre migliore del precedente.

### [MEDIO] 08-07 «vs prec.» confronta il periodo in corso (parziale) col precedente intero
- File: `frontend/apps/dashboard/src/sections/insight/index.jsx:84-91`; `frontend/.../insight/kpiDefs.js:31-44`
- Stato: CONFERMATO (percorso ripercorso).
- Scenario: il 22/9 incasso, vendite, appuntamenti, nuovi clienti di 1–22/9 contro tutto agosto → frecce rosse (−25/−30%) a ritmo invariato quasi ogni giorno; `prevPeriodAnchor` usa inoltre `new Date().getMonth()` del dispositivo (fuso diverso dal salone a cavallo del mese → periodo sbagliato).

### [MEDIO] 08-08 create_salon con email già esistente: salone irraggiungibile, doppioni per maiuscole, slug non validato
- File: `backend/apps/core/management/commands/create_salon.py:44-70`; `backend/apps/accounts/api.py:92-99,195`
- Stato: CONFERMATO (probe ProbeCreateSalonExistingUser: login → sempre il primo salone; «Anna@x.it» vs «anna@x.it» → 2 utenti).
- Scenario: secondo salone dello stesso titolare (o di una ex collaboratrice) creato «con successo» ma il login prende la prima membership; `get_or_create(email=)` è case-sensitive; slug non passato dai validatori (spazi/accenti → app cliente non lo riconosce, SLUG_RE).

### [MEDIO] 08-09 Registro attività: orari e «Oggi/Ieri» col fuso del dispositivo
- File: `frontend/apps/dashboard/src/sections/impostazioni/ActivityLogPage.jsx:51-64`
- Stato: CONFERMATO (lettura codice).
- Scenario: `logDateLabel` usa `setHours/getDate/getMonth/toTimeString` su ISO dell'API: da un dispositivo con altro fuso il «chi ha fatto cosa e quando» mostra ore e giorni sbagliati (invariante `salonDateParts` violata).

### [BASSO] 08-10 Occupazione storica gonfiata quando un'operatrice viene disattivata
- File: `backend/apps/insights/services.py:160-163`
- Stato: CONFERMATO (probe: luglio mercoledì 10% → 20% dopo `active=False`).
- Scenario: le prenotazioni dell'operatrice uscita restano, la sua capacità sparisce da tutti i periodi passati (e una nuova assunta diluisce retroattivamente).

### [BASSO] 08-11 Ticket SSE riusabile per 10 minuti e con permessi congelati
- File: `backend/apps/core/views.py:121-139,202-206`; `backend/apps/core/api.py:476-492`
- Stato: CONFERMATO (probe: stesso ticket apre più stream, anche dopo la rimozione della membership: 200, 200).
- Scenario: non è monouso (`cache.get` senza delete), sta in query string (access log gunicorn/Traefik); chi viene tolta dal salone o perde uno scope continua a ricevere incassi/nomi fino a ~30 min.

### [BASSO] 08-12 Keepalive soppresso dagli eventi invisibili: disconnessione non rilevata, posto SSE trattenuto
- File: `backend/apps/core/views.py:187-195`
- Stato: CONFERMATO (probe: 0,6 s di eventi `sale.` per utente solo-agenda con keepalive 0,05 s → nessun ping).
- Scenario: `last_ping` si azzera anche senza scrivere nulla; senza scritture gunicorn non si accorge del client caduto e il posto (tetto globale per processo, condiviso da tutti i saloni) resta occupato fino ai 20 min.

### [BASSO] 08-13 Feed live: evento perso per la corsa fra id di sequenza e commit (F8 del 18/09 ancora aperto)
- File: `backend/apps/core/views.py:183-192`; `backend/apps/core/api.py:415-424`
- Stato: PLAUSIBILE (solo Postgres, finestra di pochi ms).
- Scenario: una transazione prende l'id N e committa dopo N+1: il cursore supera N e nessuna postazione lo riceve (nemmeno il polling di coerenza).

### [BASSO] 08-14 Doppia consegna stream + polling di coerenza: duplicati nella campanella
- File: `frontend/apps/dashboard/src/ctx.jsx:65-71,116-131`
- Stato: PLAUSIBILE (percorso ripercorso).
- Scenario: il polling a 30 s può prendere un evento prima dello stream, che lo riconsegna (cursore server indipendente); `deliver` non deduplica → voci doppie con key React duplicate e ricariche doppie.

### [BASSO] 08-15 Orari scritti da /admin/ non validati → 500 su agenda e disponibilità
- File: `backend/apps/core/admin.py:19-21`; `backend/apps/staff/services.py:39-50`; `DEPLOY.md:317-318`
- Stato: CONFERMATO (probe: `{"0": ["09:00-19:00"]}` → `/api/agenda/day` 500).
- Scenario: DEPLOY.md §7 fa creare le Impostazioni da admin; un formato diverso blocca agenda e prenotazioni del salone.

### [BASSO] 08-16 Date inesistenti o fuori scala → 500 invece di 400
- File: `backend/apps/core/api.py:376-379`; `backend/apps/insights/api.py:16-22`; `backend/apps/insights/services.py:50-54,76-78,93-95`
- Stato: CONFERMATO (probe: `2026-02-30`, anno 0001, anno 9999 → 500).
- Scenario: `parse_date` solleva ValueError non gestito; anno 1/9999 va in overflow nella conversione UTC o in `date(10000,…)`.

### [BASSO] 08-17 cash_in/deposit_cashed degli insight non tolgono le caparre rimborsate
- File: `backend/apps/insights/services.py:354-358,458`; `backend/apps/agenda/services.py:1661-1735`
- Stato: CONFERMATO (probe: caparra 30 rimborsata → cash_in 30).
- Scenario: il rimborso non genera movimento; valore solo in API (stesso difetto in `sales.today_summary` «Incassato oggi», area sales).

### [BASSO] 08-18 PUT /settings e logo: save() completo sull'istanza letta a inizio richiesta
- File: `backend/apps/core/api.py:145,216-218,241-247,256-259`
- Stato: CONFERMATO (probe con interleaving simulato: `stripe_account_id` scritto dal callback Stripe viene riportato a "").
- Scenario: raro (finestra di ms), ma un PUT concorrente al collegamento Stripe scollega l'account; serve `update_fields`.

### [BASSO] 08-19 HoursDrawer dice che gli orari non limitano le prenotazioni, ma le limitano
- File: `frontend/apps/dashboard/src/sections/impostazioni/HoursDrawer.jsx:111`; `backend/apps/staff/services.py:156-158`; `backend/apps/agenda/services.py:312`
- Stato: CONFERMATO (lettura codice).
- Scenario: il titolare imposta orari «pubblici» più stretti dei turni credendo che contino solo per l'app → quegli slot spariscono dall'app cliente.

Aree controllate senza reperti: validazione PUT /settings (range interi, automation_delay_seconds 0–600, enum, colore, URL privacy, budget, invariante sollecito<scadenza sui valori effettivi, fasce sovrapposte/invertite/oltre 24:00); branding pubblico (solo dati pubblici, nessuna scrittura); isolamento per salone di registro, feed e stream; filtro per area identico in SSE e polling; rilascio dello slot SSE alla chiusura della risposta (gunicorn chiama `respiter.close()`); sede predefinita unica; upload/rimozione logo; regole caparra malformate già neutralizzate da `_rule_matches`; confini di periodo e ora legale nel backend (mezzanotte aware, Trunc* nel fuso corrente); divisioni per zero e periodi vuoti; bucket settimanali; doppio conteggio caparra; tetto intervallo personalizzato; `_teardown` rispetta i PROTECT.
