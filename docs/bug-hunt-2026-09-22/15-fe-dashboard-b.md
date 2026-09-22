# Revisore 15 — dashboard: impostazioni, staff, servizi, magazzino, insight, automazioni, guscio

Conteggio: 1 alto (plausibile) · 8 medi · 13 bassi (22 reperti).

Probe usati (poi cancellati): `apps/accounts/tests_probe_fe_dashboard_b.py`,
`apps/inventory/tests_probe_fe_dashboard_b.py`.

---

### [ALTO] 15-01 La pagina di accesso di produzione indica l'account demo, che il seed crea superuser con password pubblica
- File: `frontend/apps/dashboard/src/LoginPage.jsx:116-118`; `backend/apps/core/management/commands/seed_demo.py:155-162`; `DEPLOY.md:320-331`
- Stato: PLAUSIBILE (il codice è certo; non posso verificare se l'utente esiste nel database di produzione)
- Difetto: sotto il modulo di login, in produzione, compare fisso «Demo: sole@theparlour.it». `seed_demo` crea quell'utente con `is_staff=True, is_superuser=True` e password `theparlour`, e sia `DEPLOY.md` §7 («puoi tenerlo accanto ai dati reali») sia `INTEGRATION_NOTES.md` riportano email e password in chiaro. La pagina pubblica consegna quindi a chiunque metà della credenziale, e l'altra metà è scritta nella documentazione.
- Scenario: se il salone demo è stato seminato sul server come suggerisce la guida, chiunque apra `beauty.yourang.ai` legge l'email, prova `theparlour` ed entra: nella dashboard come titolare di «The Parlour», e soprattutto in `/admin/` come superuser, cioè con accesso a tutti i saloni.
- Correzione: togliere il suggerimento dalla pagina di login (o mostrarlo solo con `import.meta.env.DEV`); verificare in produzione se `sole@theparlour.it` esiste e disattivarlo; nel seed niente `is_superuser` e una password casuale stampata a video.

### [MEDIO] 15-02 Chi ha il solo «team» può togliere il ruolo a una collega con più permessi (rimuoverla invece è vietato)
- File: `backend/apps/accounts/api.py:384-409` (`set_member_role`); `frontend/apps/dashboard/src/sections/impostazioni/TeamDrawer.jsx:136-144`
- Stato: CONFERMATO (probe `DemoteProbe`: rimozione → 403, ma `role_id: null` → 200 e ruolo più stretto → 200)
- Difetto: `remove_member`, `update_role` e `delete_role` chiamano `_require_can_touch_role` («chi non è titolare non fa piazza pulita dei colleghi con più permessi di lui»), `set_member_role` no: controlla solo che il ruolo NUOVO sia concedibile, e «Nessun ruolo» salta anche quel controllo. La UI rispecchia il buco: nel menu del membro le voci «non assegnabile» sono spente, ma «Nessun ruolo» e i ruoli più stretti restano selezionabili anche per una collega il cui ruolo attuale il chiamante non potrebbe toccare.
- Scenario: la titolare crea «Personale» (team + agenda + clienti) per la responsabile del personale. Questa apre Membri del team e sul membro «Manager» sceglie «Nessun ruolo»: la Manager perde all'istante vendite, magazzino, listino e marketing, cioè esattamente ciò che la regola sulla rimozione voleva impedire.
- Correzione: in `set_member_role`, se il chiamante non è titolare, `_require_can_touch_role(ctx, membership.role)` prima di cambiare ruolo; nel TeamDrawer disabilitare il menu quando `!canAssign(m.role)`.

### [MEDIO] 15-03 Due pulsanti «Salva» nella stessa pagina: quello in evidenza butta via le modifiche dell'altra parte e conferma «salvato»
- File: `frontend/apps/dashboard/src/sections/impostazioni/BookingsOptimPage.jsx:71-90,216-228`; `frontend/apps/dashboard/src/sections/staff/StaffPage.jsx:186-190,302,317,518`; `sections/staff/ShiftPattern.jsx:73-75`
- Stato: CONFERMATO (percorso ripercorso nel codice)
- Difetto: in «Prenotazioni & ottimizzazione» le regole caparra stanno subito sopra il grande «Salva» a tutta larghezza, che salva solo le impostazioni e poi chiama `onBack()`: la pagina si smonta e le bozze delle regole (salvabili solo con il «Salva regola» dentro la card) spariscono. Nella scheda operatrice il «Salva» dell'intestazione resta visibile anche nella linguetta «Turni e ferie» ma esegue `saveBasics` (solo anagrafica), mentre i turni si salvano col «Salva turni» in fondo al pattern. In più, «Crea e abilita» mostra «Servizio creato e abilitato» ma l'abilitazione è solo nel form non salvato (per chi ha `pricing` senza `team` non si salverà mai).
- Scenario: la titolare porta l'acconto di una regola dal 30% al 50%, scorre in basso e preme «Salva»: toast «Impostazioni salvate», si torna indietro, la regola resta al 30%. In Staff si cambia il sabato da «9–13» a «9–19», si preme il «Salva» in alto: «Modifiche salvate», si esce, i turni sono quelli vecchi e il sabato pomeriggio non è prenotabile.
- Correzione: un solo salvataggio per pagina che includa tutte le parti sporche, oppure il «Salva» principale disabilitato/avvisato quando c'è una bozza non salvata altrove (regola caparra, pattern turni); il toast di creazione servizio deve dire che va salvato.

### [MEDIO] 15-04 «Carico merce» manda nome/SKU e non l'id del prodotto scelto: la merce finisce su un altro articolo, anche disattivato
- File: `frontend/apps/dashboard/src/sections/magazzino/RestockModal.jsx:29-31,42-49,65-66`; `backend/apps/inventory/api.py:300-306`
- Stato: CONFERMATO (probe `RestockTargetProbe`: stesso nome → il carico va al vecchio articolo disattivato; stesso SKU con due fornitori → va al primo)
- Difetto: l'utente sceglie un prodotto preciso dall'elenco (o il CSV viene abbinato a un prodotto attivo), ma il corpo contiene solo `{name: l.sku ? '' : l.name, sku}`. Il server ripete l'abbinamento con `filter(sku__iexact).first()` / `filter(name__iexact).first()` su TUTTI i prodotti, disattivati compresi: il bersaglio non è quello che l'interfaccia ha mostrato. L'esito a video riporta lo stesso nome, quindi non si nota.
- Scenario: la titolare disattiva «Shampoo Idratante» (vecchio fornitore) e crea un nuovo «Shampoo Idratante»; arriva la merce, «Carico merce» → sceglie il nuovo → +12. Il nuovo resta a 0 e sotto soglia (e rientra nelle bozze d'ordine), i 12 pezzi finiscono sull'articolo nascosto. Stesso effetto con lo stesso codice produttore presso due distributori.
- Correzione: per le righe con prodotto noto mandare `product_id` (nuovo campo in `CsvRowIn`, usato prima di SKU/nome); per l'abbinamento testuale privilegiare i prodotti attivi.

### [MEDIO] 15-05 Operatrici e prodotti disattivati spariscono dagli elenchi e non si possono più riattivare dalla dashboard
- File: `frontend/apps/dashboard/src/sections/staff/StaffGrid.jsx:31`, `StaffPage.jsx:252-258` con `backend/apps/staff/api.py:218`; `frontend/apps/dashboard/src/sections/magazzino/ProdottiSub.jsx:40-50`, `ProductDrawer.jsx:159,204`
- Stato: CONFERMATO (percorso ripercorso: nessuna vista elenca gli inattivi)
- Difetto: la scheda operatrice ha l'interruttore «Operatrice attiva», ma `GET /api/staff/` restituisce solo le attive e la griglia Staff legge solo quella lista: una volta salvata «non attiva» la scheda non si riapre più. Per i prodotti «Disattiva» è un clic senza conferma e la tabella Prodotti chiede la lista senza `include_inactive`, mentre la scheda prodotto non ha un comando per rimettere `active: true`. Un'azione che l'interfaccia presenta come reversibile è di fatto definitiva.
- Scenario: un'operatrice va in maternità e la si disattiva; al rientro non c'è modo di riattivarla, e crearne una nuova collegata allo stesso utente fallisce («Utente già collegato a …», perché l'`Operator` inattivo tiene l'utente). Un prodotto disattivato per errore va ricreato, e il doppione alimenta il reperto 15-04.
- Correzione: filtro «Mostra archiviate/disattivati» nelle due liste (`GET /api/staff/?include_inactive=true` da aggiungere, `include_inactive` già esistente per i prodotti) e l'interruttore attivo/disattivo nella scheda prodotto.

### [MEDIO] 15-06 L'editor degli orari dice che gli orari «non limitano le prenotazioni», ma le limitano
- File: `frontend/apps/dashboard/src/sections/impostazioni/HoursDrawer.jsx:110-112`; `backend/apps/staff/services.py:156-158`, `backend/apps/agenda/services.py:500-515`
- Stato: CONFERMATO (codice e test `apps/staff/tests.py` sull'intersezione con `opening_hours_week`)
- Difetto: il testo sotto l'editor recita «Gli orari compaiono nell'app cliente e in cima all'agenda. Non limitano da soli le prenotazioni: quelle seguono i turni delle operatrici». Dal 16/09 invece `shift_windows` interseca i turni con le fasce del giorno (giorno senza fasce = chiuso) e `_ensure_within_opening` rifiuta le catene che finiscono dopo la chiusura: gli orari sono un vincolo per disponibilità online, vista giorno e occupazione.
- Scenario: la titolare imposta «a occhio» sabato 9–13 e domenica chiusa, fidandosi del testo; le operatrici con turno sabato 9–18 non sono più prenotabili il pomeriggio dall'app cliente, e in agenda servono prenotazioni forzate. Nessuno capisce perché gli orari siano spariti.
- Correzione: riscrivere il testo («Fuori da questi orari non si prenota, anche se l'operatrice è in turno; lo staff può forzare») e ricordarlo alla chiusura di un giorno.

### [MEDIO] 15-07 Rinominare un'etichetta cliente disattiva in silenzio regole caparra e filtri delle automazioni, e il menu mostra un'altra etichetta
- File: `frontend/apps/dashboard/src/sections/impostazioni/lib.jsx:101,167`; `sections/automazioni/controls.jsx:19`, `sections/automazioni/DkCondRow.jsx:50-55`; `sections/impostazioni/modals/CategoriesManagerModal.jsx:58-66`
- Stato: CONFERMATO (percorso ripercorso: le condizioni salvano il NOME e `client_facts` confronta i nomi)
- Difetto: le condizioni «Etichetta cliente» memorizzano `value: c.name`. Rinominando l'etichetta dal gestore categorie nessuno aggiorna regole e automazioni, che smettono di scattare. In più `DkDrop` quando il valore salvato non è fra le opzioni mostra `options[0]`: nella card aperta compare la PRIMA etichetta della lista, non quella salvata (la frase riassuntiva invece stampa il vecchio nome), e un salvataggio della regola per altri motivi rimanda il vecchio nome.
- Scenario: regola «SE Etichetta cliente = A rischio → acconto 30%». La titolare rinomina l'etichetta in «Da seguire». Da quel momento a nessuna cliente viene chiesta la caparra; aprendo la regola il menu dice «Nuova» (la prima etichetta), quindi sembra configurata su un'altra etichetta.
- Correzione: salvare l'id dell'etichetta nelle condizioni (o aggiornare le condizioni al rename); in `DkDrop` mostrare il valore non riconosciuto come tale («etichetta eliminata: A rischio») invece della prima opzione.

### [MEDIO] 15-08 Tre azioni irreversibili partono al primo clic: elimina etichetta, elimina ruolo, scollega Stripe
- File: `frontend/apps/dashboard/src/sections/impostazioni/modals/CategoriesManagerModal.jsx:73-81,159,179`; `sections/impostazioni/RolesDrawer.jsx:76-83,185-187`; `sections/impostazioni/PaymentsDrawer.jsx:41-51,98`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: la «x» rossa accanto a ogni etichetta la cancella subito (per le etichette cliente il legame con tutte le schede sparisce, per quelle magazzino i prodotti perdono la categoria); «Elimina ruolo» cancella subito il ruolo (`Membership.role` SET_NULL: chi lo aveva resta senza nessun permesso; gli inviti con quel ruolo vengono cancellati in cascata); «Scollega» Stripe stacca subito l'account. La passata del 18/09 ha aggiunto `DkConfirm` a rimozione membro e sede proprio perché «partiva al primo clic e non si annulla»; queste tre sono rimaste fuori.
- Scenario: nel gestore categorie un clic sulla «x» invece che sulla matita accanto cancella «VIP» da 300 clienti. Un clic su «Elimina ruolo» mentre si rinomina «Front desk» lascia tutta la reception senza agenda né cassa. «Scollega» per errore: da quel momento le caparre pagate dal link finiscono sull'account della piattaforma (come spiega il drawer stesso) finché non si rifà l'OAuth.
- Correzione: `DkConfirm` con il conteggio di ciò che si perde (clienti con l'etichetta, membri con il ruolo) e, per Stripe, dove andranno gli incassi.

### [MEDIO] 15-09 Il registro attività mostra ora e «Oggi/Ieri» nel fuso del dispositivo
- File: `frontend/apps/dashboard/src/sections/impostazioni/ActivityLogPage.jsx:51-64`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `logDateLabel` usa `toTimeString()`, `setHours(0,0,0,0)`, `getDate()`/`getMonth()` su un istante dell'API: ora e giorno sono quelli del computer, non del salone (vietato dall'invariante sul fuso). Il filtro «Oggi» invece è calcolato sul giorno del salone lato server, quindi etichette e filtro non coincidono.
- Scenario: la titolare in vacanza (o una postazione rimasta in UTC) apre il registro per ricostruire chi ha annullato un appuntamento: l'annullamento delle 10:15 compare alle 08:15, e le azioni delle 00:30 risultano di «Ieri». Nel registro di controllo è un'ora sbagliata con l'aria di essere esatta.
- Correzione: usare `salonDateParts`/`fmtTime` (o `toLocaleString` con `salonTzOpts`) e confrontare con `todayStr()`.

### [BASSO] 15-10 I ruoli «di sistema» sono dichiarati non modificabili ma l'API li riscrive
- File: `backend/apps/accounts/api.py:463-483` (`update_role`); `frontend/apps/dashboard/src/sections/impostazioni/RolesDrawer.jsx:152,163`
- Stato: CONFERMATO (probe `SystemRoleProbe`: chi ha team+agenda+clienti fa PUT sul ruolo «Operatrice» con `scopes: ["clients"]` → 200)
- Difetto: la UI blocca i ruoli `is_system` («Ruolo di sistema: permessi non modificabili»), ma `update_role` non controlla `is_system` (lo fa solo `delete_role`). La garanzia mostrata è solo cosmetica.
- Scenario: una responsabile con team+agenda+clienti, con una chiamata diretta, toglie «agenda» al ruolo di sistema «Operatrice»: tutte le operatrici perdono l'agenda, e la UI continua a dire che quel ruolo non si può modificare.
- Correzione: in `update_role` rifiutare con 400 i ruoli `is_system` (il titolare compreso, o solo i non titolari).

### [BASSO] 15-11 Esc chiude il pannello sotto invece della finestra in primo piano
- File: `frontend/apps/dashboard/src/ui/DkModal.jsx:13-18`, `ui/DkDrawer.jsx:7-13`; casi: `sections/impostazioni/modals/CategoriesManagerModal.jsx:169`, `sections/magazzino/ProdottiSub.jsx:182-187`
- Stato: CONFERMATO (percorso ripercorso: gli ascoltatori su `window` scattano in ordine di registrazione)
- Difetto: ogni modale/drawer registra un `keydown` su `window` e chi arriva prima fa `preventDefault()`; il secondo vede `defaultPrevented` e non fa nulla. Il primo registrato è quello aperto PRIMA, cioè quello sotto: l'opposto dell'intento dichiarato nel commento.
- Scenario: nella scheda prodotto si cambia il prezzo (non salvato), si apre «+» (carico rapido) e si preme Esc per annullarlo: si chiude la scheda prodotto (modifica persa) e il carico rapido resta aperto sull'elenco. Esc su «Modifica categoria» chiude l'intero gestore categorie.
- Correzione: una pila di livelli aperti (l'ultimo aperto gestisce Esc), oppure ascoltatore in cattura sul nodo del modale con `stopPropagation`.

### [BASSO] 15-12 Il selettore colore della categoria nella scheda prodotto salva e ricarica tutto il magazzino a ogni movimento del cursore
- File: `frontend/apps/dashboard/src/sections/magazzino/ProductDrawer.jsx:24-30,36`; `sections/magazzino/ProdottiSub.jsx:80-87`
- Stato: CONFERMATO (percorso ripercorso; `onChange` di `<input type="color">` in React scatta sull'evento `input`)
- Difetto: `onChange={(e) => commit(e.target.value)}` chiama `onCatColor` → `PUT /inventory/categories/{id}` + `refreshShared()` (categorie, fornitori e tutte le pagine dei prodotti) per ogni evento del selettore nativo. Il commento del componente promette il salvataggio solo a fine scelta; lo stesso difetto era già stato corretto per il colore operatrice in `ctx.jsx`. Le PUT partono in parallelo: vince l'ultima che arriva, non necessariamente l'ultimo colore scelto.
- Scenario: trascinando il cursore per due secondi partono ~60 PUT e ~60 ricariche dello snapshot (con 3.000 articoli, 6 pagine ciascuna): la pagina si impianta e la categoria può restare con un colore intermedio.
- Correzione: aggiornare solo lo stato locale in `onChange` e fare `commit` su `blur`/chiusura del selettore (come `SvcEditModal`), oppure con un debounce.

### [BASSO] 15-13 Automazioni: attivare/disattivare dalla lista (o una modifica altrui) cancella le modifiche non salvate nel costruttore
- File: `frontend/apps/dashboard/src/sections/automazioni/index.jsx:52,55-65,182`
- Stato: CONFERMATO (percorso ripercorso: il toggle salva `updated_at`, la key del Builder lo contiene)
- Difetto: il Builder ha `key={curRule.id + ':' + curRule.updated_at}`. Il toggle della lista fa POST + `refetch()`, `updated_at` cambia e il Builder si rimonta da zero; lo stesso succede quando `useLive(/^automation\./)` ricarica la regola modificata da un'altra postazione.
- Scenario: si stanno impostando filtri e anticipo di «Promemoria 24h» (non salvati) e si mette in pausa la stessa regola dall'interruttore a sinistra: filtri e anticipo tornano quelli di prima, senza avviso.
- Correzione: rimontare solo se il draft non è sporco (o sincronizzare il solo `active`), e avvisare quando la regola cambia altrove mentre la si modifica.

### [BASSO] 15-14 «Il giorno più scarico» indica un giorno di chiusura
- File: `frontend/apps/dashboard/src/sections/insight/Charts.jsx:89-113`; `backend/apps/insights/services.py:128-133,185-190`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: per un giorno senza capacità (nessun turno, salone chiuso) il server restituisce `occupancy_pct = 0` (divisione per zero ripiegata a 0), indistinguibile da «aperto e vuoto». Il grafico colora quel giorno di rosso come minimo e `quietest` lo sceglie come «giorno più scarico».
- Scenario: salone chiuso lunedì e domenica: Analisi dati scrive sempre «Lun è il giorno più scarico», anche se il mercoledì è mezzo vuoto; il suggerimento spinge a promuovere un giorno in cui non si lavora.
- Correzione: dal server `null` (o la capacità) per i giorni senza turni, e nel grafico escluderli dal minimo e mostrarli come «chiuso».

### [BASSO] 15-15 Analisi dati: se l'intervallo personalizzato fallisce restano a video i numeri del periodo precedente sotto il titolo «intervallo scelto»
- File: `frontend/apps/dashboard/src/sections/insight/index.jsx:79-101,128-129`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: nel `catch` il componente mostra solo un toast; `kpis`, `series`, `byCategory` restano quelli della richiesta precedente mentre `isCustom` diventa vero e il titolo cambia.
- Scenario: si sceglie un intervallo di tre anni (oltre il limite di 732 giorni) e si preme Applica: toast «Intervallo troppo ampio», ma la pagina mostra i KPI del mese corrente con la dicitura «Andamento · intervallo scelto».
- Correzione: azzerare i dati (o tornare all'intervallo precedente) quando la richiesta fallisce.

### [BASSO] 15-16 Regola caparra: passando da importo fisso a percentuale il valore non viene limitato a 100
- File: `frontend/apps/dashboard/src/sections/impostazioni/DepositRules.jsx:208-212`; `backend/apps/core/schemas.py:103-109`
- Stato: CONFERMATO (percorso ripercorso: `NumInput` limita solo al blur, il server non valida)
- Difetto: il `max={100}` del campo vale solo quando si esce dal campo; cambiando il selettore da «Importo fisso» a «% del totale» il valore resta quello di prima e viene salvato così. `DepositRuleIn` accetta qualunque `amount`.
- Scenario: regola a importo fisso di 150 €, la titolare la converte in percentuale e salva: «acconto 150%», e `compute_deposit` chiede come caparra l'intero prezzo del servizio (limite al totale).
- Correzione: al cambio di tipo portare il valore in scala (o azzerarlo) e validare lato server `0 ≤ amount ≤ 100` per `pct`.

### [BASSO] 15-17 Il permesso «Analisi dati» si può assegnare ma non dà accesso a nulla
- File: `frontend/apps/dashboard/src/sections/impostazioni/RolesDrawer.jsx:20`; `sections/insight/index.jsx:24`; `backend/apps/insights/api.py:28-53`
- Stato: CONFERMATO (lo scope `insights` non è letto da nessun endpoint)
- Difetto: l'editor dei ruoli propone «Analisi dati» come permesso concedibile, ma sezione e API sono riservate al titolare (`require_owner`): lo scope non ha alcun effetto.
- Scenario: la titolare dà «Analisi dati» alla Manager perché segua i numeri del mese; la Manager apre la sezione e trova «Funzione riservata al titolare».
- Correzione: o far valere lo scope (`require_scope(ctx, "insights")` e sezione aperta a chi lo ha), o toglierlo dall'elenco dei permessi concedibili.

### [BASSO] 15-18 Scheda operatrice: la «Media» degli incassi è arrotondata all'euro e poi scritta con i centesimi
- File: `frontend/apps/dashboard/src/sections/staff/StaffPage.jsx:349,389`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `avg = Math.round(somma / n)` prima di `eur()`, che scrive due decimali: la stessa «cifra precisa e sbagliata» corretta il 18/09 in Profilo e Insight, rimasta qui.
- Scenario: sei mesi per 7.407 € in tutto: «Media €1.235,00» invece di €1.234,50, e la riga tratteggiata della media è posizionata sul valore arrotondato.
- Correzione: togliere il `Math.round`.

### [BASSO] 15-19 Salvataggio riuscito trattato come fallito quando fallisce il passo successivo: al nuovo tentativo nascono doppioni
- File: `frontend/apps/dashboard/src/sections/staff/AbsenceCalendar.jsx:66-72`; `sections/magazzino/ProductDrawer.jsx:162-168`; `sections/automazioni/index.jsx:241-253`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: nello stesso `try` stanno la scrittura e il passo dopo (ricarica assenze; carico della scorta iniziale; `reload.salon()`): se il secondo fallisce si mostra errore e il pannello resta nello stato «da creare», benché la scrittura sia andata.
- Scenario: si aggiunge «Ferie 10–14 agosto», la POST riesce ma la ricarica cade per un attimo di rete: toast «Errore di rete», il pannello resta aperto, si ripreme «Aggiungi» → due assenze identiche. Nella scheda prodotto nuova con scorta iniziale: prodotto creato, carico fallito, «Crea prodotto» di nuovo → due prodotti uguali (il primo a zero). Nel ritardo automazioni la pillola torna al valore vecchio anche se il server ha salvato il nuovo.
- Correzione: chiudere/aggiornare lo stato dopo la scrittura riuscita e trattare a parte l'errore del passo successivo (per il prodotto: passare alla scheda del prodotto creato).

### [BASSO] 15-20 Nuova regola caparra e nuova categoria senza guardia contro il doppio clic
- File: `frontend/apps/dashboard/src/sections/impostazioni/DepositRules.jsx:31-44`; `sections/impostazioni/modals/CategoriesManagerModal.jsx:58-62,181`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `add()` e `save()` non hanno uno stato «in corso»: due clic ravvicinati mandano due POST.
- Scenario: doppio clic su «Nuova regola deposito» → due «Nuova regola» con la stessa priorità; doppio clic su «Salva» di una nuova categoria servizi o magazzino → due categorie identiche (per le etichette cliente la seconda finisce in errore di unicità).
- Correzione: flag `busy` che disabilita il pulsante durante la richiesta.

### [BASSO] 15-21 Magazzino: gli aggiornamenti in tempo reale rinfrescano le cifre in testata ma non la tabella né gli ordini
- File: `frontend/apps/dashboard/src/sections/magazzino/index.jsx:67`; `ProdottiSub.jsx:37-55`; `OrdiniSub.jsx:35-43`; `StoricoSub.jsx:26-41`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `useLive` ricarica solo lo snapshot condiviso; le liste paginate dipendono da `tick`, che cambia solo con le azioni della propria postazione. Sulla stessa schermata metriche e righe si contraddicono (scelta di progetto: «dati sempre freschi»).
- Scenario: la reception carica 10 pezzi da un'altra postazione: «Valore magazzino» e «Sottoscorta» si aggiornano, la riga del prodotto continua a mostrare la giacenza vecchia; un ordine inviato altrove resta «Bozza» con «Conferma e invia» (che poi risponde 400).
- Correzione: agganciare anche le liste a `useLive` (incrementare `tick` sugli stessi prefissi).

### [BASSO] 15-22 Altre date e giorni letti sull'orologio del dispositivo invece che su quello del salone
- File: `frontend/apps/dashboard/src/sections/impostazioni/HoursDrawer.jsx:20-24` (riga «Oggi» in Impostazioni); `sections/insight/kpiDefs.js:31-44` (periodo di confronto); `sections/impostazioni/TeamDrawer.jsx:166` (scadenza invito); `sections/staff/StaffPage.jsx:418-422` (ultima visita); `shell/Topbar.jsx:138`; `sections/staff/AbsenceCalendar.jsx:15`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `new Date().getDay()`, `getMonth()` e `toLocaleDateString` senza `timeZone` su istanti dell'API o su «adesso», contro l'invariante del fuso. Ciascuno sbaglia solo a cavallo della mezzanotte o da un dispositivo con altro fuso.
- Scenario: da un portatile in UTC, alle 00:30 del 1° ottobre ora di Roma, «vs prec.» dei KPI confronta settembre con agosto invece che con settembre; alle 00:30 di domenica la riga Orari dice «Oggi: 9:00–13:00» (sabato); un'ultima visita alle 00:30 appare del giorno prima.
- Correzione: `todayStr()`/`salonDateParts()`/`salonTzOpts()` al posto dei metodi locali.

---

Aree controllate senza reperti: indice e settimana del ciclo turni (`cycleWeekIndex` confrontato con `_week_index` su 900 giorni, 2025–2027, zero differenze; evidenza «settimana corrente» sul giorno del salone); correzione J6 (sincronizzazione ciclo con i valori di `detail`); parsing e validazione turni/pause (`parseRange`, `shiftsFromWeeks`) contro `_validate_shift_row`; assenze su più giorni e mesi (solo date pure, nessun problema di ora legale); editor orari (fasce invertite, sovrapposte, vuote, giorno chiuso, 24:00) coerente con `normalize_opening_hours_week`; salvataggi parziali delle impostazioni (`exclude_unset`, nessun campo perso da drawer diversi); ritardo automazioni 0–600 s (scelte valide, valori esterni mostrati, solo titolare come il server); payload completi di servizi (riattivazione con descrizione e posa), pacchetti, operatrici da `syncOperators`, automazioni; margine prodotto IVA scorporata e arrotondamenti delle righe d'ordine/PDF (J1, J2 corretti); snapshot prodotti paginato (nessun tetto di `limit` lato server); ordini: invio e ricezione con lock e guardie `busy`, righe senza prezzo escluse dai totali; ruoli/inviti: nessuno assegna scope che non ha, titolare non modificabile né rimovibile dalla UI; login, refresh single-flight e sincronizzazione fra schede, logout con revoca, popup Yourang e Stripe (origin controllata); boot del contesto accessibile a ogni ruolo; `useLive` (timer in ref, J13 corretto); fmtEur/eur0 sui KPI; gating owner di Insight, Brand, Orari, Pagamenti, Motivazioni, Regole caparra; sidebar e navigazione fra sezioni/sottosezioni (letture aperte a tutto lo staff per SPEC §1).
