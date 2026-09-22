# Revisore 05 — cassa, vendite e Stripe

Probe lasciati (da cancellare a cura dell'orchestratore): `backend/apps/sales/tests_probe_05_vendite.py`, `backend/apps/sales/tests_probe_05_stripe_lib.py`; script node in `scratchpad/p05/`.

### [CRITICO] 05-01 Con stripe==15.6.1 ogni risposta Stripe esplode su `.get()`: webhook, link caparra, Connect e rimborsi rotti
- File: `backend/apps/sales/api.py:751-753` (event.get), `:791`, `:374`; `backend/apps/sales/stripe_service.py:115` (OAuth response.get), `:285` (session.get("id")); `backend/apps/sales/services.py:463-465`; `backend/apps/agenda/services.py:1636-1642`; `backend/apps/sales/api.py:685`; `backend/requirements.txt` (stripe==15.6.1)
- Stato: CONFERMATO (probe `tests_probe_05_stripe_lib` con libreria reale, solo HTTP finto: webhook firmato → 500 e caparra resta «richiesta»; `ensure_deposit_link` → AttributeError dopo aver creato la sessione su Stripe; `connect_exchange` → AttributeError dopo aver consumato il code; annullamento → rimborso eseguito da Stripe, poi AttributeError, caparra resta `refund_due`)
- Difetto: da stripe-python 12+ `StripeObject` non è un dict; il codice usa `.get()` su Event/Session/Refund/OAuthToken. I test passano solo perché mockano con dict.
- Scenario: la cliente paga il link → webhook 500 per 3 giorni, caparra mai registrata, con scadenza lo slot si libera e le arriva «caparra non versata»; «Invia link» → 500; «Collega Stripe» non si completa mai; annullare con caparra online → 500 e stato sbagliato.
- Correzione: usare accesso per chiave/attributo (`obj["id"]`, `getattr`) o `.to_dict()` subito dopo ogni chiamata Stripe e su `construct_event`; test con oggetti `stripe.*.construct_from`.

### [ALTO] 05-02 Un solo segreto di firma per il webhook: con Stripe Connect una delle due famiglie di eventi è sempre rifiutata
- File: `backend/apps/sales/stripe_service.py:483-497`, `backend/config/settings.py:272`, `DEPLOY.md:335`
- Stato: PLAUSIBILE (dipende dalla configurazione degli endpoint in produzione; su Stripe l'endpoint «account» e quello «Connect» hanno segreti distinti)
- Difetto: le caparre dei saloni collegati sono eventi Connect (sessione creata con `stripe_account`), quelle dei saloni non collegati eventi della piattaforma; `verify_webhook` accetta un solo `STRIPE_WEBHOOK_SECRET`.
- Scenario: salone collegato, cliente paga → evento con firma dell'endpoint Connect → 400 «Firma webhook non valida» → caparra mai pagata, slot liberato.
- Correzione: accettare più segreti (es. `STRIPE_WEBHOOK_SECRETS` / `STRIPE_CONNECT_WEBHOOK_SECRET`) e documentare i due endpoint.

### [MEDIO] 05-03 Storico vendite: «Incasso totale» conta due volte ogni caparra
- File: `backend/apps/sales/api.py:281-307`
- Stato: CONFERMATO (probe `HistoryKpiProbe`: servizio 100 con caparra 30 → revenue 130, count 2, items 2)
- Difetto: il KPI somma anche le vendite-caparra (`deposit_appointment`), mentre il checkout ha già il totale pieno; la correzione del 18/09 ha escluso le caparre solo in `today_summary` e insights. Le caparre compaiono come «Da banco» con riga «Servizio #».
- Correzione: escludere `deposit_appointment__isnull=False` da revenue/count/items (o esporle a parte).

### [MEDIO] 05-04 Una caparra rimborsata resta per sempre in `cash_in` / `deposit_cashed`
- File: `backend/apps/sales/services.py:479-521`, `backend/apps/insights/services.py:344-458`
- Stato: CONFERMATO (probe `RefundNotInCashProbe`: caparra 30 pagata, annullamento in tempo, rimborso riuscito → cash_in 30, deposit_cashed 30)
- Difetto: da quando la caparra è una vendita, nessun rimborso (annullamento, eccedenza, rimborso dalla dashboard) la storna.
- Correzione: registrare il rimborso come movimento negativo (o ridurre la vendita-caparra) in `record_deposit_refund`/`mark_deposit_refunded`.

### [MEDIO] 05-05 La vendita-caparra conta come visita e come spesa della cliente
- File: `backend/apps/clients/services.py:28-47` (usata da `compute_deposit`, automazioni, scheda cliente)
- Stato: CONFERMATO (probe `ClientStatsProbe`: dopo la sola caparra visits=1 e la regola rapida «Prima visita» non chiede più la caparra alla seconda prenotazione; dopo il checkout visits=2, spesa 120 per un servizio da 100)
- Difetto: `client_stats` esclude solo le vendite di sole gift card; `last_visit` diventa il giorno in cui è arrivata la caparra.
- Correzione: escludere `deposit_appointment__isnull=False` da visite, spesa e ultima visita.

### [MEDIO] 05-06 Dopo una riduzione della visita, rimborsare l'eccedenza segna «rimborsata» l'intera caparra e la cliente ripaga
- File: `backend/apps/agenda/services.py:1181-1218` (shrink abbassa `deposit_amount` sotto il pagato), `:1661-1735` (confronto con `deposit_amount`)
- Stato: CONFERMATO (probe `ShrinkThenRefundProbe`: caparra 50 pagata, visita scesa a 20, rimborso di 30 dalla dashboard → stato `refunded`, credit 0, checkout detrae 0 e incassa altri 20)
- Scenario: il registro dice «30 € da rimborsare», il titolare li rimborsa da Stripe → la cliente paga 50−30+20 = 40 per 20; annullando poi, i 20 non vengono restituiti.
- Correzione: confrontare i rimborsi con l'importo realmente incassato (non con la caparra ridotta) o registrare l'eccedenza come rimborso atteso.

### [MEDIO] 05-07 Caparra ridotta ma link vecchio: la cliente paga l'importo pieno e l'eccedenza sparisce
- File: `backend/apps/agenda/services.py:1181-1218`, `backend/apps/sales/api.py:631-658`
- Stato: CONFERMATO (probe `StaleLinkOverpaymentProbe`: link da 30, caparra scesa a 20, pagamento 30 → vendita-caparra 20, credit 20, nessun log sui 10 in più)
- Difetto: `shrink_deposit_to_total` non chiude/rifà il link; il webhook accetta `received > expected` in silenzio.
- Correzione: alla riduzione chiudere la sessione e rifare il link; nel webhook rimborsare o registrare l'eccedenza.

### [MEDIO] 05-08 «Torna indietro» su un appuntamento con caparra: link già spedito, sessione aperta, pagamento poi ignorato
- File: `backend/apps/agenda/undo.py:240-258`, `backend/apps/sales/api.py:509-515`
- Stato: CONFERMATO (probe `UndoCreateWithDepositProbe`: dopo l'undo l'evento `deposit.payment_link` resta `pending`, `Session.expire` mai chiamato, un pagamento sull'id cancellato non produce log, vendita né rimborso)
- Scenario: appuntamento creato per errore (o sull'orario sbagliato e rifatto): la cliente riceve comunque il link e se lo paga i soldi restano su Stripe senza traccia; se c'è un secondo link, quello vero resta non pagato e lo slot si libera.
- Correzione: nell'undo della creazione sopprimere l'evento del link e chiudere la sessione; nel webhook, appuntamento inesistente → rimborso + log.

### [MEDIO] 05-09 Arrotondamento diverso fra frontend e backend sulle righe scontate: vendita impossibile (422)
- File: `frontend/apps/dashboard/src/sections/pos/lib.js:4,44-48,77`, `backend/apps/sales/services.py:33-40,213`
- Stato: CONFERMATO (probe `RoundingProbe`: POS 9,50 + 10,50 con sconto 15% → frontend 16,99, backend 17,01 → 422; script `p05/round4.mjs`: al 15% sbaglia ~4,5% dei prezzi, al 10% ~2,4%)
- Difetto: float + `round2` contro Decimal HALF_UP; con due righe sfasate lo scarto è 2 cent > tolleranza 0,01, e il pannello pagamenti non permette di inserire l'importo del server.
- Correzione: calcolare gli importi in centesimi interi con half-up nel frontend (o farseli restituire dal server).

### [MEDIO] 05-10 Il link caparra scade dopo 24 h ma resta quello salvato: la cliente non può più pagare online
- File: `backend/apps/sales/stripe_service.py:272-276,313-334`, `frontend/apps/client-app/src/screens/lib.jsx:68`
- Stato: CONFERMATO (probe `LinkLifetimeProbe`: con scadenza «Mai» (default) nessun `expires_at`; `client/appointments/{id}/deposit-link` restituisce il link salvato senza rigenerarlo) — la chiusura a 24 h è il default Stripe
- Scenario: prenotazione fatta con giorni di anticipo, la cliente apre «Paga ora» il giorno dopo → pagina Stripe scaduta; stesso link nel sollecito.
- Correzione: salvare la scadenza della sessione e rigenerare il link se scaduto (anche nell'endpoint cliente).

### [MEDIO] 05-11 Link non creato (errore Stripe) ma scadenza della caparra fissata: lo slot si libera e la cliente riceve «caparra non versata»
- File: `backend/apps/agenda/services.py:1795-1823`, `backend/apps/agenda/api.py:218-228`
- Stato: CONFERMATO (probe `HoldWithoutLinkProbe`: Session.create fallisce, due_at impostato, dopo 21 min `released=1` ed evento `appointment.released_unpaid`)
- Scenario: account Connect non ancora attivato o errore di rete: ogni prenotazione con caparra si annulla da sola senza che la cliente abbia mai avuto il link.
- Correzione: fissare/mantenere la scadenza solo se il link esiste (azzerarla se la creazione fallisce).

### [MEDIO] 05-12 Dopo aver collegato/scollegato Stripe, rimborsi e chiusure dei link delle caparre già pagate vanno sull'account nuovo e falliscono
- File: `backend/apps/sales/stripe_service.py:42-45,288-304,436-480`
- Stato: CONFERMATO (probe `AccountSwitchProbe`: caparra pagata sulla piattaforma, poi collegamento → `Refund.create(..., stripe_account='acct_new')`, caparra `refund_due`)
- Difetto: l'account dell'intent (già firmato in `acct`) non viene salvato sull'appuntamento; si usa sempre l'account attuale. Il titolare non può rimborsare dal suo Stripe denaro che sta sulla piattaforma.
- Correzione: salvare l'account della caparra sull'appuntamento e usarlo per refund/expire.

### [BASSO] 05-13 Il link caparra sopravvive al rilascio e all'annullamento (C12 del 18/09 mai corretto)
- File: `backend/apps/sales/stripe_service.py:272-276`, `backend/apps/agenda/services.py:1545-1616,1881-1916`
- Stato: CONFERMATO (probe `LinkLifetimeProbe`: con scadenza 20 min — preset consigliato — nessun `expires_at`, la sessione resta pagabile 24 h)
- Scenario: pagamento dopo il rilascio → `refund_due` e rimborso, commissioni Stripe perse, cliente confusa.
- Correzione: `expire_deposit_checkout` in `release_for_unpaid_deposit` e `cancel_appointment`.

### [BASSO] 05-14 Lo stato della caparra dipende dall'ordine degli eventi di rimborso
- File: `backend/apps/agenda/services.py:1661-1735`, `backend/apps/agenda/models.py:144-157`
- Stato: CONFERMATO (probe `OutOfOrderRefundProbe`: `refund.updated` succeeded poi `refund.created` pending in ritardo → `refunding`, 0 €; probe `FloorThenFailedProbe`: `charge.refunded` poi fallimento → resta `refunded` con 0 € rimborsati)
- Difetto: uno stato non terminale sovrascrive uno terminale; il «pavimento» di `charge.refunded` non è salvato; con un rimborso parziale in corso `deposit_credit` diventa 0.
- Correzione: non retrocedere da succeeded/failed a pending; persistere il pavimento; credit = importo − (riusciti + in corso).

### [BASSO] 05-15 La cassa blocca il conto quando la caparra supera il dovuto, anche se il backend ora la tronca e rimborsa
- File: `frontend/apps/dashboard/src/sections/pos/modals/SellModal.jsx:152-153,310,471-475`
- Stato: CONFERMATO (lettura: `dueOk = due >= 0` disabilita «Incassa»)
- Scenario: caparra 30 su 50 e buono fedeltà da 25 (o servizio in omaggio) → «rimuovi qualche omaggio», il buono non si può usare.
- Correzione: con dovuto negativo inviare pagamenti vuoti e mostrare l'eccedenza che verrà restituita.

### [BASSO] 05-16 Riepilogo di cassa: «Incassato oggi» compare solo se ci sono gift card riscattate
- File: `frontend/apps/dashboard/src/sections/agenda/RightRail.jsx:87-91`
- Stato: CONFERMATO (lettura)
- Difetto: con caparre incassate o detratte oggi `cash_in` ≠ totale ma non viene mostrato; `deposit_cashed`/`deposit_used` mai visualizzati.
- Correzione: mostrare la riga quando `cash_in != total`.

### [BASSO] 05-17 Storico vendite: i servizi compaiono come «Servizio #12»
- File: `frontend/apps/dashboard/src/sections/pos/HistoryTab.jsx:203`, `backend/apps/sales/schemas.py:49-62`, `backend/apps/sales/api.py:64-79`
- Stato: CONFERMATO (lettura: `service_name` non esiste in `SaleLineOut`)
- Correzione: aggiungere `service_name` alla riga (select_related service).

### [BASSO] 05-18 Il buono sconto non si riflette sulle righe: il fatturato per operatrice supera l'incasso
- File: `backend/apps/sales/api.py:114-127,301-306`, `backend/apps/staff/services.py:258-300`
- Stato: CONFERMATO (probe `CouponOperatorRevenueProbe`: vendita 100 con buono 20 → storico 80, filtrato per operatrice 100, breakdown 100)
- Correzione: ripartire lo sconto sulle righe (o sottrarlo in proporzione nei totali per operatrice).

### [BASSO] 05-19 Fedeltà «per visita»: ogni gift card comprata al banco vale un timbro
- File: `backend/apps/marketing/services.py:247-262`
- Stato: CONFERMATO (probe `LoyaltyPerVisitProbe`: tre gift card da 5 € → 3 timbri)
- Difetto: per_euro esclude le gift card, per_visit no: timbri a basso costo e doppio conteggio (acquisto + visita pagata con la carta).
- Correzione: in per_visit/per_service ignorare le vendite di sole gift card.

### [BASSO] 05-20 Il checkout non prende `lock_salon`: una mutazione d'agenda concorrente riscrive lo stato di un conto chiuso
- File: `backend/apps/sales/api.py:159-208`, `backend/apps/agenda/services.py:805-820,1545-1616`, `backend/apps/agenda/undo.py:297-345`
- Stato: PLAUSIBILE (interleaving: annulla/no-show/check-in/undo rileggono prima del commit del checkout, poi l'UPDATE passa dopo)
- Scenario: cassa chiude mentre una collega annulla → appuntamento «annullato» con vendita, caparra già detratta rimborsata.
- Correzione: `lock_salon()` + rilettura anche nel checkout (o `select_for_update` nella rilettura di `_lock_and_reload`).

Aree controllate senza reperti: aritmetica Decimal di `line_amount`/coupon/caparra lato server (sconti 0–100, prezzo zero, qty ≤ 999, sconto e buono mai sopra il totale, caparra troncata al totale), gift card come pagamento (lock, saldo, scadenza, codice mancante) e righe gift card con qty > 1, coupon consumato con UPDATE condizionale dentro la transazione, doppio checkout (lock di riga + OneToOne), webhook ripetuti `payment_intent.succeeded`/`checkout.session.completed` (idempotenti), seconda caparra su link doppio (rimborsata), caparra pagata a conto chiuso o dopo annullamento (`refund_due`), isolamento fra saloni su righe/prodotti/operatrici/appuntamenti e metadati webhook (salon_id + token `acct` firmato), permessi `sales` su storico/dettaglio/checkout/POS/link, fuso Europe/Rome in `today_summary` e filtri data, scarico magazzino (lock prodotto, omaggi scalati), accredito fedeltà con lock e tetto premi, `record_gift_card_cashed` senza doppio conteggio, Stripe Connect OAuth (state firmato, solo titolare).
