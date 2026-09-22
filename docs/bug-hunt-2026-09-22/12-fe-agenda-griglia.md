# Revisore 12 — agenda React: griglie, trascinamento, zoom

Probe lasciati su richiesta dell'orchestratore: `backend/apps/agenda/tests_probe_12_fe_agenda_griglia.py` (5 test, tutti verdi = difetti confermati) e `scratchpad/probe12/` (harness node che monta DayGrid.jsx come funzione: `t2.mjs`, `t3.mjs`).

### [ALTO] 12-01 Staccare il primo servizio (o uno in mezzo) fa slittare in avanti quelli che restano, mentre la griglia li mostra fermi
- File: `frontend/apps/dashboard/src/sections/agenda/DayGrid.jsx:299-311,457-460` (anteprima e verifica dello stacco) ↔ `backend/apps/agenda/services.py:1372-1426` (`split_appointment`)
- Stato: CONFERMATO (probe `test_split_of_first_service_moves_the_remaining_one`)
- Difetto: il server toglie il servizio e lascia `appointment.start` invariato, quindi i servizi successivi si ricompattano indietro; l'anteprima dice «gli altri restano dove sono» e valida solo il servizio staccato. Se la catena ricompattata si sovrappone a qualcosa il server dà 409 e `splitItem` riprova con force: sovrapposizione scritta in silenzio.
- Scenario: Maria manicure 10:00 (Anna) + copertura 11:00 (Giulia); Giulia ha un'altra cliente alle 10:00. Si trascina la manicure alle 14:00: la copertura finisce alle 10:00 sopra l'altra cliente, nessun avviso (toast «staccato alle 14:00»).
- Correzione: nello stacco conservare gli orari degli altri servizi (spostare `start` se si toglie il primo, aggiungere la durata tolta all'attesa del precedente se in mezzo), oppure mostrare e validare la ricompattazione.

### [MEDIO] 12-02 Ridimensionare una pausa non funziona: TypeError a ogni movimento
- File: `DayGrid.jsx:347` (`bestSnapEnd(..., d.block.opId)`), `DayGrid.jsx:215-222` (`onPauseResizeDown` non ha `block`)
- Stato: CONFERMATO (harness `probe12/t2.mjs`: «TypeError: Cannot read properties of undefined (reading 'opId')», al rilascio nessuna `onResizePause`)
- Difetto: il ramo resize di `onMove` legge `d.block.opId` anche per le pause (regressione del commit 6fb5d62, aggancio al vicino).
- Scenario: si allunga la pausa pranzo trascinando il bordo: nulla cambia, errori in console.
- Correzione: `d.block?.opId ?? d.obj.operator_id` per le pause.

### [MEDIO] 12-03 Ridimensionare un servizio che finisce dopo le 20:00 lo accorcia fino alle 20:00, anche con un tocco
- File: `DayGrid.jsx:353` (`nd = Math.max(5, Math.min(DK_END - d.orig, nd))`), stesso clamp per le pause
- Stato: CONFERMATO (harness `t3.mjs`: 19:45+30' spostato di 5 px → invia 15'; 19:00+90' toccato di 3 px → invia 60')
- Scenario: salone aperto fino alle 21 (o incastro forzato serale): toccando la maniglia la durata del servizio viene tagliata e il PUT parte.
- Correzione: non limitare la durata alla fine della griglia (o limitare solo l'anteprima).

### [MEDIO] 12-04 Griglia fissa 08:00–20:00: appuntamenti prima delle 8 invisibili, dopo le 20 fuori griglia e non raggiungibili
- File: `lib.js:4-5` (DK_START/DK_END), `DayGrid.jsx:829` (top negativo sotto l'intestazione sticky), `DayGrid.jsx:365` (clamp del drag), `WeekView.jsx:597`
- Stato: CONFERMATO (lettura: top = (start−480)·pxm negativo, intestazione sticky z 9 sopra i blocchi z 2)
- Scenario: sposa forzata alle 07:00 → in vista giorno e settimana non c'è; turni fino alle 21 → le fasce 20–21 non si cliccano e un drag le schiaccia a 19:45.
- Correzione: ricavare inizio/fine griglia da turni, orari del centro e appuntamenti del giorno.

### [MEDIO] 12-05 «Sposta qui» sull'ombra non sposta niente (stessa ora e operatrice) o sposta male (ombra di un servizio successivo)
- File: `index.jsx:269-277` (uscita anticipata `startMin === fromMin && !reassigned` che ignora la data), `index.jsx:367-376`, `DayGrid.jsx:637-656`
- Stato: CONFERMATO (lettura del percorso)
- Scenario: pannello aperto su Maria mar 10:00 Anna, si sfoglia giovedì, clic sull'ombra «10:00 · qui» → «Sposta qui» → nessuna richiesta, nessun toast, Maria resta martedì. Clic sull'ombra della piega (11:00, Giulia) → la visita parte alle 11:00 e i servizi di Anna passano a Giulia.
- Correzione: considerare anche il giorno nel confronto; nell'ombra usare l'ora d'inizio visita e la colonna della principale (o il servizio cliccato con `fromOp`).

### [MEDIO] 12-06 Visita divisa fra due colonne (un servizio per operatrice): nessuna spina, non si sposta intera; il trascinamento la spezza
- File: `lanes.js:113-115` (`sp.count > 1`), `DayGrid.jsx:190` (detach per ogni visita multi-servizio), `DayGrid.jsx:823-826` (il title promette la «barra scura»)
- Stato: CONFERMATO (`probe12/t1.mjs`: 0 spine in entrambe le colonne)
- Scenario: colore (Anna) + piega (Giulia): per spostarla di un'ora si trascina un blocco → diventa un appuntamento a parte (e con 12-01 l'altro servizio slitta indietro).
- Correzione: spina/maniglia anche con un solo servizio per colonna quando la visita ne ha più d'uno.

### [MEDIO] 12-07 Colonne di operatrici disattivate: riassegnare dà 404, e i servizi di una disattivata dentro visite altrui spariscono
- File: `index.jsx:285` e `WeekView.jsx:295` (`from_operator_id` sempre inviato) ↔ `backend/apps/agenda/api.py:583-584` (`salon_get(..., active=True)`); `api.py:327-331` (orfane solo per operatrice principale)
- Stato: CONFERMATO (probe `test_reassign_from_inactive_operator_column`: 404 con from_operator_id, 200 senza; `test_item_of_inactive_operator_has_no_column`)
- Scenario: Giulia lascia il salone; la sua colonna resta «per riassegnare», ma trascinarne gli appuntamenti a Sara → toast «Not Found». Una piega di Giulia nella visita di Anna non ha colonna e non si vede.
- Correzione: non richiedere `active` su `from_operator`; aggiungere righe orfane anche per gli operatori dei servizi.

### [MEDIO] 12-08 Verso la striscia dei giorni badge e ombra mentono; mancare la pillola sposta davvero, e lo stacco sul giorno a video spezza la visita
- File: `DayGrid.jsx:149-157` (`colFromX` guarda solo la X), `DayGrid.jsx:359-366`, `DayGrid.jsx:408-418`
- Stato: CONFERMATO (harness `t3.mjs` (b): rilascio 35 px sotto la striscia → `onInvalidDrop` con ns 08:00, nop = colonna sotto la X → spostamento forzato; (c): stacco sulla pillola del giorno corrente → `onSplitItem` stesso orario)
- Scenario: sopra la pillola il badge dice «08:00 · Giulia · Fuori turno» anche se l'azione è «stesso orario, altro giorno»; rilasciando fra la striscia e la griglia l'appuntamento va (forzato) all'ora calcolata e a Giulia; le forbici lasciate sul giorno selezionato creano un appuntamento a parte.
- Correzione: fuori dal rettangolo della griglia niente orario/colonna (annulla), badge dedicato sopra le pillole, ignorare la pillola del giorno corrente.

### [MEDIO] 12-09 La vista giorno non si ricarica per turni, assenze e orari del centro cambiati altrove
- File: `index.jsx:133` (regex senza `operator.` e `settings.`), `MonthView.jsx:57`
- Stato: CONFERMATO (lettura: `operator.absence_created`/`shifts_updated`, `settings.updated` ricaricano solo il contesto, non `/agenda/day`)
- Scenario: la titolare segna Giulia assente da un'altra postazione; al banco la colonna resta «in turno», il drag dice «Disponibile», il POST prende 409 e si riprova con force: appuntamento forzato su un'assente senza avviso. Nel mese l'occupazione resta vecchia.
- Correzione: aggiungere `operator.` e `settings.` ai prefissi del ricarico (giorno e mese).

### [MEDIO] 12-10 Settimana: `refetchWeek` senza guardia, una risposta della settimana vecchia sovrascrive quella a video
- File: `WeekView.jsx:50-54`, `WeekView.jsx:327` (`onMutate: refetchWeek` catturato all'apertura del pannello)
- Stato: CONFERMATO (lettura; percorso deterministico)
- Scenario: dettaglio aperto dalla settimana 21–27, dal pannello si sfoglia alla settimana dopo (la griglia la segue), si preme «Salva»: `onMutate` ricarica la 21–27 e la griglia la mostra sotto l'intestazione «28 set – 4 ott»; clic e drag lavorano sulle date vecchie. Stessa corsa con eventi live + cambio settimana.
- Correzione: numero di sequenza + confronto con la settimana corrente letta da una ref, come `fetchDay`.

### [BASSO] 12-11 Ombra e «Sposta qui» usano `modal.props.appointment`, che non si aggiorna dopo le modifiche fatte nel pannello
- File: `index.jsx:362,366,823-828`
- Stato: PLAUSIBILE (percorso ripercorso: `applyMove`/`saveChanges` fanno `setAppt` interno, le props restano quelle d'apertura)
- Scenario: nel pannello si passa Maria da Anna a Giulia, si sfoglia un altro giorno: l'ombra è nella colonna di Anna all'ora vecchia; «Sposta qui» nella colonna di Anna non fa nulla, alle 11:00 sposta ma lascia Giulia.

### [BASSO] 12-12 Ridimensionare un servizio dà 400 se un ALTRO servizio della visita è di un'operatrice disattivata o non più abilitata
- File: `index.jsx:483-490` ↔ `backend/apps/agenda/services.py:713-718` (`resolve_items_edit` rivalida l'idoneità anche delle righe invariate)
- Stato: CONFERMATO (probe `ProbeResizeTests`: 400 anche con force)

### [BASSO] 12-13 Spostare a un orario già passato di oggi marca l'appuntamento «forzato» senza bisogno
- File: `DayGrid.jsx:329` (`nowMin` → `past`), `index.jsx:410-425` (force diretto, senza tentativo normale); il server per lo staff ammette il passato
- Stato: PLAUSIBILE

### [BASSO] 12-14 `pointerId` mai controllato: su tablet un secondo dito sposta e rilascia il trascinamento in corso
- File: `DayGrid.jsx:336-372,384`, `WeekView.jsx:113,223`
- Stato: PLAUSIBILE

### [BASSO] 12-15 Scorrere con la rotella durante il trascinamento non aggiorna l'orario: il blocco si stacca dal puntatore
- File: `DayGrid.jsx:341,358-359` e `WeekView.jsx:227-229` (minuti da `clientY − startY`, ignorano lo scroll)
- Stato: PLAUSIBILE

### [BASSO] 12-16 Campo esadecimale del colore operatrice inutilizzabile: completa con zeri e salva a ogni tasto
- File: `DayGrid.jsx:543` (`padEnd(6,'0')` + `maxLength 6` + PATCH con evento live)
- Stato: PLAUSIBILE

### [BASSO] 12-17 In settimana, aprendo un appuntamento di un altro giorno compare un'ombra sul giorno «selezionato», che la vista non evidenzia
- File: `index.jsx:366,673`, `WeekView.jsx:504`
- Stato: PLAUSIBILE

### [BASSO] 12-18 Esc per annullare un trascinamento chiude anche il pannello di dettaglio
- File: `DayGrid.jsx:140` (niente `preventDefault`), `ui/DkPanel.jsx:19`
- Stato: PLAUSIBILE

### [BASSO] 12-19 `wlRank` legge `getDay()` su un ISO dell'API (fuso del dispositivo)
- File: `lib.js:164`
- Stato: CONFERMATO (lettura)

### [BASSO] 12-20 Incasso nelle testate di giorno e settimana conta i no-show, il mese no
- File: `DayGrid.jsx:511`, `WeekView.jsx:416` vs `monthLib.js:66`
- Stato: CONFERMATO (lettura)

### [BASSO] 12-21 Settimana: sotto-colonne per le operatrici di tutte le sedi, non solo di quella attiva
- File: `WeekView.jsx:158-166` (`operators` del contesto, non filtrate per `locationId`)
- Stato: PLAUSIBILE

### [BASSO] 12-22 Sfogliando i giorni la griglia si rimonta e torna alle 08:00: l'ombra finisce fuori schermo
- File: `index.jsx:111-117,705-707` (`setDayData(null)` → skeleton), `WeekView.jsx:61-68`
- Stato: PLAUSIBILE

### [BASSO] 12-23 Evidenza del blocco aperto: `zIndex` duplicato nello stile, quello del contorno non vale mai
- File: `DayGrid.jsx:835-836`
- Stato: CONFERMATO (lettura)

### [BASSO] 12-24 «Vai a una data» scritta a tastiera salta all'anno 1902 al primo tasto
- File: `index.jsx:890` (`onChange` → `jumpToDate` a ogni valore valido, `parseISO('0002-…')` → 1902)
- Stato: PLAUSIBILE

### [BASSO] 12-25 Settimana non si ricarica per `deposit.` e `sale.`: pallino caparra e stati restano vecchi
- File: `WeekView.jsx:58`
- Stato: CONFERMATO (lettura)

Aree controllate senza reperti: conversioni `isoAtMin`/`minutesOfDay` nei giorni di cambio ora (29/03 e 25/10 verificati), ancoraggio dello zoom, `lanes.js` (sovrapposizioni, posa, stessa cliente), chiavi React, vista mese (`monthGrid`, filtri, riepilogo), sede attiva nei fetch, riprova con force al 409, trascinamento della spina e gruppo fra colonne con `from_operator_id` (a parte 12-07), attesa/POSA nel resize.
