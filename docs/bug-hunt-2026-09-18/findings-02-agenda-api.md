# Agenda API — 1 alto, 4 medi, 8 bassi. Migrazioni allineate (makemigrations --check: No changes detected)

## [B1] PUT appuntamento: save() completo su copia stale -> caparra pagata torna "richiesta", slot liberato — ALTO
- Dove: apps/agenda/api.py:648-672
- Cosa: letto fuori transazione e fuori lock, controllo stato sulla copia, poi save() completo. _lock_and_reload (services.py:697-712) e update_fields esistono proprio per questo; qui nessuno dei due. lock_salon solo se data.items valorizzato.
- Scenario: mentre si salva una nota, il webhook Stripe scrive deposit_status=paid + intent. Il save riporta required, rimette deposit_due_at, azzera l'intent. process_deposit_holds poi annulla l'appuntamento di chi HA pagato, e senza intent il rimborso non e piu possibile. Con annullamento concorrente lo status riscritto resuscita un cancelled.
- Fix: _lock_and_reload dentro atomic + save(update_fields=[...]).

## [B2] Modifica servizi: prezzo e posa riscritti dal listino di oggi — MEDIO
- Dove: apps/agenda/api.py:669-670, services.py:757-770
- Cosa: AppointmentService e uno snapshot (models.py:161-163). La PUT cancella tutti gli item e li ricrea con price/soak dal listino corrente. ItemEditIn.id accettato e ignorato.
- Scenario: visita prenotata a 30, listino portato a 45; allungare il taglio di 10 min -> la visita vale 45 e la caparra copre un'altra percentuale.
- Fix: riusare prezzo e posa dell'item esistente quando id e valorizzato.

## [B3] Ripristino slot liberato: resta il link Stripe gia scaduto — MEDIO
- Dove: apps/agenda/api.py:588-596, 213-223; stripe_service.py:229-232, 291
- Scenario: slot liberato alle 18:00 e ripristinato alle 18:10; la cliente apre il link e trova la pagina scaduta, non puo pagare, lo slot si libera di nuovo.
- Fix: azzerare link e session id in restore_released, o ensure_deposit_link(resend=True).

## [B4] Gli eventi deposit.* non entrano nel feed live — MEDIO
- Dove: apps/core/views.py:66-72 (LIVE_FEED_PREFIXES), core/api.py:276-281
- Cosa: l'elenco ha appointment./pause./waitlist./slot./sale. ma non deposit.
- Scenario: la cliente paga la caparra, le postazioni aperte continuano a mostrare "caparra richiesta" col conto alla rovescia fino a un evento estraneo o a un ricaricamento.
- Fix: aggiungere "deposit." e il corrispondente regex nel frontend.

## [B5] Il vincolo "non finire dopo la chiusura" esiste solo in creazione — MEDIO
- Dove: apps/agenda/api.py:654-672 e 1012-1024; _ensure_within_opening (services.py:448-464) chiamato solo da resolve_items
- Scenario: colore 40' + 45' di posa, chiusura 19:00. Alle 18:20 la creazione da 409, ma spostando dall'app cliente passa: si resta in salone fino alle 19:45.
- Fix: chiamare _ensure_within_opening anche in resolve_items_edit, move_appointment, split_appointment.

## [B6] start senza fuso -> 500 invece di errore di validazione — BASSO
- Dove: apps/agenda/api.py:520-541, 544-575, 746-768, 993-1024
- Fix: validatore condiviso che rifiuta o rende aware i datetime naive.

## [B7] Testi oltre 255 caratteri (motivo annullamento, nota pausa) -> 500 da Postgres — BASSO
- Dove: apps/agenda/api.py:615-632, 746-791. Su SQLite passa: i test non lo vedono.
- Fix: Field(max_length=255).

## [B8] Nessun tetto al numero di servizi nella POST — BASSO
- Dove: apps/agenda/api.py:66 vs 520-539
- Scenario: POST con 100.000 item e force=true -> 200.000 query e 100.000 INSERT col lock di scrittura in mano.
- Fix: max_length=MAX_ITEMS_PER_REQUEST sugli schemi.

## [B9] GET /agenda/pauses senza data restituisce tutte le pause, senza paginazione — BASSO
- Dove: apps/agenda/api.py:735-743

## [B10] La modifica dei servizi non emette nessun evento outbox — BASSO
- Dove: apps/agenda/api.py:674-681. Creazione/spostamento/stacco/annullamento lo fanno.
- Scenario: si aggiunge un servizio, la fine cambia di 45 min, ma il promemoria WhatsApp conserva la durata vecchia.

## [B11] client_delete_waitlist senza log ne evento — BASSO
- Dove: apps/agenda/api.py:1086-1091

## [B12] Admin appuntamenti: N+1 e select con tutti i clienti di tutti i saloni — BASSO
- Dove: apps/agenda/admin.py:12-30

## [B13] /agenda/range accetta 43 giorni invece di 42 — BASSO
- Dove: apps/agenda/api.py:434 (.days > 42 con ciclo inclusivo)
