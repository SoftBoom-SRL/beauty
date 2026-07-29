# Collegare Stripe e provare i pagamenti — guida operativa

Questa guida serve a **chi deve configurare Stripe e provare il livello pagamenti**
del progetto. Il codice è completo e coperto da test, ma non è mai stato eseguito
contro Stripe vero: manca solo questo passaggio.

Non serve saper programmare per i passi da 1 a 4. I passi 5 e 6 richiedono di
avviare il progetto in locale.

---

## Cosa stiamo per fare, in breve

Ogni centro estetico collega il **proprio** account Stripe e incassa sul proprio
conto: caparre e addebiti per mancata presentazione. La piattaforma (youty) non
trattiene commissioni e non tocca il denaro.

Perché funzioni serve **un solo valore configurato una volta**: l'identificativo
della piattaforma verso Stripe (`ca_...`). Non è l'account di nessun salone e non
riceve denaro: serve solo a far esistere il pulsante "Collega Stripe", come
l'identificativo che serve per far funzionare un "accedi con Google".

**In modalità test non si muove un euro e non serve nessun dato reale.**

---

## 1. Account Stripe della piattaforma

Serve un account Stripe intestato alla società (SoftBoom SRL). Se esiste già,
usa quello e salta al passo 2.

Se non esiste: **dashboard.stripe.com/register** → email e password. In modalità
test non è richiesta nessuna verifica di identità: quella serve solo per
incassare denaro reale.

> Attenzione: creare l'account comporta l'accettazione dei termini di Stripe.
> Va fatto da chi ha titolo a impegnare la società.

## 2. Accendi la modalità test e attiva Connect

1. Entra in **dashboard.stripe.com**
2. In alto, accendi l'interruttore **"Modalità test"** (Test mode). Da qui in poi
   tutto quello che fai è finto e reversibile.
3. Menu di sinistra → **Connect**. Se è la prima volta compare una procedura di
   attivazione: seguila, sono due o tre schermate. È gratuita.

## 3. Prendi i due valori e imposta i redirect

**Valore A — l'identificativo della piattaforma**
`Connect` → `Impostazioni`. Cerca la voce **client ID**: inizia con `ca_`.

Nella stessa pagina c'è il campo dei **redirect URI**. Aggiungi:

```
http://localhost:5173/oauth-popup/stripe-done
```

Serve a Stripe per sapere dove rimandare l'utente dopo il collegamento. Senza
questo, il collegamento viene rifiutato.

**Valore B — la chiave segreta di test**
`Sviluppatori` → `Chiavi API` → riga **Chiave segreta**, bottone "Rivela".
Inizia con `sk_test_`.

> La chiave segreta dà accesso all'account Stripe. Non incollarla in chat, in
> email o in un messaggio: va solo nel file del passo 4, che è escluso da Git.

## 4. Metti i valori nel file di configurazione

Nella cartella del progetto, apri `backend/.env` con un editor di testo.
Se non esiste, copia `backend/.env.example` e rinominalo in `.env`.

Aggiungi (o scommenta) queste righe, sostituendo i valori:

```
STRIPE_SECRET_KEY=sk_test_...        # il valore B
STRIPE_CONNECT_CLIENT_ID=ca_...      # il valore A
FRONTEND_ORIGIN=http://localhost:5173
CLIENT_APP_ORIGIN=http://localhost:5174
```

Salva. Il file `.env` è già in `.gitignore`: non finirà mai su GitHub.

## 5. Avvia il progetto

Se è la prima volta su questa macchina:

```bash
cd backend
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo          # salone demo "The Parlour" + dati finti

cd ../frontend
npm install
```

Poi, dalla cartella principale:

```bash
./start-dev.sh
```

Tre indirizzi:

| | URL | accesso |
|---|---|---|
| Dashboard salone | http://localhost:5173 | `sole@theparlour.it` / `theparlour` |
| App cliente | http://localhost:5174 | vedi nota OTP più sotto |
| Documentazione API | http://localhost:8000/api/docs | — |

> **Nota sull'OTP:** l'accesso dell'app cliente avviene con un codice che passa
> dalla piattaforma Yourang, che in locale non è collegata. Il codice si legge
> nel log del backend, oppure nella tabella `core_outboxevent` cercando
> `event_type = "client.otp"`. Non c'entra con Stripe: è un limite separato,
> tracciato a parte.

## 6. La prova

### 6.1 Collegare l'account del salone

1. Dashboard → **Impostazioni** → **Pagamenti**
2. Premi **"Collega Stripe"**: si apre una finestra di Stripe
3. In modalità test Stripe offre di creare un account di prova precompilato:
   accettalo (è finto). Se chiede il tipo di attività scegli quello che vuoi.
4. Conferma il collegamento

**Cosa deve accadere:** la finestra si chiude da sola e la pagina mostra
**"Incassi attivi"** con l'identificativo dell'account (`acct_...`).

Se mostra **"Verifica da completare"**: è normale se l'account di prova non ha
completato l'onboarding. Premi **"Ricontrolla"**. Con un account di test
generato da Stripe di solito risulta subito attivo.

### 6.2 Caparra pagata dalla cliente

1. Dashboard → **Impostazioni** → **Pagamenti** → attiva **"Richiedi la caparra"**, salva
2. Servono anche delle regole di importo: **Impostazioni** → **Prenotazioni e
   ottimizzazione** → sezione acconti, crea una regola (es. 30%)
3. App cliente → accedi (vedi nota OTP) → prenota un appuntamento
4. Nella lista **Le tue prenotazioni** deve comparire il pulsante
   **"Versa la caparra · € X"**
5. Premilo: si apre la pagina di pagamento di Stripe

Usa la carta di test che riesce sempre:

```
Numero:    4242 4242 4242 4242
Scadenza:  una data futura qualsiasi (es. 12/34)
CVC:       tre cifre qualsiasi (es. 123)
```

**Cosa deve accadere:** il pagamento va a buon fine, torni nell'app, e in
dashboard l'appuntamento risulta con caparra **pagata**.

> Perché conta: lo stesso pagamento **salva anche la carta**, così l'eventuale
> addebito per mancata presentazione non richiede un secondo passaggio della
> cliente. Verifica che nel **Profilo** dell'app cliente compaia "Carta salvata".

### 6.3 Salvataggio carta senza pagamento

App cliente → **Profilo** → sezione **Pagamenti** → **"Salva carta"**.
Si apre la stessa pagina Stripe, ma **non viene addebitato nulla**.

Serve ai saloni che vogliono tutelarsi dalle mancate presentazioni **senza**
chiedere caparre.

Attiva poi l'interruttore **"Autorizzo l'addebito"**: senza quel consenso
nessun addebito è possibile, anche con la carta salvata.

### 6.4 Addebito per mancata presentazione, e rimborso

1. Dashboard → **Agenda** → apri un appuntamento della cliente di prova
2. Segnalo come **No-show**
3. Riapri l'appuntamento: compare il blocco **Addebito** con percentuale e importo
4. Premi **"Addebita"**

**Cosa deve accadere:** messaggio di conferma con l'importo. Poi premi
**"Rimborsa"** e verifica che il rimborso vada a buon fine.

Prova anche a premere **"Addebita" due volte**: la seconda volta deve rifiutare
con "Questo appuntamento è già stato addebitato". È una protezione contro il
doppio prelievo.

### 6.5 Il caso da verificare con più attenzione

In Europa, un addebito su carta salvata **può richiedere che la cliente
autentichi l'operazione con la sua banca** (normativa PSD2). Non è un errore: è
previsto, e nessuna implementazione può garantire il prelievo automatico al 100%.

Stripe mette a disposizione carte di test che forzano proprio questo caso.
L'elenco aggiornato è qui: **https://docs.stripe.com/testing** — cerca la
sezione sull'autenticazione (SCA / 3D Secure), in particolare una carta
descritta come *"requires authentication"*.

Salva quella carta nel profilo dell'app cliente (passo 6.3) e poi ripeti
l'addebito del passo 6.4.

**Cosa deve accadere:** il messaggio deve dire **"Addebito in attesa: la cliente
deve autenticarlo con la banca"**, e **non** "Addebitato". Nel **Registro
attività** (Impostazioni → Registro attività) deve comparire una voce di
addebito *in attesa*.

Questo è il punto su cui è più importante avere conferma: se qui dicesse
"Addebitato", il salone crederebbe di aver incassato senza averlo fatto.

---

## Cosa riportare indietro

Per ognuno dei punti 6.1 → 6.5: **funziona** oppure **cosa è comparso invece**.

Se qualcosa va storto servono:
- il messaggio d'errore visto a schermo
- le ultime righe del terminale dove gira il backend
- in Stripe: `Sviluppatori` → `Log`, l'ultima richiesta con il suo errore

Quest'ultimo è il più utile: dice esattamente cosa Stripe ha rifiutato e perché.

---

## Cosa è già verificato (non serve riprovarlo)

- **217 test automatici** verdi, comprese le garanzie che ogni salone incassi sul
  proprio account e che non si possa addebitare due volte
- I nomi dei campi dell'API Stripe, controllati contro la libreria installata
  (`stripe 15.3.1`): collegamento OAuth, stato dell'account, pagamento ospitato,
  rimborso, e il modo in cui si indica l'account del salone
- La gestione dell'errore PSD2, dove erano emersi due difetti poi corretti

Quello che **non** è verificato è solo il comportamento contro il servizio vero:
è esattamente ciò che serve provare qui.

---

## Note

- **Il webhook non è coperto da questa guida.** In locale Stripe non riesce a
  contattare il server, quindi lo stato della caparra non si aggiorna da sé dopo
  il pagamento. Per provarlo serve `stripe listen` (la CLI di Stripe) oppure un
  ambiente raggiungibile da internet. Da fare in un secondo giro.
- **Restare in modalità test** finché la prova non è conclusa. Il passaggio alla
  modalità reale richiede la verifica dell'identità della società e chiavi
  diverse (`sk_live_`, `ca_` di produzione).
- Il modello scelto è **Connect Standard con addebiti diretti**: il salone è il
  titolare dell'incasso, il suo nome compare sull'estratto conto della cliente e
  le eventuali contestazioni le gestisce lui. La motivazione completa è nel
  messaggio del commit `1f5f8b4`.
