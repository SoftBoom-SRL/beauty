# Design — Webapp cliente: ingresso anonimo, account alla prima prenotazione

Data: 2026-07-15
Ambito: app cliente (`frontend/apps/client-app`) + un endpoint backend nuovo. Nessuna
modifica alla dashboard in questo intervento.

## Problema

Oggi la webapp cliente ha una **barriera di login all'ingresso** (`App.jsx` → se
`!session` mostra `AuthFlow`): non si vede nulla del centro senza prima autenticarsi via
telefono/OTP. Vogliamo un'esperienza **anonima prima**: si entra, si vede il centro, si
prenota; l'identità e l'account arrivano solo alla conferma della prima prenotazione.

## Obiettivo (flusso desiderato)

1. Il cliente apre il link e vede **direttamente** il centro (nessun login all'ingresso).
2. Può prenotare. All'**ultimo step prima della conferma** inserisce **nome, cognome,
   telefono** (niente email).
3. Conferma il telefono via **OTP** → l'OTP **conferma la prenotazione** e, se il numero è
   nuovo, **crea l'account**.
4. Dopo la prima prenotazione ha un account: potrà accedere e vedere tutto (prenotazione
   attuale, modifica/annulla, storico, coupon/fedeltà, ecc.).
5. Senza accesso si può **sempre prenotare**; da **in alto a destra** si accede al proprio
   profilo.

## Decisioni prese (con l'utente)

- **Cliente di ritorno (numero già noto):** l'OTP fa accedere all'account esistente e la
  prenotazione va lì; nome/cognome eventualmente digitati vengono ignorati se il cliente
  esiste. Flusso unico: telefono → OTP → prenotato e loggato.
- **Navigazione anonima:** shell snella (Home del centro + Prenota) con **"Accedi" in alto
  a destra**; niente tab personali finché non si accede. Dopo login/prima prenotazione
  compaiono le tab (Prenotazioni, Portafoglio, Profilo) e in alto a destra il profilo.
- **Meccanismo prenota+OTP: approccio A** — riuso degli endpoint esistenti orchestrati dal
  frontend (nessun endpoint atomico nuovo).
- **Caparra:** nessuna modifica backend — `compute_deposit` è **già condizionale** (nessuna
  `DepositRule` attiva → deposito 0). Il toggle esplicito in dashboard è un intervento a
  parte, fuori scope.

## Architettura

### Frontend — `frontend/apps/client-app`

**1. Shell (`App.jsx`, `ctx.jsx`)**
- Rimuovere il gate `if (!session) return <AuthFlow/>`. L'app si renderizza sempre.
- `ctx`: `session` può essere `null` (`client` di conseguenza). Aggiungere:
  - `authOpen` + `openAuth()` / `closeAuth()`: apre il flusso di login su richiesta.
  - `onAuthed(cb)` opzionale: callback dopo login riuscito (per riprendere un'azione).
- `AuthFlow` diventa un **overlay/schermata a richiesta** (non più il gate d'ingresso),
  invocato da "Accedi" in alto a destra. Il flusso resta telefono → OTP (con
  registrazione inline per numero sconosciuto), già presente.
- **Guardia viste personali:** se `view` è una schermata personale (`prenotazioni`,
  `wallet`, `profilo`, `waitlist`, `sposta`, `annulla`, `giftcard`) e `!session`, aprire
  il login invece di renderizzarla.

**2. Chrome / navigazione**
- **NavBar (`NavBar.jsx`)**: se `!session`, mostrare shell snella (Home + FAB Prenota);
  se `session`, la barra completa attuale.
- **Top-right**: nuovo controllo in Home (e nelle schermate pubbliche): "Accedi" se
  anonimo (→ `openAuth()`), avatar/nome → `profilo` se loggato.

**3. Home (`Home.jsx`)**
- **Loggato**: comportamento attuale (saluto + prossimo appuntamento + CTA).
- **Anonimo**: cover del centro + breve intro + **anteprima servizi/pacchetti** (dal
  catalogo pubblico già esistente) + CTA "Prenota ora" + footer salone. Nessuna chiamata
  autenticata (`useClientAppointments` solo se `session`).

**4. Prenotazione (`Prenota.jsx`)**
- Deve funzionare **da anonimo**:
  - Step servizio: catalogo pubblico (già `/api/catalog/public/services`, `auth:false`).
  - Step giorno/ora: usare la **nuova disponibilità pubblica** (vedi backend) quando
    `!session`; se `session`, può continuare a usare `client/availability` (equivalente).
    Per semplicità: usare sempre l'endpoint pubblico con lo slug del salone.
  - Step riepilogo: invariato.
- **Nuovo step "I tuoi dati"** (solo se `!session`), tra riepilogo e conferma:
  - Campi: **nome, cognome, telefono** (no email).
  - Azione "Invia codice" → step OTP → "Conferma prenotazione".
  - Se `session` esiste già, questo step si salta (conferma diretta come oggi).
- **Orchestrazione OTP+prenotazione (approccio A)**, all'atto della conferma anonima:
  1. `POST /api/auth/client/request-otp {salon_slug, phone}`.
     - 200 → numero noto (cliente di ritorno): si prosegue con l'OTP, nome/cognome ignorati.
     - 404 → numero nuovo: `POST /api/auth/client/register {salon_slug, first_name,
       last_name, phone, lang}` (email omessa) — che emette l'OTP.
  2. Utente inserisce il codice → `POST /api/auth/client/verify-otp {salon_slug, phone,
     code}` → salva la sessione (`clientAuth` già lo fa).
  3. Subito dopo: `POST /api/agenda/client/appointments {items, start}` (ora autenticato)
     → appuntamento creato → schermata di successo (messaggio caparra già condizionale).
- **Successo**: invariato; la sessione ora esiste, quindi "Torna alla home" mostra la Home
  loggata e le tab personali sono disponibili.

### Backend

**Nuovo endpoint pubblico di disponibilità** (unico pezzo nuovo lato server):
- `GET /api/agenda/public/availability?salon=<slug>&date=<YYYY-MM-DD>&items=<json>`,
  `auth=False`, `response=list[SlotOut]`.
- Risolve il salone dallo slug (come gli altri `/public/...`), poi riusa la stessa logica
  di `client_availability` / `get_free_slots`. Nessuna informazione sensibile esposta
  (solo orari liberi), coerente con gli altri endpoint pubblici.

**Nessun'altra modifica backend**:
- `request-otp` / `register` / `verify-otp` / `client/appointments` già esistono e
  bastano per l'approccio A.
- `compute_deposit` già condizionale → la caparra è richiesta solo se il centro ha regole.

## Flussi (riassunto)

**Anonimo → prima prenotazione (numero nuovo)**
Home pubblica → Prenota (servizio → orario pubblico → riepilogo) → "I tuoi dati"
(nome/cognome/telefono) → request-otp (404) → register → OTP → verify-otp (sessione) →
create appointment → successo. Account creato.

**Anonimo → prenotazione (numero già registrato)**
…"I tuoi dati" → request-otp (200) → OTP → verify-otp (accede all'account esistente) →
create appointment (sul suo account) → successo. Nome/cognome digitati ignorati.

**Accesso dal top-right (senza prenotare)**
"Accedi" → telefono → (se noto) OTP / (se nuovo) registrazione inline → OTP → loggato →
tab personali + profilo disponibili.

## Gestione errori / edge case

- **Slot occupato tra OTP e create** → `client/appointments` risponde 409 → tornare allo
  step orario e ricaricare (comportamento già presente in `confirm()`). L'account però è
  già stato creato/loggato: si riprova solo la scelta orario + conferma (niente nuovo OTP).
- **OTP errato/scaduto** → messaggio, possibilità di reinvio (già in `AuthFlow`, da
  replicare nello step OTP di prenotazione o riusando il componente).
- **429 troppi OTP** → messaggio dedicato.
- **Vista personale da anonimo** → apre il login.
- **Deposito**: se il centro non ha regole, nessuna richiesta (già così).

## Testing

- **Backend**: test dell'endpoint pubblico di disponibilità (200 senza auth, stessi slot
  di `client/availability` a parità di input; salone inesistente → 404).
- **Frontend (verifica guidata in browser, come nel resto del progetto)**: via Playwright
  sul Chrome di sistema —
  1. Ingresso senza sessione: Home del centro visibile, nessun gate, "Accedi" in alto a dx.
  2. Prenotazione anonima con **numero nuovo**: fino a "I tuoi dati" → OTP (codice dal log
     backend) → prenotazione confermata + sessione creata + tab personali comparse.
  3. Prenotazione anonima con **numero esistente**: riconosciuto, prenotato sul suo account.
  4. "Accedi" dal top-right con numero esistente → profilo con storico/prenotazioni.
  - Screenshot a conferma di ciascun passaggio chiave.

## Fuori ambito (YAGNI / dopo)

- Toggle "sistema caparra" nelle impostazioni della dashboard (da rivedere a parte).
- Scelta operatrice lato cliente (gap API preesistente, non introdotto qui).
- Endpoint atomico "public/appointments" (approccio B) — scartato a favore di A.
- Refresh token cliente (inesistente; sessione ~30 giorni, invariato).
