# Integration notes — migrazione prototipo → Vite + API (luglio 2026)

Stato: tutte le 12 sezioni (11 dashboard + app cliente) sono portate su Vite e collegate alle API reali.
Build di produzione verdi per entrambe le app. E2E backend 14/14 (`backend/scripts/run_e2e.sh`).

## Bug backend corretti durante la migrazione
- **Route shadowing** (405 su rotte letterali registrate dopo rotte con parametro): corretti aggiungendo
  convertitori `{int:...}` a tutti i parametri `*_id` nei decorator di `apps/*/api.py` (75 rotte).
  Casi concreti: `POST /api/clients/import`, `POST /api/catalog/categories/reorder`.
  `webhook_token` resta volutamente stringa.

## Gap API noti (candidati fase 2 — il frontend ha workaround attivi)
- **Operatrici pubbliche**: nessun endpoint client/pubblico per elencare le operatrici → l'app cliente
  prenota "prima disponibile" (niente scelta stilista, né in prenotazione né in lista d'attesa).
- **Branding pubblico**: mancano address/phone/hours/social → footer app e CTA `tel:` senza dati.
- **Catalogo**: nessun flag "prenotabile online", deposito %, buffer, patch-test, descrizione per servizio;
  niente deposito/validità sui pacchetti. L'app cliente mostra tutti i servizi attivi.
- **Clienti (staff)**: manca storico appuntamenti per cliente; vendite/coupon/gift per cliente solo via
  `q=` su nome (serve param `client_id`); saldo fedeltà staff-side richiede scan di `accounts` per
  programma (rompe oltre limit=200 — servirebbe un mirror staff di `client/wallet`); note senza update;
  `TechnicalSheetIn` senza campo foto; PUT clients richiede payload completo (parziale resetta i default).
- **Sales**: `SaleLineOut` senza `product_name`; `kpi.revenue` decimale non quantizzato.
- **Comunicazioni**: niente upload immagine, niente `q`, niente metriche; audience vuota = zero destinatari;
  `send_communication` fa `scheduled_at or comm.scheduled_at` → "invia subito" richiede PUT null prima.
- **Magazzino**: non si può aggiungere una riga a un ordine draft, creare ordine manuale, o "riaprire"
  un ordine inviato; categorie inventario senza colore; niente endpoint stats (valore magazzino calcolato
  da snapshot limit=500); le righe ordine non memorizzano prezzi.
- **Staff**: role_title monolingua; niente timbrature/commissioni (fase 2); overlap assenze non validato;
  eccezioni orarie one-off non rappresentabili; turni spezzati 3+ segmenti semplificati al salvataggio.
- **Automazioni**: events-catalog senza metadati di tipo campo; niente metriche di consegna (Yourang).
- **Agenda**: `day`/`week` restituiscono UTC mentre `availability` restituisce +02:00 (il frontend
  normalizza; da unificare server-side); `week` non porta il payload completo degli appuntamenti;
  nessuna creazione lista d'attesa staff-side.
- **Insights**: `occupancy_pct` è 0–100 mentre i `*_rate` sono 0–1 (da normalizzare).
- **Core**: nessuna API per cambiare `default_lang` del salone o cancellare il logo.

## Note di design v1 (intenzionali, da conoscere)
- Checkout senza guardia di stato (si può incassare un `confirmed` senza check-in).
- `check-in` accettato su `in_progress` (regressione di stato).
- Refresh token vecchi validi fino a scadenza (JWT stateless, no revoca).
- Coupon auto-assignment non esiste: se serve, è dominio automazioni.

## Refactor futuri frontend
- `DkCondRow`/`DkDrop` duplicati in `sections/automazioni/` e `sections/impostazioni/lib.jsx`
  (naming operatori diverso: prototipo `op` vs API `cmp`) → estrarre in `ui/` condivisa.
- `fmtEur(0)` → "Gratis": Insight, POS e Magazzino hanno wrapper locali per mostrare "€0";
  valutare un'opzione in `@youty/shared`.
- `opColors` (override colori operatrici) è session-only: valutare persistenza.
- Resize appuntamenti non portato (durata deriva dai servizi); resize attivo solo sulle pause.

## Come si avvia (dev)
```bash
# backend (porta 8000, db.sqlite3 con seed; opzionale: seed_demo --reset per appuntamenti "oggi")
cd backend && .venv/bin/python manage.py runserver

# dashboard staff → http://localhost:5173 (login sole@theparlour.it / theparlour)
cd frontend && npm run dev:dashboard

# app cliente → http://localhost:5174 (registrazione + OTP: codice nel log server o in core_outboxevent)
cd frontend && npm run dev:client

# E2E backend ripetibile (DB usa-e-getta, non tocca db.sqlite3)
backend/scripts/run_e2e.sh
```

## Passata UX/UI di settembre 2026 (feedback utenti)
- **Dati sempre aggiornati fra postazioni** (non "notifiche": chi guarda lo schermo vede lo stato
  reale). Push dal server con **Server-Sent Events**: `POST /api/core/activity/stream-ticket` (Bearer)
  → `GET /api/core/activity/stream?ticket=…&after=<id>` (vista Django in `core/views.py`, fan-out via
  tabella `ActivityLog` interrogata ogni secondo: nessun Redis/ASGI). Riserva: polling di
  `GET /api/core/activity/feed?after=<id>` (3 s senza stream, 30 s con stream). In `ctx.jsx` il hook
  `useLive(prefissi, fn)` ricarica in silenzio la sezione; i cataloghi base del contesto (operatrici,
  servizi, categorie, impostazioni) si ricaricano da soli. Agganciate: agenda giorno/settimana, clienti
  (lista, profilo, storico), servizi, magazzino, comunicazioni, automazioni. Le pause loggano anche
  `pause.updated` / `pause.deleted`. **Docker**: gunicorn passa a `--worker-class gthread --threads 24`
  perché ogni stream aperto occupa un thread (vedi Dockerfile e DEPLOY.md). Il pannello campanella
  resta come "attività del team", senza badge.
- **Nuova prenotazione unificata**: un solo drawer (`newappt`) da topbar, slot, lista d'attesa, slot
  liberato, scheda cliente. Cliente con creazione rapida inline (`ClientPicker`, riusato anche dal
  gruppo). Orario richiesto dall'agenda: esito esplicito (disponibile / motivo del rifiuto: fuori
  turno, occupata fino alle…, in pausa, non esegue il servizio, orario passato) + alternative vicine.
  Mentre il drawer è aperto l'agenda è in "pick mode". Pulsante finale mai muto: elenca cosa manca.
- **Agenda**: drag con traccia dell'origine, colonna target evidenziata, badge orario+esito calcolato
  lato client (`explainSlot` in `agenda/lib.js`, stesse regole di `agenda/services.py`); un rilascio
  non valido non chiama il server. Corretto il bug per cui dopo un trascinamento si apriva la scheda
  dell'appuntamento (click post-drop). Indicatore slot al passaggio del mouse; etichette "Fuori turno";
  velo sul passato; menu slot con stato; permessi mancanti → toast, mai silenzio. Tasto `N` = prenota.
- **Chip selezionabili** `.dk-pill*`: stato on inequivocabile (agenda, prenotazione, servizi, staff).
- **Modali/drawer/sheet**: chiusura solo se il gesto inizia E finisce sullo scrim (prima una
  selezione di testo rilasciata fuori chiudeva la finestra — segnalato su modifica servizio).
- **Servizi**: lista compatta a righe raggruppata per categoria (collassabile) al posto delle card.
- **Staff**: servizi abilitati raggruppati per categoria, seleziona tutti/nessuno, creazione servizio
  inline (scope `pricing`) subito abilitato per l'operatrice.
- **Favicon**: SVG + PNG in `public/` di entrambe le app; l'app cliente usa logo/colore del salone.

## Clienti (settembre 2026, secondo giro di feedback)
- **Genere** (`gender`: female | male | other | "") e **compleanno con anno facoltativo**: l'API accetta e
  restituisce `birthday` come `YYYY-MM-DD` oppure `--MM-DD` (ISO 8601 senza anno; nel DB anno segnaposto
  1904 + `birthday_year_known=false`), più `age` calcolata quando l'anno c'è. Selettori: `ui/GenderPicker`,
  `clienti/components.BirthdayInput`. Il genere si chiede anche nella creazione rapida in agenda.
- **Modifica cliente esplicita**: `newclient` è ora crea+modifica (`client` prop); pulsante "Modifica" in
  testa al profilo e card "Anagrafica" con i campi e "+ aggiungi" sui vuoti.
- **Storico unificato**: `GET /api/clients/{id}/history` → timeline visite (servizi, operatrici, stato,
  incasso, nota appuntamento, note di trattamento con allegati, schede tecniche) + vendite al banco +
  note/schede libere; `upcoming` per i futuri. `StoricoTab` la rende con azioni per visita
  (nota/foto di trattamento, scheda tecnica).
- **Note con allegati**: `ClientNote.appointment` (nota di trattamento legata alla visita) e
  `ClientNoteAttachment` (foto/PDF/Word, max 15 MB, sotto `MEDIA_ROOT/client_notes/`). Endpoint:
  `POST /notes/upload` (multipart, `files[]`), `PUT /notes/{id}`, `POST /notes/{id}/attachments`,
  `DELETE /notes/{id}/attachments/{aid}`. Foto scheda tecnica: `POST /sheets/{id}/photo`.
  Componenti condivisi in `clienti/NoteBits.jsx` (NoteComposer, NoteCard, AttachmentGrid).
- **Import CSV in tre passi** (`BulkImportModal`): rilevamento separatore/intestazione/codifica, parser
  RFC 4180, mappatura colonne → campi con suggerimenti da titoli e contenuto, normalizzazione (telefono,
  genere in più lingue, date in vari formati anche senza anno, etichette separate da , ; |), verifica con
  avvisi per riga, `update_existing`. Backend `import_rows`: match telefono tollerante (`phone_key`),
  etichette create al volo, nota privata, `skipped` + `errors` per riga.
- **Orari di apertura del centro**: `SalonSettings.opening_hours_week` ({"0".."6": [["HH:MM","HH:MM"]]},
  0 = lunedì) validato in `core.services.normalize_opening_hours_week`; il testo `opening_hours` per l'app
  cliente viene generato da lì. Editor in Impostazioni → Salone → Orari di apertura (`HoursDrawer`),
  chip "Centro 9–13 · 14–19" nella barra dell'agenda (deepLink `hours`).

## Correzioni dall'audit del 16 settembre 2026
Riferimento: report di audit (B01–B21). Cosa cambia per chi integra:
- **Isolamento salone nelle vendite**: `finalize_sale` verifica che servizi, prodotti e operatrici delle
  righe siano del salone autenticato (404 altrimenti). Limiti numerici sugli schemi: quantità ≥ 1, prezzi e
  pagamenti ≥ 0, sconto 0–100, durata servizio ≥ 1 minuto, quantità pacchetto ≥ 1 (422 dal contratto).
- **Gift card**: il riscatto richiede `payment_status = paid` (una carta comprata dall'app va prima incassata
  in salone con `POST /gift-cards/{id}/mark-paid`).
- **Allegati riservati**: gli URL degli allegati delle note e delle foto delle schede tecniche tornano
  **firmati e a scadenza** (`/media/client_notes/...?t=…`, 4 ore). La vista `/media/` rifiuta senza token i
  prefissi `client_notes/`, `technical_sheets/`, `inventory/invoices/` (anche con DEBUG=1). Usare sempre
  l'URL restituito dall'API; ricaricare la nota se il link è scaduto (403).
- **Stripe**: il webhook è rifiutato (503) senza `STRIPE_WEBHOOK_SECRET`; `payment_intent.succeeded` paga la
  caparra solo con `metadata.kind = deposit`, da stato `required`, una sola volta e se l'importo copre la
  caparra; salva `deposit_payment_intent_id`. L'addebito no-show è unico per appuntamento
  (`no_show_payment_intent_id` + idempotency key) e ammesso solo su appuntamenti `no_show`.
- **Caparra all'annullamento in tempo**: nuovo stato `deposit_status = refund_due` («da rimborsare»). Se la
  caparra è stata pagata online e Stripe è configurato il rimborso parte subito e lo stato diventa
  `refunded`; altrimenti resta `refund_due` finché lo staff non conferma con
  `POST /api/agenda/appointments/{id}/deposit-refunded` (scope `sales`; pulsante nel dettaglio
  appuntamento). `depositMeta` in `@youty/shared` conosce il nuovo stato.
- **Login OTP**: max 5 tentativi errati per i codici attivi (poi 429 e codici invalidati), max 5 richieste di
  codice per cliente ogni 15 minuti (cache su database: serve `createcachetable`). Il payload degli eventi
  outbox non finisce più nei log.
- **Telefono**: `common.phone` normalizza in E.164 a ogni ingresso (dashboard, app, form pubblico, import,
  sync Yourang); login e registrazione riconoscono lo stesso numero scritto in modi diversi e cercano anche
  fra i numeri salvati prima della normalizzazione.
- **Prenotazione cliente**: `POST /client/appointments` rifiuta orari passati (400) e servizi disattivati
  (404) e assegna la sede predefinita del salone. `GET /client/availability` accetta
  `exclude_appointment_id` (solo un proprio appuntamento): l'appuntamento da spostare non conta come
  occupato e, se gli item non indicano `operator_id`, eredita le operatrici dell'appuntamento — così
  «Sposta» propone solo orari che la conferma accetta. Gli appuntamenti del cliente espongono
  `services[].operator_id`.
- **Orari di apertura come vincolo**: `staff.services.shift_windows` interseca i turni con
  `opening_hours_week` quando è configurato (giorno senza fasce = chiuso). Vale per disponibilità, vista
  giorno e occupazione. Senza orari configurati contano solo i turni.
- **Concorrenza**: creazione, spostamento e modifica servizi prendono un lock sulla riga del salone
  (`agenda.services.lock_salon`, `SELECT … FOR UPDATE` su PostgreSQL) dentro la transazione: due
  prenotazioni simultanee sullo stesso slot non passano più entrambe.
- **Sede attiva** (dashboard): vive in `ctx.locationId` (persistita per postazione) e viene passata come
  `location_id` a `/agenda/day`, `/agenda/availability` e alla creazione appuntamenti; la vista giorno con
  filtro sede include anche gli appuntamenti senza sede. `ctx.location` è l'oggetto sede.
- **POS**: i picker prodotti usano `pos/useProductCatalog.js` (prima pagina da 200 + ricerca lato server
  quando il catalogo è più grande).
- **Feed live**: HTTP e SSE condividono `core.views.LIVE_FEED_PREFIXES` (incluse `settings.` e
  `client_category.`). **Insights**: l'occupazione conta anche `checked_in` e `in_progress`.
- **Yourang**: un evento importato che cambia durata aggiorna la riga segnaposto locale.
- **Campanella**: `NotifPanel` riceve `streamOk` come prop (prima leggeva una variabile inesistente e il
  pannello andava in errore alla prima apertura). **Prenota**: le risposte di disponibilità fuori ordine
  vengono ignorate (numero di sequenza per richiesta).

## Passata "meglio al mondo" del 16 settembre 2026 (13 richieste del titolare)
Tutto verificato nel browser sull'ambiente locale. In sintesi, per chi integra:

**Agenda — lo staff comanda sulle regole**
- `force: true` su `POST /agenda/appointments`, `/{id}/move`, `/{id}/split`, `/{id}/restore`: salta turni,
  orari del centro e sovrapposizioni (mai l'idoneità dell'operatrice al servizio). L'appuntamento resta
  `forced: true` ed è evidenziato in tutte le viste. Solo staff: l'app cliente non può forzare.
- Drawer prenotazione: campo **«Orario a mano»**; se l'orario non è fra gli slot liberi spiega perché e il
  pulsante diventa «Crea forzando». Un 409 apre «Crea comunque» invece di far perdere il lavoro fatto.
- Drag & drop: un rilascio non valido (o un 409) apre la conferma **«Sposta comunque»** in giorno e settimana.
- **Stacca e sposta** (`POST /agenda/appointments/{id}/split` con `item_id`): un servizio di una visita
  multi-servizio diventa un appuntamento a sé, anche in un altro giorno. La caparra resta sull'originale.

**Caparra con scadenza (anti slot bloccati)**
- `SalonSettings.deposit_hold_minutes` / `deposit_reminder_minutes` (Impostazioni → Pagamenti & caparre).
  Alla prenotazione parte il link Stripe Checkout (`deposit_payment_link`), dopo il sollecito e allo scadere
  lo slot viene liberato: l'appuntamento resta `auto_released` fra i **«da richiamare»** nel pannello
  laterale (`GET /agenda/released`, `POST /agenda/appointments/{id}/restore`). Il giro avviene a ogni
  lettura dell'agenda e dal cron `python manage.py process_deposit_holds`.

**Disponibilità intelligente** — `get_free_slots` calcola `recommended` per ogni slot: falso se lascerebbe
un buco più corto del servizio più breve a listino. `SalonSettings.agenda_fill = max_revenue` (ora il
default) fa vedere alle clienti solo i consigliati; la dashboard li mostra tutti, con i non consigliati
attenuati. Verificato: con turno 9–13 e servizio minimo 30', le 9:15 non vengono proposte.

**Pagamenti** — Stripe Connect del salone (`GET/POST/DELETE /sales/stripe/connect/*`, popup
`/stripe-connect/start|done`): caparre e addebiti no-show passano sull'account collegato. Link caparra:
`POST /sales/appointments/{id}/deposit-link` (staff, anche come sollecito) e
`POST /sales/client/appointments/{id}/deposit-link` (cliente). Il webhook gestisce anche
`checkout.session.completed`. Senza `STRIPE_CONNECT_CLIENT_ID` la voce resta informativa.

**Gift card** — `gifts[]` su ogni appuntamento (agenda giorno/settimana/mese, dettaglio, app cliente):
carte «a trattamento» attive e **pagate** della cliente che coprono un servizio della visita. Il checkout
precompila il pagamento con la gift card. `client_id` filtra `GET /marketing/gift-cards`. Il wallet cliente
espone `gift_service_name`, `buyer_name`, `received`, `payment_status`. In cassa e nei KPI:
`gift_card_sold`, `gift_card_redeemed`, `cash_in` (= incasso − riscatti, così il regalo non conta due volte).
Nella modale «Nuova gift card» la destinataria è una **cliente** (il credito segue la scheda); il nome libero
resta possibile ma avvisa che varrà solo il codice.

**Altro** — colore operatrice condiviso (`PATCH /staff/{id}/color`, evento `operator.updated`);
`description_it`/`description_en` sui servizi (editor + listino pubblico + app cliente);
motivazioni di annullamento/no-show personalizzabili (`cancel_reasons`, `no_show_reasons`);
`PhoneInput` (bandiera + prefisso a discesa + numero) in ogni campo telefono delle due app, valore sempre
E.164; creazione rapida cliente in agenda con «Scheda completa» (email, compleanno, lingua, etichette,
origine, nota, consensi); `GET /agenda/range` per la vista mese; `GET /core/outbox/status` con la
diagnostica della consegna messaggi (perché un OTP non arriva).

**Consegna messaggi** — `flush_outbox` ora consegna davvero: POST JSON su `YOURANG_API_URL` con
`Authorization: Bearer YOURANG_API_KEY` e `Idempotency-Key`, ritenta fino a 8 volte, poi `failed`.
Va schedulato (`python manage.py flush_outbox --loop` o cron). **Senza `YOURANG_API_URL` gli OTP restano
in coda: è questa la ragione per cui il codice non arriva**, non la connessione OAuth di Yourang.

---

## Ricerca bug del 17 settembre 2026 (88 difetti, 79 corretti)

Sei revisioni in parallelo su tutto il codice, più due analizzatori statici eseguiti fuori dal
repository. Sotto ci sono solo le decisioni che cambiano il modo di lavorare sul progetto: il
resto è documentato nei commenti al codice, accanto alla correzione.

**Numeri di telefono.** `Client.phone_key` (E.164 senza `+`, indicizzato) è la chiave con cui si
riconosce una cliente già in rubrica. Viene calcolata da `Client.save()`: **non scrivere `phone`
con `queryset.update()`**, la chiave resterebbe vecchia. `common.phone.find_client_by_phone` cerca
prima per uguaglianza esatta, poi sulla chiave; la scansione in memoria è rimasta solo per le
schede mai risalvate dalla migrazione `clients.0006`.

**Limiti di frequenza.** `common.ratelimit` è il punto unico: `hit(chiave, tetto, finestra)` conta
con `add`+`incr` sulla cache (che è su database, quindi condivisa fra i worker) e non con
`get`+`set`, che due richieste parallele leggono uguale. Lo usano registrazione cliente, invio e
verifica del codice, disponibilità pubblica e webhook delle automazioni. `client_ip()` prende
l'**ultimo** elemento di `X-Forwarded-For`: il primo è scrivibile dal client.

**Stripe e account collegati.** `Client.stripe_account_id` dice a quale account appartengono
`stripe_customer_id` e `stripe_payment_method_id`. `ensure_customer()` ricrea il cliente e azzera
la carta quando l'account cambia — chiamarla **prima** di leggere la carta salvata. I webhook
filtrano per `salon_id` nei metadata e confrontano `event["account"]` con l'account del salone.

**Coda messaggi.** `OutboxEvent` ha ora `sending` (preso in carico), `next_attempt_at` (attesa che
raddoppia) e `claimed_at` (recupero dopo un processo morto). Due worker in parallelo non mandano
più lo stesso messaggio. Il campo `code` viene oscurato alla consegna e gli eventi consegnati si
cancellano dopo 30 giorni.

**Turni.** L'indice della settimana nel ciclo si calcola da `staff.services._week_index` (settimane
trascorse), **non** dal numero di settimana ISO: negli anni da 53 settimane il ciclo si invertiva
per sempre. Le finestre contigue vengono unite da `_merge_windows`.

**Orari consigliati.** `_slot_is_recommended` guarda i bordi di **ogni** operatrice coinvolta nella
catena, non solo del primo e dell'ultimo servizio.

**Connessioni live.** `SSE_MAX_CONNECTIONS` (default 40, per processo) limita gli stream aperti:
oltre il tetto la vista risponde 503 e la dashboard passa da sola al polling, con ritentativi
sfalsati. Vale circa metà di `--threads` di gunicorn.

**Job schedulati.** `flush_outbox` e `process_deposit_holds` vanno programmati sul server: vedi la
tabella in `DEPLOY.md`. Senza il secondo, le caparre scadute non liberano mai lo slot.

## Audit del 17 settembre 2026 (14 difetti, tutti corretti)

Invarianti introdotte con queste correzioni. Romperle rimette in piedi difetti
già pagati una volta.

**Fuso orario.** Il gestionale ragiona sull'orologio del SALONE, che arriva dal
server (`timezone` in `/api/core/salon` e in `/api/core/public/branding`) e che
le due app impostano al boot con `setSalonTz()`. In `@youty/shared/format.js` la
distinzione è netta: gli ISTANTI (ISO con orario, `new Date()`) si leggono nel
fuso del salone — `minutesOfDay`, `nowMinutes`, `todayStr`, `fmtTime`,
`toDateStr` su una stringa con la T, `isoAtMin`, `toDateTimeLocal` — mentre le
date pure (`"YYYY-MM-DD"` e i Date che ne derivano) restano aritmetica di
giorni, senza fuso. Non leggere mai `getHours()`/`getDate()` su un istante che
arriva dall'API: da una postazione su un altro fuso l'agenda mostra ore
traslate. I test stanno in `packages/shared/test/format.test.js` (`npm test`).

**Caparra.** Si detrae `deposit_credit`, mai `deposit_amount`: dopo un rimborso
parziale la quota in cassa è più bassa. Lo stato del deposito lo decide
`agenda.services.record_deposit_refund()`, che tiene i rimborsi uno per id
Stripe (idempotente, riconcilia gli aggiornamenti) e scrive «rimborsata» solo
quando i rimborsi RIUSCITI coprono l'intera caparra. «Rimborso in corso»
(`refunding`) è lo stato di un rimborso ancora pending. Un secondo incasso sulla
stessa caparra viene restituito, non ignorato; e creare un nuovo link chiude la
Checkout Session precedente (`deposit_checkout_session_id`).

**Concorrenza.** Ogni mutazione di un appuntamento passa da
`agenda.services._lock_and_reload()`: lock del salone e rilettura DENTRO la
transazione, poi `save(update_fields=[…])` con i soli campi toccati. Un `save()`
completo su un'istanza caricata a inizio richiesta riscrive anche quello che è
cambiato nel frattempo. Stessa regola per `inventory.services.receive_order()`,
che rilegge l'ordine bloccato prima di decidere se è già stato ricevuto.

**Rate limit.** `common.ratelimit` non usa più la cache: conta su
`core.RateLimitCounter` con una `UPDATE … count + 1` e una scadenza propria. La
cache su database non è atomica e riporta il TTL a 300 secondi. Le finestre
scadute le pulisce il job `flush_outbox`.

**Disponibilità.** Quello che la ricerca propone, la conferma deve accettarlo.
Ricerca e prenotazione usano la STESSA sede (`services.default_location`); lo
spostamento costruisce il piano dallo snapshot della visita (durate, pose e
operatrici scritte sull'appuntamento, non il listino di oggi) e ammette i
servizi nel frattempo disattivati (`keep_service_ids`); `get_free_slots` verifica
la chiusura del centro sull'intera permanenza, posa finale compresa.

**Premi fedeltà.** `marketing.services._issue_reward()` emette davvero ogni tipo
offerto dall'interfaccia: coupon € e sconto %, servizio omaggio (gift card
legata al servizio, del suo prezzo) e gift card. Se un premio non è emettibile i
punti NON si consumano. Il «prodotto omaggio» non esiste più fra le scelte:
nessuna cassa saprebbe riscattarlo.

**Accessi.** L'accettazione di un invito valida la password con le regole di
Django; il login staff ha un tetto per account e uno per indirizzo, senza blocchi
permanenti (un accesso riuscito azzera il contatore dell'account).
