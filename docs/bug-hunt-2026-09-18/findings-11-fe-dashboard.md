# Bug hunt — frontend dashboard (escluso `sections/agenda/`)

Ambito: `frontend/apps/dashboard/src/` (ctx, shell, ui, modals, LoginPage, App, main e tutte le
sezioni tranne `agenda/`). Verificato leggendo il codice e, dove serviva, il contratto backend.

Conteggio: **2 alti · 9 medi · 6 bassi** (17 difetti).

---

## [J1] Gli importi con i centesimi vengono mostrati troncati: 35,50 € diventa «€35,5»
- **Gravità**: alto
- **Dove**: `frontend/packages/shared/src/format.js:4` (usato da `sections/pos/lib.js:24`, `sections/staff/lib.js:189`, `sections/magazzino/OrdiniSub.jsx:351,367,369,381-383`, `sections/clienti/tabs/WalletTab.jsx:197`, `sections/clienti/tabs/StoricoTab.jsx:127`, `sections/servizi/*`, `sections/fedelta/GiftSub.jsx:94-96`)
- **Cosa**: `fmtEur` fa `'€' + Number(n).toLocaleString(loc)` senza `minimumFractionDigits`/`maximumFractionDigits`. Verificato: `35.50 -> "€35,5"`, `12.30 -> "€12,3"`, e nel senso opposto `8.415 -> "€8,415"` (3 decimali). Tutte le cifre di denaro della dashboard passano di qui.
- **Scenario**: al banco POS si vende un prodotto da 35,50 €; carrello, pulsante «Completa vendita» e riepilogo a video scrivono «€35,5». In Magazzino -> Ordini, con prezzo d'acquisto 9,90 € e sconto fornitore 15%, «Prezzo un.» mostra «€8,415» e il totale ordine somma con tre decimali, mentre il PDF dello stesso ordine (`sections/magazzino/lib.js:100`, che usa `minimumFractionDigits: 2`) mostra 8,42 €: video e stampa non coincidono.
- **Fix**: in `fmtEur` passare `{ minimumFractionDigits: 2, maximumFractionDigits: 2 }` a `toLocaleString` (e arrotondare a 2 decimali prima di sommare i totali d'ordine).

## [J2] Il «Margine» del prodotto confronta prezzo IVA inclusa e costo IVA esclusa: è gonfiato di tutta l'IVA
- **Gravità**: alto
- **Dove**: `frontend/apps/dashboard/src/sections/magazzino/ProductDrawer.jsx:316-321` (mostrato a riga 330)
- **Cosa**: nella stessa scheda il prezzo d'acquisto è dichiarato «IVA esclusa» (riga 296) e il prezzo di vendita «IVA inclusa» (riga 306), ma il margine è `sale - net`, cioè un prezzo lordo meno un costo netto. La percentuale `margin / sale` eredita lo stesso errore.
- **Scenario**: prodotto comprato a 10,00 € + IVA 22% e rivenduto a 20,00 € IVA inclusa. La scheda dice «Margine €10 · 50%»; il margine reale è 20/1,22 − 10 = 6,39 € (circa 32%). Il titolare fissa i prezzi su un numero sovrastimato del 22%.
- **Fix**: scorporare l'IVA dal prezzo di vendita — `const margin = sale / (1 + vat/100) - net;` — oppure confrontare `sale` con `buyIncl`, già calcolato a riga 317.

## [J3] `fmtEur(0)` scrive «Gratis»: una gift card esaurita mostra «Gratis» al posto di «€0»
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx:197,220,231`; `sections/fedelta/GiftSub.jsx:94-96`; `sections/magazzino/OrdiniSub.jsx:381-383`
- **Cosa**: `fmtEur` ritorna `'Gratis'`/`'Free'` quando il valore è 0 (convenzione dei listini servizi). Il progetto lo sa e ha tre wrapper apposta (`pos/lib.js:24 money`, `magazzino/lib.js:49 eur0`, `insight/index.jsx:104`), ma questi punti chiamano `fmtEur` nudo.
- **Scenario**: una cliente consuma tutta la gift card; nella scheda cliente -> Wallet la card compare con saldo «Gratis» e il dettaglio scrive «Saldo: Gratis». Idem in Promozioni -> Gift card, dove i KPI «Valore venduto / Già riscattato / Da riscattare» leggono «Gratis» finché non c'è nessuna card.
- **Fix**: usare `eur0(...)` (o `money(...)`) anche in questi file invece di `fmtEur` diretto.

## [J4] Import CSV clienti: le righe in errore sono numerate sulla lista filtrata, non sul file
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/modals/BulkImportModal.jsx:242,249,286` (confronta con l'anteprima a riga 418)
- **Cosa**: `payload = ready.map(...)` scarta le righe `_skip`; il backend rinumera gli errori sull'indice del blocco ricevuto (`backend/apps/clients/services.py`, `{"row": index}`), quindi `e.row + i` è l'indice dentro `payload`. L'esito lo stampa come «Riga {e.row + 1}», mentre lo step 3 numera le righe con `r._idx + 1` (indice nel file). I due numeri divergono di quante righe sono state saltate prima.
- **Scenario**: si importa un CSV di 200 clienti dove le prime 10 righe sono senza telefono (saltate); il server rifiuta la riga 50 del file; l'esito dice «Riga 40 — Nome mancante» e chi corregge il file va a cercare la riga sbagliata.
- **Fix**: portarsi dietro l'indice originale (`ready[k]._idx`) nel payload e stamparlo nell'esito al posto dell'indice di `payload`.

## [J5] Scheda cliente: due modifiche ravvicinate si sovrascrivono (stato stantio in `updateClient`)
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/ClientProfile.jsx:58-66` (chiamanti: `:180`, `:198`, `:263`, `:279`)
- **Cosa**: `updateClient` costruisce il corpo con `toClientIn(c, patch)` dove `c` è lo stato del render corrente, e `assignedIds` (riga 110) è calcolato dallo stesso `c`. Le PUT sono a corpo completo (vedi commento in `helpers.js:31`): finché la prima risposta non è arrivata, la seconda parte dallo stesso `c` e riscrive tutti i campi.
- **Scenario**: nel menù etichette si clicca «VIP» e subito dopo «Colore»: partono due PUT con `category_ids` calcolati entrambi sulla lista di partenza, e la seconda cancella l'etichetta appena aggiunta dalla prima. Stesso effetto togliendo un'etichetta mentre è in volo il cambio lingua.
- **Fix**: serializzare le mutazioni (coda/`await` con flag `saving`) o costruire il corpo dentro `setC((prev) => ...)` partendo sempre dall'ultimo stato noto.

## [J6] Salvare i turni scrive anche le modifiche non salvate della scheda Anagrafica
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/staff/StaffPage.jsx:111-131` (righe 121-124, con `buildPayload` a `:82-94`)
- **Cosa**: quando il numero di settimane del ciclo cambia, `saveShifts` fa `api.put('/api/staff/{id}', buildPayload(weeks.length))`: `buildPayload` legge tutto `form` (nome, cognome, ruolo, sede, costo orario, servizi abilitati, attiva), cioè lo stato del form Anagrafica anche se l'utente non ha premuto «Salva» lì.
- **Scenario**: si apre un'operatrice, si abbassa per prova il costo orario a 0 e si toglie la spunta «Operatrice attiva», poi si cambia idea e si passa alla scheda «Turni e ferie», si aggiunge una settimana e si preme «Salva turni». Le modifiche abbandonate dell'anagrafica vengono persistite: l'operatrice sparisce dall'agenda.
- **Fix**: per la sincronizzazione del ciclo mandare i valori di `detail` (server) e non di `form`, oppure usare una patch che tocchi solo `cycle_weeks`.

## [J7] Wallet cliente: i punti fedeltà si perdono oltre le prime 200 iscritte
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx:34-46` (riga 39: `params: { limit: 200 }`)
- **Cosa**: per ogni programma attivo si scarica una sola pagina di 200 account e si cerca la cliente lato client (`acc.items.find(...)`). Se non è in quella pagina, `points` resta `null` e la UI (righe 152-153) dichiara «Non ancora iscritta al programma», con barra a 0.
- **Scenario**: salone con 600 tessere fedeltà; si apre una cliente storica con 9 timbri su 10 e la sua scheda dice che non è iscritta — l'operatrice non le riconosce il premio. Lo stesso schema (query larga + filtro locale) è usato per i coupon con `limit: 100` alla riga 25.
- **Fix**: interrogare l'endpoint filtrando per cliente (`client_id`) o paginare fino a trovarla; in mancanza, distinguere «non iscritta» da «non verificabile».

## [J8] Ordini fornitore: prezzi e IVA a 0 (silenziosi) per i prodotti oltre i primi 500
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/magazzino/OrdiniSub.jsx:24-28,124-136`, alimentato da `sections/magazzino/index.jsx:28` (`limit: 500`)
- **Cosa**: le righe d'ordine non portano il prezzo: viene arricchito lato client da `prodById`, costruito sullo snapshot `allProds` caricato con `limit: 500`. Per un prodotto assente dallo snapshot `unitCost(undefined)` vale 0 e `vat` vale 0; non c'è nessun segnale a video (il backend accetta `limit=500` senza tetto, quindi il taglio è puramente lato client).
- **Scenario**: catalogo con più di 500 articoli; la bozza d'ordine generata include un articolo oltre il 500°: riga a «Gratis», imponibile e IVA sottostimati, e il PDF inviato al fornitore riporta 0,00 € su quella riga.
- **Fix**: caricare per id i prodotti che servono all'ordine invece di affidarsi a uno snapshot troncato, o almeno marcare le righe senza prezzo noto e non sommarle come 0.

## [J9] «Carica altre» può appendere risultati del filtro precedente
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/pos/HistoryTab.jsx:54-64`; stesso schema in `sections/clienti/index.jsx:55-64`
- **Cosa**: `loadMore` non ha il guard `dead`/`alive` che ha invece la fetch principale (`HistoryTab.jsx:38-52`) e cattura i filtri al momento del clic. La risposta viene appesa con `setItems((l) => [...l, ...])` senza verificare che i filtri siano ancora quelli.
- **Scenario**: nello Storico vendite si preme «Carica altre vendite» e mezzo secondo dopo si cambia il filtro operatrice; quando la risposta arriva, le 50 vendite della vecchia operatrice vengono appese in coda alla nuova lista, con un conteggio in testata che non corrisponde.
- **Fix**: annullare la richiesta in volo (token/`AbortController` o flag di generazione dei filtri) e scartare la risposta se i parametri sono cambiati.

## [J10] Coupon: cambiare filtro mentre si è a pagina 2+ lancia due richieste e può mostrare la pagina sbagliata
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/fedelta/CouponSub.jsx:37` e `:61`
- **Cosa**: due effetti separati — uno azzera `offset` quando cambiano `originF/statusF`, l'altro rifà la fetch. Nel commit in cui il filtro cambia, il secondo effetto gira ancora con l'`offset` vecchio; poi `offset = 0` fa partire una seconda fetch. Entrambe hanno il proprio `alive`, quindi nessuna viene scartata: vince l'ultima che risponde.
- **Scenario**: si va a pagina 3 dei coupon e si filtra «Da fedeltà»; se la richiesta con `offset=48` risponde per ultima si vedono i coupon dell'offset 48 mentre il pager in fondo dice «1–24 di N».
- **Fix**: un solo effetto con filtri e offset nelle dipendenze, azzerando l'offset nello stesso handler che cambia il filtro (come già fa `ProdottiSub` con `resetPage`).

## [J11] Comunicazioni: la ricerca guarda solo la prima pagina caricata
- **Gravità**: medio
- **Dove**: `frontend/apps/dashboard/src/sections/comunicazioni/index.jsx:52-56` e `:108`
- **Cosa**: il filtro testuale è client-side sui soli `items` già scaricati (PAGE = 24) e, quando c'è una ricerca attiva, il pulsante «Carica altre» viene nascosto (`!needle && items.length < count`): non c'è modo di far entrare nel filtro le campagne successive.
- **Scenario**: archivio con 60 comunicazioni; si cerca «Natale» (campagna dell'anno scorso, quindi oltre la prima pagina) e la sezione risponde «Nessun risultato», senza alcun indizio che stia cercando solo fra le prime 24.
- **Fix**: caricare tutte le pagine prima di filtrare, o dichiarare a video che la ricerca è limitata alle campagne caricate lasciando visibile «Carica altre».

## [J12] Magazzino: «Valore magazzino» e «Prodotti» sono calcolati su uno snapshot troncato a 500
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/magazzino/ProdottiSub.jsx:59-61` (dati da `sections/magazzino/index.jsx:28`)
- **Cosa**: le metriche in testata sommano `allProds` (max 500 articoli), mentre la tabella sotto pagina sul server e mostra il `count` reale. Le due cifre divergono senza avvisi; anche il pallino «sotto soglia» sulla linguetta Ordini (`index.jsx:43-46,64`) usa la lista tagliata.
- **Scenario**: catalogo da 800 articoli: la card dice «Prodotti 500» e un valore di magazzino sottostimato, la tabella accanto dice «di 800».
- **Fix**: chiedere al server gli aggregati (o almeno il conteggio) invece di derivarli da una pagina.

## [J13] `useLive`: il debounce non funziona fra un evento e l'altro e il timer non viene fermato allo smontaggio
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/ctx.jsx:13-28` (righe 21-26)
- **Cosa**: `live` è un `useMemo` che cambia identità a ogni evento consegnato (`events`/`unread`/`version` sono stati), quindi l'effetto di `useLive` si rimonta a ogni consegna e la variabile locale `timer` riparte da `null`: il `clearTimeout(timer)` non coalizza mai due eventi vicini. Inoltre la cleanup restituisce solo l'unsubscribe, senza `clearTimeout`.
- **Scenario**: un'altra postazione salva tre appuntamenti in mezzo secondo -> la sezione Clienti fa tre ricarichi invece di uno. Se si cambia sezione entro 250 ms dall'ultimo evento la callback parte comunque su un componente smontato (in `ClientProfile.jsx:41-43` produce una GET inutile).
- **Fix**: tenere il timer in un `useRef` e ripulirlo nella cleanup; dipendere da `live.subscribe` (stabile) invece che dall'oggetto `live`.

## [J14] Scontrino medio della cliente arrotondato all'euro
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/ClientProfile.jsx:220`
- **Cosa**: `fmtEur(Math.round(totalSpent / Math.max(1, visits)), lang)` arrotonda il valore prima di formattarlo (il KPI «Valore totale» accanto non lo fa).
- **Scenario**: cliente con 2 visite e 95,00 € di spesa: «Scontrino medio €48» invece di €47,50, mentre il totale accanto continua a dire €95.
- **Fix**: togliere `Math.round` e lasciare la formattazione a due decimali (vedi J1).

## [J15] `Cons` e `Section` sono definiti dentro il render: i toggle consensi perdono il fuoco a ogni clic
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/clienti/modals/NewClientModal.jsx:71-80` (stesso schema per `Steps` in `modals/BulkImportModal.jsx:295`)
- **Cosa**: essendo ricreati a ogni render sono un tipo di componente nuovo ogni volta, quindi React smonta e rimonta il sottoalbero a ogni battuta di tasto o cambio di stato del form.
- **Scenario**: nella creazione cliente si raggiunge con Tab il toggle «Comunicazioni marketing» e si preme Spazio: il valore cambia ma il pulsante viene rimontato e il fuoco torna a inizio documento, quindi il Tab successivo riparte dall'alto.
- **Fix**: spostare `Cons`/`Section`/`Steps` fuori dal componente (come già fatto in `impostazioni/index.jsx:27-46`).

## [J16] Regole deposito: attivare/disattivare una regola butta via le modifiche non salvate
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/sections/impostazioni/DepositRules.jsx:113` e `:133-139`
- **Cosa**: `toggleActive` invia i valori del server (`rule.conditions`, `rule.amount`, …) ignorando `draft`; al ritorno il nuovo oggetto `rule` fa scattare l'effetto a riga 113 che rifà `setDraft(toDraft(rule))` e `setDirty(false)`.
- **Scenario**: si apre una regola, si porta l'acconto dal 30% al 50% e si aggiunge una condizione, poi si clicca l'interruttore per disattivarla momentaneamente: il form torna a 30% e alla vecchia condizione, senza avvisi, e «Salva regola» si spegne.
- **Fix**: disabilitare l'interruttore quando `dirty`, oppure inviare `draftConditions`/`draft.amount` anche nel toggle.

## [J17] Login con Yourang: chiudendo il popup il pulsante resta bloccato su «Connessione…»
- **Gravità**: basso
- **Dove**: `frontend/apps/dashboard/src/LoginPage.jsx:30-49`
- **Cosa**: `setYourangBusy(true)` viene azzerato solo dall'arrivo di un `postMessage` di tipo `yourang-oauth`. Se l'utente chiude la finestra OAuth (o questa muore prima di rispondere) non arriva nessun messaggio e non c'è né un timeout né un controllo su `popup.closed`.
- **Scenario**: si clicca «Accedi con Yourang», ci si accorge di aver sbagliato account e si chiude il popup: il pulsante resta disabilitato con la scritta «Connessione…» e per riprovare bisogna ricaricare la pagina.
- **Fix**: sondare `popup.closed` con un intervallo (o un timeout di sicurezza) e rimettere `yourangBusy` a false.
