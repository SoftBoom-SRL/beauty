# Stato delle correzioni — caccia ai bug del 22 settembre 2026

Aggiornato al 23/09/2026 sul ramo `claude/exciting-bohr-5ch9g7`, partito da `d147276` (il codice
revisionato, 754ed6b, più le correzioni del 21 settembre e le prime del 22).

**327 reperti (4 critici, 26 alti, 123 medi, 174 bassi): 327 FATTO, 0
PARZIALE, 0 NON FATTO.** Il rapporto unico ne contava 326: nella tabella del revisore 10
(sicurezza) manca uno dei suoi reperti bassi.

## Come si è lavorato

Quattordici aree, ognuna su un ramo `fix22/<area>` con file assegnati in esclusiva e 23 contratti API
scritti in anticipo fra le aree (C1–C23: per esempio `updated_at` / `expected_updated_at` → 412 sul
PUT dell'appuntamento, `spendable` sulle gift card del wallet, codici delle gift card mascherati a chi
non ha marketing o cassa). Poi l'unione dei quattordici rami, le richieste che un'area faceva a
un'altra già conclusa (fatte nell'integrazione) e una revisione finale di regressione sui contratti fra
frontend e backend, fatta da tre revisori sul codice unito.

Nella colonna «Correzione» c'è il commit che corregge il reperto, e fra parentesi il ramo, oppure
«integrazione» (correzioni fatte durante l'unione) o «prima del pool» (già in `d147276`).

## Verifiche finali

- Test: 1237 backend e 255 frontend verdi (il 22 erano 653 e 27), build di dashboard e
  app cliente verdi, `makemigrations --check` pulito.
- Revisione di regressione: tre revisori hanno controllato sul codice unito i 23 contratti, da tutti e
  due i lati (server e client), e le cuciture fra i rami: tutti rispettati. Hanno trovato sei difetti,
  corretti ciascuno con il suo test:
  - «Indietro» dopo aver ridotto una caparra ancora da pagare rimetteva l'importo ma non il link: la
    cliente pagava l'importo ridotto e alla scadenza perdeva il posto (`2b6dd3c`);
  - un rimborso in corso contato due volte al checkout, e un rimborso fallito che lasciava la caparra
    «rimborsata» con i soldi al salone (`fe8c005`);
  - link e sollecito della caparra fermi dietro ai messaggi trattenuti dell'appuntamento, fino a
    quaranta minuti mentre il termine per pagare correva (`0ce7b03`);
  - l'annullamento di una campagna programmata scadeva dopo dodici ore anche con la campagna fra
    qualche giorno (`e8fc422`);
  - il raggruppamento degli eventi live lanciava «Illegal invocation» nel browser, e nessuna vista si
    sarebbe più aggiornata da sola (`e1695d1`);
  - nei picker cliente l'avviso di una scheda archiviata restava dopo aver corretto il numero, e
    riattivava la scheda sbagliata (`9e246f5`).


## Da controllare in produzione (sono verifiche, non codice)

Tutti i passi sono in DEPLOY.md §9.4. In breve:

1. **Account demo**: se esiste `sole@theparlour.it` (superuser con password pubblicata), disattivarlo
   o togliergli staff e superuser e cambiargli la password; controllare gli accessi a `/admin/`. Mai
   `seed_demo` in produzione: ora con `DEBUG=0` si rifiuta di partire.
2. **Telefoni**: `check_phone_duplicates` prima del deploy e di nuovo dopo (la migrazione
   `clients.0008` ricalcola le chiavi con le regole nuove); bonificare a mano i gruppi che emergono.
3. **Stripe**: due endpoint webhook (account e Connect) con i loro segreti
   (`STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`) e gli eventi elencati nel §8.
4. **Job**: `flush_outbox --loop --interval 5` come worker sempre acceso, `sync_yourang` ogni ora,
   `process_deposit_holds` ogni 5 minuti.
5. **Database in UTF8** (`SHOW server_encoding;`) per la ricerca clienti senza accenti.
6. **Tessere a timbri**: `marketing.0004` è irreversibile; vedi §9.4 per il controllo prima del deploy.

## Aperti

Non sono reperti rimasti indietro: sono decisioni da prendere, verifiche che richiedono servizi esterni
e migliorie facoltative segnalate dai fixer.

- **Decisione di prodotto (da 13-02).** Lo staff non ha un «annullato per conto della cliente»: se la
  cliente disdice tardi per telefono, il salone non può trattenere la caparra, perché il no-show si
  segna solo dopo l'inizio della visita. Serve decidere la regola lato server (la semantica esiste già
  per l'annullamento dall'app: tardivo → caparra trattenuta).
- **Prenotazione dall'app ripetuta (resto di 16-08).** La seconda prova riconosce ora la prenotazione
  già fatta; resta scoperto il caso del primo invio ancora in volo, che chiuderebbe solo una chiave di
  idempotenza nella richiesta di creazione.
- **Rimborsi Stripe, da provare in modalità test.** Non si è potuto verificare se `amount_refunded`
  della Charge conti anche i rimborsi ancora in corso. Il calcolo ora è giusto in tutti e due i casi,
  purché l'endpoint riceva anche `refund.created`, `refund.updated` e `refund.failed` (DEPLOY.md §8):
  provare un rimborso parziale che resta «pending» e uno che fallisce.
- **Yourang, da concordare.** Deve gestire gli eventi nuovi `communication.cancel` e
  `client.marketing_consent`, altrimenti gli invii già consegnati partono comunque. Il proxy deve
  rimandare intatta la query del `return_to` (mode e state, circa 200 caratteri): da provare in
  staging. La sincronizzazione presume sul proxy la rotta `GET /contacts/{id}`.
- **Preesistente, fuori dai reperti.** Un utente nato da un'identità Yourang con email non verificata
  non riesce a rientrare (`_get_or_create_user` rifiuta l'account esistente).
- **Facoltativi non fatti.** `undo_id` nelle risposte di sposta, stacca e pausa (oggi la dashboard lo
  ricava rileggendo `GET /undo`); le finestre di turno in `/api/agenda/week`; tolleranza a orari
  malformati salvati a database nel modulo staff.


## Correzioni fatte nell'integrazione

- `0ce7b03` Outbox: link e sollecito della caparra non aspettano i messaggi solo trattenuti
- `e8fc422` Comunicazioni: l'annullamento di una campagna vale fino alla sua data
- `9e246f5` Picker cliente: correggendo il numero sparisce l'avviso della scheda archiviata
- `fe8c005` Caparra: un rimborso in corso non si sottrae due volte, uno fallito rimette i soldi in cassa
- `2b6dd3c` Indietro: la caparra che torna all'importo di prima ha un link con quell'importo
- `e1695d1` Feed live: i timer del debounce chiamati come funzioni, non come metodi
- `7a543b5` Test frontend: il sostituto di @youty/shared esporta anche le regole del telefono
- `d1620c4` Gift card: «In regalo da» solo se l'ha comprata qualcun altro
- `a0ab544` Dashboard: eventi live non persi nel debounce, schede archiviate anche dai picker
- `bb01e30` Test: una prenotazione Yourang passa a una collega dalla dashboard
- `ba7b6e7` Consegna messaggi: programmati e scaduti contati a parte
- `38d0062` Documentazione: niente password demo, deploy di fine settembre, contratti nuovi
- `f4dc994` Feed live: etichette anche a marketing, regole caparra al titolare
- `5e8a5f2` Messaggi in ordine per oggetto, lock del magazzino e codici mascherati nella scheda
- `a8cbd2f` Indietro: l'evento dice quali visite ha toccato
- `5f1666d` Agenda: il pannello aperto non si rimonta e tiene le modifiche non salvate
- `d008209` Caparra: la cassa detrae quello che il salone ha ancora, anche con un rimborso in corso
- `3aa7cc1` Test caparra in agenda: il finto Stripe con la sessione nuova
- `d845054` Migrazioni core: la 0011 dell'outbox segue la 0010 del salone demo


## 01 — Motore disponibilità

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 01-01 | alto | Forzando con «Prima disponibile» la visita va alla prima operatrice idonea anche se è occupata e una collega è libera | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-02 | medio | Stessa cliente + «Prima disponibile»: il servizio finisce sull'operatrice già impegnata con lei, mentre la ricerca proponeva la collega libera | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-03 | medio | Il ripiego «cerca fra le altre idonee» (correzione A13) propone orari che la conferma rifiuta | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-04 | medio | «Consigliati» (agenda_fill=max_revenue, default) ignora la posa: nasconde l'orario perfetto e consiglia quello che lascia un buco morto | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-05 | medio | «Riprogramma» dello staff cerca con il listino di oggi e contando la visita stessa come occupata | FATTO | `8d34f0b` (ag-disp), `45b2104` (fe-modali) |
| 01-06 | medio | Le visite di un'operatrice disattivata non si riassegnano: trascinamento e «Passa a» → 404, modifica → 400 | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp), `bb01e30` (integrazione), `1e47625b` (prima del pool) |
| 01-07 | medio | Caparra chiesta su un trattamento già pagato con gift card | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 01-08 | basso | La posa può finire nella chiusura di pranzo (orari spezzati) e, senza orari configurati, oltre il turno | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-09 | basso | Prenotazioni importate da Yourang non si allungano né si riassegnano (segnaposto senza operatrici idonee) | FATTO | `ce4689b` (integrazioni) |
| 01-10 | basso | Spostamento dall'app impossibile se l'operatrice della visita ha perso quel servizio fra le competenze | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 01-11 | basso | La conferma dall'app è più larga della ricerca: con operatrice scelta (e in ogni spostamento) si entra nella posa altrui | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp), `e097b0b` (ag-life) |
| 01-12 | basso | Il PUT non conosce client_overlap_ok: allungare un servizio sovrapposto alla stessa cliente marca la visita «forzata» | FATTO | `5478c5d` (ag-disp), `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 01-13 | basso | Regole caparra per etichetta legate al NOME: rinominare l'etichetta spegne la regola in silenzio | FATTO | `0487e86` (clienti) |
| 01-14 | basso | `duration_min` senza tetto nel PUT: un refuso passa forzando da solo e blocca il giorno dopo | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp) |

## 02 — Ciclo di vita dell'appuntamento

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 02-01 | alto | Riducendo la caparra alla nuova visita si perde quanto la cliente ha versato | FATTO | `11dbbac` (ag-caparra) |
| 02-02 | alto | Staccare un servizio fa slittare gli altri della visita (l'anteprima dice di no) e col 409→force li mette sopra un'altra cliente | FATTO | `1e47625b` (prima del pool) |
| 02-03 | alto | «Torna indietro» cancella anche il messaggio di uno spostamento precedente fuso nello stesso evento | FATTO | `82b881e` (ag-life) |
| 02-04 | alto | La scadenza caparra tagliata sull'inizio non segue lo spostamento: la visita spostata viene liberata all'ora vecchia | FATTO | `1077374` (ag-caparra) |
| 02-05 | medio | Riassegnare dalla colonna di un'operatrice disattivata risponde 404 | FATTO | `1e47625b` (prima del pool) |
| 02-06 | medio | Dopo la riduzione della caparra «richiesta» il link resta all'importo vecchio e il webhook incassa di più registrando di meno | FATTO | `11dbbac` (ag-caparra) |
| 02-07 | medio | Undo di una creazione: il link caparra resta pagabile e il pagamento di un appuntamento sparito viene ignorato | FATTO | `11dbbac` (ag-caparra), `82b881e` (ag-life) |
| 02-08 | medio | L'undo rimette l'appuntamento sopra una cliente prenotata nel frattempo | FATTO | `da6a172` (ag-life) |
| 02-09 | medio | No-show accettato dopo check-in, a trattamento in corso e prima dell'orario | FATTO | `af3ec25` (fe-modali), `e097b0b` (ag-life) |
| 02-10 | medio | Anteprima dell'annullamento dal banco: «caparra trattenuta» sotto le 24 h, ma il server la rimborsa | FATTO | `f143772` (fe-modali) |
| 02-11 | medio | Rimborso della caparra: la vendita-caparra resta nell'incasso | FATTO | `07d5de6` (ag-caparra) |
| 02-12 | medio | slot.freed per orari già passati (ogni no-show) | FATTO | `82b881e` (ag-life) |
| 02-13 | medio | slot.freed dello spostamento descrive male cosa si è liberato | FATTO | `82b881e` (ag-life) |
| 02-14 | medio | Fusione eventi: il messaggio di spostamento porta l'orario intermedio o perde `old_start` | FATTO | `82b881e` (ag-life) |
| 02-15 | basso | Spostamento dall'app con operatrice disattivata: orario proposto e poi rifiutato (409) | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 02-16 | basso | Sollecito caparra immediato per le prenotazioni a ridosso | FATTO | `1077374` (ag-caparra) |
| 02-17 | basso | Rilascio automatico mentre uno spostamento è trattenuto: «posto liberato» e poi «spostato» | FATTO | `82b881e` (ag-life) |
| 02-18 | basso | GET /agenda/released senza require_scope("agenda") | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 02-19 | basso | Check-in accettato da «in corso»: lo stato torna indietro e l'evento riparte | FATTO | `e097b0b` (ag-life) |
| 02-20 | basso | Modifica (PUT) accanto alla stessa cliente: la visita diventa «forzata» | FATTO | `5478c5d` (ag-disp), `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 02-21 | basso | Rimborso parziale «pending»: tutta la caparra diventa «rimborso in corso», credito 0 | FATTO | `07d5de6` (ag-caparra), `d008209` (integrazione) — completato nell'integrazione: la quota detraibile è deposit_retained |
| 02-22 | basso | Undo del no-show accettato dopo l'addebito no-show | FATTO | `da6a172` (ag-life) |
| 02-23 | basso | `_lock_and_reload` rilegge senza lock di riga: webhook caparra e rilascio automatico (select_for_update di riga) non si escludono con lock_salon | FATTO | `e097b0b` (ag-life) |
| 02-24 | basso | Riprogramma dal pannello: disponibilità senza escludere la visita e con le durate di listino | FATTO | `8d34f0b` (ag-disp), `45b2104` (fe-modali) |
| 02-25 | basso | Fuso del dispositivo: scadenza caparra nel pannello e giorno nella classifica lista d'attesa | FATTO | `ac697b9` (fe-griglia), `f143772` (fe-modali) |

## 03 — Torna indietro e messaggi trattenuti

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 03-01 | alto | «Torna indietro» butta via anche le modifiche precedenti ancora trattenute: lo spostamento che resta in vigore non viene mai comunicato | FATTO | `82b881e` (ag-life) |
| 03-02 | alto | Annullare una creazione con caparra online cancella l'appuntamento ma lascia aperto il link di pagamento già inviato: se la cliente paga, i soldi spariscono senza traccia | FATTO | `11dbbac` (ag-caparra), `82b881e` (ag-life) |
| 03-03 | medio | «Torna indietro» su un no-show già addebitato passa: il conto in cassa non viene visto | FATTO | `da6a172` (ag-life) |
| 03-04 | medio | La fusione di `slot.freed` annuncia lo slot sbagliato e perde quello davvero liberato | FATTO | `82b881e` (ag-life) |
| 03-05 | medio | Il salone annulla una prenotazione fatta dall'app entro la trattenuta: alla cliente non arriva nulla | FATTO | `82b881e` (ag-life) |
| 03-06 | medio | Il messaggio di spostamento fuso porta l'orario «di prima» sbagliato o non lo porta | FATTO | `82b881e` (ag-life) |
| 03-07 | medio | L'«Annulla» del pannello di dettaglio rifà lo spostamento al contrario forzandolo | FATTO | `b472859` (fe-modali) |
| 03-08 | basso | Corsa worker/fusione: il worker spedisce il payload vecchio e sovrascrive quello fuso | FATTO | `96714a6` (ag-life) |
| 03-09 | basso | Passare a «Subito» con eventi trattenuti: la correzione scavalca la conferma vecchia, che parte per ultima | FATTO | `ec70b2c` (ag-life) |
| 03-10 | basso | Smoke e2e step 11 (slot.freed non trovato per #9): smoke rimasto indietro rispetto alla trattenuta; resta un caso vero stretto per la lista d'attesa | FATTO | `ec70b2c` (ag-life) |
| 03-11 | basso | Il rilascio per caparra non pagata non supera gli eventi trattenuti: «posto liberato» e poi «spostato» | FATTO | `82b881e` (ag-life) |
| 03-12 | basso | L'undo di un gesto già comunicato libera uno slot senza avvisare la lista d'attesa | FATTO | `da6a172` (ag-life) |
| 03-13 | basso | L'undo ricrea le righe servizio con id nuovi: una modifica dal pannello rimasto aperto riprezza la visita a listino | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp), `b472859` (fe-modali), `da6a172` (ag-life) |
| 03-14 | basso | «Torna indietro» su un annullamento con caparra rimborsata da Stripe dà la colpa a una collega | FATTO | `da6a172` (ag-life) |
| 03-15 | basso | L'«Annulla» dei toast usa una chiusura vecchia: con «Indietro» o ⌘Z un attimo prima si annullano due gesti | FATTO | `ac697b9` (fe-griglia) |
| 03-16 | basso | Le voci di «torna indietro» scadute restano per sempre per chi non fa più gesti | FATTO | `e759b12` (ag-life) |

## 04 — API agenda

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 04-01 | medio | Riassegnare gli appuntamenti di un'operatrice disattivata risponde 404: `from_operator_id` deve essere attiva | FATTO | `1e47625b` (prima del pool) |
| 04-02 | medio | Vista giorno: il servizio di un'operatrice disattivata che non è la principale della visita non ha colonna e sparisce dalla griglia | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 04-03 | medio | App cliente: per spostare una visita di un'operatrice uscita la ricerca propone gli orari di un'altra, la conferma valida sulla vecchia | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 04-04 | medio | App cliente, salone con più sedi: la stilista di un'altra sede non è prenotabile, ma la ricerca propone orari (di un'altra) e la conferma risponde 400 | FATTO | `8000d3c` (accounts-staff-inv), `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 04-05 | medio | `GET /agenda/released` senza `require_scope`: nomi e telefoni delle clienti a chi non ha l'agenda | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 04-06 | basso | Sposta e annulla dall'app cliente rispondono con la scheda dello staff: la nota interna arriva alla cliente | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 04-07 | basso | Vista giorno con filtro sede: una pausa di un'operatrice di un'altra sede le apre una colonna | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 04-08 | basso | App cliente: con la stilista scelta si prenota e si sposta sopra la posa di un'altra cliente | FATTO | `8d34f0b` (ag-disp), `e097b0b` (ag-life) |
| 04-09 | basso | Walk-in e appuntamenti registrati a posteriori: il link della caparra parte per una visita già cominciata | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 04-10 | basso | PUT: un servizio aggiunto senza operatrici abilitate risponde 409, e il ritentativo forzato ripete 409 «Orario non più disponibile» | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 04-11 | basso | Date di calendario inesistenti, anni limite e durate senza tetto danno 500 invece di 400 | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |

## 05 — Cassa e Stripe

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 05-01 | critico | Con stripe==15.6.1 ogni risposta Stripe esplode su `.get()`: webhook, link caparra, Connect e rimborsi rotti | FATTO | `5940f3a` (ag-caparra) |
| 05-02 | alto | Un solo segreto di firma per il webhook: con Stripe Connect una delle due famiglie di eventi è sempre rifiutata | FATTO | `5940f3a` (ag-caparra) |
| 05-03 | medio | Storico vendite: «Incasso totale» conta due volte ogni caparra | FATTO | `61d8aee` (ag-caparra) |
| 05-04 | medio | Una caparra rimborsata resta per sempre in `cash_in` / `deposit_cashed` | FATTO | `07d5de6` (ag-caparra) |
| 05-05 | medio | La vendita-caparra conta come visita e come spesa della cliente | FATTO | `fc0757b` (clienti) |
| 05-06 | medio | Dopo una riduzione della visita, rimborsare l'eccedenza segna «rimborsata» l'intera caparra e la cliente ripaga | FATTO | `11dbbac` (ag-caparra) |
| 05-07 | medio | Caparra ridotta ma link vecchio: la cliente paga l'importo pieno e l'eccedenza sparisce | FATTO | `11dbbac` (ag-caparra) |
| 05-08 | medio | «Torna indietro» su un appuntamento con caparra: link già spedito, sessione aperta, pagamento poi ignorato | FATTO | `11dbbac` (ag-caparra), `82b881e` (ag-life) |
| 05-09 | medio | Arrotondamento diverso fra frontend e backend sulle righe scontate: vendita impossibile (422) | FATTO | `2292243` (fe-cassa-fedelta) |
| 05-10 | medio | Il link caparra scade dopo 24 h ma resta quello salvato: la cliente non può più pagare online | FATTO | `11dbbac` (ag-caparra), `3aa7cc1` (integrazione) |
| 05-11 | medio | Link non creato (errore Stripe) ma scadenza della caparra fissata: lo slot si libera e la cliente riceve «caparra non versata» | FATTO | `11dbbac` (ag-caparra) |
| 05-12 | medio | Dopo aver collegato/scollegato Stripe, rimborsi e chiusure dei link delle caparre già pagate vanno sull'account nuovo e falliscono | FATTO | `11dbbac` (ag-caparra), `3aa7cc1` (integrazione) |
| 05-13 | basso | Il link caparra sopravvive al rilascio e all'annullamento (C12 del 18/09 mai corretto) | FATTO | `82b881e` (ag-life) |
| 05-14 | basso | Lo stato della caparra dipende dall'ordine degli eventi di rimborso | FATTO | `07d5de6` (ag-caparra) |
| 05-15 | basso | La cassa blocca il conto quando la caparra supera il dovuto, anche se il backend ora la tronca e rimborsa | FATTO | `f9826c4` (fe-cassa-fedelta) |
| 05-16 | basso | Riepilogo di cassa: «Incassato oggi» compare solo se ci sono gift card riscattate | FATTO | `3189acf` (fe-modali) |
| 05-17 | basso | Storico vendite: i servizi compaiono come «Servizio #12» | FATTO | `7a2653a` (fe-cassa-fedelta) |
| 05-18 | basso | Il buono sconto non si riflette sulle righe: il fatturato per operatrice supera l'incasso | FATTO | `61d8aee` (ag-caparra) |
| 05-19 | basso | Fedeltà «per visita»: ogni gift card comprata al banco vale un timbro | FATTO | `70bcd92` (marketing) |
| 05-20 | basso | Il checkout non prende `lock_salon`: una mutazione d'agenda concorrente riscrive lo stato di un conto chiuso | FATTO | `b39a8cf` (ag-caparra) |

## 06 — Clienti e telefoni

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 06-01 | alto | Le caparre e gli addebiti no-show contano come visite, e la caparra si somma al conto pieno | FATTO | `fc0757b` (clienti) |
| 06-02 | medio | Cliente archiviata = vicolo cieco: non si trova, non si ricrea, non si riattiva, non entra nell'app | FATTO | `85321b8` (clienti), `566406d` (clienti), `2aee16f` (fe-clienti), `a0ab544` (integrazione) |
| 06-03 | medio | Foto delle schede tecniche restituite senza firma → 403 nella scheda tecnica | FATTO | `e69aba0` (clienti) |
| 06-04 | medio | Numeri esteri rovinati dalla tabella corta dei prefissi | FATTO | `870b056` (clienti), `9842b42` (fe-cliente-shared) |
| 06-05 | medio | Storico: chi non ha il permesso vendite (Operatrice predefinita) vede ogni visita pagata «non incassato» | FATTO | `fc0757b` (clienti), `528513d` (fe-clienti) |
| 06-06 | medio | Rinominare un'etichetta spegne in silenzio le regole caparra e i filtri che la citano | FATTO | `0487e86` (clienti) |
| 06-07 | medio | Import: «cliente dal» = oggi per tutto lo storico importato | FATTO | `85321b8` (clienti) |
| 06-08 | medio | Import: riga senza telefono con email condivisa rinomina un'altra cliente | FATTO | `85321b8` (clienti) |
| 06-09 | medio | `whatsapp_reminders` (e `wa`) non li legge nessuno: chi spegne i promemoria li riceve lo stesso | FATTO | `82b881e` (ag-life) |
| 06-10 | basso | La scheda aperta in dashboard riscrive lang/email/promemoria/consensi dalla copia vecchia | FATTO | `581cfba` (clienti), `566406d` (clienti), `21a88c1` (fe-clienti) |
| 06-11 | basso | Doppio prefisso «+39 39 333…» accettato come numero valido | FATTO | `870b056` (clienti), `9842b42` (fe-cliente-shared) |
| 06-12 | basso | Etichetta con nome già esistente (o doppio clic su Salva) → 500 | FATTO | `0487e86` (clienti) |
| 06-13 | basso | Import: 29/02 di un anno non bisestile fa perdere l'intera riga | FATTO | `85321b8` (clienti), `b31626a` (fe-clienti) |
| 06-14 | basso | Import: compleanno senza anno nel file cancella l'anno già noto | FATTO | `85321b8` (clienti) |
| 06-15 | basso | Import: reimportare lo stesso file duplica le note su ogni cliente | FATTO | `85321b8` (clienti) |
| 06-16 | basso | Ricerca insensibile agli accenti assente («nicolo» non trova «Nicolò») | FATTO | `e69aba0` (clienti) |
| 06-17 | basso | Revoca del consenso marketing: correzione del 18/09 incompleta | FATTO | `cc444e0` (accounts-staff-inv), `cec710c` (fe-cliente-shared) |
| 06-18 | basso | Storico: giorno/mese della timeline dal fuso del dispositivo | FATTO | `528513d` (fe-clienti) |
| 06-19 | basso | Bonifica doppioni: consiglia di cancellare la scheda «svuotata» guardando solo visite e vendite | FATTO | `b45d749` (clienti), `38d0062` (integrazione) |
| 06-20 | basso | Form pubblico: il contatto nuovo nasce sempre in italiano | FATTO | `581cfba` (clienti), `56762b4` (fe-cliente-shared) |

## 07 — Fedeltà, coupon, gift card, comunicazioni

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 07-01 | critico | Un programma «A timbri» creato dalla dashboard dà un timbro per ogni euro: più premi a ogni scontrino | FATTO | `442c27a` (fe-cassa-fedelta), `70bcd92` (marketing) |
| 07-02 | alto | Modificare, riprogrammare o eliminare una comunicazione programmata non ferma l'invio già consegnato a Yourang | FATTO | `4c16fd1` (marketing) |
| 07-03 | medio | La revoca del consenso marketing non vale per le campagne già programmate o in coda | FATTO | `566406d` (clienti), `c73b96c` (marketing), `4c16fd1` (marketing) — chiuso insieme alla scheda cliente (update_client / delete_client) |
| 07-04 | medio | Il Front desk non può incassare una gift card comprata dall'app né venderne una legata alla destinataria | FATTO | `f2103fc` (fe-cassa-fedelta), `03f098e` (marketing) |
| 07-05 | medio | App cliente: il saldo gift card conta le carte da pagare e quelle regalate ad altre | FATTO | `4cfe2e4` (fe-cliente-shared), `03f098e` (marketing) |
| 07-06 | medio | Scheda cliente: punti fedeltà cercati scorrendo pagine ordinate solo per punti → iscritta data per «Non ancora iscritta» | FATTO | `fe06be7` (fe-clienti), `70bcd92` (marketing) |
| 07-07 | medio | Carte e coupon scaduti restano «attivi»: la nuova prenotazione promette come regalo una carta scaduta o di un'altra persona | FATTO | `f2103fc` (fe-cassa-fedelta), `f9fea5a` (fe-modali), `03f098e` (marketing) |
| 07-08 | basso | Comprare una gift card al banco vale una «visita» nei programmi per visita | FATTO | `70bcd92` (marketing) |
| 07-09 | basso | Il premio fedeltà speso fa guadagnare altri punti | FATTO | `70bcd92` (marketing) |
| 07-10 | basso | Premio «servizio omaggio» su un servizio a prezzo zero blocca l'incasso della cliente | FATTO | `70bcd92` (marketing) |
| 07-11 | basso | La modifica di un coupon può resuscitare un coupon appena usato in cassa | FATTO | `03f098e` (marketing) |
| 07-12 | basso | Checkout: il precompilato spende una seconda gift card «a trattamento» su altri servizi | FATTO | `2292243` (fe-cassa-fedelta) |
| 07-13 | basso | Iscrizione «Su richiesta»/«A pagamento»: il programma non accoglie più nessuna nuova cliente | FATTO | `91045c6` (fe-cassa-fedelta), `70bcd92` (marketing) |
| 07-14 | basso | Si può programmare una comunicazione nel passato | FATTO | `fc7df32` (fe-cassa-fedelta), `4c16fd1` (marketing) |
| 07-15 | basso | Scadenze di coupon e gift card nel fuso del dispositivo; «+N mesi» sfora a fine mese | FATTO | `5091ffd` (fe-cassa-fedelta) |
| 07-16 | basso | Scheda cliente: premi «Sconto %» e «Gift card» mostrati come numero nudo | FATTO | `fe06be7` (fe-clienti) |

## 08 — Core, impostazioni, insight

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 08-01 | critico | seed_demo crea un superuser con password pubblica: /admin/ su tutti i saloni | FATTO | `c48118d` (core-insights) |
| 08-02 | alto | seed_demo --reset cancella per slug anche un salone vero chiamato «The Parlour» | FATTO | `c48118d` (core-insights) |
| 08-03 | medio | Il checkout non produce eventi visibili all'agenda: le operatrici restano su «in corso» | FATTO | `61d8aee` (ag-caparra), `4a8d330` (fe-griglia) |
| 08-04 | medio | Rebooking dei periodi passati ~0%: le visite successive già chiuse vengono escluse | FATTO | `dda9bca` (core-insights) |
| 08-05 | medio | «Nuovi clienti»: tutta la rubrica importata conta come nuova, le clienti storiche non «di ritorno» | FATTO | `85321b8` (clienti), `dda9bca` (core-insights), `ce4689b` (integrazioni) |
| 08-06 | medio | Tassi no-show/cancellazioni diluiti dagli appuntamenti futuri del periodo | FATTO | `dda9bca` (core-insights) |
| 08-07 | medio | «vs prec.» confronta il periodo in corso (parziale) col precedente intero | FATTO | `a45aaee` (fe-impostazioni) |
| 08-08 | medio | create_salon con email già esistente: salone irraggiungibile, doppioni per maiuscole, slug non validato | FATTO | `cc444e0` (accounts-staff-inv), `f8e4dd2` (core-insights) |
| 08-09 | medio | Registro attività: orari e «Oggi/Ieri» col fuso del dispositivo | FATTO | `b935dae` (fe-impostazioni) |
| 08-10 | basso | Occupazione storica gonfiata quando un'operatrice viene disattivata | FATTO | `1e47625b` (prima del pool) |
| 08-11 | basso | Ticket SSE riusabile per 10 minuti e con permessi congelati | FATTO | `341916a` (core-insights) |
| 08-12 | basso | Keepalive soppresso dagli eventi invisibili: disconnessione non rilevata, posto SSE trattenuto | FATTO | `341916a` (core-insights) |
| 08-13 | basso | Feed live: evento perso per la corsa fra id di sequenza e commit (F8 del 18/09 ancora aperto) | FATTO | `341916a` (core-insights) |
| 08-14 | basso | Doppia consegna stream + polling di coerenza: duplicati nella campanella | FATTO | `aec1aec` (fe-impostazioni) |
| 08-15 | basso | Orari scritti da /admin/ non validati → 500 su agenda e disponibilità | FATTO | `f41769d` (core-insights) |
| 08-16 | basso | Date inesistenti o fuori scala → 500 invece di 400 | FATTO | `f41769d` (core-insights), `dda9bca` (core-insights) |
| 08-17 | basso | cash_in/deposit_cashed degli insight non tolgono le caparre rimborsate | FATTO | `07d5de6` (ag-caparra) |
| 08-18 | basso | PUT /settings e logo: save() completo sull'istanza letta a inizio richiesta | FATTO | `f41769d` (core-insights) |
| 08-19 | basso | HoursDrawer dice che gli orari non limitano le prenotazioni, ma le limitano | FATTO | `b935dae` (fe-impostazioni) |

## 09 — Magazzino, catalogo, staff

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 09-01 | alto | L'API staff mostra a qualunque ruolo gli incassi delle colleghe e la spesa delle clienti | FATTO | `8000d3c` (accounts-staff-inv), `f29949f` (fe-impostazioni) |
| 09-02 | medio | «Carico merce» carica la merce su un altro prodotto quando nome o SKU non sono univoci | FATTO | `5c45c80` (accounts-staff-inv), `735e6bd` (fe-impostazioni) |
| 09-03 | medio | L'app cliente propone operatrici di un'altra sede e la prenotazione con loro fallisce | FATTO | `8000d3c` (accounts-staff-inv) |
| 09-04 | medio | Chi fa il secondo servizio di una visita non la conta: «Clienti oggi» e «Clienti serviti» perdono quelle clienti | FATTO | `8000d3c` (accounts-staff-inv) |
| 09-05 | medio | Un'operatrice disattivata non si può più riaprire né riattivare dalla dashboard | FATTO | `8000d3c` (accounts-staff-inv), `f29949f` (fe-impostazioni) |
| 09-06 | basso | Carico CSV non atomico: un errore di database a metà lascia caricate le righe precedenti e il nuovo tentativo le carica due volte | FATTO | `5c45c80` (accounts-staff-inv) |
| 09-07 | basso | L'app cliente mostra la durata senza la posa: la visita dura più di quanto dice | FATTO | `e7582fd` (accounts-staff-inv), `c4950fd` (fe-cliente-shared) |
| 09-08 | basso | Il magazzino non si aggiorna dopo una vendita: giacenze vecchie sulle altre postazioni | FATTO | `5c45c80` (accounts-staff-inv), `735e6bd` (fe-impostazioni) |
| 09-09 | basso | La scheda operatrice salva colore e servizi letti all'apertura e cancella le modifiche fatte nel frattempo | FATTO | `8000d3c` (accounts-staff-inv), `f29949f` (fe-impostazioni) |
| 09-10 | basso | Elenco prodotti con ordinamento non univoco: fra una pagina e l'altra un prodotto può ripetersi o sparire | FATTO | `5c45c80` (accounts-staff-inv) |
| 09-11 | basso | «Ultima visita» dei clienti serviti nel fuso del dispositivo | FATTO | `f29949f` (fe-impostazioni) |

## 10 — Sicurezza e permessi

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 10-01 | alto | Lo scope «team» scala a qualunque ruolo tramite gli inviti in attesa | FATTO | `333d3f4` (accounts-staff-inv), `b935dae` (fe-impostazioni) |
| 10-02 | basso | `oauth/exchange` (connect) senza `state`/CSRF: login-CSRF sul collegamento Yourang | FATTO | `c657630` (integrazioni) |
| 10-03 | medio | Il login «Accedi con Yourang» collega il salone all'org di un membro qualunque | FATTO | `c657630` (integrazioni) |
| 10-04 | basso | I tetti «per salone» di OTP e registrazione bloccano l'accesso di tutte le clienti del salone | FATTO | `cc444e0` (accounts-staff-inv) |
| 10-05 | alto | «team» può azzerare il ruolo di un collega più potente (revoca di permessi altrui) | FATTO | `333d3f4` (accounts-staff-inv) |
| 10-06 | medio | Codici gift card e coupon (strumenti al portatore) leggibili da tutto lo staff | FATTO | `03f098e` (marketing) |
| 10-09 | medio | Dati di cassa/HR (costo orario, incassi per operatrice, spesa cliente, fatture) senza il permesso «sales» | FATTO | `5c45c80` (accounts-staff-inv), `8000d3c` (accounts-staff-inv), `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 10-10 | medio | Le note interne dello staff finiscono alla cliente quando sposta o annulla dall'app | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 10-11 | basso | Il logout non revoca i refresh «legacy» senza jti, che restano riusabili | FATTO | `cc444e0` (accounts-staff-inv) |
| 10-12 | basso | Il ticket dello stream SSE resta valido dopo rimozione/cambio password (fino a 10 min) | FATTO | `341916a` (core-insights) |
| 10-13 | basso | `POST /auth/staff/password` senza tetto sui tentativi: brute force della password attuale | FATTO | `cc444e0` (accounts-staff-inv) |
| 10-14 | basso | `client/register`: la corsa sul doppio invio esce come 500 invece del 400 | FATTO | `cc444e0` (accounts-staff-inv) |
| 10-15 | basso | `public/hook`: riattiva schede cliente disattivate senza autenticazione | FATTO | `581cfba` (clienti) |
| 10-16 | basso | Upload fattura magazzino: validazione debole, conserva nome/estensione del client | FATTO | `5c45c80` (accounts-staff-inv) |

## 11 — Integrazioni e deploy

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 11-01 | alto | «Collega Yourang» riscatta un codice preso dall'URL con la sessione del titolare: salone ricollegato all'org di un altro | FATTO | `c657630` (integrazioni) |
| 11-02 | alto | «Accedi con Yourang» fa collegare il salone a un membro non titolare (e con due saloni collega quello sbagliato) | FATTO | `c657630` (integrazioni) |
| 11-03 | medio | Uno stato remoto terminale sovrascrive una visita con check-in o in corso: incasso rifiutato o conto «chiuso» senza vendita | FATTO | `ce4689b` (integrazioni) |
| 11-04 | medio | Le prenotazioni Yourang restano inchiodate sulla prima operatrice: il segnaposto non ha operatrici idonee | FATTO | `ce4689b` (integrazioni), `bb01e30` (integrazione) |
| 11-05 | medio | `cancel_event` con UPDATE nudo: annulla anche visite chiuse o in corso, senza registro né lista d'attesa | FATTO | `ce4689b` (integrazioni) |
| 11-06 | medio | Import e annullamenti Yourang invisibili alle postazioni aperte: nessuna riga nel registro, quindi nessun aggiornamento live | FATTO | `ce4689b` (integrazioni) |
| 11-07 | medio | Ogni ri-consegna riporta orario e cliente al valore Yourang, annullando lo spostamento fatto in salone | FATTO | `ce4689b` (integrazioni) |
| 11-08 | medio | Outbox: un ritentativo consegna la conferma DOPO l'annullamento | FATTO | `96714a6` (ag-life), `0ce7b03` (integrazione), `5e8a5f2` (integrazione) |
| 11-09 | medio | Configurare `YOURANG_API_URL` spedisce l'intero arretrato senza scadenza; senza URL nessuna pulizia | FATTO | `96714a6` (ag-life) |
| 11-10 | medio | `sync_yourang` manca dai job schedulati di DEPLOY.md | FATTO | `38d0062` (integrazione) — DEPLOY.md: sync_yourang ogni ora fra i job schedulati |
| 11-11 | medio | Dopo ogni deploy la dashboard aperta va in bianco aprendo una sezione o una modale non ancora caricata | FATTO | `aec1aec` (fe-impostazioni) |
| 11-12 | medio | La sync completa gira dentro le richieste: login/collega e ogni webhook contact.* fanno migliaia di chiamate HTTP in linea | FATTO | `6f725f1` (integrazioni), `c657630` (integrazioni) |
| 11-13 | medio | Migrazioni additive NOT NULL senza `db_default`: il container vecchio rompe ogni scrittura di OutboxEvent | FATTO | `e759b12` (ag-life) |
| 11-14 | basso | Riconnessione con un'altra org: restano contact-id, item-id e catalogue_id della vecchia (H6 corretto solo su disconnect) | FATTO | `c657630` (integrazioni) |
| 11-15 | basso | Il claim del worker non ricontrolla la trattenuta: una fusione che committa fra lettura e claim parte col payload vecchio | FATTO | `96714a6` (ag-life) |
| 11-16 | basso | Due consegne concorrenti dello stesso evento creano due righe segnaposto | FATTO | `ce4689b` (integrazioni) |
| 11-17 | basso | Prenotazioni Yourang senza telefono tutte sulla stessa scheda, col nome della prima (H12 del 18/09 non corretto) | FATTO | `ce4689b` (integrazioni) |
| 11-18 | basso | Gli errori di sync non arrivano al titolare (fix H17 incompleto) | FATTO | `b935dae` (fe-impostazioni), `c657630` (integrazioni) |
| 11-19 | basso | CLIENT_APP_ORIGIN mancante non ripiega su FRONTEND_ORIGIN ma su http://localhost:5174 | FATTO | `5940f3a` (ag-caparra) |
| 11-20 | basso | nginx delle due SPA senza header di sicurezza | FATTO | `d147276` (prima del pool) |
| 11-21 | basso | flush_outbox «ogni minuto» contro trattenuta di 30 s | FATTO | `38d0062` (integrazione) — DEPLOY.md: flush_outbox come worker --loop --interval 5 |

## 12 — Agenda React: griglia

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 12-01 | alto | Staccare il primo servizio (o uno in mezzo) fa slittare in avanti quelli che restano, mentre la griglia li mostra fermi | FATTO | `1e47625b` (prima del pool) |
| 12-02 | medio | Ridimensionare una pausa non funziona: TypeError a ogni movimento | FATTO | `f8e1526` (fe-griglia) |
| 12-03 | medio | Ridimensionare un servizio che finisce dopo le 20:00 lo accorcia fino alle 20:00, anche con un tocco | FATTO | `f8e1526` (fe-griglia) |
| 12-04 | medio | Griglia fissa 08:00–20:00: appuntamenti prima delle 8 invisibili, dopo le 20 fuori griglia e non raggiungibili | FATTO | `b993075` (fe-griglia) |
| 12-05 | medio | «Sposta qui» sull'ombra non sposta niente (stessa ora e operatrice) o sposta male (ombra di un servizio successivo) | FATTO | `4a8d330` (fe-griglia) |
| 12-06 | medio | Visita divisa fra due colonne (un servizio per operatrice): nessuna spina, non si sposta intera; il trascinamento la spezza | FATTO | `f8e1526` (fe-griglia) |
| 12-07 | medio | Colonne di operatrici disattivate: riassegnare dà 404, e i servizi di una disattivata dentro visite altrui spariscono | FATTO | `1e47625b` (prima del pool) |
| 12-08 | medio | Verso la striscia dei giorni badge e ombra mentono; mancare la pillola sposta davvero, e lo stacco sul giorno a video spezza la visita | FATTO | `f8e1526` (fe-griglia) |
| 12-09 | medio | La vista giorno non si ricarica per turni, assenze e orari del centro cambiati altrove | FATTO | `4a8d330` (fe-griglia) |
| 12-10 | medio | Settimana: `refetchWeek` senza guardia, una risposta della settimana vecchia sovrascrive quella a video | FATTO | `4a8d330` (fe-griglia) |
| 12-11 | basso | Ombra e «Sposta qui» usano `modal.props.appointment`, che non si aggiorna dopo le modifiche fatte nel pannello | FATTO | `4a8d330` (fe-griglia) |
| 12-12 | basso | Ridimensionare un servizio dà 400 se un ALTRO servizio della visita è di un'operatrice disattivata o non più abilitata | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 12-13 | basso | Spostare a un orario già passato di oggi marca l'appuntamento «forzato» senza bisogno | FATTO | `f8e1526` (fe-griglia) |
| 12-14 | basso | `pointerId` mai controllato: su tablet un secondo dito sposta e rilascia il trascinamento in corso | FATTO | `f8e1526` (fe-griglia) |
| 12-15 | basso | Scorrere con la rotella durante il trascinamento non aggiorna l'orario: il blocco si stacca dal puntatore | FATTO | `f8e1526` (fe-griglia) |
| 12-16 | basso | Campo esadecimale del colore operatrice inutilizzabile: completa con zeri e salva a ogni tasto | FATTO | `f8e1526` (fe-griglia) |
| 12-17 | basso | In settimana, aprendo un appuntamento di un altro giorno compare un'ombra sul giorno «selezionato», che la vista non evidenzia | FATTO | `4a8d330` (fe-griglia) |
| 12-18 | basso | Esc per annullare un trascinamento chiude anche il pannello di dettaglio | FATTO | `f8e1526` (fe-griglia), `a596286` (prima del pool) |
| 12-19 | basso | `wlRank` legge `getDay()` su un ISO dell'API (fuso del dispositivo) | FATTO | `ac697b9` (fe-griglia) |
| 12-20 | basso | Incasso nelle testate di giorno e settimana conta i no-show, il mese no | FATTO | `f8e1526` (fe-griglia) |
| 12-21 | basso | Settimana: sotto-colonne per le operatrici di tutte le sedi, non solo di quella attiva | FATTO | `f8e1526` (fe-griglia) |
| 12-22 | basso | Sfogliando i giorni la griglia si rimonta e torna alle 08:00: l'ombra finisce fuori schermo | FATTO | `b993075` (fe-griglia) |
| 12-23 | basso | Evidenza del blocco aperto: `zIndex` duplicato nello stile, quello del contorno non vale mai | FATTO | `f8e1526` (fe-griglia) |
| 12-24 | basso | «Vai a una data» scritta a tastiera salta all'anno 1902 al primo tasto | FATTO | `ac697b9` (fe-griglia) |
| 12-25 | basso | Settimana non si ricarica per `deposit.` e `sale.`: pallino caparra e stati restano vecchi | FATTO | `4a8d330` (fe-griglia) |

## 13 — Agenda React: flussi

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 13-01 | alto | «Sposta qui» alla stessa ora e nella stessa colonna di un altro giorno non sposta niente (proprio dove l'ombra dice «qui») | FATTO | `4a8d330` (fe-griglia) |
| 13-02 | alto | L'anteprima dell'annullamento promette «Caparra trattenuta» sotto le 24 h, ma dal gestionale la caparra viene sempre rimborsata (anche su Stripe, in automatico) | FATTO | `f143772` (fe-modali) — l'annullamento «per conto della cliente» dallo staff è una decisione aperta: vedi Aperti |
| 13-03 | alto | Il pannello di dettaglio non si aggiorna quando l'appuntamento cambia altrove: i suoi comandi ripartono dalla copia vecchia e disfano o raddoppiano le modifiche | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp), `b472859` (fe-modali) |
| 13-04 | medio | Riassegnare gli appuntamenti di un'operatrice disattivata risponde «Not Found» (pannello e trascinamento) | FATTO | `1e47625b` (prima del pool) |
| 13-05 | medio | Le modifiche ai servizi non salvate spariscono con qualunque altro gesto del pannello (e «Incassa» fattura i servizi vecchi) | FATTO | `b472859` (fe-modali), `5f1666d` (integrazione) |
| 13-06 | medio | «Annulla» dell'avviso di uno spostamento dal pannello rifà la strada al contrario con force: «Forzato» per sempre, visite miste riassegnate male, secondo messaggio alla cliente | FATTO | `b472859` (fe-modali) |
| 13-07 | medio | «Sposta qui» e l'ombra usano la copia dell'appuntamento di quando si è aperto il pannello: dopo «Passa a»/± mandano l'operatrice di partenza sbagliata | FATTO | `4a8d330` (fe-griglia) |
| 13-08 | medio | Con il drawer «Nuova prenotazione» aperto, un clic in vista settimana (o su un blocco esistente) lo sostituisce: cliente, servizi e nota persi | FATTO | `4a8d330` (fe-griglia) |
| 13-09 | medio | Nel drawer il servizio risulta «Regalo» (prezzo barrato) anche con carte scadute o intestate a un'altra persona: in cassa il regalo non c'è | FATTO | `f9fea5a` (fe-modali), `03f098e` (marketing) |
| 13-10 | medio | Esc nella ricerca cliente chiude tutto il drawer (nuova prenotazione o gruppo) | FATTO | `b589a1a` (fe-modali) |
| 13-11 | medio | Gli orari del drawer non seguono le altre postazioni: uno slot preso nel frattempo resta «libero» e il 409 fa forzare sopra l'altra cliente | FATTO | `f9fea5a` (fe-modali) |
| 13-12 | medio | Orario «non fra gli slot»: si forza già al primo tentativo e i servizi su «Prima disponibile» vanno alla prima operatrice in ordine anche se occupata | FATTO | `8d34f0b` (ag-disp), `f9fea5a` (fe-modali) |
| 13-13 | basso | Salvataggio servizi (e resize in griglia) → 400 se l'operatrice di una riga esistente non è più abilitata o è disattivata; la riga non mostra chi la ha | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp), `af3ec25` (fe-modali) |
| 13-14 | basso | Orari nel fuso del dispositivo: scadenza caparra nel pannello e date del feed | FATTO | `aec1aec` (fe-impostazioni), `f143772` (fe-modali) |
| 13-15 | basso | Anteprime no-show/annullamento con deposit_amount invece di deposit_credit | FATTO | `f143772` (fe-modali) |
| 13-16 | basso | «Nuovo cliente» dal pulsante diviso apre la prenotazione su oggi, non sul giorno guardato | FATTO | `2aee16f` (fe-clienti) |
| 13-17 | basso | «Riprogramma»: su 409 chiede un secondo clic citando «Sposta comunque» che non esiste; disponibilità calcolata sulle durate di listino, non su quelle della visita | FATTO | `8d34f0b` (ag-disp), `45b2104` (fe-modali) |
| 13-18 | basso | L'orario scelto a mano o fra le alternative torna all'orario cliccato in agenda (forzato) quando si cambiano i servizi | FATTO | `f9fea5a` (fe-modali) |
| 13-19 | basso | Drawer «Nuova prenotazione» e «Gruppo» non restringono l'area di lavoro: coprono le ultime colonne in modalità scelta orario; «Gruppo» col dettaglio aperto si apre nascosto dietro | FATTO | `b589a1a` (fe-modali) |
| 13-20 | basso | Risposte in volo che chiudono il pannello aperto nel frattempo; X del gruppo attiva durante la creazione | FATTO | `b589a1a` (fe-modali), `b472859` (fe-modali) |
| 13-21 | basso | Importi: «€0» senza decimali (fmtMoney) e «− Gratis» nelle righe del margine | FATTO | `f143772` (fe-modali) |
| 13-22 | basso | Ricerca cliente: accenti/apostrofo tipografico non trovano; Invio prima della risposta apre «Nuovo cliente»; errore di rete = «Nessun cliente trovato» | FATTO | `e69aba0` (clienti) |
| 13-23 | basso | Nota di una visita chiusa (o senza permesso agenda) modificabile ma non salvabile; il testo rimanda a un pulsante che non c'è | FATTO | `af3ec25` (fe-modali) |
| 13-24 | basso | «Mostra margine» resta quello di prima del salvataggio dei servizi | FATTO | `b472859` (fe-modali) |
| 13-25 | basso | «Copia link caparra» nell'avviso: la conferma «Link copiato» non compare mai e la copia non è verificata | FATTO | `bc11ccf` (fe-cliente-shared), `f9fea5a` (fe-modali), `af3ec25` (fe-modali) |

## 14 — Dashboard: clienti, cassa, fedeltà

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 14-01 | critico | Tessera «A timbri» creata dalla dashboard: un timbro per ogni euro, premi a raffica | FATTO | `442c27a` (fe-cassa-fedelta), `70bcd92` (marketing) |
| 14-02 | alto | Check-out impossibile quando la caparra supera il conto (la correzione C3 del server resta irraggiungibile) | FATTO | `f9826c4` (fe-cassa-fedelta) |
| 14-03 | alto | La vendita-caparra è contata come visita, spesa e vendita da banco | FATTO | `61d8aee` (ag-caparra), `fc0757b` (clienti) |
| 14-04 | medio | Carrello/check-out: arrotondamento in virgola mobile diverso dal server | FATTO | `2292243` (fe-cassa-fedelta) |
| 14-05 | medio | La scheda cliente rimanda i consensi letti all'apertura: annulla le revoche fatte dall'app | FATTO | `566406d` (clienti), `21a88c1` (fe-clienti) |
| 14-06 | medio | Wallet: saldo fedeltà cercato scorrendo pagine ordinate per `-points` invece di `client_id` | FATTO | `fe06be7` (fe-clienti), `70bcd92` (marketing) |
| 14-07 | medio | Import CSV: la colonna indovinata dal contenuto ruba il campo a quella col titolo giusto | FATTO | `b31626a` (fe-clienti) |
| 14-08 | medio | Import da Excel italiano (Windows-1252): l'avviso sugli accenti è in un passo che si salta | FATTO | `b31626a` (fe-clienti) |
| 14-09 | medio | Comunicazioni: «Salva» su una campagna programmata la riporta in bozza senza dirlo | FATTO | `fc7df32` (fe-cassa-fedelta) |
| 14-10 | basso | Esc sulla «Conferma pagamento» chiude tutto il check-out | FATTO | `f9826c4` (fe-cassa-fedelta), `a596286` (prima del pool) |
| 14-11 | basso | Storico vendite: le righe servizio si leggono «Servizio #12» | FATTO | `7a2653a` (fe-cassa-fedelta) |
| 14-12 | basso | Buono applicato resta dopo cambio cliente o dopo aver tolto i prodotti | FATTO | `f9826c4` (fe-cassa-fedelta), `2292243` (fe-cassa-fedelta) |
| 14-13 | basso | Date lette sul fuso del dispositivo | FATTO | `5091ffd` (fe-cassa-fedelta), `528513d` (fe-clienti) |
| 14-14 | basso | Consensi: nessuna data di raccolta o revoca dalla dashboard | FATTO | `566406d` (clienti), `21a88c1` (fe-clienti) |
| 14-15 | basso | Import: telefoni impossibili accettati senza avviso; 29/02 non bisestile scarta la riga | FATTO | `a12cbfc` (clienti), `85321b8` (clienti), `b31626a` (fe-clienti) |
| 14-16 | basso | Import: «Cognome e nome» / «Nominativo» fusi o invertiti, invisibile in anteprima | FATTO | `b31626a` (fe-clienti) |
| 14-17 | basso | Import: «Riga N» è la riga dei dati, non quella del file | FATTO | `b31626a` (fe-clienti) |
| 14-18 | basso | Import chiuso o fallito a metà: prosegue in background / riprova duplica le note | FATTO | `b31626a` (fe-clienti) |
| 14-19 | basso | Nuova cliente e creazione rapida: telefono non verificato | FATTO | `3e17a12` (fe-cassa-fedelta), `2aee16f` (fe-clienti), `a0ab544` (integrazione) |
| 14-20 | basso | Wallet e KPI della scheda restano vecchi; errori mostrati come «nessun coupon» | FATTO | `fe06be7` (fe-clienti), `21a88c1` (fe-clienti) |
| 14-21 | basso | Wallet: premio «Sconto %» e «Gift card» mostrati come «Premio: 10.00» | FATTO | `fe06be7` (fe-clienti) |
| 14-22 | basso | Selettori cliente di coupon, gift card e comunicazioni includono le schede archiviate | FATTO | `3e17a12` (fe-cassa-fedelta) |
| 14-23 | basso | Compleanno: giorno 31 + cambio mese salva «--04-31»; togliere il mese non cancella | FATTO | `194c533` (fe-clienti) |
| 14-24 | basso | Lista clienti: ogni evento client.* la svuota e torna ai primi 50, in cima | FATTO | `194c533` (fe-clienti) |
| 14-25 | basso | Storico cliente: caparra mostrata per intero dopo un rimborso parziale | FATTO | `528513d` (fe-clienti) |

## 15 — Dashboard: impostazioni e resto

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 15-01 | alto | La pagina di accesso di produzione indica l'account demo, che il seed crea superuser con password pubblica | FATTO | `c48118d` (core-insights) |
| 15-02 | medio | Chi ha il solo «team» può togliere il ruolo a una collega con più permessi (rimuoverla invece è vietato) | FATTO | `333d3f4` (accounts-staff-inv), `b935dae` (fe-impostazioni) |
| 15-03 | medio | Due pulsanti «Salva» nella stessa pagina: quello in evidenza butta via le modifiche dell'altra parte e conferma «salvato» | FATTO | `b935dae` (fe-impostazioni), `f29949f` (fe-impostazioni) |
| 15-04 | medio | «Carico merce» manda nome/SKU e non l'id del prodotto scelto: la merce finisce su un altro articolo, anche disattivato | FATTO | `5c45c80` (accounts-staff-inv), `735e6bd` (fe-impostazioni) |
| 15-05 | medio | Operatrici e prodotti disattivati spariscono dagli elenchi e non si possono più riattivare dalla dashboard | FATTO | `735e6bd` (fe-impostazioni), `f29949f` (fe-impostazioni) |
| 15-06 | medio | L'editor degli orari dice che gli orari «non limitano le prenotazioni», ma le limitano | FATTO | `b935dae` (fe-impostazioni) |
| 15-07 | medio | Rinominare un'etichetta cliente disattiva in silenzio regole caparra e filtri delle automazioni, e il menu mostra un'altra etichetta | FATTO | `0487e86` (clienti), `a45aaee` (fe-impostazioni), `b935dae` (fe-impostazioni), `f4dc994` (integrazione) |
| 15-08 | medio | Tre azioni irreversibili partono al primo clic: elimina etichetta, elimina ruolo, scollega Stripe | FATTO | `b935dae` (fe-impostazioni) |
| 15-09 | medio | Il registro attività mostra ora e «Oggi/Ieri» nel fuso del dispositivo | FATTO | `b935dae` (fe-impostazioni) |
| 15-10 | basso | I ruoli «di sistema» sono dichiarati non modificabili ma l'API li riscrive | FATTO | `333d3f4` (accounts-staff-inv) |
| 15-11 | basso | Esc chiude il pannello sotto invece della finestra in primo piano | FATTO | `735e6bd` (fe-impostazioni), `aec1aec` (fe-impostazioni), `a596286` (prima del pool) |
| 15-12 | basso | Il selettore colore della categoria nella scheda prodotto salva e ricarica tutto il magazzino a ogni movimento del cursore | FATTO | `735e6bd` (fe-impostazioni) |
| 15-13 | basso | Automazioni: attivare/disattivare dalla lista (o una modifica altrui) cancella le modifiche non salvate nel costruttore | FATTO | `a45aaee` (fe-impostazioni) |
| 15-14 | basso | «Il giorno più scarico» indica un giorno di chiusura | FATTO | `dda9bca` (core-insights), `a45aaee` (fe-impostazioni) |
| 15-15 | basso | Analisi dati: se l'intervallo personalizzato fallisce restano a video i numeri del periodo precedente sotto il titolo «intervallo scelto» | FATTO | `a45aaee` (fe-impostazioni) |
| 15-16 | basso | Regola caparra: passando da importo fisso a percentuale il valore non viene limitato a 100 | FATTO | `f41769d` (core-insights), `b935dae` (fe-impostazioni) |
| 15-17 | basso | Il permesso «Analisi dati» si può assegnare ma non dà accesso a nulla | FATTO | `dda9bca` (core-insights), `aec1aec` (fe-impostazioni) |
| 15-18 | basso | Scheda operatrice: la «Media» degli incassi è arrotondata all'euro e poi scritta con i centesimi | FATTO | `f29949f` (fe-impostazioni) |
| 15-19 | basso | Salvataggio riuscito trattato come fallito quando fallisce il passo successivo: al nuovo tentativo nascono doppioni | FATTO | `a45aaee` (fe-impostazioni), `735e6bd` (fe-impostazioni), `f29949f` (fe-impostazioni) |
| 15-20 | basso | Nuova regola caparra e nuova categoria senza guardia contro il doppio clic | FATTO | `b935dae` (fe-impostazioni) |
| 15-21 | basso | Magazzino: gli aggiornamenti in tempo reale rinfrescano le cifre in testata ma non la tabella né gli ordini | FATTO | `735e6bd` (fe-impostazioni) |
| 15-22 | basso | Altre date e giorni letti sull'orologio del dispositivo invece che su quello del salone | FATTO | `a45aaee` (fe-impostazioni), `b935dae` (fe-impostazioni), `f29949f` (fe-impostazioni), `aec1aec` (fe-impostazioni) |

## 16 — App cliente e condiviso

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 16-01 | alto | Il tetto OTP per salone si riempie con numeri inventati e blocca l'accesso a tutte le clienti | FATTO | `cc444e0` (accounts-staff-inv) |
| 16-02 | medio | PhoneInput: il «+» battuto sparisce e il prefisso battuto a mano diventa doppio | FATTO | `9842b42` (fe-cliente-shared) |
| 16-03 | medio | GiftCard: il «Saldo gift card… spendibili in salone» somma anche le carte ancora da pagare | FATTO | `4cfe2e4` (fe-cliente-shared), `03f098e` (marketing) |
| 16-04 | medio | Un'operatrice di un'altra sede compare nel selettore: mostra gli orari di una collega, poi 400 alla conferma | FATTO | `8000d3c` (accounts-staff-inv) |
| 16-05 | medio | La Home della cliente loggata non si aggiorna mai: «Oggi/Domani», caparra e dati restano quelli del caricamento | FATTO | `4add147` (fe-cliente-shared) |
| 16-06 | basso | Spostamento e annullamento dall'app restituiscono alla cliente la nota interna dello staff | FATTO | `8bc8f61` (ag-disp), `8d34f0b` (ag-disp) |
| 16-07 | basso | «Carta mia» nell'app (`received`) non coincide con la regola del backend (gift_index) | FATTO | `4cfe2e4` (fe-cliente-shared), `03f098e` (marketing) |
| 16-08 | basso | findBooked può scambiare un altro appuntamento allo stesso orario per quello appena tentato | FATTO | `51be71e` (fe-cliente-shared) — resta scoperto il primo invio ancora in volo: vedi Aperti |
| 16-09 | basso | «Esci» dal Profilo riapre subito la schermata di accesso (K6 corretto solo in Utility) | FATTO | `cec710c` (fe-cliente-shared) |
| 16-10 | basso | AuthFlow: con Invio parte request-otp anche per un numero non plausibile | FATTO | `56762b4` (fe-cliente-shared) |
| 16-11 | basso | phone.js e phone.py divergono su due casi di testo grezzo | FATTO | `870b056` (clienti), `9842b42` (fe-cliente-shared) |
| 16-12 | basso | Coupon in percentuale arrotondato nel portafoglio | FATTO | `4cfe2e4` (fe-cliente-shared) |

## 17 — Contratto frontend↔backend

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 17-01 | medio | Riassegnare un appuntamento dalla colonna di un'operatrice disattivata risponde 404 «Not Found» | FATTO | `1e47625b` (prima del pool) |
| 17-02 | medio | Centesimi arrotondati diversamente da cassa (float) e server (Decimal HALF_UP): vendita rifiutata | FATTO | `2292243` (fe-cassa-fedelta) |
| 17-03 | medio | Cassa bloccata se la caparra supera il totale scontato, che il server ora accetta | FATTO | `f9826c4` (fe-cassa-fedelta) |
| 17-04 | medio | Storico cliente: per chi non ha «vendite» ogni visita chiusa risulta «non incassato» | FATTO | `fc0757b` (clienti), `528513d` (fe-clienti) |
| 17-05 | medio | «Annulla» del pannello fa uno spostamento forzato al contrario invece del torna indietro | FATTO | `b472859` (fe-modali) |
| 17-06 | medio | «Sposta qui» alla stessa ora su un altro giorno non fa niente | FATTO | `4a8d330` (fe-griglia) |
| 17-07 | medio | Operatrice disattivata: la disponibilità propone un'altra operatrice, lo spostamento tiene quella disattivata (A13 incompleto) | FATTO | `7c7f62b` (ag-disp), `8d34f0b` (ag-disp) |
| 17-08 | basso | Viste settimana e mese non si aggiornano su `deposit.*` (M1 corretto solo nella vista giorno) | FATTO | `4a8d330` (fe-griglia) |
| 17-09 | basso | Nuova prenotazione: «Regalo» con regole diverse da `gifts[]` del server | FATTO | `f9fea5a` (fe-modali), `03f098e` (marketing) |
| 17-10 | basso | Modificare/ridimensionare una visita con una riga di un'operatrice disattivata → 400 «Operatrice non idonea», anche con force | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 17-11 | basso | Scope «insights» assegnabile ma ignorato (M6 non corretto) | FATTO | `dda9bca` (core-insights), `aec1aec` (fe-impostazioni) |
| 17-12 | basso | Errori 422 di validazione in inglese e senza il nome del campo | FATTO | `4e5e764` (fe-cliente-shared), `f9fea5a` (fe-modali), `af3ec25` (fe-modali) |
| 17-13 | basso | Errori della prima sincronizzazione Yourang ancora invisibili (H17 incompleto) | FATTO | `b935dae` (fe-impostazioni), `c657630` (integrazioni) |
| 17-14 | basso | App cliente, schermata Gift card: il saldo somma carte da pagare e carte regalate ad altri | FATTO | `4cfe2e4` (fe-cliente-shared), `03f098e` (marketing) |
| 17-15 | basso | Istanti dell'API letti col fuso del dispositivo | FATTO | `5091ffd` (fe-cassa-fedelta), `b935dae` (fe-impostazioni), `f143772` (fe-modali) |
| 17-16 | basso | Carico merce: un prodotto nuovo con SKU verrebbe creato col nome uguale allo SKU | FATTO | `735e6bd` (fe-impostazioni) |

## 18 — Concorrenza e integrità dati

| ID | Gravità | Difetto | Stato | Correzione |
|---|---|---|---|---|
| 18-01 | alto | «Torna indietro» su una creazione con caparra: il link di pagamento resta vivo e il pagamento finisce nel nulla | FATTO | `11dbbac` (ag-caparra), `82b881e` (ag-life) |
| 18-02 | alto | `phone_key` scritta con l'algoritmo del 17/09 e mai ricalcolata dopo la modifica di `normalize_phone` (9991cb5) | FATTO | `b45d749` (clienti) |
| 18-03 | medio | Undo del no-show dopo l'addebito della carta: l'appuntamento torna confermato con la vendita no-show attaccata e il conto non si chiude più | FATTO | `da6a172` (ag-life) |
| 18-04 | medio | La fusione degli eventi trattenuti perde informazione verso la cliente e la lista d'attesa | FATTO | `82b881e` (ag-life) |
| 18-05 | medio | L'outbox non rispetta l'ordine per oggetto: un evento in ritentativo parte dopo uno più recente dello stesso appuntamento/automazione | FATTO | `96714a6` (ag-life), `0ce7b03` (integrazione), `5e8a5f2` (integrazione) |
| 18-06 | medio | PUT dell'appuntamento con id di riga non più esistenti: i servizi vengono riprezzati dal listino senza errore | FATTO | `6542814` (ag-disp), `8d34f0b` (ag-disp) |
| 18-07 | medio | Salvataggi completi e decisioni su copie lette a inizio richiesta (classe) | FATTO | `e7582fd` (accounts-staff-inv), `cc444e0` (accounts-staff-inv), `85321b8` (clienti), `566406d` (clienti), `f41769d` (core-insights), `c657630` (integrazioni), `f861b89` (marketing), `4c16fd1` (marketing), `03f098e` (marketing) |
| 18-08 | basso | `lock_salon()` con FOR UPDATE: deadlock con chi blocca un appuntamento e poi committa righe legate al salone | FATTO | `b39a8cf` (ag-caparra), `07d5de6` (ag-caparra), `e097b0b` (ag-life), `5e8a5f2` (integrazione) |
| 18-09 | basso | Worker outbox: `_claim` non ricontrolla la scadenza e `deliver_event` invia il payload letto prima del claim | FATTO | `96714a6` (ag-life) |
| 18-10 | basso | Cursore del feed live su id autoincrementale: eventi committati fuori ordine saltati per sempre | FATTO | `341916a` (core-insights) |
| 18-11 | basso | `ensure_customer` non idempotente: due Customer Stripe e carta sul cliente sbagliato | FATTO | `b39a8cf` (ag-caparra) |
| 18-12 | basso | Registrazione dall'app: doppio invio = 500 (correzione L20 del 18/09 incompleta) | FATTO | `cc444e0` (accounts-staff-inv) |
| 18-13 | basso | `cancel_event` (Yourang) annulla con `queryset.update` saltando la logica di dominio | FATTO | `ce4689b` (integrazioni) |
| 18-14 | basso | `replace_shifts`: cancella-e-ricrea senza lock, due salvataggi concorrenti raddoppiano i turni | FATTO | `8000d3c` (accounts-staff-inv) |
| 18-15 | basso | Primo accesso Yourang non atomico: due accessi simultanei della stessa org → 500 | FATTO | `c657630` (integrazioni) |
