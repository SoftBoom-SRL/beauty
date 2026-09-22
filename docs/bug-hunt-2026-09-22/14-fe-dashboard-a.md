# Revisore 14 — dashboard: clienti, cassa, fedeltà, comunicazioni

Conteggio: 1 critico · 2 alti · 6 medi · 14 bassi (23). Rapporto breve: indagine interrotta su richiesta dell'orchestratore.
Probe lasciati sul disco (li rimuove l'orchestratore): `backend/apps/marketing/tests_probe_14.py`, `backend/apps/sales/tests_probe_14.py`, `backend/apps/clients/tests_probe_14.py`; script node in `scratchpad/p14/`.

### [CRITICO] 14-01 Tessera «A timbri» creata dalla dashboard: un timbro per ogni euro, premi a raffica
- File: `frontend/apps/dashboard/src/sections/fedelta/LoyaltySub.jsx:29-34` (blank: `earn_metric:'per_euro'`), `fedelta/modals/LoyaltyEditModal.jsx:99,109-118,33`; `backend/apps/marketing/services.py:247-262` (`_points_earned` ignora `type`)
- Stato: CONFERMATO (probe `apps.marketing.tests_probe_14`: visita da 45 € → 4 «piega omaggio» emesse, saldo 5 timbri)
- Difetto: scegliendo «A timbri» cambia solo `type`; il selettore della metrica è nascosto (`isPts`) e resta `per_euro`, che il server applica: 1 timbro per euro.
- Scenario: tessera «10 timbri = piega omaggio» → ogni scontrino emette floor(totale/10) gift card omaggio (fino a 10 per vendita) e altrettanti messaggi premio, per tutte le clienti.
- Correzione: con `type:'stamps'` forzare `earn_metric:'per_visit'` (o mostrare la metrica); lato server rifiutare stamps+per_euro.

### [ALTO] 14-02 Check-out impossibile quando la caparra supera il conto (la correzione C3 del server resta irraggiungibile)
- File: `frontend/apps/dashboard/src/sections/pos/modals/SellModal.jsx:152-153,175,310,471-475`; server `backend/apps/sales/services.py:196-202`, `sales/api.py:213-215`
- Stato: CONFERMATO (percorso + test backend `test_a_deposit_bigger_than_the_bill_is_capped_and_given_back`)
- Difetto: `dueOk = due >= 0` spegne «Incassa»; il server invece detrae fino al totale e rimborsa l'eccedenza.
- Scenario: servizio ridotto da 100 a 20 con caparra 50 (o buono 40 su 60 con caparra 30): pulsante spento, messaggio «rimuovi qualche omaggio», conto non chiudibile, eccedenza mai rimborsata.
- Correzione: consentire `due < 0` inviando pagamenti a 0 e mostrare «caparra eccedente da restituire».

### [ALTO] 14-03 La vendita-caparra è contata come visita, spesa e vendita da banco
- File: `backend/apps/clients/services.py:28-47` (client_stats), `backend/apps/sales/api.py:298` (list_sales), `backend/apps/clients/api.py:486` (client_history); visibile in `clienti/ClientProfile.jsx:250-258`, `clienti/tabs/StoricoTab.jsx:120-129`, `pos/HistoryTab.jsx:110-124`
- Stato: CONFERMATO (probe `apps.sales.tests_probe_14.DepositDoubleCountProbe`: servizio 100 + caparra 30 → visite 2, speso 130, incasso storico 130, 2 vendite)
- Difetto: le vendite con `deposit_appointment` non sono escluse (lo fanno solo today_summary e insights).
- Scenario: ogni cliente con caparra ha visite e «Valore totale» gonfiati, scontrino medio dimezzato, una finta «Vendita al banco» nello storico; le regole caparra (`client_facts.visits`) vedono visite mai fatte.
- Correzione: escludere `deposit_appointment__isnull=False` in client_stats, list_sales e dalle counter_sales.

### [MEDIO] 14-04 Carrello/check-out: arrotondamento in virgola mobile diverso dal server
- File: `frontend/apps/dashboard/src/sections/pos/lib.js:4,44-48,96-101`; `backend/apps/sales/services.py:33-40`
- Stato: CONFERMATO (probe `apps.sales.tests_probe_14.CartRoundingProbe`)
- Difetto: `round2(qty*prezzo*(1-d/100))` arrotonda per difetto i mezzi centesimi (18,90 −15% = 16,06 contro 16,07 del server).
- Scenario: due prodotti 18,90 e 9,50 con sconto vendita 15% → carrello 24,13, server 24,15 → 422 «I pagamenti non corrispondono al totale»; con una sola riga la vendita passa ma l'incasso registrato (16,06) differisce dal totale (16,07).
- Correzione: calcolare in centesimi interi con arrotondamento half-up come `line_amount`/`coupon_discount`.

### [MEDIO] 14-05 La scheda cliente rimanda i consensi letti all'apertura: annulla le revoche fatte dall'app
- File: `frontend/apps/dashboard/src/sections/clienti/helpers.js:42-62` (`consents` sempre nel corpo), `ClientProfile.jsx:43-45,72-88`, `modals/NewClientModal.jsx:67`
- Stato: CONFERMATO (probe `apps.clients.tests_probe_14`)
- Difetto: PUT a corpo completo con `consents` vecchio; il live ricarica solo su `client.updated|deleted` con payload (non `client.consent_updated`, non il form hook).
- Scenario: cliente revoca il marketing dall'app mentre la reception ha la scheda aperta; un clic su etichetta/lingua/«Rimuovi caparra» riporta `marketing: true` e cancella `marketing_revoked_at`.
- Correzione: inviare solo i campi cambiati (il PUT è già parziale) e non mandare mai `consents` fuori dalla scheda Consensi.

### [MEDIO] 14-06 Wallet: saldo fedeltà cercato scorrendo pagine ordinate per `-points` invece di `client_id`
- File: `frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx:24-36` (commento falso: il filtro esiste in `backend/apps/marketing/api.py:78-89`); `marketing/models.py:178`; stesso ordinamento in `fedelta/LoyaltyMembersDrawer.jsx:19`
- Stato: PLAUSIBILE (LIMIT/OFFSET su ordine non univoco in Postgres dà pagine sovrapposte/buchi; più punti che cambiano durante la scansione)
- Scenario: programma con centinaia di iscritte a pari punti → la cliente non cade in nessuna pagina → «Non ancora iscritta al programma»; nel drawer iscritte doppioni e mancanti.
- Correzione: `params: { client_id: c.id }`; ordinamento `["-points", "id"]`.

### [MEDIO] 14-07 Import CSV: la colonna indovinata dal contenuto ruba il campo a quella col titolo giusto
- File: `frontend/apps/dashboard/src/sections/clienti/modals/BulkImportModal.jsx:84,101-128` (dedup «primo che arriva»)
- Stato: CONFERMATO (script node `p14/t3.mjs`)
- Scenario: «Data inserimento» (gg/mm/aaaa) prima di «Cellulare» → le date diventano telefoni e «Cellulare» è ignorata; «Ultima visita» prima di «Data di nascita» → compleanni = ultime visite; «Codice» a 8 cifre → telefono.
- Correzione: assegnare prima i campi riconosciuti dal titolo, poi i suggerimenti per contenuto solo sui campi liberi; `looksPhone` escluda le date.

### [MEDIO] 14-08 Import da Excel italiano (Windows-1252): l'avviso sugli accenti è in un passo che si salta
- File: `BulkImportModal.jsx:238,240-243,357-364`
- Stato: CONFERMATO (percorso)
- Difetto: `readFile` passa subito al passo 2; codifica e avviso «accenti strani? prova Windows-1252» vivono solo nel passo 1.
- Scenario: CSV da Excel IT → nomi e note importati con «�» senza alcun avviso.
- Correzione: mostrare codifica e avviso anche nei passi 2/3, o rilevare la codifica automaticamente.

### [MEDIO] 14-09 Comunicazioni: «Salva» su una campagna programmata la riporta in bozza senza dirlo
- File: `frontend/apps/dashboard/src/sections/comunicazioni/ComEditModal.jsx:111-123,296-300`; `backend/apps/marketing/api.py:128-151`
- Stato: CONFERMATO (percorso fino a update_communication)
- Scenario: si corregge un refuso in una campagna programmata e si preme «Salva» (pulsante principale): invio annullato, stato «Bozza», la campagna non parte alla data; il campo «Programma invio» dell'editor non programma nulla.
- Correzione: su campagne programmate «Salva» deve riprogrammare (o avvisare), oppure unire salva+invia.

### [BASSO] 14-10 Esc sulla «Conferma pagamento» chiude tutto il check-out
- File: `frontend/apps/dashboard/src/ui/DkModal.jsx:13-18`, `pos/modals/SellModal.jsx:304,482`
- Stato: CONFERMATO (ordine dei listener su window: vince il modale principale, anche durante «Registrazione…»)
- Scenario: Esc sul dialogo di conferma → si perdono righe, buono e pagamento diviso composti.
- Correzione: gestire Esc solo nel modale più in alto (stack) e bloccare la chiusura mentre `saving`.

### [BASSO] 14-11 Storico vendite: le righe servizio si leggono «Servizio #12»
- File: `frontend/apps/dashboard/src/sections/pos/HistoryTab.jsx:201-203`; `backend/apps/sales/schemas.py:49-62` (niente `service_name`)
- Stato: CONFERMATO. La caparra appare come «Servizio #».
- Correzione: aggiungere `service_name` a SaleLineOut.

### [BASSO] 14-12 Buono applicato resta dopo cambio cliente o dopo aver tolto i prodotti
- File: `pos/CartTab.jsx:111-126,279,269,399`
- Stato: CONFERMATO (percorso)
- Scenario: buono di Anna, poi si cambia cliente o resta solo una gift card: «Buono applicato» ancora a video, la vendita è rifiutata al Conferma (422).
- Correzione: togliere/rivalidare il buono su cambio cliente e quando `couponBase` scende a 0.

### [BASSO] 14-13 Date lette sul fuso del dispositivo
- File: `clienti/tabs/StoricoTab.jsx:13,94-102` (`getDate()` su ISO), `fedelta/GiftSub.jsx:25-28`, `fedelta/CouponSub.jsx:78,138`, `fedelta/modals/CouponEditModal.jsx:28`, `fedelta/modals/GiftCardModal.jsx:10-15,190`, `fedelta/LoyaltyMembersDrawer.jsx:63`, `clienti/helpers.js:146-153`
- Stato: CONFERMATO (codice)
- Scenario: da un dispositivo su altro fuso le visite serali cambiano giorno, la scadenza coupon si salva alle 23:59 del dispositivo; «6 mesi» dal 31 agosto scade il 3 marzo (overflow di setMonth).
- Correzione: `salonDateParts`/`toDateStr(iso)`/`dateTimeLocalToIso` al posto dei metodi locali.

### [BASSO] 14-14 Consensi: nessuna data di raccolta o revoca dalla dashboard
- File: `clienti/tabs/ConsensiTab.jsx:13-16`, `modals/NewClientModal.jsx:73,194`
- Stato: CONFERMATO. La revoca lascia `marketing_at`, la concessione non scrive `privacy_at`/`marketing_at`, mentre la modale promette che la scheda Consensi «ne conserva la data».
- Correzione: scrivere `<flag>_at` / `marketing_revoked_at` come fa `client_set_marketing_consent`.

### [BASSO] 14-15 Import: telefoni impossibili accettati senza avviso; 29/02 non bisestile scarta la riga
- File: `BulkImportModal.jsx:133,167,182`; `backend/apps/clients/services.py:198-202`
- Stato: CONFERMATO (node `p14/t1.mjs`)
- Scenario: «348 221 0094 / 06 1234567» → 19 cifre; «3,93482E+11» di Excel → «393482+11»; «29/02/1991» riconosciuta ma il server rifiuta l'intera cliente.
- Correzione: validare con `isPlausiblePhone` e con il calendario reale dell'anno.

### [BASSO] 14-16 Import: «Cognome e nome» / «Nominativo» fusi o invertiti, invisibile in anteprima
- File: `BulkImportModal.jsx:76-83,119-122,191,434`
- Stato: CONFERMATO (node): «Cognome e nome» → tutto in `first_name`; «Nominativo» ROSSI MARIA → nome ROSSI; l'anteprima concatena e sembra giusta.
- Correzione: riconoscere «cognome e nome» come campo a sé e mostrare nome e cognome in colonne separate.

### [BASSO] 14-17 Import: «Riga N» è la riga dei dati, non quella del file
- File: `BulkImportModal.jsx:44,196,263-266,306,433`
- Stato: CONFERMATO. Intestazione e righe vuote scartate spostano il numero (J4 corretta a metà).

### [BASSO] 14-18 Import chiuso o fallito a metà: prosegue in background / riprova duplica le note
- File: `BulkImportModal.jsx:248-278,292,317` (X/Esc non bloccati durante `busy`); `backend/apps/clients/services.py:280-281`
- Stato: CONFERMATO (percorso). Dopo un errore al blocco k nessun riepilogo dei blocchi già entrati; rilanciando, con «aggiorna esistenti» ogni nota viene creata di nuovo.

### [BASSO] 14-19 Nuova cliente e creazione rapida: telefono non verificato
- File: `clienti/modals/NewClientModal.jsx:51`, `fedelta/ClientPicker.jsx:46`
- Stato: CONFERMATO (percorso fino a `canonical_phone`): «333» si salva come «+39333»; `isPlausiblePhone` usato solo nell'app cliente.

### [BASSO] 14-20 Wallet e KPI della scheda restano vecchi; errori mostrati come «nessun coupon»
- File: `clienti/tabs/WalletTab.jsx:45-72` (nessun useLive, `catch → []`), `ClientProfile.jsx:43-45`
- Stato: CONFERMATO (codice). Saldo gift card detto alla cliente dopo un riscatto a un'altra cassa è quello vecchio; un errore di rete appare come «Nessun coupon/gift card».

### [BASSO] 14-21 Wallet: premio «Sconto %» e «Gift card» mostrati come «Premio: 10.00»
- File: `clienti/tabs/WalletTab.jsx:75-84` (cerca 'percent'/'amount' in 'discount_pct'/'gift_card')
- Stato: CONFERMATO. Correzione: usare `composeReward` di `fedelta/meta.js`.

### [BASSO] 14-22 Selettori cliente di coupon, gift card e comunicazioni includono le schede archiviate
- File: `fedelta/ClientPicker.jsx:27`, `comunicazioni/ComEditModal.jsx:65` (manca `is_active: true`)
- Stato: CONFERMATO. Buono intestato al doppione archiviato → al banco «Coupon riservato a Maria Rossi» per la Maria Rossi attiva.

### [BASSO] 14-23 Compleanno: giorno 31 + cambio mese salva «--04-31»; togliere il mese non cancella
- File: `clienti/components.jsx:109-121`
- Stato: CONFERMATO (codice): il giorno sparisce a video ma resta nel valore → 400 al salvataggio; stato parziale non emesso → resta il compleanno vecchio.

### [BASSO] 14-24 Lista clienti: ogni evento client.* la svuota e torna ai primi 50, in cima
- File: `clienti/index.jsx:25,48-58`
- Stato: CONFERMATO. Con 4000 clienti chi scorre «Mostra altri» perde posizione a ogni salvataggio altrui (e proprio).

### [BASSO] 14-25 Storico cliente: caparra mostrata per intero dopo un rimborso parziale
- File: `clienti/tabs/StoricoTab.jsx:160` (`deposit_amount` invece di `deposit_credit`; niente per refund_due/refunding)
- Stato: CONFERMATO (codice).

Aree controllate senza reperti: doppio clic su Incassa/Conferma (guardia `saving` + React 18), payload POS/checkout rispetto a `SaleLineIn/PaymentIn`, detrazione `deposit_credit` e precompilato gift card, sconti riga/vendita ed esclusione gift card dal buono, reset del carrello dopo la vendita, biglietti anti-risposta-fuori-ordine (clienti, storico vendite, coupon, gift card, comunicazioni), coda delle PUT in ClientProfile (J5), parser CSV (virgolette, separatore dentro campo, BOM, CRLF, righe vuote, `;`/`,`), date gg/mm/aaaa, aaaa-mm-gg, `--MM-DD`, programmazione comunicazioni nel fuso del salone, invio subito con `scheduled_at: null`.
