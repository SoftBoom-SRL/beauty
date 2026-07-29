# Integration notes — migrazione prototipo → Vite + API (luglio 2026)

Stato: tutte le 12 sezioni (11 dashboard + app cliente) sono portate su Vite e collegate alle API reali.
Build di produzione verdi per entrambe le app. E2E backend 14/14 (`backend/scripts/run_e2e.sh`).

## Bug backend corretti durante la migrazione
- **Route shadowing** (405 su rotte letterali registrate dopo rotte con parametro): corretti aggiungendo
  convertitori `{int:...}` a tutti i parametri `*_id` nei decorator di `apps/*/api.py` (75 rotte).
  Casi concreti: `POST /api/clients/import`, `POST /api/catalog/categories/reorder`.
  `webhook_token` resta volutamente stringa.

## Gap API noti (candidati fase 2 — il frontend ha workaround attivi)

> **Verificato il 29/07/2026**: le voci barrate qui sotto sono state chiuse (branch
> `feat/phase2-gaps` e lavori successivi). Le altre restano valide.

- ~~**Operatrici pubbliche**~~: chiuso — esiste `GET /api/staff/public/operators`
  (e `GET /api/agenda/public/availability` per la disponibilità pre-login).
- **Branding pubblico**: address/phone ora ci sono (più `timezone`); restano da esporre
  hours strutturati e social.
- **Catalogo**: nessun flag "prenotabile online", deposito %, buffer, patch-test, descrizione per servizio;
  niente deposito/validità sui pacchetti. L'app cliente mostra tutti i servizi attivi.
- **Clienti (staff)**: manca storico appuntamenti per cliente; vendite/coupon/gift per cliente solo via
  `q=` su nome (serve param `client_id`); saldo fedeltà staff-side richiede scan di `accounts` per
  programma (rompe oltre limit=200 — servirebbe un mirror staff di `client/wallet`); note senza update;
  `TechnicalSheetIn` senza campo foto. ~~PUT clients richiede payload completo~~ → chiuso:
  verificato che un PUT parziale non azzera più i campi non inviati.
- **Sales**: `SaleLineOut` senza `product_name`; `kpi.revenue` decimale non quantizzato.
- **Comunicazioni**: niente upload immagine, niente `q`, niente metriche; audience vuota = zero destinatari;
  `send_communication` fa `scheduled_at or comm.scheduled_at` → "invia subito" richiede PUT null prima.
- **Magazzino**: non si può aggiungere una riga a un ordine draft, creare ordine manuale, o "riaprire"
  un ordine inviato; categorie inventario senza colore; niente endpoint stats (valore magazzino calcolato
  da snapshot limit=500); le righe ordine non memorizzano prezzi.
- **Staff**: role_title monolingua; niente timbrature/commissioni (fase 2); overlap assenze non validato;
  eccezioni orarie one-off non rappresentabili; turni spezzati 3+ segmenti semplificati al salvataggio.
- **Automazioni**: events-catalog senza metadati di tipo campo; niente metriche di consegna (Yourang).
- **Agenda**: `day`/`week` restituiscono UTC mentre `availability` restituisce +02:00.
  ~~Da unificare server-side~~ → **verificato innocuo**: sono lo stesso istante e il layer
  date del frontend li normalizza in modo identico in ogni fuso (provato su 5 fusi e sui
  due cambi di ora legale). Resta pulizia, non un bug. Il problema vero era un altro ed
  è stato corretto: il frontend renderizzava nel fuso del BROWSER anziché del salone
  (vedi `salon*` in `packages/shared/src/format.js` e `settings.timezone`).
  Restano aperti: `week` non porta il payload completo degli appuntamenti; nessuna
  creazione lista d'attesa staff-side.
- **Insights**: ~~`occupancy_pct` 0–100 vs `*_rate` 0–1 da normalizzare~~ → **non è un difetto**:
  è una convenzione coerente col nome del campo (`*_pct` = 0–100, `*_rate` = 0–1) e il
  frontend la rispetta già (`kpiDefs.js`: occupancy grezzo + '%', i rate via `pct()`).
  Rinominare sarebbe una rottura di contratto senza beneficio: lasciare così.
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
