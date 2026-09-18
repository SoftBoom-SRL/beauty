# Marketing / fedeltà / gift card — 1 critico, 2 alti, 7 medi, 4 bassi

## [E1] Gift card «pagata ora» non registra nessun incasso — CRITICO
- Dove: backend/apps/marketing/api.py:224-246 (create_gift_card_staff) vs api.py:264-272
- Cosa: mark_gift_card_paid chiama record_gift_card_cashed; il percorso "vendo e segno pagata subito" (default in GiftCardModal.jsx:37, paid=true) no. Nasce GiftCard payment_status=paid senza Sale/SaleLine/Payment.
- Scenario: carta 40 EUR pagata dalla sezione Fedelta -> nessuna vendita a registro. Quando la cliente la spende: revenue +40, gift_card_redeemed +40, cash_in=0. I 40 EUR non compaiono mai. Cristallizzato dal test tests.py:398-465 (cash_in == 0.00). Non recuperabile: mark_gift_card_paid da 422 "gia pagata".
- Fix: in create_gift_card_staff, se data.paid chiamare record_gift_card_cashed(...). La guardia SaleLine.exists() protegge dal doppio conteggio.

## [E2] Punti fedeltà senza lock: punti persi, premio doppio, vendita persa — ALTO
- Dove: backend/apps/marketing/services.py:234-238, 257-296 (accrue_loyalty)
- Cosa: LoyaltyAccount letto con .filter().first(), somma in Python, save(update_fields). Nessun select_for_update né F().
- Scenario: 95 punti, soglia 100, due incassi paralleli da 10 -> entrambi leggono 95, entrambi emettono premio, saldo 5 invece di 15. Se l'account non esiste: doppio create -> IntegrityError su uq_loyalty_program_client dentro l'atomic di finalize_sale -> 500 e vendita annullata.
- Fix: select_for_update dentro la transazione + get_or_create con retry.

## [E3] Comunicazione programmata rinviabile all'infinito e non annullabile — ALTO
- Dove: backend/apps/marketing/api.py:441-448, 425-438, 405-422; services.py:359
- Cosa: il send blocca solo status==SENT. Una SCHEDULED resta rinviabile e ogni chiamata emette un nuovo OutboxEvent. flush_outbox usa Idempotency-Key outbox-<id>: eventi diversi, nessuna deduplica. Delete/update non toccano l'evento in coda.
- Scenario: riprogrammazione -> ogni cliente riceve il messaggio due volte. Eliminazione -> il messaggio parte comunque per una campagna che non esiste piu.
- Fix: rifiutare send se status != DRAFT, annullare l'OutboxEvent pendente su delete/update.

## [E4] mark-paid senza lock: due incassi per la stessa carta — MEDIO
- Dove: backend/apps/marketing/api.py:249-280 + apps/sales/services.py:266
- Scenario: doppio clic su "Segna come pagata" -> due Sale + due Payment da 50 EUR per una carta da 50.
- Fix: transaction.atomic + select_for_update, vincolo unique su SaleLine.gift_card.

## [E5] Wallet mostra come spendibili carte scadute e non pagate — MEDIO
- Dove: backend/apps/marketing/api.py:458-463 (client_wallet)
- Cosa: filtro solo su status=ACTIVE; EXPIRED si scrive solo dentro redeem_gift_card. Nessun filtro su payment_status. I coupon invece filtrano expires_at (api.py:470).
- Scenario: carta scaduta entra nel "Saldo totale" e la cassa poi rifiuta. Agenda coerente (gift_index filtra PAID) -> le due viste si contraddicono.
- Fix: filtrare expires_at e payment_status.

## [E6] KPI gift card contano carte mai pagate e premi fedeltà — MEDIO
- Dove: backend/apps/marketing/api.py:195-207
- Cosa: sold_total/outstanding non filtrano payment_status=PAID; includono i premi emessi da _issue_reward (paid=True, method=loyalty).
- Fix: filter=Q(payment_status=PAID), filtro scadenza su outstanding, separare i premi.

## [E7] Programma fedeltà accetta enum inventati e numeri fuori scala — MEDIO
- Dove: backend/apps/marketing/api.py:301-316, schemas.py:106-119
- Cosa: validato solo reward_type; type/earn_metric/enrollment/threshold/earn_ratio/points_expiry_months/color scritti tali e quali, save() senza full_clean().
- Scenario: earn_metric="per_euro " cade nel ramo per_service senza errore. enrollment errato -> nessuna iscrizione, punti fermi in silenzio. threshold=-1, points_expiry_months=99999, earn_ratio=1e12 -> 500. threshold=0 -> punti senza premi.
- Fix: validare contro le TextChoices, threshold>=1, tetti sui numerici, o full_clean().

## [E8] Nessun tetto ai premi emessi da una singola vendita — MEDIO
- Dove: backend/apps/marketing/services.py:258-295
- Scenario: earn_ratio=1000 per euro con soglia 10, incasso 100 EUR -> 10.000 premi, 30.000 insert, 10.000 eventi WhatsApp, con la transazione di cassa aperta.
- Fix: min(points//threshold, MAX_REWARDS_PER_SALE) e tetto su earn_ratio.

## [E9] App cliente crea gift card senza tetto né rate limit — MEDIO
- Dove: backend/apps/marketing/api.py:498-509, schemas.py:248-250
- Scenario: POST client/gift-cards value=99999999.99 -> carta da 100 milioni unpaid, entra nei KPI e nel wallet. In ciclo riempie la tabella.
- Fix: intervallo ragionevole, lunghezza recipient_name, ratelimit.hit.

## [E10] /gift-cards senza paginazione + N+1 su gift_service — MEDIO
- Dove: backend/apps/marketing/api.py:172-208, schemas.py:83-85
- Fix: select_related("gift_service") e @paginate.

## [E11] Marcatura EXPIRED persa dentro finalize_sale — BASSO
- Dove: backend/apps/marketing/services.py:96-118
- Cosa: l'atomic interno diventa savepoint dentro finalize_sale, l'HttpError annulla anche status=EXPIRED.
- Fix: scrittura fuori transazione o job periodico, filtrare expires_at in lettura.

## [E12] Valore coupon non validato (negativo, >100%, fuori scala) — BASSO
- Dove: backend/apps/marketing/api.py:76-123, schemas.py:15-19
- Scenario: kind=percent value=500 -> "Sconto del 500%" nel wallet.
- Fix: value>0, <=100 se percent, tetto compatibile con max_digits=10.

## [E13] «Invia subito» impossibile via API su comunicazione programmata — BASSO
- Dove: backend/apps/marketing/services.py:347
- Fix: distinguere campo assente da null esplicito in CommunicationSendIn.

## [E14] N+1 su accounts_count nell'elenco programmi — BASSO
- Dove: backend/apps/marketing/schemas.py:139-141
- Fix: annotate(Count("accounts")).

## Verificati e scartati
- Isolamento multi-salone: ok ovunque (salon_get/filter). Nessun IDOR.
- Codici: secrets.choice, 2^40 coupon / 2^60 gift card, nessun lookup pubblico.
- Doppio riscatto gift card concorrente: select_for_update regge fino al commit esterno.
- Punti doppi su acquisto gift card: righe gift_card sottratte correttamente.
- require_scope assente sulle GET: convenzione dell'intero progetto.
- Immagine comunicazioni pubblica: scelta esplicita (common/media.py:18).
