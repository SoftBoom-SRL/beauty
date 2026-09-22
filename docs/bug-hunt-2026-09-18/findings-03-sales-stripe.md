# Vendite / Stripe / caparre — 3 alti, 6 medi, 5 bassi

## [C1] Caparra pagata dopo il checkout: incasso doppio, nessun rimborso — ALTO
- Dove: apps/sales/api.py:453 (e 484), 140-166
- Cosa: _payment_intent_succeeded intercetta solo cancelled e no_show. Un appuntamento gia closed passa il controllo e la caparra diventa paid. Il checkout non chiama expire_deposit_checkout: il link resta pagabile dopo la cassa.
- Scenario: caparra 30 non pagata online, cliente salda 100 in salone, poi apre il link e paga 30. Salone incassa 130 per un conto da 100, nessun rimborso, nessun avviso.
- Fix: trattare closed/esistenza Sale come il ramo cancellato (refund_due + settle_deposit_refund); chiamare expire_deposit_checkout alla chiusura.

## [C2] Collegare/scollegare Stripe Connect fa ignorare le caparre in volo — ALTO
- Dove: apps/sales/api.py:423-431
- Cosa: confronto con l'account ATTUALE del salone, mentre il PaymentIntent e nato sull'account di allora. Dopo un collegamento i pagamenti dei link aperti sono scartati con deposit.payment_ignored.
- Scenario: link creato senza Connect, titolare collega Stripe, cliente paga: evento scartato, caparra resta required, lo slot puo essere liberato, i 30 EUR restano sulla piattaforma senza riconciliazione ne rimborso.
- Fix: memorizzare sull'appuntamento l'account usato per l'intent e accettarlo; comunque rimborsare invece di ignorare.

## [C3] Caparra superiore al conto finale: checkout impossibile — ALTO
- Dove: apps/sales/services.py:157-161, api.py:145, schemas.py:31
- Cosa: finalize_sale pretende sum(payments) == total - deposit_deducted, pagamenti ge=0. Se la caparra supera il venduto il dovuto e negativo: 422 permanente, nessun flusso restituisce la differenza.
- Scenario: prenotazione 100 con caparra 50, servizio ridotto (PUT agenda non ricalcola il deposito, agenda/api.py:643), conto reale 20 -> -30 -> "I pagamenti non corrispondono" per sempre. SellModal.jsx:138 disabilita pure il pulsante.
- Fix: detrarre solo fino a total e registrare l'eccedenza come rimborso dovuto.

## [C4] Webhook caparra senza lock: due pagamenti restano entrambi incassati — MEDIO
- Dove: apps/sales/api.py:416-452
- Cosa: _refund_duplicate_deposit si basa su stato letto senza lock e fuori transazione. Due consegne concorrenti vedono required e scrivono paid.
- Fix: transaction.atomic + select_for_update sull'appuntamento, rileggere dentro il lock.

## [C5] L'addebito no-show ignora i rimborsi parziali della caparra — MEDIO
- Dove: apps/sales/stripe_service.py:316-325
- Cosa: sottrae l'intera deposit_amount anche se parte e gia stata rimborsata (deposit_refunded_amount).
- Scenario: caparra 30 con 10 rimborsati, poi no-show su visita da 100: addebita 70 mentre in cassa restano 20. Salone perde 10.
- Fix: max(deposit_amount - deposit_refunded_amount, 0).

## [C6] Addebito no-show e caparra trattenuta non diventano mai una vendita — MEDIO
- Dove: apps/sales/api.py:281-301, services.py:254-290
- Cosa: charge_no_show incassa su Stripe ma scrive solo una riga di registro. Sale/Payment nascono solo da finalize_sale e record_gift_card_cashed.
- Scenario: no-show da 80 EUR addebitato: riepilogo di giornata e KPI restano a 0.
- Fix: creare Sale + Payment(card) per addebito no-show e caparra trattenuta.

## [C7] cash_in sottrae caparre mai entrate in nessun giorno — MEDIO
- Dove: apps/sales/services.py:293-327, insights/services.py:312,369
- Cosa: il commento dice "gia incassato in un altro giorno" ma nessun percorso la registra come incasso.
- Scenario: giorno 1 caparra 30 -> 0; giorno 2 checkout 100 con deposit_deducted 30 -> cash_in 70. Totale 70 contro 100 reali.
- Fix: registrare l'incasso il giorno in cui arriva, oppure non sottrarre deposit_used.

## [C8] KPI storico: filtrando per operatrice il fatturato conta le vendite intere — MEDIO
- Dove: apps/sales/api.py:242-258
- Scenario: vendita 100 con 20 di Giulia e 80 di Anna; filtrando Giulia HistoryTab.jsx:103 mostra 100.
- Fix: aggregare su SaleLine.amount filtrato per operatrice.

## [C9] Il checkout riscrive l'intero appuntamento e puo cancellare la caparra — MEDIO
- Dove: apps/sales/api.py:165-166
- Cosa: appointment.save() senza update_fields ne lock, fuori dalla transazione.
- Scenario: la cliente paga il link mentre la cassiera conferma: il save riporta deposit_status a required e azzera deposit_payment_intent_id. Caparra non piu rimborsabile.
- Fix: save(update_fields=[...]) dentro la transazione.

## [C10] limit/offset negativi sullo storico vendite -> 500 — BASSO
- Dove: apps/sales/api.py:223-224, 250
- Fix: Query(50, ge=1, le=200) e Query(0, ge=0).

## [C11] Il dettaglio vendita non richiede il permesso sales — BASSO
- Dove: apps/sales/api.py:267-270
- Scenario: operatrice senza scope sales legge lo scontrino intero con GET /api/sales/12 mentre GET /api/sales/ da 403.
- Fix: require_scope(ctx, "sales").

## [C12] Lo slot rilasciato per caparra non pagata lascia vivo il link — BASSO
- Dove: apps/agenda/services.py:1315-1342; stripe_service.py:230-234
- Scenario: hold 20 min, slot liberato, la cliente paga dopo: soldi entrati e poi rimborsati, commissioni Stripe perse ogni volta.
- Fix: expire_deposit_checkout nel rilascio automatico e in cancel_appointment.

## [C13] Idempotency key no-show blocca il ritentativo per 24 h — BASSO
- Dove: apps/sales/stripe_service.py:357-372
- Fix: includere un contatore di tentativi o il payment_method nella chiave.

## [C14] Riga gift card con qty>1: solo l'ultima carta resta legata alla vendita — BASSO
- Dove: apps/sales/services.py:193-210, 266
- Scenario: qty=3 is_gift=true -> due carte scollegate; incassandole da Fedelta si creano vendite del loro valore pieno (ricavi mai entrati).
- Fix: una SaleLine per carta.

## Verificati e scartati
- Firma webhook obbligatoria e corretta (503 senza secret).
- Isolamento fra saloni su righe/servizi/prodotti/operatrici e gift card: corretto.
- Aritmetica: tutto Decimal, nessun float, line_amount quantizza HALF_UP.
- Doppio checkout concorrente: coperto da OneToOne + except IntegrityError.
- Rimborsi parziali/pending/falliti: record_deposit_refund idempotente per id rimborso.
- _charge_refunded non verifica salone ma richiede match esatto su deposit_payment_intent_id: rischio trascurabile.
