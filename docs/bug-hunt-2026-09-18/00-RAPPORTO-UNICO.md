# Caccia ai bug — beauty, 18 settembre 2026

Sedici revisori in parallelo, uno per area. Ogni difetto è stato verificato ripercorrendo il percorso di esecuzione completo; i cinque critici li ho poi ricontrollati personalmente sul codice.

**267 segnalazioni: 5 critici, 40 alti, 115 medi, 90 bassi.** Una ventina sono lo stesso difetto trovato da revisori diversi, e questo ne conferma la sostanza.

Stato di partenza: la suite backend passa interamente (337 test), i test frontend passano (18 su 18), nessun errore di sintassi, nessun segreto tracciato in git, dipendenze Python aggiornate.

---

## I cinque critici

### 1. Una cancellazione Yourang senza identificativo azzera l'intera agenda del salone
`backend/apps/integrations/api.py:214` → `sync.py:322`

Il ramo `event.deleted` non verifica che l'identificativo sia valorizzato, mentre il ramo gemello sulla riga dopo lo fa. La funzione filtra `yourang_event_id=""`, che è il valore predefinito di **tutti** gli appuntamenti nativi: il vincolo di unicità è parziale e li esclude. Un payload senza `resource_id` manda in stato annullato ogni appuntamento del salone, passato e futuro, in una sola query, e risponde «ok». Il commento nel codice documenta che il nome di quel campo è già cambiato una volta.

**Verificato di persona.**

### 2. Annullare dal salone trattiene la caparra della cliente e la marchia come inaffidabile
`backend/apps/agenda/services.py:1088`

L'annullamento calcola «tardivo» solo dal tempo che manca, senza guardare chi sta annullando. Ma l'app cliente non può annullare sotto le 24 ore: viene fermata prima con un errore. Quindi «tardivo» è vero **solo quando è il salone ad annullare**. L'operatrice si ammala, la reception annulla due ore prima, e la cliente perde la caparra e si becca un annullamento tardivo sulla scheda, che alimenta le regole caparra: le verrà chiesta una caparra anche in futuro. Il test esistente asserisce esattamente questo esito come se fosse corretto.

**Verificato di persona:** i due soli chiamanti sono l'endpoint staff e quello cliente, e il secondo è protetto dal controllo sulle 24 ore.

### 3. La gift card venduta e segnata pagata subito non registra nessun incasso
`backend/apps/marketing/api.py:224`

Il percorso «incasso dopo» crea la vendita, il percorso «pagata ora», che è il default nella maschera, no. Nasce una carta pagata senza nessuna vendita. Quando la cliente la spende, l'importo viene sottratto dall'incasso di giornata: i soldi non compaiono in nessun giorno e in nessun periodo. Un test esistente fotografa il risultato sbagliato come corretto. Non è recuperabile a mano, perché marcarla pagata una seconda volta dà errore.

**Verificato di persona:** la funzione di creazione scrive solo una riga nel diario attività.

### 4. La guida al deploy descrive variabili Yourang che il codice non legge più
`DEPLOY.md:96` contro `backend/config/settings.py:211`

Cinque variabili prescritte come obbligatorie non esistono nel backend. Le tre che servono davvero non sono documentate. Chi segue la guida alla lettera ottiene un deploy verde in cui ogni collegamento risponde con un errore e ogni webhook in ingresso viene rifiutato.

**Verificato di persona.**

### 5. Senza l'indirizzo del servizio messaggi non parte nessun codice di accesso
`DEPLOY.md:88` contro `flush_outbox.py:216`

Le due variabili che abilitano l'invio sono citate solo di sfuggita in una riga di prosa, non nell'elenco. Il job gira, non manda nulla, i codici restano in coda e nessuna cliente riesce a entrare. La tabella diagnostica della guida attribuisce quel sintomo a un'altra causa.

**Verificato di persona.**

---

## I temi che attraversano più aree

**Il salvataggio completo su una copia vecchia.** Quattro revisori indipendenti lo hanno trovato negli stessi tre punti: modifica appuntamento, chiusura conto, ripristino di uno slot liberato. Tutti e tre rileggono l'oggetto a inizio richiesta e poi lo riscrivono per intero. Se nel frattempo arriva il pagamento della caparra, il salvataggio lo cancella: stato riportato a «richiesta», identificativo del pagamento perso, rimborso non più possibile, e il job che libera gli slot annulla l'appuntamento di chi ha pagato. Il progetto ha già la funzione giusta, `_lock_and_reload`, usata ovunque tranne qui.

**Il denaro che entra e non viene registrato.** Gift card pagata subito, addebito per mancata presentazione, caparra trattenuta: tre incassi reali che non diventano mai una vendita. E la caparra viene sottratta dall'incasso del giorno in cui si chiude il conto, pur non essendo mai stata registrata in nessun altro giorno. Nessuno di questi percorsi ha un test.

**Le scritture concorrenti senza lock.** Punti fedeltà, riscatto coupon, incasso gift card, rimborsi parziali, giacenze di magazzino, invio ordine al fornitore. Ognuno legge, calcola in memoria e riscrive: due operazioni simultanee si sovrascrivono. Sui punti fedeltà il caso peggiore emette due premi per una sola soglia; se l'iscrizione non esiste ancora, fa fallire l'intera vendita.

**La caparra senza pagamenti online.** L'unico punto del backend che segna una caparra come pagata è il webhook Stripe. Non esiste nessun modo di registrare una caparra incassata in contanti. La funzione scritta apposta per fermare il rilascio automatico non è chiamata da nessuna parte. Un salone con la regola caparra attiva ma senza Stripe si vede annullare da solo ogni prenotazione. **Verificato di persona.**

**I permessi che non coprono le letture.** Vista giorno, vista settimana, margine per appuntamento, riepilogo di cassa e dettaglio vendita non richiedono il permesso d'area. Lo stream in tempo reale consegna l'intero diario attività a chiunque sia autenticato, mentre l'endpoint equivalente lo protegge. Il permesso «team» permette di crearsi un ruolo con tutti gli altri permessi e assegnarselo. Nessun test della suite asserisce un rifiuto per permesso mancante.

**Il fuso orario del dispositivo.** Nell'app cliente la striscia dei giorni, la scadenza della caparra e le scadenze di gift card e coupon usano l'orologio del telefono invece di quello del salone. Il pacchetto condiviso ha già le funzioni giuste e i test che le coprono; queste chiamate non le usano.

**Gli importi troncati.** La funzione di formattazione non fissa i decimali: trentacinque euro e cinquanta si legge «35,5», e un prezzo con tre decimali si legge per intero. Vale su entrambe le applicazioni, in 124 punti. Non è coperta da alcun test.

**Il buon esito.** La verifica incrociata di tutte le 196 rotte del backend contro tutte le 248 chiamate del frontend non ha trovato nessuna rotta inesistente, nessun metodo sbagliato, nessun disallineamento di enum, di paginazione o di formato numerico. Il contratto fra le due parti è solido.

---

## Conteggio per area

| Area | Critici | Alti | Medi | Bassi |
|---|---|---|---|---|
| Motore prenotazioni | 0 | 3 | 5 | 5 |
| API agenda | 0 | 1 | 4 | 8 |
| Vendite e Stripe | 0 | 3 | 6 | 5 |
| Clienti | 0 | 2 | 8 | 4 |
| Fedeltà e gift card | 1 | 2 | 7 | 4 |
| Impostazioni, insight, automazioni | 0 | 3 | 7 | 5 |
| Magazzino, catalogo, staff | 0 | 2 | 8 | 6 |
| Integrazioni | 1 | 5 | 8 | 3 |
| Agenda lato React | 0 | 2 | 3 | 5 |
| Resto della dashboard | 0 | 2 | 9 | 6 |
| App cliente e condiviso | 0 | 2 | 6 | 9 |
| Integrità dati e concorrenza | 0 | 6 | 9 | 5 |
| Sicurezza e autenticazione | 0 | 2 | 5 | 7 |
| Contratto fra client e server | 0 | 1 | 4 | 6 |
| Deploy | 2 | 4 | 6 | 5 |
| Qualità dei test | 3 | 15 | 20 | 7 |

---

## Ordine di intervento suggerito

1. I cinque critici. I due di deploy sono modifiche alla documentazione e si chiudono in mezz'ora.
2. Il salvataggio completo su copia vecchia nei tre punti, usando la funzione che il progetto ha già.
3. La caparra: registrarla in contanti, non fissare la scadenza senza pagamenti online, ridurla quando la visita si accorcia.
4. Gli incassi che non diventano vendita, e la caparra sottratta due volte dai totali.
5. I lock mancanti sulle scritture concorrenti.
6. I permessi sulle letture e sullo stream.
7. Decimali e fusi orari lato interfaccia.

I rapporti per area sono nei file `findings-*.md` di questa cartella.
