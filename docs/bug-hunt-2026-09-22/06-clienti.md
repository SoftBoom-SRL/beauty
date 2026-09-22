# Revisore 06 — clienti (formato breve per STOP dell'orchestratore)

Probe in `backend/apps/clients/tests_probe_clienti.py` (non cancellato, come richiesto) + script node/python nello scratchpad (`phone_fe.mjs`, `phone_fe2.mjs`, `phone_cases.py`).

### [ALTO] 06-01 Le caparre e gli addebiti no-show contano come visite, e la caparra si somma al conto pieno
- File: `backend/apps/clients/services.py:28-47` (client_stats), `backend/apps/clients/api.py:480-486,530` (storico), `backend/apps/agenda/services.py:478-480` (compute_deposit via client_facts)
- Stato: CONFERMATO (StatsProbe.* falliscono: caparra 30 + conto 100 → visits 2, total_spent 130; caparra rimborsata senza visita → 1 visita/30 €; no-show addebitato → 1 visita; regola «Prima visita» (visits<1) non chiede più la caparra dopo la prima caparra pagata)
- Difetto: dal 18/09 caparra e no-show sono `Sale` (riga service); insights li esclude (`deposit_appointment__isnull=True`), client_stats no. Nello storico la caparra appare come «Vendita al banco».
- Scenario: ogni cliente con caparra: KPI Visite/Valore/Scontrino medio sbagliati (anche in ApptDetailModal), regole caparra e segmenti automazioni («Nuovi», «Alto valore») decidono su numeri gonfiati.
- Correzione: in client_stats escludere le vendite `deposit_appointment` e i no-show (meglio: visite dagli appuntamenti chiusi); storico: agganciare la vendita-caparra alla sua visita.

### [MEDIO] 06-02 Cliente archiviata = vicolo cieco: non si trova, non si ricrea, non si riattiva, non entra nell'app
- File: `backend/apps/clients/api.py:125-128,321-335`; `frontend/apps/dashboard/src/sections/clienti/index.jsx:37`; `sections/agenda/ClientPicker.jsx:57`; `ClientProfile.jsx:343`; `backend/apps/accounts/api.py:625`; `client-app/src/screens/auth/AuthFlow.jsx:177-181`
- Stato: CONFERMATO (ArchivedProbe: ricerca con is_active=true → 0, POST stesso numero → 400 «Telefono già registrato per un altro cliente")
- Difetto: liste/picker filtrano is_active, l'unicità conta anche le archiviate, nessuna UI di riattivazione (il modale dice «Potrà essere riattivato», l'app dice «contatta il salone per riattivarla»); create_appointment esige is_active; l'import la «aggiorna» lasciandola invisibile.
- Scenario: cliente archiviata che richiama per prenotare → la reception non può prenotarla col suo numero; lei non riceve OTP.
- Correzione: riattivare su POST/import con lo stesso numero (o mostrare/aprire la scheda archiviata con «Riattiva»).

### [MEDIO] 06-03 Foto delle schede tecniche restituite senza firma → 403 nella scheda tecnica
- File: `backend/apps/clients/api.py:721-728,756,777`; `backend/apps/clients/schemas.py:228`
- Stato: CONFERMATO (SheetPhotoProbe: URL da GET /sheets e da POST /photo senza `?t=` → 403; dallo storico firmato → 200)
- Difetto: list_sheets/create_sheet/upload_sheet_photo restituiscono il modello; ninja serializza FieldFile con `.url` nudo, mentre technical_sheets/ è privato.
- Scenario: tab «Scheda tecnica» e modale: foto sempre rotte, anche subito dopo il caricamento; l'operatrice ricarica e sostituisce.
- Correzione: serializzare con `_sheet_out` (signed_media_url) o resolver su TechnicalSheetOut.photo.

### [MEDIO] 06-04 Numeri esteri rovinati dalla tabella corta dei prefissi
- File: `backend/common/phone.py:16-55`; `frontend/packages/shared/src/phone.js:129-138`
- Stato: CONFERMATO (PhoneProbe.test_foreign_number_without_plus_like_frontend; node: joinPhone('RO','0721234567') → +400721234567)
- Difetto: (a) lo 0 nazionale si toglie solo per 12 prefissi: Romania, Albania, Ucraina, Marocco, Moldavia… salvano +40 0721…, numero inesistente, e la stessa persona scritta senza 0 diventa una seconda scheda; (b) 12+ cifre senza «+» con prefisso fuori elenco ricevono +39 (380501234567 → +39380501234567) mentre normalizePhone del frontend dà +380…: la regola «uguale a splitPhone» non lo è (import CSV da Excel).
- Scenario: cliente romena digita 0721 234 567 con bandiera RO → OTP e promemoria mai arrivati, niente accesso all'app.
- Correzione: togliere lo 0 per tutti i paesi salvo IT/SM/VA/CI; `_already_international` con l'elenco completo dei prefissi (quello del frontend).

### [MEDIO] 06-05 Storico: chi non ha il permesso vendite (Operatrice predefinita) vede ogni visita pagata «non incassato»
- File: `backend/apps/clients/api.py:469-486,509`; `frontend/.../clienti/tabs/StoricoTab.jsx:196-197`
- Stato: CONFERMATO (HistoryProbe.test_history_without_sales_scope…: sale=None e nessun flag «nascosto»)
- Difetto: il backend nasconde la vendita, il frontend interpreta sale=null come non pagato e mostra comunque il prezzo.
- Scenario: l'operatrice dice alla reception che la cliente non ha pagato l'ultima volta.
- Correzione: `sales_hidden` nella risposta (come stats_hidden) e niente etichetta di pagamento in quel caso.

### [MEDIO] 06-06 Rinominare un'etichetta spegne in silenzio le regole caparra e i filtri che la citano
- File: `backend/apps/clients/api.py:79-94`; `backend/apps/clients/services.py:59-61`; `frontend/.../impostazioni/lib.jsx:167`
- Stato: CONFERMATO (RenameLabelProbe.test_renaming…: caparra 20 € → 0 dopo «Da seguire» → «Da seguire!»)
- Difetto: le condizioni salvano il NOME dell'etichetta; update_category non aggiorna DepositRule/Automation.
- Scenario: il titolare corregge il nome dell'etichetta → alle clienti a rischio non si chiede più la caparra.
- Correzione: riscrivere il nome nelle condizioni al rename (o condizioni per id).

### [MEDIO] 06-07 Import: «cliente dal» = oggi per tutto lo storico importato
- File: `backend/apps/clients/services.py:264-267`; effetti in `backend/apps/insights/services.py:292-331,428-430`
- Stato: CONFERMATO per lettura (nessun campo `since` importabile; KPI su since)
- Difetto: la correzione del 18/09 dà `since=oggi` a ogni scheda importata.
- Scenario: salone che importa 4000 clienti: «Nuovi clienti» 4000 nel mese, «di ritorno» a zero, ogni scheda storica dice «cliente dal 2026».
- Correzione: since vuoto (o colonna importabile) per le righe importate.

### [MEDIO] 06-08 Import: riga senza telefono con email condivisa rinomina un'altra cliente
- File: `backend/apps/clients/services.py:219-233`
- Stato: CONFERMATO (ImportProbe.test_phoneless…: «Mamma Rossi» diventa «Figlia Rossi», esito 1 creata 1 aggiornata)
- Difetto: il ripiego per email sovrascrive nome/cognome della scheda trovata.
- Scenario: email di famiglia, figlia senza telefono nel file → la scheda della madre prende il nome della figlia.
- Correzione: su match per email non toccare nome/cognome (o saltare con errore se il nome differisce).

### [MEDIO] 06-09 `whatsapp_reminders` (e `wa`) non li legge nessuno: chi spegne i promemoria li riceve lo stesso
- File: `backend/apps/agenda/services.py:823-848` (_event_payload); `backend/apps/accounts/api.py:741`; `ConsensiTab.jsx:17-20`
- Stato: CONFERMATO per lettura (grep: nessun uso fuori da scrittura/serializzazione; già annotato in docs/MIGLIORIE_2026-09-18.md §3/0.6, mai corretto)
- Scenario: la cliente disattiva i promemoria dal Profilo dell'app → conferme e promemoria continuano ad arrivarle.
- Correzione: portare le preferenze nel payload o non emettere gli eventi-messaggio per chi ha detto no.

### [BASSO] 06-10 La scheda aperta in dashboard riscrive lang/email/promemoria/consensi dalla copia vecchia
- File: `frontend/.../clienti/helpers.js:32-50`; `ClientProfile.jsx:47-49,72-87`; `backend/apps/accounts/api.py:731-743`; `backend/apps/clients/api.py:918`
- Stato: CONFERMATO (StaleConsentsProbe: dopo il cambio in app lang en → it, whatsapp_reminders False → True)
- Difetto: ogni PUT (anche un'etichetta) manda il corpo intero; client_update_me e il form pubblico non emettono `client.updated` con client_id, quindi la scheda non si ricarica. I consensi toccati dalla dashboard non hanno data, benché la UI dica che «ne conserva la data».
- Correzione: mandare solo i campi cambiati; date del consenso gestite dal server.

### [BASSO] 06-11 Doppio prefisso «+39 39 333…» accettato come numero valido
- File: `backend/common/phone.py:58-75`; `frontend/packages/shared/src/phone.js:132-139`
- Stato: CONFERMATO (PhoneProbe.test_double…); PLAUSIBILE che in archivio restino numeri +3939… del difetto D2, mai bonificati
- Scenario: in PhoneInput con IT si digita «39 333…» → +39393331234567: seconda identità, OTP a numero inesistente.
- Correzione: dopo +39 più di 11 cifre che iniziano per 39 → togliere il 39 ripetuto (e bonifica).

### [BASSO] 06-12 Etichetta con nome già esistente (o doppio clic su Salva) → 500
- File: `backend/apps/clients/api.py:64-94`; `CategoriesManagerModal.jsx:58-70`
- Stato: CONFERMATO (RenameLabelProbe.test_duplicate…: IntegrityError non gestita)
- Correzione: catturare IntegrityError → 400; guardia busy sul salvataggio.

### [BASSO] 06-13 Import: 29/02 di un anno non bisestile fa perdere l'intera riga
- File: `BulkImportModal.jsx:133` (valid() usa il 2000); `backend/apps/clients/services.py:196-202`
- Stato: CONFERMATO (ImportProbe.test_feb_29…: created 0, riga scartata)
- Correzione: validare col vero anno nel frontend; lato server importare senza compleanno invece di scartare.

### [BASSO] 06-14 Import: compleanno senza anno nel file cancella l'anno già noto
- File: `backend/apps/clients/services.py:241-242`
- Stato: CONFERMATO (ImportProbe.test_yearless…)

### [BASSO] 06-15 Import: reimportare lo stesso file duplica le note su ogni cliente
- File: `backend/apps/clients/services.py:280-281`
- Stato: CONFERMATO (ImportProbe.test_reimport…: 2 note)

### [BASSO] 06-16 Ricerca insensibile agli accenti assente («nicolo» non trova «Nicolò»)
- File: `backend/apps/clients/api.py:131-156`
- Stato: CONFERMATO (SearchProbe)

### [BASSO] 06-17 Revoca del consenso marketing: correzione del 18/09 incompleta
- File: `backend/apps/marketing/api.py:711-742`
- Stato: CONFERMATO per lettura (nessuna schermata chiama /client/marketing-consent; ClientMeOut non espone i consensi)
- Scenario: chi ha dato il consenso dal form non può revocarlo dall'app.

### [BASSO] 06-18 Storico: giorno/mese della timeline dal fuso del dispositivo
- File: `frontend/.../clienti/tabs/StoricoTab.jsx:88-96` (`new Date(e.date).getDate()`)
- Stato: CONFERMATO per lettura

### [BASSO] 06-19 Bonifica doppioni: consiglia di cancellare la scheda «svuotata» guardando solo visite e vendite
- File: `backend/apps/clients/management/commands/check_phone_duplicates.py:71-75,158-166`; `DEPLOY.md:422-424`
- Stato: PLAUSIBILE (dipende dall'uso)
- Difetto: la cancellazione porta via in CASCADE note, schede tecniche, punti fedeltà, lista d'attesa e scollega vendite e gift card; il comando non li mostra.

### [BASSO] 06-20 Form pubblico: il contatto nuovo nasce sempre in italiano
- File: `backend/apps/clients/api.py:858-873`; `backend/apps/clients/schemas.py:259-275`; `client-app/src/screens/Hook.jsx:27-36`
- Stato: CONFERMATO per lettura (HookLeadIn senza lang)

Aree controllate senza reperti: phone_key sempre ricalcolata (nessun update()/bulk_* sul telefono fuori dalla 0006), IntegrityError su create/update cliente → 400, form pubblico (honeypot, rate limit, non-oracolo, doppio invio), allegati delle note (tipo/estensione, nome generato, firma, percorsi canonici, filtro salone), check_phone_duplicates eseguibile, parse_birthday (--02-30 → 400, --02-29 ok), genere, schede tecniche immutabili con appuntamento validato, permessi su storico/note/schede, stats_hidden, parser CSV (BOM, «;», virgolette, righe vuote), numeri corti a 5 cifre accettati per scelta (test frontend).
