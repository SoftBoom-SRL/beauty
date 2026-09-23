# Caccia ai bug — beauty, 22 settembre 2026

> **Stato al 23/09/2026:** tutti i reperti sono stati corretti sul ramo `claude/exciting-bohr-5ch9g7`.
> Per ogni ID il commit che lo corregge, le verifiche da fare in produzione e i punti aperti sono in
> [STATO-CORREZIONI.md](STATO-CORREZIONI.md). Il testo qui sotto è il rapporto del 22, com'era.

Diciotto revisori in parallelo su `main` = 754ed6b (in produzione): quindici per area e tre trasversali
(funzioni nuove, contratto fra frontend e backend, concorrenza). Tutti in sola lettura. **La revisione è
stata interrotta a metà per esaurimento dei crediti**: ogni revisore ha scritto ciò che aveva già trovato,
quindi alcune aree non sono state esplorate fino in fondo.

**326 segnalazioni: 4 critiche, 26 alte, 123 medie, 173 basse.** Molte coincidono fra revisori diversi,
il che le conferma. Una volta fusi i doppioni, a occhio restano circa 250 difetti distinti. **Non è stato
corretto nulla.**

Stato di partenza: 653 test backend verdi, 27 frontend verdi, build verdi, nessuna migrazione mancante,
nessun identificatore JS non dichiarato. Lo smoke end-to-end fallisce allo step 11: è lo smoke rimasto
indietro rispetto alla trattenuta dei messaggi, e sotto c'è un caso vero più stretto (03-10).

I revisori hanno marcato ogni reperto come CONFERMATO (percorso ripercorso o probe che lo riproduce) oppure
PLAUSIBILE. Di persona ho riverificato soltanto i punti segnati ✔.

Prove temporanee dei revisori: `probes/<app>/tests_probe_*.py`. Riproducono i difetti; vanno riportate
dentro `backend/apps/<app>/` per eseguirle.

---

## Da controllare subito in produzione (sono verifiche, non codice)

1. **Stripe** (05-01, ✔): se in produzione Stripe è configurato, link caparra, webhook, Connect e rimborsi
   sono rotti già oggi.
2. **Account demo** (08-01, 15-01, 08-02): controllare che in produzione non esista `sole@theparlour.it`
   come superuser. **Mai eseguire `seed_demo` in produzione**: il salone vero si chiama «The Parlour» e
   `--reset` cancella per slug proprio quello.
3. **`phone_key`** (18-02): le chiavi scritte prima di 9991cb5 non sono mai state ricalcolate. Le clienti
   con quelle chiavi rischiano di non essere trovate per numero.

---

## I critici

### 1. Con `stripe==15.6.1` ogni risposta Stripe esplode su `.get()` — 05-01 ✔
`backend/apps/sales/stripe_service.py:115`, `:285` e gli altri punti in cui si fa `.get()` su oggetti Stripe.
Da stripe-python 15 `StripeObject` non è più un `dict`: `obj.get("x")` solleva
`AttributeError: 'get' is a dict method, but a StripeObject is not a dict`. Verificato nel venv con la
versione bloccata in `requirements.txt`. Correzione: accesso per chiave (`obj["x"]`), `getattr`, oppure
`obj.to_dict()`.

### 2. Tessera «A timbri» creata dalla dashboard: un timbro per ogni euro — 07-01 = 14-01
Trovato in modo indipendente da due revisori. A ogni scontrino scattano più premi.

### 3. `seed_demo` crea un superuser con password pubblica — 08-01 (con 15-01 e 08-02)
Il superuser dà accesso a `/admin/` di tutti i saloni. `entrypoint.sh` non esegue il seed ✔, quindi
l'account esiste in produzione solo se qualcuno ha lanciato il comando a mano. Però la pagina di accesso di
produzione mostra «Demo: sole@theparlour.it» (`frontend/apps/dashboard/src/LoginPage.jsx:117`) ✔, e
`seed_demo --reset` cancella per slug il salone vero «The Parlour» (08-02).

---

## Gli alti (26), per tema

**Soldi e caparre**
- 02-01 Se si riduce la caparra alla nuova visita, si perde quanto la cliente ha già versato.
- 02-04 La scadenza della caparra resta sull'orario di prima: la visita spostata viene liberata all'ora vecchia.
- 03-02 = 18-01 (+ 02-07, 05-08) Annullare una creazione con caparra online lascia vivo il link: se la cliente paga, i soldi spariscono.
- 05-02 C'è un solo segreto di firma per il webhook: con Stripe Connect una delle due famiglie di eventi viene sempre rifiutata.
- 14-02 (= 17-03, 05-15) Il conto non si chiude quando la caparra supera il totale.
- 14-03 = 06-01 (+ 05-05, 05-03) La vendita-caparra conta come visita, spesa della cliente e vendita da banco.
- 13-02 = 02-10 L'anteprima dell'annullamento promette «caparra trattenuta», ma dal gestionale la caparra viene sempre rimborsata.

**Agenda e messaggi**
- 01-01 Forzando con «Prima disponibile», la visita va alla prima operatrice idonea anche se è occupata e una collega è libera.
- 02-02 = 12-01 Se si stacca un servizio, gli altri della visita slittano mentre la griglia li mostra fermi; con 409→force finiscono sopra un'altra cliente.
- 02-03 = 03-01 «Torna indietro» butta via anche le modifiche precedenti ancora trattenute: lo spostamento che resta in vigore non viene mai comunicato.
- 07-02 Modificare, riprogrammare o eliminare una comunicazione programmata non ferma l'invio già consegnato a Yourang.
- 13-01 (= 17-06, 12-05) «Sposta qui» alla stessa ora e nella stessa colonna di un altro giorno non sposta niente.
- 13-03 Il pannello di dettaglio non si aggiorna quando l'appuntamento cambia altrove: i suoi comandi partono dalla copia vecchia.

**Sicurezza e permessi**
- 10-01 Con lo scope «team» ci si può dare qualunque ruolo tramite gli inviti in attesa.
- 10-05 (= 15-02) Con lo scope «team» si può azzerare il ruolo di una collega con più permessi.
- 09-01 (+ 10-09) L'API staff mostra a qualunque ruolo gli incassi delle colleghe e la spesa delle clienti.
- 11-01 «Collega Yourang» riscatta un codice preso dall'URL con la sessione del titolare: il salone viene ricollegato all'organizzazione di un altro.
- 11-02 = 10-03 «Accedi con Yourang» fa collegare il salone a un membro che non è il titolare.
- 16-01 = 10-04 Il tetto OTP per salone si riempie con numeri inventati e blocca l'accesso di tutte le clienti.
- 08-02 `seed_demo --reset` cancella il salone vero «The Parlour».
- 15-01 La pagina di accesso di produzione indica l'account demo.

**Dati**
- 18-02 `phone_key` è stata scritta con l'algoritmo del 17/09 e mai ricalcolata dopo il cambio di `normalize_phone` in 9991cb5.

---

## Temi trovati da più revisori

- **Operatrice disattivata** (01-06, 02-05, 04-01, 12-07, 13-04, 17-01, più 09-05 e 15-05): riassegnarne gli
  appuntamenti risponde 404, i suoi servizi dentro visite altrui spariscono dalla griglia, e dalla dashboard
  non la si riattiva più.
- **Fuso del dispositivo invece di quello del salone**: registro attività, scadenza della caparra nel
  pannello, storico cliente, «ultima visita», scadenze di coupon e gift card, `wlRank` (02-25, 06-18,
  07-15, 08-09, 09-11, 12-19, 13-14, 14-13, 15-09, 15-22, 17-15).
- **La caparra negli incassi**: contata due volte nello storico, rimborsata ma ancora in `cash_in`, contata
  come visita (02-11, 05-03, 05-04, 05-05, 06-01, 08-17, 14-03).
- **Centesimi**: la cassa arrotonda in virgola mobile, il server in Decimal HALF_UP, e la vendita viene
  rifiutata con 422 (05-09, 14-04, 17-02).
- **«Annulla» del pannello**: rifà lo spostamento al contrario forzandolo invece di passare dal torna
  indietro: resta «forzato» e alla cliente parte un secondo messaggio (03-07, 13-06, 17-05).
- **Fusione degli eventi**: `slot.freed` annuncia lo slot sbagliato, il messaggio di spostamento porta
  l'orario intermedio o perde `old_start`, il worker spedisce il payload letto prima della fusione (02-13,
  02-14, 03-04, 03-06, 03-08, 11-15, 18-04, 18-09).
- **Nota interna dello staff** restituita alla cliente quando sposta o annulla dall'app (04-06, 10-10, 16-06).
- **Saldo gift card nell'app cliente**: somma anche le carte da pagare e quelle regalate ad altre (07-05,
  16-03, 17-14).
- **Etichetta rinominata**: spegne in silenzio le regole caparra e i filtri che la citano per nome (01-13,
  06-06, 15-07).
- **Permessi sulle letture**: `/agenda/released` senza scope (02-18, 04-05, 10-09); codici di gift card e
  coupon leggibili da tutto lo staff (10-06).

---

## Conteggio per area

| # | Area | Critici | Alti | Medi | Bassi | Tot |
|---|---|---|---|---|---|---|
| 01 | Motore disponibilità | 0 | 1 | 6 | 7 | 14 |
| 02 | Ciclo di vita dell'appuntamento | 0 | 4 | 10 | 11 | 25 |
| 03 | Torna indietro e messaggi trattenuti | 0 | 2 | 5 | 9 | 16 |
| 04 | API agenda | 0 | 0 | 5 | 6 | 11 |
| 05 | Cassa e Stripe | 1 | 1 | 10 | 8 | 20 |
| 06 | Clienti e telefoni | 0 | 1 | 8 | 11 | 20 |
| 07 | Fedeltà, coupon, gift card, comunicazioni | 1 | 1 | 5 | 9 | 16 |
| 08 | Core, impostazioni, insight | 1 | 1 | 7 | 10 | 19 |
| 09 | Magazzino, catalogo, staff | 0 | 1 | 4 | 6 | 11 |
| 10 | Sicurezza e permessi | 0 | 2 | 4 | 7 | 13 |
| 11 | Integrazioni e deploy | 0 | 2 | 11 | 8 | 21 |
| 12 | Agenda React: griglia | 0 | 1 | 9 | 15 | 25 |
| 13 | Agenda React: flussi | 0 | 3 | 9 | 13 | 25 |
| 14 | Dashboard: clienti, cassa, fedeltà | 1 | 2 | 6 | 16 | 25 |
| 15 | Dashboard: impostazioni e resto | 0 | 1 | 8 | 13 | 22 |
| 16 | App cliente e condiviso | 0 | 1 | 4 | 7 | 12 |
| 17 | Contratto frontend↔backend | 0 | 0 | 7 | 9 | 16 |
| 18 | Concorrenza e integrità dati | 0 | 2 | 5 | 8 | 15 |
| | **Totale** | **4** | **26** | **123** | **173** | **326** |

I critici sono 4 segnalazioni ma 3 difetti: 07-01 e 14-01 sono lo stesso.

---

## Ordine di intervento suggerito

1. Le tre verifiche in produzione qui sopra.
2. I tre critici: Stripe (una modifica meccanica), timbri, guardie su `seed_demo` e sulla pagina di accesso.
3. Gli alti di sicurezza: scope «team», collegamento Yourang, tetto OTP, API staff.
4. Gli alti su soldi e caparre, poi quelli dell'agenda.
5. I temi ripetuti, ciascuno con una sola correzione: operatrice disattivata, fuso, centesimi, caparra negli
   incassi.

Come la volta scorsa: correzioni con proprietà esclusiva dei file, e alla fine un revisore dedicato alle
regressioni sul contratto fra frontend e backend.
