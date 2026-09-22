# Revisore 11 — integrazione Yourang, consegna messaggi, deploy

Probe (lasciati su richiesta dell'orchestratore): `backend/apps/integrations/tests_probe_11_integrazioni.py` (15 test verdi = difetti confermati), `backend/apps/core/tests_probe_11_outbox.py` (4 test verdi).

### [ALTO] 11-01 «Collega Yourang» riscatta un codice preso dall'URL con la sessione del titolare: salone ricollegato all'org di un altro
- File: `frontend/apps/dashboard/src/oauth/OAuthPopup.jsx:40-46`, `backend/apps/integrations/api.py:94-139`
- Stato: CONFERMATO (probe ConnectRepointProbe: org cambiata, anagrafica non collegata spinta all'org nuova, webhook dell'org legittima poi ignorati con 200)
- Difetto: `/oauth-popup/done?mode=connect&yr_link=…` riscatta subito il codice, `mode` compreso, con il Bearer del titolare (localStorage); nessuno state/nonce lega il codice a chi ha avviato il flusso, e l'exchange sovrascrive `yourang_org_id` anche su un salone già collegato.
- Scenario: l'attaccante fa il login Yourang sul proprio org, blocca il redirect, manda al titolare il link con `mode=connect` e il suo codice; un clic → tutte le clienti (nome, telefono, email) spinte sulla sua org, le sue prenotazioni finte entrano in agenda, quelle vere smettono di arrivare. Con `mode=login` la vittima si ritrova loggata nel salone dell'attaccante.
- Correzione: legare il codice a uno state generato lato server/sessionStorage all'avvio e verificarlo; rifiutare il cambio di org su un salone già collegato senza disconnessione esplicita.

### [ALTO] 11-02 «Accedi con Yourang» fa collegare il salone a un membro non titolare (e con due saloni collega quello sbagliato)
- File: `backend/apps/integrations/login.py:90-97, 139-150`
- Stato: CONFERMATO (probe LoginAdoptsSalonProbe; lo stesso caso lo prova anche il revisore 10)
- Difetto: il caso B adotta il primo salone senza connessione in cui l'utente è membro, owner o no, e lo collega all'org dell'identità; il connect richiede `require_owner`, il login no. Con due saloni sceglie il primo per id.
- Scenario: un'operatrice con ruolo «agenda» che ha una sua org Yourang accede con Yourang → salone collegato alla sua org e intera anagrafica spinta lì. Titolare di «Centro» e «Mare» accede con l'org di Mare → collegato «Centro».
- Correzione: nel caso B adottare solo saloni di cui l'utente è titolare e solo se unico; altrimenti niente collegamento automatico.

### [MEDIO] 11-03 Uno stato remoto terminale sovrascrive una visita con check-in o in corso: incasso rifiutato o conto «chiuso» senza vendita
- File: `backend/apps/integrations/sync.py:43-50, 344-353, 462-466`
- Stato: CONFERMATO (probe RemoteStatusProbe: no_show su IN_PROGRESS → checkout 400 «no-show»; completed su CHECKED_IN → CLOSED senza Sale)
- Difetto: `_STATUS_RANK` mette CLOSED/NO_SHOW/CANCELLED (3) sopra CHECKED_IN/IN_PROGRESS, contro il commento che vuole le decisioni del salone vincenti.
- Scenario: cliente in poltrona, Yourang segna no_show/annullato/completed → a fine servizio la cassa non può incassare (400) o l'agenda la mostra chiusa senza pulsante «Incassa».
- Correzione: se lo stato locale è già oltre CONFIRMED, lo stato remoto non si applica.

### [MEDIO] 11-04 Le prenotazioni Yourang restano inchiodate sulla prima operatrice: il segnaposto non ha operatrici idonee
- File: `backend/apps/integrations/sync.py:314-341`; `backend/apps/agenda/services.py:1263, 708-738, 1364`
- Stato: CONFERMATO (probe PlaceholderEligibilityProbe: move su altra operatrice 400, allungamento 400 con operatrice e 409 senza, anche con force)
- Difetto: «Prenotazione Yourang» nasce senza `operators`; idoneità mai forzabile → niente trascinamento su altra colonna, niente ridimensionamento, niente stacco, niente aggiunta di servizi tenendo il segnaposto.
- Scenario: ogni prenotazione Yourang atterra sulla prima operatrice attiva (anche assente); la reception la trascina su chi la farà → errore e rimbalzo.
- Correzione: rendere il segnaposto idoneo a tutte le operatrici (o esentarlo dal controllo di idoneità).

### [MEDIO] 11-05 `cancel_event` con UPDATE nudo: annulla anche visite chiuse o in corso, senza registro né lista d'attesa
- File: `backend/apps/integrations/sync.py:502-515`
- Stato: CONFERMATO (probe test_cancel_event_turns_a_closed_visit_into_a_cancelled_one)
- Difetto: nessun controllo di stato, nessun lock, nessun `log_activity`, nessun `slot.freed`, `updated_at` non toccato (diversamente da `_merged_status` e da `cancel_appointment`).
- Scenario: su Yourang si elimina un evento passato (pulizia, contatto cancellato) → la visita già incassata diventa «annullata» nello storico; un annullamento futuro non avvisa la lista d'attesa.
- Correzione: passare da una funzione che rilegge sotto lock, lascia stare CLOSED/IN_PROGRESS/CHECKED_IN, scrive il registro e annuncia lo slot.

### [MEDIO] 11-06 Import e annullamenti Yourang invisibili alle postazioni aperte: nessuna riga nel registro, quindi nessun aggiornamento live
- File: `backend/apps/integrations/sync.py:404-515`; `backend/apps/core/views.py` (feed su ActivityLog); `frontend/apps/dashboard/src/ctx.jsx`
- Stato: CONFERMATO lato backend (probe: 0 ActivityLog dopo import+cancel); catena frontend PLAUSIBILE
- Difetto: SSE e polling leggono solo ActivityLog; `import_event`/`cancel_event` non ne scrivono.
- Scenario: arriva una prenotazione WhatsApp, l'agenda aperta resta vuota in quella fascia; la reception ci mette un'altra cliente, il 409 viene ritentato con force → doppia prenotazione senza avviso.
- Correzione: `log_activity(... "appointment.created"/"appointment.cancelled" ...)` negli import e negli annullamenti.

### [MEDIO] 11-07 Ogni ri-consegna riporta orario e cliente al valore Yourang, annullando lo spostamento fatto in salone
- File: `backend/apps/integrations/sync.py:455-468`
- Stato: CONFERMATO (probe test_redelivery_moves_back_what_the_salon_moved_and_overlaps: torna alle 10 sopra un'altra cliente, nessun registro)
- Difetto: nessun push appuntamento→evento, eppure `start` e `client` si riscrivono a ogni `event.*`; nessun controllo di sovrapposizione.
- Scenario: la reception sposta alle 12 una prenotazione Yourang e dà le 10 a Luisa; Yourang manda un `event.updated` (approvazione) → la prima torna alle 10 sopra Luisa, in silenzio. Stesso per la cliente corretta a mano (torna la scheda del telefono).
- Correzione: riscrivere start/cliente solo se il valore remoto è cambiato rispetto all'ultimo importato (salvare l'ultimo remoto visto).

### [MEDIO] 11-08 Outbox: un ritentativo consegna la conferma DOPO l'annullamento
- File: `backend/apps/core/management/commands/flush_outbox.py:96-111, 192-211`; `backend/apps/core/services.py:97-113`
- Stato: CONFERMATO (probe test_a_retried_confirmation_arrives_after_the_cancellation: ordine consegnato [cancelled, created])
- Difetto: con `attempts>0` l'evento non si fonde più e riparte col payload vecchio secondo il suo backoff; nessun ordinamento per `coalesce_key`.
- Scenario: la conferma prende un 502, la reception annulla, l'annullamento parte, poi parte la conferma: la cliente si presenta a un appuntamento annullato.
- Correzione: non consegnare un evento se uno più recente con la stessa `coalesce_key` è già partito (o superarlo), oppure consegnare in ordine per chiave.

### [MEDIO] 11-09 Configurare `YOURANG_API_URL` spedisce l'intero arretrato senza scadenza; senza URL nessuna pulizia
- File: `backend/apps/core/management/commands/flush_outbox.py:192-211, 226-235`
- Stato: CONFERMATO (probe test_the_backlog_leaves_whatever_its_age, test_without_url_nothing_is_ever_purged)
- Difetto: nessuna età massima per tipo di evento; senza URL `handle` esce prima di `purge_delivered` e `ratelimit.purge_expired`.
- Scenario: oggi la consegna è spenta; il giorno in cui si accende partono a raffica OTP vecchi, conferme/spostamenti di appuntamenti passati, campagne di mesi prima. Nel frattempo SUPERSEDED con telefoni e contatori di rate limit restano per sempre.
- Correzione: scadenza per tipo (OTP minuti, appuntamenti a inizio visita, campagne ore) → `failed`/`expired`; purge anche senza URL.

### [MEDIO] 11-10 `sync_yourang` manca dai job schedulati di DEPLOY.md
- File: `DEPLOY.md:515-523`; `backend/apps/integrations/management/commands/sync_yourang.py`
- Stato: CONFERMATO per lettura (sync_services è chiamata solo da connect/login/cron)
- Difetto: la tabella elenca solo flush_outbox e process_deposit_holds.
- Scenario: dopo il collegamento il listino su Yourang non si aggiorna mai (prezzi e servizi nuovi), le clienti nuove arrivano su Yourang solo se capita un webhook contact.*, lo stato ERROR non si recupera.
- Correzione: aggiungere `python manage.py sync_yourang` (es. ogni ora) alla tabella.

### [MEDIO] 11-11 Dopo ogni deploy la dashboard aperta va in bianco aprendo una sezione o una modale non ancora caricata
- File: `frontend/nginx.conf:20-24`; `frontend/apps/dashboard/src/sections/registry.js`, `src/modals/registry.js`, `src/shell/Shell.jsx`
- Stato: CONFERMATO per percorso (chunk lazy, immagine nuova senza i vecchi hash → 404; nessun error boundary né handler `vite:preloadError`)
- Difetto: `index.html` è no-cache ma le schede già aperte chiedono chunk che non esistono più; React.lazy rigetta e smonta l'albero.
- Scenario: push su main a metà mattina; la reception, con l'agenda aperta da ore, apre «Nuovo appuntamento» o «Incassa» → pagina bianca, lavoro in corso perso.
- Correzione: handler `vite:preloadError` che ricarica la pagina (o error boundary con ricarica); opzionalmente tenere i vecchi asset.

### [MEDIO] 11-12 La sync completa gira dentro le richieste: login/collega e ogni webhook contact.* fanno migliaia di chiamate HTTP in linea
- File: `backend/apps/integrations/sync.py:218-248`; `api.py:141-143, 248-249`; `login.py:148-150`; `client.py:74`
- Stato: CONFERMATO (probe ContactWebhookCostProbe: 3 webhook × 120 schede non collegate = 360 POST con 403)
- Difetto: push sequenziale di ogni scheda non collegata, `httpx.request` nuovo per chiamata (niente pool), ripetuto a ogni webhook contact.* e per ogni scheda che il remoto rifiuta.
- Scenario: salone con ~4000 clienti: il primo «Accedi con Yourang» resta appeso per minuti; con scope contacts:write mancante ogni modifica di contatto su Yourang occupa un thread gunicorn per minuti, a raffica fino a esaurirli.
- Correzione: sync fuori dalla richiesta (job), client httpx riusato, sui webhook contact.* riconciliare solo `resource_id`.

### [MEDIO] 11-13 Migrazioni additive NOT NULL senza `db_default`: il container vecchio rompe ogni scrittura di OutboxEvent
- File: `backend/apps/core/migrations/0009_outboxevent_coalesce_key_and_more.py`; Django `db/backends/base/schema.py:729, 776-783`; `DEPLOY.md` §9 e «Il container resta unhealthy»
- Stato: PLAUSIBILE (meccanica verificata sul sorgente Django; durata dipende da Coolify)
- Difetto: Django aggiunge la colonna col default e poi lo toglie: il codice vecchio inserisce senza `coalesce_key` → violazione NOT NULL. Vale nella finestra del rolling deploy e, peggio, se il container nuovo va unhealthy DOPO `migrate`: Coolify tiene il vecchio sul DB migrato.
- Scenario: durante/ dopo un deploy fallito, creare/spostare/annullare appuntamenti, chiedere un OTP → 500.
- Correzione: `db_default` sulle colonne nuove (Django 5), e in DEPLOY.md avvertire che il rollback dopo migrate non è sicuro.

### [BASSO] 11-14 Riconnessione con un'altra org: restano contact-id, item-id e catalogue_id della vecchia (H6 corretto solo su disconnect)
- File: `backend/apps/integrations/api.py:134-139`; riga «Connesso» cliccabile in `impostazioni/index.jsx:213-220`
- Stato: CONFERMATO (probe 11-01: PUT su items/i-legit con catalogue_id vecchio verso l'org nuova)
- Scenario: il titolare riclicca «Collega» con un'altra org → clienti collegate mai spinte, voci listino 404 per sempre.
- Correzione: se l'org cambia, azzerare riferimenti remoti e catalogue_id come nel disconnect.

### [BASSO] 11-15 Il claim del worker non ricontrolla la trattenuta: una fusione che committa fra lettura e claim parte col payload vecchio
- File: `backend/apps/core/management/commands/flush_outbox.py:161-180, 114-153`
- Stato: CONFERMATO con interleaving simulato (probe test_a_merge_committed_after_the_listing_is_sent_with_the_old_payload)
- Scenario: correzione a ridosso dei 30 s → la cliente riceve l'orario vecchio e il payload fuso in DB viene sovrascritto.
- Correzione: claim con `_due(now)` nel WHERE e `refresh_from_db()` dopo il claim.

### [BASSO] 11-16 Due consegne concorrenti dello stesso evento creano due righe segnaposto
- File: `backend/apps/integrations/sync.py:474-486`
- Stato: CONFERMATO con interleaving simulato (probe test_two_deliveries_interleaved_create_two_placeholder_rows: 120' invece di 60', poi mai più aggiornato)
- Correzione: `select_for_update` sull'appuntamento prima di leggere/creare le righe.

### [BASSO] 11-17 Prenotazioni Yourang senza telefono tutte sulla stessa scheda, col nome della prima (H12 del 18/09 non corretto)
- File: `backend/apps/integrations/sync.py:370-375`
- Stato: CONFERMATO per lettura
- Scenario: la seconda cliente senza numero appare in agenda col nome, le note e lo storico della prima.
- Correzione: scheda propria per nome (o evento non importato senza telefono).

### [BASSO] 11-18 Gli errori di sync non arrivano al titolare (fix H17 incompleto)
- File: `backend/apps/integrations/api.py:40-49`, `schemas.py:21-26`, `sync_yourang.py:43-44`
- Stato: CONFERMATO per lettura
- Difetto: `last_error` non è in StatusOut; la riga dice «Connesso · sincronizzati»; il cron lo azzera anche con errori parziali.
- Correzione: esporre `last_error` e scriverlo dal cron come fanno connect/login.

### [BASSO] 11-19 CLIENT_APP_ORIGIN mancante non ripiega su FRONTEND_ORIGIN ma su http://localhost:5174
- File: `backend/config/settings.py:296`, `backend/apps/sales/stripe_service.py:223`, `DEPLOY.md:175, 313-315`, `backend/.env.example`
- Stato: CONFERMATO per lettura
- Difetto: default non vuoto rende morto l'`or`; documentazione e diagnosi del §6 sbagliate (la cliente finisce su localhost, non sulla dashboard).
- Correzione: default "" in settings (o correggere la doc).

### [BASSO] 11-20 nginx delle due SPA senza header di sicurezza
- File: `frontend/nginx.conf`
- Stato: PLAUSIBILE (impatto limitato dal partizionamento dello storage)
- Difetto: niente HSTS, X-Frame-Options/frame-ancestors, nosniff; la password staff si digita su beauty.yourang.ai, l'HSTS è solo sull'API.
- Correzione: `add_header ... always` per HSTS, frame-ancestors, nosniff.

### [BASSO] 11-21 flush_outbox «ogni minuto» contro trattenuta di 30 s
- File: `DEPLOY.md:522`; `backend/apps/core/services.py:106-112`
- Stato: PLAUSIBILE (la logica di fusione è del revisore 03)
- Difetto: un evento scaduto ma non ancora preso resta fino a 60 s «né trattenuto né partito»: correzioni e «torna indietro» in quella finestra non fondono né sopprimono → due messaggi.
- Correzione: documentare il worker `--loop --interval 5` come necessario, o considerare trattenuti anche i pendenti mai tentati.

Aree controllate senza reperti: firma HMAC (fail-closed, non-ASCII, tolleranza 5 min, verifica prima del DB), guardie su resource_id vuoto e JSON non oggetto, percent-encoding degli id remoti, timeout httpx presenti (20 s proxy, 15 s outbox), claim condizionale e recupero `sending`, redazione del codice OTP, purge dei consegnati, corrispondenza completa fra variabili lette e documentate (salvo 11-19), Dockerfile backend (utente non root, healthcheck, start-period) e frontend (guardie APP/VITE_API_URL), entrypoint, `/healthz` esente dal redirect con localhost in ALLOWED_HOSTS, SPA fallback e no-cache su index.html, gzip, fuso degli eventi (fuso del salone = TIME_ZONE globale), migrazione agenda 0010, start-dev.sh.
