# Qualità dei test — 3 critici, 15 alti, 20 medi, 7 bassi (45)
La suite passa interamente (337 test). Questi sono i punti in cui da falsa sicurezza.

## [T1] Annullare dal salone trattiene la caparra della cliente e la marchia come inaffidabile — CRITICO
- Dove: agenda/tests.py:500; produzione agenda/services.py:1096-1108, api.py:861-864 e 1028-1033, clients/services.py:63-65
- Cosa: cancel_appointment calcola late = start - now < CLIENT_MOVE_CANCEL_MIN_HOURS senza guardare CHI annulla, e su late trattiene la caparra e scrive cancelled_late. Ma l'app cliente non puo annullare sotto le 24 ore: _client_policy_ok risponde 400 prima. Quindi late=True si verifica SOLO quando e il salone ad annullare.
- Scenario: l'operatrice si ammala, la reception annulla due ore prima. La cliente perde la caparra e si becca un cancelled_late che alimenta latecancel_count nelle regole caparra: le verra chiesta la caparra anche in futuro. Il test asserisce FORFEITED e cancelled_late su un annullamento senza attore, quindi blinda il difetto.
- Fix: passare a cancel_appointment chi annulla e applicare penale e cancelled_late solo all'annullamento della cliente.

## [T2] PUT appuntamento: salva la copia vecchia — CRITICO (stesso di B1, L2, A3)
- Dove: agenda/api.py:636-676; ConcurrentTransitionTests copre move e check_in, non il PUT.

## [T3] Il checkout non ha un solo test dei suoi controlli — CRITICO
- Dove: sales/api.py:127-186. L'unica chiamata a /api/sales/checkout in tutta la suite e in marketing/tests.py:444, percorso felice senza caparra.
- Scoperti: detrazione della caparra al netto dei rimborsi, rifiuto di appuntamento annullato o no-show, rifiuto del secondo incasso, ramo IntegrityError, e il save pieno dopo finalize_sale.
- Scenario: dopo un rimborso parziale di 10 su 30 si detraggono 30 che il salone non ha piu. test_deposit_deducted passa l'importo a mano: se il checkout usasse deposit_amount invece di deposit_credit resterebbe verde.

## Alti (15)
- T4 Il PUT cliente azzera consensi, affidabilita e is_active; il test che lo esegue guarda altro — clients/tests.py:432, api.py:156-157. Si corregge un cognome e sparisce la prova del consenso marketing: da li in poi la cliente e esclusa dalle campagne per sempre, in silenzio.
- T5 Gift card pagata subito: incasso mai in cassa, test con numeri sbagliati — marketing/tests.py:456 (stesso di E1)
- T6 update_product riscrive stock_qty con save pieno; creazione e modifica prodotto senza alcun test — inventory/api.py:64
- T7 import_event riscrive operatrice e stato a ogni webhook; i test contano solo le righe — integrations/tests.py:173
- T8 audience_type non validato: tutto cio che non e "labels" viene letto come lista di id cliente — marketing/api.py:394. Un refuso manda la promozione a due persone a caso.
- T9 rebooking_rate conta l'appuntamento chiuso di oggi come futuro; il test crea quel caso e non lo asserisce — insights/tests.py:157
- T10 laneCss: tre assert su sottostringhe presenti in entrambe le corsie; il test passa anche se la posizione viene ignorata — dashboard/test/lanes.test.js:72
- T11 Nessun test asserisce mai un 403: /day, /week, /range, /margin, /today-summary e il dettaglio vendita si leggono senza permesso d'area — agenda/api.py:262
- T12 Lista d'attesa: zero test in tutta la suite, compreso l'abbinamento in free_slot_event — agenda/services.py:1461
- T13 Scadenza OTP mai testata: nessun test sposta l'orologio — accounts/services.py:101
- T14 token_version (uscita forzata al cambio password) mai testato — accounts/api.py:223
- T15 Rotta webhook Yourang senza test: coperta solo la verifica della firma — integrations/api.py:183
- T16 Guardia anti account-takeover del login Yourang mai eseguita — integrations/login.py:46
- T17 YourangClient._request mockato ovunque: URL e header di organizzazione mai verificati — integrations/tests.py:109
- T18 Il 409 "automazione disattivata" senza test: spegnerla potrebbe non fermarla — automations/api.py:196

## Medi (20)
- T19 Chiusura del centro verificata solo in creazione — agenda/services.py:652
- T20 Pause a cavallo di mezzanotte non bloccano il giorno dopo; assert debolissimo — agenda/services.py:119
- T21 _merge_windows puo inghiottire la pausa pranzo; righe di turno sovrapposte accettate — staff/services.py:70
- T22 I test turni si seminano la fixture con _week_index, la funzione che verificano — staff/tests.py:200
- T23 shift_windows mockata: nessun test dell'agenda vede un'assenza — agenda/tests.py:76
- T24 Margine appuntamento: solo assertIn("margin") — agenda/tests.py:760
- T25 restore_released non rilegge dopo il lock — agenda/services.py:1446
- T26 Coupon mai validati ne applicati in cassa: validate_coupon non ha chiamanti — marketing/services.py:302
- T27 revenue_series e revenue_by_category asseriti su dataset vuoto — insights/tests.py:104
- T28 Test "concorrenza" su receive_order puramente sequenziale — inventory/tests.py:243
- T29 Catalog e inventory senza richieste HTTP: /categories/reorder risponde 405 in produzione e il test e verde — catalog/api.py:107
- T30 client_stats mai su dati veri, conta le gift card come visite — clients/services.py:14
- T31 Rate limit dell'hook pubblico sulla cache non atomica — clients/api.py:720
- T32 Un GET pubblico non autenticato crea righe SalonSettings — core/api.py:358
- T33 create_sheet accetta appointment_id di un altro salone — clients/api.py:603
- T34 nowMinutes: assert vacuo e suite nel fuso della macchina (che coincide col fuso salone) — shared/test/format.test.js:59
- T35 fmtEur senza test: i prezzi perdono i centesimi — shared/src/format.js:4
- T36 by-phone: percent-encoding del + non verificato — integrations/tests.py:137
- T37 Automazioni: event non validato, catalogo slegato dal modello — automations/api.py:92
- T38 Nessun percorso di revoca del consenso marketing (GDPR art. 7.3) — marketing/services.py:321

## Bassi (7)
- T39 test_public_availability_no_auth: lista sempre vuota — agenda/tests.py:770
- T40 Caparra: hold 20 / reminder 10 rende indistinguibili due formule — agenda/tests.py:1101
- T41 Due asserzioni tautologiche in core — core/tests.py:165, 294
- T42 assertGreaterEqual(age, 30) non vede l'off-by-one sul compleanno — clients/tests.py:437
- T43 update_category di catalog azzera il colore — catalog/api.py:74
- T44 cache.clear() non azzera il rate limiter (ora su tabella) — accounts/tests.py:224
- T45 list_client_appointments aggira l'invariante dichiarata dai test — clients/api.py:266

## Verificati e scartati
- serviceBands e altezza del blocco settimana: proporzioni corrette.
- Assenze parziali: il modello ha solo date_from/date_to, le mezze giornate non esistono.
- test_line_amount_helper corretto con ROUND_HALF_UP, non ricalcolato con la formula di produzione.
- charge_full_amount: l'importo in centesimi e verificato da NoShowAmountTests.
