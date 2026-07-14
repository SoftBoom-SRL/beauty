# Design — Anteprima passo-passo del flusso no-show / cancellazione

Data: 2026-07-14
Ambito: dashboard (sezione Agenda). Nessuna modifica all'app cliente.

## Problema

La sequenza **conferma no-show → esito caparra → slot liberato → proposta alla lista
d'attesa** avviene già a livello funzionale, ma dall'interfaccia non è chiara: oggi è
comunicata solo con un paragrafo di prosa nel modale di conferma, seguito da un toast e
dall'apertura di un modale separato ("Slot liberato"). L'operatrice non vede la sequenza
come un insieme connesso di passi con i valori reali.

## Obiettivo

Nel modale di conferma di **no-show** e **cancellazione**, mostrare una **timeline
verticale numerata** (sola lettura) che illustra *cosa sta per succedere*, con i valori
reali, PRIMA che l'operatrice confermi. Dopo la conferma il comportamento resta invariato
(toast + modale "Slot liberato" che gestisce l'azione sul passo 4).

## Decisioni prese (con l'utente)

1. **Quando**: anteprima *prima* di confermare (non un riepilogo dopo).
2. **Forma**: timeline verticale numerata ①②③④.
3. **Passo caparra**: adattivo al caso reale (trattenuta / rimborsata / nessuna caparra).
4. **Soglia cancellazione**: esposta dal backend (`cancel_min_hours`) per mostrare l'esito
   definito anche in cancellazione.
5. **Ambito**: sia no-show sia cancellazione (stesso flusso a 4 passi).

## Comportamento reale del backend (fonte di verità)

Da `backend/apps/agenda/services.py`:

- `mark_no_show`: se `deposit_status == PAID` → `FORFEITED` (trattenuta); altrimenti nessun
  addebito automatico. Poi `free_slot_event` (emette `slot.freed` con i match di lista
  d'attesa compatibili).
- `cancel_appointment`: `late = (start - now) < CLIENT_MOVE_CANCEL_MIN_HOURS`. Caparra
  pagata → `FORFEITED` se tardiva, `REFUNDED` se anticipata; senza caparra nessun
  movimento. Poi `free_slot_event`.
- Compatibilità lista d'attesa (`free_slot_event`): entry `ACTIVE`, stesso `service_id` di
  uno degli item, operatrice non indicata oppure tra quelle coinvolte.

La timeline deve rispecchiare esattamente questi esiti, senza inventare passi.

## I quattro passi (contenuto adattivo)

| # | Titolo | Dettaglio a destra |
|---|--------|--------------------|
| ① | No-show confermato / Cancellazione confermata | — |
| ② | Esito caparra | `Caparra trattenuta €X` (no-show con caparra; cancell. tardiva) · `Caparra rimborsata €X` (cancell. anticipata) · `Nessuna caparra` (attenuato, quando non c'è) |
| ③ | Slot liberato | `HH:MM–HH:MM` dell'appuntamento |
| ④ | Proposto alla lista d'attesa | `N in attesa` (match compatibili) · `Nessuno compatibile` (attenuato) |

## Componenti e file

### 1. `FlowSteps` — componente di presentazione (nuovo)
- Posizione: `frontend/apps/dashboard/src/sections/agenda/FlowSteps.jsx`.
- Sola lettura. Prop: `steps` = array di `{ n, title, detail?, tone?: 'default'|'danger'|'ok'|'muted' }`.
- Rende, per ogni voce: badge numerico ① + linea connettore verticale (tranne l'ultimo) +
  titolo a sinistra e `detail` a destra. `tone` colora badge/valore (es. `danger` per
  trattenuta, `ok` per rimborsata, `muted` per passi "nessuno/nessuna").
- Nessuna logica di dominio dentro il componente: riceve dati già pronti.

### 2. Costruttori dei passi (in `frontend/apps/dashboard/src/sections/agenda/lib.js`)
- `noShowSteps(appt, matchCount, t, lang)` → array dei 4 passi.
- `cancelSteps(appt, late, matchCount, t, lang)` → array dei 4 passi; il passo ② dipende
  da `late` e da `deposit_status`/`deposit_amount`.
- Helper già presenti da riusare: `aStartMin`, `aEndMin`, `timeLabel`, `wlMatches`,
  `fmtEur`. `late` calcolato nel modale (vedi sotto), non nel costruttore.

### 3. Backend — esporre la soglia
- `backend/apps/core/schemas.py` · `SettingsOut`: aggiungere `cancel_min_hours: int`.
- Popolarlo da `django.conf.settings.CLIENT_MOVE_CANCEL_MIN_HOURS` dove si serializza
  `SettingsOut` (endpoint `GET /api/core/salon`, `core/api.py`). È un valore derivato da
  settings, non un campo del modello `SalonSettings`.
- Il dashboard lo riceve già via `ctx.settings` (`salon.settings`). Nessun nuovo fetch.

### 4. Integrazione in `ApptDetailModal.jsx`
- Flow `noshow`: sostituire il box di prosa (righe ~188–201) con `<FlowSteps steps={noShowSteps(...)} />`.
  Restano invariati `ReasonPicker` e il pulsante "Conferma no-show".
- Flow `cancel`: sostituire il box caparra condizionale (righe ~219–226) con
  `<FlowSteps steps={cancelSteps(appt, late, matchCount, t, lang)} />`.
  `late = parseISO(appt.start) - now < cancel_min_hours` (ore da `settings.cancel_min_hours`,
  fallback 24 se assente).
- **Conteggio lista d'attesa nel passo ④**: pre-caricare i match all'ingresso nel flow di
  conferma. Recuperare `GET /api/agenda/waitlist` una volta all'apertura del flow (o
  riusare eventuale stato già disponibile), calcolare `matchCount = wlMatches(wl, appt).length`.
  Stato locale `matchCount` con placeholder finché il fetch non risponde (es. mostrare "…"
  o nascondere il dettaglio del passo ④ fino al caricamento; nessun blocco della conferma).
- `destroy(kind)` resta invariato: dopo la conferma apre `FreedSlotModal` se ci sono match.

### 5. `FreedSlotModal.jsx` — invariato
Resta l'azione del passo ④ dopo la conferma (miglior match + suggerimento WhatsApp).

## Flusso dati

1. Apertura appuntamento → `ApptDetailModal` (detail).
2. Click "No-show" / "Cancella" → entra nel flow relativo → fetch waitlist per `matchCount`.
3. Render `<FlowSteps>` con i 4 passi adattivi (valori reali di caparra/slot/attesa).
4. Conferma → `POST /api/agenda/appointments/{id}/{no-show|cancel}` → toast → se match,
   `FreedSlotModal`.

## Gestione errori

- Fetch waitlist per il conteggio fallisce → il passo ④ mostra un testo neutro
  ("Verrà proposto alla lista d'attesa") senza numero; la conferma NON è bloccata.
- `settings.cancel_min_hours` assente (backend vecchio) → fallback client a 24h.
- Nessun cambiamento agli endpoint di mutazione né alla logica di dominio backend.

## Testing

- **Backend**: test che `GET /api/core/salon` includa `settings.cancel_min_hours` uguale a
  `CLIENT_MOVE_CANCEL_MIN_HOURS`.
- **Frontend (verifica manuale guidata, coerente col resto del progetto)**: via Playwright
  sul Chrome di sistema — login, aprire un appuntamento con caparra pagata, aprire il flow
  no-show e verificare la timeline (② "Caparra trattenuta €X", ③ orario slot, ④ conteggio);
  ripetere per una cancellazione anticipata (② "Caparra rimborsata") e per un appuntamento
  senza caparra (② "Nessuna caparra", attenuato). Screenshot di conferma.
- Casi limite da coprire nei costruttori: nessuna caparra; caparra pending vs paid;
  zero match in lista d'attesa.

## Fuori ambito (YAGNI)

- Nessun riepilogo animato post-conferma / stepper con avanzamento live.
- Nessun addebito su carta per no-show senza caparra (non esiste lato backend).
- Nessuna estensione ad altri flussi (spostamento, check-in) in questo intervento.
- Nessuna modifica all'app cliente.
