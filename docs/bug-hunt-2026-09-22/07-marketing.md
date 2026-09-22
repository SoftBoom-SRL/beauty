# Revisore 07 — marketing: fedeltà, coupon, gift card, comunicazioni

Probe: `backend/apps/marketing/tests_probe_07marketing.py` (lasciato su disco su richiesta dell'orchestratore; ogni test afferma il comportamento corretto e fallisce). Script node: `scratchpad/probe07/frontend_probe.mjs`.

### [CRITICO] 07-01 Un programma «A timbri» creato dalla dashboard dà un timbro per ogni euro: più premi a ogni scontrino
- File: `frontend/apps/dashboard/src/sections/fedelta/modals/LoyaltyEditModal.jsx:17,33-34,109-121`, `fedelta/LoyaltySub.jsx:29-34`, `fedelta/meta.js:30`, `backend/apps/marketing/services.py:247-262`
- Stato: CONFERMATO (probe `StampsProgramProbe`: piega da 45 € → 4 buoni da 10 € e 5 timbri residui; atteso 1 timbro, 0 premi)
- Difetto: il modello vuoto ha `earn_metric='per_euro', earn_ratio=1`; con «A timbri» (`isPts` falso) metrica e rapporto spariscono dalla maschera ma restano nel payload; `_points_earned` ignora `type`. Il suggerimento dice «Un timbro per visita/servizio» e non c'è modo di correggerlo dalla UI.
- Scenario: «10 timbri = piega omaggio»: un colore da 60 € emette 6 carte omaggio (fino al tetto di 10) e 6 WhatsApp, per ogni cliente a ogni incasso.
- Correzione: per `stamps` mostrare/mandare visita o servizio (default `per_visit`), rifiutare `per_euro` lato server, bonificare i programmi esistenti.

### [ALTO] 07-02 Modificare, riprogrammare o eliminare una comunicazione programmata non ferma l'invio già consegnato a Yourang
- File: `backend/apps/marketing/services.py:422-440,474-493`, `backend/apps/marketing/api.py:547-589`, `core/management/commands/flush_outbox.py` (consegna subito), `frontend/.../comunicazioni/index.jsx:190-195`
- Stato: CONFERMATO (probe `ScheduledCommunicationProbe`: dopo consegna + modifica + nuovo invio 2 invii vivi e 0 annullamenti; eliminazione senza alcun evento verso Yourang)
- Difetto: la programmata esce subito (`next_attempt_at` nullo) e il worker la consegna in pochi secondi; `cancel_pending_send` guarda solo `pending`. Nessun evento di annullamento; la comunicazione non diventa mai «inviata» dopo la data e resta rinviabile. La correzione E3 del 18/09 regge solo a coda ferma.
- Scenario: con la consegna attiva, «Modifica per riprogrammare» per un refuso → ogni cliente riceve due messaggi, il primo sbagliato; una campagna eliminata parte lo stesso.
- Correzione: trattenere l'evento fino a `scheduled_at` (`next_attempt_at`) o emettere un `communication.cancel` idempotente; marcare `sent` le programmate scadute.

### [MEDIO] 07-03 La revoca del consenso marketing non vale per le campagne già programmate o in coda
- File: `backend/apps/marketing/services.py:453-472`, `backend/apps/marketing/api.py:712-742`
- Stato: CONFERMATO (probe `test_revocation_after_scheduling_is_honoured`: dopo la revoca l'id resta in `client_ids`)
- Difetto: `client_ids` congelati al clic su «Programma»; revoca o disattivazione successive non toccano il payload e nulla avvisa Yourang.
- Scenario: programmata lunedì per sabato, la cliente revoca martedì dall'app, sabato riceve la promo (GDPR art. 7.3).
- Correzione: risolvere l'audience alla consegna o togliere la cliente dai payload pendenti + evento di opt-out.

### [MEDIO] 07-04 Il Front desk non può incassare una gift card comprata dall'app né venderne una legata alla destinataria
- File: `backend/apps/marketing/api.py:274-277,326-329`, `backend/apps/accounts/services.py:22-26`, `frontend/.../fedelta/GiftSub.jsx:32,224`
- Stato: CONFERMATO (probe `FrontDeskCashProbe`: 403 «Permesso mancante: marketing»)
- Difetto: «Segna pagata» e «Pagata ora» creano vendita e pagamento ma chiedono `marketing`, che il ruolo di cassa non ha; il POS crea solo carte nuove con un nome (niente `recipient_client`). Specularmente un ruolo solo-marketing registra incassi senza `sales`.
- Scenario: la cliente passa a pagare la carta comprata in app: la receptionist non vede il pulsante, la cassa rifiuta il codice «non ancora pagata»; ripiego sul POS = seconda carta, la prima resta «da pagare».
- Correzione: richiedere `sales` per gli incassi di gift card e mostrare il pulsante con lo stesso criterio.

### [MEDIO] 07-05 App cliente: il saldo gift card conta le carte da pagare e quelle regalate ad altre
- File: `frontend/apps/client-app/src/screens/GiftCard.jsx:33-34,70-77,93-117`, `client-app/src/screens/Wallet.jsx:54-57`, `backend/apps/marketing/api.py:633-644`
- Stato: CONFERMATO (percorso ripercorso)
- Difetto: `GiftCard.jsx` somma tutte le carte (anche `unpaid`) e scrive «spendibili in salone» senza etichetta «Da pagare»; entrambe le schermate contano come credito dell'acquirente le carte comprate per un'altra (`received=false`), mentre il credito segue `recipient_client`.
- Scenario: acquisto in app da 100 € → subito «Saldo gift card €100 · spendibili in salone», rifiutata in cassa; carta regalata in salone alla figlia → lo stesso credito compare nell'app di madre e figlia.
- Correzione: in `GiftCard.jsx` la stessa separazione di `Wallet.jsx`; nel credito solo pagate e `received || !recipient_name`.

### [MEDIO] 07-06 Scheda cliente: punti fedeltà cercati scorrendo pagine ordinate solo per punti → iscritta data per «Non ancora iscritta»
- File: `frontend/.../clienti/tabs/WalletTab.jsx:13-35`, `backend/apps/marketing/api.py:491-508`, `marketing/models.py:177-178`, `fedelta/LoyaltyMembersDrawer.jsx:16-28`
- Stato: PLAUSIBILE (PostgreSQL con LIMIT/OFFSET e ORDER BY non univoco non garantisce pagine coerenti; non riproducibile su SQLite)
- Difetto: la scheda ignora il filtro `client_id` già esistente e pagina per `-points` senza spareggio; con migliaia di pari merito (timbri 0–9) una riga può saltare fra le pagine. Stesso problema nel cassetto iscritte.
- Scenario: tessera con 3.000 iscritte, cliente a 9/10 timbri: la scheda dice «Non ancora iscritta», nessuno le riconosce il premio.
- Correzione: `/accounts?client_id=<id>` e `id` come spareggio nell'ordinamento.

### [MEDIO] 07-07 Carte e coupon scaduti restano «attivi»: la nuova prenotazione promette come regalo una carta scaduta o di un'altra persona
- File: `frontend/.../agenda/modals/NewApptModal.jsx:40-49,383,409-414`, `backend/apps/marketing/api.py:95,230-233`, `clienti/tabs/WalletTab.jsx:86-88`, `fedelta/GiftSub.jsx`, `fedelta/CouponSub.jsx:138`
- Stato: CONFERMATO (probe `ExpiredStillActiveProbe`: con i parametri di NewApptModal una carta scaduta torna fra le attive)
- Difetto: `EXPIRED` si scrive solo al tentativo di riscatto; gli elenchi staff con `status=active` non filtrano `expires_at`. NewApptModal usa inoltre una regola diversa da `gift_index` (considera della cliente anche la carta comprata per «Zia Carla»). Le viste staff mostrano scaduti come attivi e il filtro «Scadute» non li trova.
- Scenario: «Piega» regalata scaduta la settimana scorsa: in prenotazione prezzo barrato «Regalo · da Anna», al checkout nessun regalo e la cassa chiede 45 €.
- Correzione: filtrare `expires_at` negli elenchi `active`; in NewApptModal la regola di `gift_index` (o `gifts[]`).

### [BASSO] 07-08 Comprare una gift card al banco vale una «visita» nei programmi per visita
- File: `backend/apps/marketing/services.py:258-259`, `backend/apps/sales/services.py:293-295`
- Stato: CONFERMATO (probe `PerVisitProbe`: vendita POS con sola gift card → 1 timbro)
- Difetto/Scenario: `per_euro` e `client_stats` escludono le gift card vendute, `per_visit` no (e la stessa carta incassata da Promozioni non accredita): cinque carte di Natale in cinque scontrini = cinque timbri.

### [BASSO] 07-09 Il premio fedeltà speso fa guadagnare altri punti
- File: `backend/apps/marketing/services.py:247-262` (base = `sale.total`), `services.py:196-232`
- Stato: CONFERMATO (percorso: i pagamenti con carte `paid_method="loyalty"` non si sottraggono)
- Difetto/Scenario: la piega omaggio da 45 € accredita 45 punti; con timbri per servizio l'omaggio conta come timbro e il premio arriva ogni 9 visite pagate invece di 10.

### [BASSO] 07-10 Premio «servizio omaggio» su un servizio a prezzo zero blocca l'incasso della cliente
- File: `backend/apps/marketing/services.py:57-59,196-208`, `backend/apps/marketing/api.py:404-405,432-434`
- Stato: CONFERMATO (probe `FreeServiceRewardProbe`: 422 «Valore della gift card non valido»)
- Difetto/Scenario: il listino ammette prezzo 0; alla soglia `create_gift_card(0)` solleva dentro la transazione e ogni scontrino di quella cliente viene rifiutato. Correzione: rifiutare il servizio a 0 € o trattarlo come premio non emettibile.

### [BASSO] 07-11 La modifica di un coupon può resuscitare un coupon appena usato in cassa
- File: `backend/apps/marketing/api.py:134-156` (`coupon.save()` completo su copia letta a inizio richiesta)
- Stato: CONFERMATO (probe `CouponUpdateRaceProbe` con interleaving simulato: torna `active`, `sale=None`)
- Difetto/Scenario: se `mark_coupon_redeemed` lo consuma durante la PUT, il save riscrive `status=active`: scontrino scontato e buono di nuovo spendibile. Correzione: update condizionato a `status='active'`.

### [BASSO] 07-12 Checkout: il precompilato spende una seconda gift card «a trattamento» su altri servizi
- File: `frontend/apps/dashboard/src/sections/pos/modals/SellModal.jsx:74-96`
- Stato: CONFERMATO (script node: Piega 40 + Colore 60 con due carte «Piega» → entrambe usate, contanti 20)
- Difetto/Scenario: la riga coperta non viene segnata e il tetto è il residuo dell'intero conto: la seconda piega regalata paga il colore senza che nessuno se ne accorga.

### [BASSO] 07-13 Iscrizione «Su richiesta»/«A pagamento»: il programma non accoglie più nessuna nuova cliente
- File: `backend/apps/marketing/services.py:284-286`, `fedelta/modals/LoyaltyEditModal.jsx:217-223`, `fedelta/LoyaltyMembersDrawer.jsx:81`
- Stato: CONFERMATO (nessun endpoint crea un `LoyaltyAccount` fuori da `accrue_loyalty` con `auto`)
- Difetto/Scenario: opzioni offerte e salvate, il cassetto promette «su richiesta», ma nessuna via per iscrivere: le nuove clienti non maturano nulla, in silenzio.

### [BASSO] 07-14 Si può programmare una comunicazione nel passato
- File: `backend/apps/marketing/api.py:592-612`, `services.py:479-483`, `comunicazioni/SendConfirmModal.jsx:18-20`
- Stato: CONFERMATO (nessun controllo `scheduled_at > now`; il campo parte dalla data salvata)
- Difetto/Scenario: bozza con data vecchia → «Programma» → «Programmata» per sempre con data passata, comportamento di Yourang indefinito.

### [BASSO] 07-15 Scadenze di coupon e gift card nel fuso del dispositivo; «+N mesi» sfora a fine mese
- File: `fedelta/modals/GiftCardModal.jsx:9-15`, `fedelta/modals/CouponEditModal.jsx:28`, `fedelta/CouponSub.jsx:78,138`, `fedelta/GiftSub.jsx:25-28`
- Stato: CONFERMATO (script node: 31 ago + 6 mesi → 3 mar; 30 nov + 3 mesi → 2 mar)
- Difetto/Scenario: `setHours`, `new Date(d+'T23:59')`, `toDateStr(parseISO(iso))`, `toLocaleDateString` senza fuso del salone: da una postazione su altro fuso la scadenza si sposta a ogni salvataggio; una carta «6 mesi» del 31/8 scade il 3/3.

### [BASSO] 07-16 Scheda cliente: premi «Sconto %» e «Gift card» mostrati come numero nudo
- File: `frontend/apps/dashboard/src/sections/clienti/tabs/WalletTab.jsx:75-84`
- Stato: CONFERMATO (script node: `discount_pct` → «20.00», `gift_card` → «20.00»)
- Difetto/Scenario: `rt.includes('percent')` non riconosce `discount_pct`; usare `composeReward` di `fedelta/meta.js`.

Aree controllate senza reperti: isolamento fra saloni (salon_get/filtri ovunque, client_auth); riscatto gift card concorrente e parziale (select_for_update, ricontrollo saldo, più pagamenti con la stessa carta); consumo coupon (UPDATE condizionato, vincolo cliente anche su vendita anonima, base senza righe gift card, sconto ≤ imponibile, Decimal HALF_UP); punti per euro (floor sul totale scontato meno gift card vendute), lock + F() e tetto premi; KPI gift card (venduto senza non pagate/premi, residuo senza scadute); wallet cliente (scadenza, non pagate solo all'acquirente); filtro consenso/attive/salone all'invio; audience_type validato; invio solo da bozza; mark-paid sotto lock e carta «pagata ora» con vendita; limiti gift card da app; data programmata nel fuso del salone; require_scope su tutte le scritture e letture aperte a tutto lo staff (coerente con la lezione delle automazioni); gift_index (pagate, attive, non scadute, saldo > 0, regola destinataria/acquirente); codici maiuscoli.
