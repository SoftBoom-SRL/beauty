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
