# Motore prenotazioni (agenda/services.py) — 3 alti, 5 medi, 5 bassi

## [A1] Caparra pagabile solo via Stripe: senza pagamenti online l'appuntamento si auto-annulla — ALTO
- Dove: apps/agenda/services.py:1295 (schedule_deposit_hold), 1307 (clear_deposit_hold MAI chiamata), 1345 (process_deposit_holds)
- Cosa: schedule_deposit_hold fissa deposit_due_at per ogni appuntamento con caparra richiesta senza verificare che il salone possa incassare online. L'unico punto che scrive deposit_status=paid e il webhook Stripe (sales/api.py:507): non esiste nessun endpoint per registrare una caparra incassata in salone o in contanti. clear_deposit_hold non e invocata da nessuna parte (grep su tutto il repo: solo la definizione).
- Scenario: salone con DepositRule attiva e hold 60 min ma senza STRIPE_SECRET_KEY, o cliente che paga alla cassa. ensure_deposit_link esce con "" in silenzio (stripe_service.py:273), nessun link parte. Dopo 60 minuti release_for_unpaid_deposit mette CANCELLED e avvisa la cliente. OGNI prenotazione con caparra viene annullata da sola.
- Fix: non fissare deposit_due_at se i pagamenti non sono attivi; aggiungere un endpoint staff "caparra incassata" che chiama clear_deposit_hold.

## [A2] restore_released prende il lock ma non rilegge: save completo con copia stantia — ALTO
- Dove: apps/agenda/services.py:1427-1448
- Scenario: slot liberato alle 10:00; alle 10:02 la cliente paga e il webhook scrive refund_due + intent e avvia il rimborso. L'operatrice clicca Ripristina: il save riporta required e azzera l'intent. Il gestionale rimanda il link mentre Stripe ha gia rimborsato, e l'id del PaymentIntent e perso.
- Fix: lock -> refresh_from_db -> controllo, come _lock_and_reload; save(update_fields).

## [A3] PUT appuntamento salva tutto da copia pre-lock (nessun lock se cambia solo la nota) — ALTO
- Dove: apps/agenda/api.py:648 -> 672 (stesso di B1 e L2)

## [A4] La modifica ignora ItemEditIn.id e ri-prezza la visita col listino di oggi — MEDIO
- Dove: apps/agenda/services.py:756-769, 555-649, schemas.py:18
- Cosa: ItemEditIn dichiara id come "existing AppointmentService id" ma nessuno lo legge. La dashboard lo manda davvero (agenda/index.jsx:363, ApptDetailModal.jsx:141).
- Scenario: Taglio prenotato a 35, listino portato a 40; allungando il blocco il PUT riscrive price=40 su una visita concordata a 35, mentre la UI mostra ancora il totale vecchio.

## [A5] "La posa deve finire entro la chiusura" vale solo in creazione — MEDIO
- Dove: apps/agenda/services.py:447 chiamata solo a 551; manca in _validate_segments:652, move:839, split:927, restore:1427, resolve_items_edit:555
- Scenario: apertura 09-18, servizio 30' + 60' di posa. La creazione alle 17:30 da 409; lo spostamento dall'app passa e la cliente resta in salone fino alle 19:00.

## [A6] Lo split lascia l'intera caparra su una visita piu corta: checkout impossibile — MEDIO
- Dove: apps/agenda/services.py:961-983; stesso effetto dal PUT items
- Scenario: visita 100 EUR con caparra 50 pagata; si stacca il Colore. L'originale vale 30 con deposit_credit 50 -> finalize_sale pretende -20 -> 422 permanente. Non c'e modo di sbloccarlo (mark_deposit_refunded richiede refund_due).
- Fix: ridurre deposit_amount a min(deposit_amount, nuovo totale) registrando la differenza come da rimborsare.

## [A7] record_deposit_refund legge-modifica-scrive senza lock: rimborso perso — MEDIO
- Dove: apps/agenda/services.py:1199-1242 (refresh_from_db senza select_for_update)
- Scenario: Stripe consegna in parallelo charge.refunded e refund.updated per lo stesso rimborso; il secondo commit azzera deposit_refunds. Un successivo refund.updated failed non trova piu nulla da correggere.

## [A8] deposit_due_at non limitato a start: annullata una visita gia in corso — MEDIO
- Dove: apps/agenda/services.py:1295-1304, 1357-1388
- Scenario: hold 60 min, prenotazione alle 09:50 per le 10:00. Alle 10:50 la cliente e sotto le mani dell'operatrice ma nessuno ha premuto check-in: l'appuntamento viene annullato e le arriva "il tuo posto e stato liberato".
- Fix: min(now + hold, start) e saltare le righe con start <= now.

## [A9] _busy_map carica gli appuntamenti del giorno prima ma non le pause — BASSO
- Dove: apps/agenda/services.py:97-121
- Scenario: pausa 23:00-08:00 (PauseIn ammette 720 min). Il giorno dopo le 08:00 risultano libere.

## [A10] mark_deposit_refunded non aggiorna deposit_refunded_amount — BASSO
- Dove: apps/agenda/services.py:1266-1280. La scheda mostra "Caparra 30 - Rimborsato 0 - Stato: Rimborsata".

## [A11] Pause create/modificate fuori dal lock e senza validazione — BASSO
- Dove: apps/agenda/api.py:746-791. Entrano in _busy_map come blocchi hard ma sfuggono all'invariante del lock.

## [A12] DST: slot in un'ora inesistente, ore ripetute confuse — BASSO
- Dove: apps/agenda/services.py:44-51
- Scenario: ultima domenica di marzo, turno dalle 02:00: due slot con etichette diverse per lo stesso istante. In ottobre due appuntamenti alle 02:30 distanti un'ora risultano collidenti.

## [A13] Spostamento da app bloccato per sempre se l'operatrice e disattivata — BASSO
- Dove: apps/agenda/services.py:236-242, api.py:940-951
- Scenario: l'operatrice lascia il salone; le clienti con visita fissata con lei vedono "nessun orario disponibile" per qualunque giorno.

## Verificati e scartati
- Greedy dell'assegnazione in get_free_slots: completo.
- Catena oltre la mezzanotte: rifiutata da _within_windows.
- Semantica di deposit_reminder_minutes: coerente col modello.
- Isolamento multi-salone di resolve_items/split/move: corretto.
- N+1 nelle viste giorno/settimana/mese: prefetch adeguati.
