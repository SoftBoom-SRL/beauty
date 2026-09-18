# Agenda lato React — 2 alti, 3 medi, 5 bassi
Cartella: frontend/apps/dashboard/src/sections/agenda/

## [I1] La vista giorno non si ricarica MAI sugli eventi live delle altre postazioni — ALTO
- Dove: index.jsx:76-84
- Cosa: il cleanup dell'effetto fa clearTimeout(liveTimer.current) a ogni ri-sottoscrizione, non solo allo smontaggio. `live` e un useMemo (ctx.jsx:133) con events/version fra le dipendenze, e deliver (ctx.jsx:56-63) chiama setEvents PRIMA di invocare i listener: il listener programma il debounce di 250 ms, React ri-renderizza con un live nuovo, l'effetto si smonta e cancella il timeout appena creato. refetchAll non parte mai. MonthView.jsx:50-63 documenta la stessa trappola e l'ha gia evitata.
- Scenario: due postazioni sulla stessa agenda; B sposta o crea un appuntamento e su A griglia, lista d'attesa, cassa e "da richiamare" restano fermi finche non si cambia giorno. Si prenota su dati vecchi.
- Fix: return unsub nel cleanup e spostare il clearTimeout in un useEffect di solo smontaggio, come in MonthView.

## [I2] Il trascinamento con le forbici su un giorno della striscia sposta TUTTA la visita — ALTO
- Dove: DayGrid.jsx:222-229
- Cosa: onUp controlla il bersaglio "giorno" prima di costruire l'intenzione e non guarda d.detach: qualunque drag item rilasciato sulla striscia chiama onDropOnDate(d.block.appt, ...) cioe lo spostamento dell'intero appuntamento. L'intento split (riga 236) non viene mai raggiunto.
- Scenario: visita di 3 servizi; si prende il servizio 2 dalle forbici e lo si lascia sulla pillola "Mer 23": si spostano tutti e tre, l'avviso dice "Spostato a Mer 23", nessuno stacco avvenuto.
- Fix: nel ramo dayTarget gestire d.detach a parte (split con data bersaglio) oppure ignorare la striscia quando d.detach e vero.

## [I3] Spegnere la chip di un'operatrice nasconde il lavoro delle altre e fa apparire liberi slot occupati — MEDIO
- Dove: index.jsx:421 -> DayGrid.jsx:43,447; lib.js:251-321
- Cosa: il backend elenca ogni appuntamento una volta, nella riga dell'operatrice principale (agenda/api.py:302-304), mentre i singoli servizi possono essere di altre operatrici: per questo DayGrid disegna i blocchi per item.operator_id e explainSlot scorre tutte le righe. Filtrando `rows` con le chip si toglie l'intero appuntamento.
- Scenario: visita di Anna 10:00-11:30 col secondo servizio fatto da Giulia; lasciando accesa solo Giulia la sua colonna risulta vuota alle 10:45, il menu dice "Disponibile" e ci si prenota sopra creando una sovrapposizione reale.
- Fix: passare tutte le righe a DayGrid per il calcolo e usare `vis` solo per scegliere quali colonne disegnare.

## [I4] Il badge del drag mente durante uno stacco — MEDIO
- Dove: DayGrid.jsx:508-522
- Cosa: durMin usa total_duration_min dell'intera visita, start usa d.apptStart + (d.ns - d.orig) invece di d.ns, who usa opName(d.origOp), e la riga 521 mostra "operatrice fissa" proprio mentre lo stacco puo riassegnare l'operatrice.
- Scenario: servizio staccato verso le 14:00 nella colonna di Giulia: il badge annuncia "13:15-14:45 Anna operatrice fissa" mentre al server arrivera 14:00-14:45 su Giulia.
- Fix: caso a se per d.detach: start = d.ns, durMin = attivo + posa del blocco, who = opName(d.nop), niente nota.

## [I5] Corsa fra spostamento e cambio giorno: la griglia mostra il giorno precedente — MEDIO
- Dove: index.jsx:55-59 (usato a 186, 199, 223, 233, 334, 344, 368, 385)
- Cosa: fetchDay cattura `date` e incrementa daySeq quando parte. La guardia protegge dalle risposte fuori ordine ma non impedisce a una richiesta con la data VECCHIA di vincere: partendo dopo prende il numero piu alto.
- Scenario: si trascina un appuntamento e subito si preme "giorno successivo": l'intestazione dice 19 settembre, la griglia mostra il 18.
- Fix: passare a fetchDay la data su cui lavora e scartare la risposta se non coincide piu con `date`.

## [I6] Durante uno stacco la traccia tratteggiata compare sotto tutti i servizi della visita — BASSO
- Dove: DayGrid.jsx:428-430. itemPos (263-265) lascia giustamente fermi gli altri servizi.
- Fix: quando d.detach e vero filtrare la traccia al solo d.itemId.

## [I7] Il tasto N apre la prenotazione singola sopra il drawer di gruppo — BASSO
- Dove: index.jsx:141-153. L'handler legge groupOpen ma non e fra le dipendenze [openNewAppt, date, modal].
- Fix: aggiungere groupOpen alle dipendenze o leggerlo da una ref.

## [I8] Prenotazione di gruppo: la durata totale della riga ignora la posa — BASSO
- Dove: GroupBookingDrawer.jsx:228 (e 325). Altrove la durata mostrata e duration_min + soak_min.
- Scenario: colore 45' + 30' di posa: la riga dice "45m" ma lo slot occupato e 1h15.

## [I9] start.slice(0, 10) prende il giorno UTC, non quello del salone — BASSO
- Dove: ApptDetailModal.jsx:113,596,635,695; RightRail.jsx:123; modals/FreedSlotModal.jsx:36,134
- Cosa: il backend serializza start come istante UTC; il resto del codice usa apposta toDateStr(iso) (format.js:145-156).
- Scenario: appuntamento alle 23:30: il sottotitolo mostra il giorno prima e "Riprogramma" si apre sulla data sbagliata.

## [I10] Ridimensionando un servizio, gli altri della visita non si spostano nell'anteprima — BASSO
- Dove: DayGrid.jsx:272-275. Nel ramo resize traslare anche i blocchi successivi della stessa visita di (d.ndur - d.origDur).
