# Integrità dati e concorrenza — 6 alti, 9 medi, 5 bassi
Verifica migrazioni: `makemigrations --check --dry-run` risponde "No changes detected". Nessuna divergenza modelli/migrazioni.

## [L1] Il checkout riscrive l'appuntamento da copia vecchia e cancella la caparra incassata — ALTO
- Dove: apps/sales/api.py:131, 165-166
- Cosa: appointment.save() senza update_fields e senza rilettura riscrive TUTTE le colonne coi valori di inizio richiesta, compresi deposit_status, deposit_payment_intent_id, deposit_refunds, deposit_refunded_amount, deposit_due_at, start, note.
- Scenario: la cliente paga il link Stripe mentre la cassiera chiude il conto. Il webhook scrive paid + pi_xxx; il save riporta required e azzera l'intent. 30 EUR incassati su Stripe, deposit_deducted 0, nessun PaymentIntent da rimborsare.
- Fix: rileggere con select_for_update dentro la transazione della vendita e salvare solo ["status", "updated_at"].

## [L2] La modifica di un appuntamento lo resuscita se nel frattempo e stato annullato — ALTO
- Dove: apps/agenda/api.py:648-672. Il lock si prende solo se data.items e valorizzato, e non c'e mai la rilettura di _lock_and_reload (services.py:696-711).
- Scenario: A cambia la nota (niente lock), B annulla. A salva: status torna confirmed, cancel_reason si svuota, deposit_status torna paid. La visita annullata ricompare sopra lo slot gia rivenduto.

## [L3] Punti fedelta sommati in Python senza lock: punti persi e premi doppi — ALTO
- Dove: apps/marketing/services.py:234-238, 257-296
- Scenario: soglia 100, cliente a 90. Due casse chiudono due vendite da 20 punti: entrambe leggono 90, entrambe emettono il premio, entrambe scrivono 10. Al primo acquisto la create concorrente solleva IntegrityError dentro l'atomic di finalize_sale: 500 alla cassiera e vendita annullata per intero.
- Fix: select_for_update().get_or_create e incremento con F("points") sotto lock.

## [L4] Incassare una gift card due volte crea due vendite per lo stesso denaro — ALTO
- Dove: apps/marketing/api.py:249-272, apps/sales/services.py:266-290
- Cosa: ne transazione ne lock; la difesa e un SaleLine.exists() anch'esso leggi-poi-scrivi.
- Fix: transaction.atomic + GiftCard.objects.select_for_update().get(pk=...) prima del controllo.

## [L5] record_deposit_refund: i rimborsi si sovrascrivono a vicenda — ALTO
- Dove: apps/agenda/services.py:1199-1242
- Cosa: e atomic ma fa refresh_from_db() senza select_for_update, poi legge il dict deposit_refunds, aggiunge una voce e riscrive tutto il campo.
- Scenario: due rimborsi parziali da 15 su una caparra da 30 arrivano su due worker: il secondo commit cancella la voce del primo. deposit_refunded_amount resta 15 invece di 30 e al checkout si detraggono 15 EUR gia tornati alla cliente.
- Fix: Appointment.objects.select_for_update().get(pk=...) a inizio blocco atomico.

## [L6] import_event deduplica sul telefono grezzo, non su phone_key: clienti doppi — ALTO
- Dove: apps/integrations/sync.py:274-277
- Cosa: usa get_or_create(salon, phone=phone). L'identita del cliente e phone_key (clients/models.py:89, common/phone.py:64-112); il vincolo uniq_client_salon_phone e sulla stringa grezza. sync_clients costruisce correttamente l'indice normalizzato, import_event no.
- Scenario: in rubrica "348 221 0094"; arriva "+39 348 2210094" -> seconda scheda. L'appuntamento importato finisce sulla scheda nuova mentre il login OTP risolve per phone_key e restituisce la vecchia. Storico, affidabilita, fedelta e caparre si spaccano su due identita.
- Fix: usare common.phone.find_client_by_phone e creare solo se None; in prospettiva UniqueConstraint su (salon, phone_key).

## [L7] restore_released decide su stato letto prima del lock e salva l'intera riga — MEDIO
- Dove: apps/agenda/services.py:1428-1449
- Scenario: due operatrici cliccano "Ripristina" sullo stesso appuntamento: la seconda entra col suo snapshot, supera la validazione e riscrive tutta la riga. Secondo log, secondo emit_event appointment.created (doppia conferma alla cliente) e nuova scadenza caparra sopra quella appena scritta.

## [L8] Il login Yourang puo azzerare o duplicare yourang_org_id (nessun unique) — MEDIO
- Dove: apps/integrations/login.py:128-133, models.py:26 (solo db_index)
- Scenario A: login con identita senza claim org -> la riga diventa yourang_org_id=""; da li in poi il webhook non trova piu la connessione e scarta in silenzio ogni prenotazione.
- Scenario B: due exchange simultanee con la stessa org su saloni diversi superano il guard applicativo: gli eventi finiscono nel salone sbagliato.
- Fix: non sovrascrivere con stringa vuota, stesso guard di oauth_exchange, UniqueConstraint parziale su yourang_org_id.

## [L9] La scheda tecnica accetta un appointment_id di un altro salone — MEDIO
- Dove: apps/clients/api.py:603-612 (**data.dict() con appointment_id). L'endpoint gemello delle note usa _appointment_for(ctx, client, appointment_id), che valida entrambi.

## [L10] Il rate limit del form pubblico usa cache.get/set non atomico — MEDIO
- Dove: apps/clients/api.py:720-725. E la sequenza che common/ratelimit.py e stato scritto per eliminare; tutti gli altri endpoint pubblici usano ratelimit.hit.
- Scenario: 20 richieste parallele leggono tutte 0 e scrivono tutte 1: il contatore avanza di 1 invece di 20. Inoltre ogni set riporta la scadenza a un'ora piena.

## [L11] Storico cliente: due query in piu per ogni appuntamento — MEDIO
- Dove: apps/clients/api.py:285, 392-405; serializzatore agenda/api.py:181-184
- Cosa: _appointment_out senza gifts_by_client esegue gift_index per ogni appuntamento, e appointment.salon non e in select_related.
- Scenario: cliente con 250 visite -> ~500 query aggiuntive.

## [L12] "Clienti serviti": un'aggregazione per cliente, senza paginazione — MEDIO
- Dove: apps/staff/services.py:224-251; endpoint staff/api.py:364-367

## [L13] CASCADE su dati storici e contabili — MEDIO
- Dove: apps/agenda/models.py:58-60 (Appointment.client CASCADE), apps/inventory/models.py:118 (StockMovement.product CASCADE)
- Cosa: le API cancellano in modo morbido ma l'admin consente la cancellazione reale. Sale.client e SaleLine.product sono SET_NULL (la vendita sopravvive) mentre l'anagrafica storica collegata viene distrutta.
- Scenario: cancellando una cliente spariscono tutti i suoi Appointment e a cascata gli AppointmentService; le Sale restano con client NULL e i ricavi non tornano piu a nessuna visita.
- Fix: on_delete=PROTECT su entrambe.

## [L14] Lo stesso coupon si puo utilizzare due volte — MEDIO
- Dove: apps/marketing/api.py:142-158. Nessun lock di riga, nessun UPDATE ... WHERE status='active'.
- Fix: update(status=REDEEMED) filtrato su status=ACTIVE, 0 righe aggiornate -> 422.

## [L15] Client.since mai valorizzata: KPI "nuovi clienti" sempre 0 — MEDIO
- Dove: apps/insights/services.py:346-352; campo clients/models.py:75. Nessuna via di creazione la scrive.

## [L16] flush_outbox: claimed_at con l'ora di inizio lotto -> consegne doppie — BASSO
- Dove: apps/core/management/commands/flush_outbox.py:156-168, 180-199

## [L17] Riga gift card con qty>1: solo l'ultima carta collegata alla vendita — BASSO
- Dove: apps/sales/services.py:193-210. La difesa anti doppio conteggio di record_gift_card_cashed non scatta per le altre.

## [L18] N+1 staff: prefetch scartato da values_list, turni e assenze non precaricati — BASSO
- Dove: apps/staff/api.py:377-392 (values_list ignora la cache di prefetch), 70-71 e 137-155

## [L19] Marcatura "gift card scaduta" annullata dal rollback del checkout — BASSO
- Dove: apps/marketing/services.py:96-118. Dentro finalize_sale l'atomic interno e un savepoint.

## [L20] Creazione cliente: check-then-create non atomico, unicita su phone e non su phone_key — BASSO
- Dove: apps/clients/api.py:120-123 e 180-181, apps/accounts/api.py:477-487, apps/clients/api.py:728-745
- Scenario A: doppio invio del form -> IntegrityError non catturata -> 500 invece di "numero gia registrato".
- Scenario B: due numeri non normalizzabili ma equivalenti passano entrambi il controllo: due schede per lo stesso contatto.
