# Deploy su Coolify

## Architettura

Quattro risorse Coolify, tutte dallo stesso repository:

| Risorsa | Tipo | Dominio | Build context | Porta |
|---|---|---|---|---|
| `beauty-db` | Database PostgreSQL | — (interno) | — | 5432 |
| `beauty-api` | Application · Dockerfile | `beautyapi.yourang.ai` | `/backend` | 8000 |
| `beauty-dashboard` | Application · Dockerfile | `beauty.yourang.ai` | `/frontend` | 80 |
| `beauty-client` | Application · Dockerfile | `beautyclients.yourang.ai` | `/frontend` | 80 |

Le due SPA sono file statici serviti da nginx: chiamano l'API in cross-origin, per
questo il backend ha un dominio suo (che ospita anche `/admin`).

**L'app cliente serve tutti i saloni con un solo deploy**: lo slug è il primo
segmento del path (`beautyclients.yourang.ai/the-parlour` → salone `the-parlour`),
vedi `resolveSalonSlug()` in `frontend/packages/shared/src/salon.js`.

Non c'è **nessun passo** da fare quando arriva un salone nuovo: creato in admin, il
suo URL funziona subito. Un dominio, un certificato, per sempre.

## Prerequisiti

- Un server con Coolify installato e il suo IP pubblico.
- Accesso al DNS di `yourang.ai`.
- Il repo `SoftBoom-SRL/beauty` collegato a Coolify (GitHub App o deploy key).

> **Stai aggiornando un'installazione che è già in produzione, non creandone una
> nuova?** I paragrafi da 1 a 8 descrivono la prima installazione: salta al
> **§9**, che elenca quello che va fatto *prima* del push — in particolare il
> controllo dei doppioni di telefono, senza il quale la migrazione del vincolo
> unico si ferma a metà e il deploy non arriva in fondo.

## 1. DNS

Due record A nella zona `yourang.ai`, entrambi verso l'IP del server Coolify
(`coolify-v1` su Hetzner, **91.99.117.151**):

```
beauty          A   91.99.117.151     dashboard staff
beautyapi       A   91.99.117.151     backend + admin
beautyclients   A   91.99.117.151     app cliente (tutti i saloni)
```

Nessun wildcard: i saloni stanno nel path, non nell'host. Se avevi già creato
`*.beautyclients`, puoi rimuoverlo.

> **Porta 80 filtrata su questo server** (verificato il 31/07/2026: 443 raggiungibile,
> 80 droppata a monte). Due conseguenze:
> - I certificati Let's Encrypt **non** possono usare la challenge HTTP-01. Il proxy
>   Coolify usa TLS-ALPN-01 sulla 443: l'emissione funziona (verificata su tutti e
>   tre gli host).
> - **Non esiste il redirect http→https.** Un link scritto `http://...` non risponde.
>   Tutti i link ai saloni condivisi con le clienti (WhatsApp, QR, biglietti da
>   visita) devono essere `https://` espliciti.
>
> È un limite del server, non di questo progetto: va risolto con un ticket a Hetzner.

## 2. Database

Coolify → **+ New** → **Database** → **PostgreSQL 16**. Nome `beauty-db`.

Dopo il deploy copia la **Postgres URL (internal)**: serve al backend. Ha la forma
`postgres://postgres:<password>@<host-interno>:5432/postgres`.

Attiva i backup pianificati nella tab **Backups** della risorsa.

## 3. Backend (`beauty-api`)

**+ New → Application → Public/Private Repository**, repo `SoftBoom-SRL/beauty`,
branch `main`, **Build Pack: Dockerfile**.

Configurazione:

| Campo | Valore |
|---|---|
| Base Directory | `/backend` |
| Dockerfile Location | `/Dockerfile` (è relativo alla Base Directory: `/backend/Dockerfile` verrebbe cercato in `backend/backend/` e non esiste) |
| Ports Exposes | `8000` |
| Domains | `https://beautyapi.yourang.ai` |
| Health Check Path | `/healthz` |

**Storage persistente** (tab *Storages* → *Add volume mount*), altrimenti gli upload
spariscono a ogni redeploy:

| Name | Destination Path |
|---|---|
| `beauty-media` | `/app/media` |

> **Questo volume non è coperto da nessun backup.** I backup pianificati del
> punto 2 sono quelli di Postgres: riguardano le righe, non i file. Se si perde
> `beauty-media` il database resta intatto ma ogni logo, foto di scheda tecnica e
> allegato diventa un 404, e non c'è modo di ricostruirli. Va programmata una
> copia fuori dal server (per esempio uno *Scheduled Task* che fa un tar della
> cartella verso uno storage esterno), oppure si spostano i media su S3 mettendo
> `SERVE_MEDIA=0`.

> **Se il volume esiste già da prima di settembre 2026**: il container ora gira
> con un utente senza privilegi (`app`, uid 10001) invece che come root. Un volume
> creato quando il container era root ha i file di root e gli upload nuovi
> falliscono in scrittura. Si sistema una volta sola, dalla shell del server:
> `docker exec -u root <container> chown -R 10001:10001 /app/media`. Un volume
> creato da zero eredita già i permessi giusti dall'immagine (Docker copia
> contenuto e proprietario solo quando il volume è vuoto al primo mount).

**Environment variables** — nessuna va marcata come *Build Variable*:

```
SECRET_KEY=<genera: openssl rand -hex 32>
DEBUG=0
DATABASE_URL=<Postgres URL interna dal punto 2>
ALLOWED_HOSTS=beautyapi.yourang.ai
CSRF_TRUSTED_ORIGINS=https://beautyapi.yourang.ai
CORS_ALLOWED_ORIGINS=https://beauty.yourang.ai,https://beautyclients.yourang.ai
FRONTEND_ORIGIN=https://beauty.yourang.ai
CLIENT_APP_ORIGIN=https://beautyclients.yourang.ai
DJANGO_SUPERUSER_EMAIL=tu@yourang.ai
DJANGO_SUPERUSER_PASSWORD=<password forte>

YOURANG_API_URL=<endpoint a cui consegnare i messaggi>
YOURANG_API_KEY=<token verso quell'endpoint>

YOURANG_PROXY_URL=https://connect.yourang.ai
YOURANG_PROXY_SLUG=beauty
YOURANG_PROXY_API_KEY=<lo genera chi amministra il proxy>
YOURANG_PROXY_WEBHOOK_SECRET=<idem, vedi §8>
```

### Le prime tre fermano l'avvio (è voluto)

Con `DEBUG=0` il backend **si rifiuta di partire** se `SECRET_KEY`, `ALLOWED_HOSTS`
o `DATABASE_URL` sono rimaste ai valori di sviluppo (`config/settings.py`). I
default servono a far girare `runserver` su un clone appena fatto, ma sono tutti
permissivi: chiave nota (quindi JWT da titolare firmabili da chiunque legga il
repository), host aperti, sqlite dentro il container che sparisce al deploy
successivo. Prima, una env persa su Coolify faceva ripartire l'applicazione con
quei valori e `/healthz` rispondeva `ok`: da fuori il deploy sembrava riuscito.

Se succede, nei log del container c'è questo — **non è un guasto, è la
configurazione incompleta**:

```
django.core.exceptions.ImproperlyConfigured: Configurazione di produzione incompleta (DEBUG spento):
- SECRET_KEY è un segnaposto o è troppo corta: firma i JWT staff e i link ai media,
  quindi chi la indovina entra come titolare di qualunque salone.
  Generane una con `openssl rand -hex 32`
- ALLOWED_HOSTS è aperto a qualunque host: elenca i domini veri separati da virgola
  (es. api.esempio.it)
- DATABASE_URL non è impostata: senza, i dati finiscono su uno sqlite effimero dentro
  il container e spariscono al prossimo deploy
```

Compaiono solo le righe che ti riguardano. I tre controlli in dettaglio:

| Controllo | Cosa viene rifiutato |
|---|---|
| `SECRET_KEY` | i segnaposto (`dev-insecure-change-me`, `change-me-in-production`, `changeme`) **e** qualunque chiave sotto i 32 caratteri |
| `ALLOWED_HOSTS` | vuota oppure contenente `*` (il default) |
| `DATABASE_URL` | assente (una stringa vuota conta come assente) |

Il container resta unhealthy e Coolify tiene in piedi la versione precedente: è
il comportamento desiderato, meglio un aggiornamento che non parte di uno che
parte con la chiave del repository. Nota che `ALLOWED_HOSTS` non ha bisogno di
`localhost`: l'healthcheck del container lo aggiunge da sé.

Tutte le altre variabili invece falliscono in silenzio: il deploy riesce,
`/healthz` risponde `ok`, e la funzione che dipendeva da quella variabile
semplicemente non c'è.

| Variabile | Cosa succede se manca |
| --- | --- |
| `FRONTEND_ORIGIN` | È l'origine della **dashboard**, e ci si costruiscono sopra sia il ritorno del popup Yourang (`<FRONTEND_ORIGIN>/oauth-popup/done`) sia il `redirect_uri` di Stripe Connect (`<FRONTEND_ORIGIN>/stripe-connect/done`). Il default è `http://localhost:5173`: in produzione il popup tornerebbe su una pagina che non esiste. |
| `CLIENT_APP_ORIGIN` | È l'origine dell'**app cliente**, e decide dove torna la cliente dopo aver pagato la caparra. Se manca si ripiega su `FRONTEND_ORIGIN`: il pagamento riesce e la cliente atterra sulla login del gestionale. |
| `YOURANG_API_URL`<br>`YOURANG_API_KEY` | Sono l'indirizzo e la chiave a cui `flush_outbox` consegna i messaggi. Senza l'URL il comando si limita a **contare** i pendenti: gli OTP dell'app cliente restano in tabella e nessuna cliente riesce a entrare. Il job schedulato da solo non basta (vedi *Job schedulati*). |
| `YOURANG_PROXY_URL`<br>`YOURANG_PROXY_API_KEY` | Servono entrambe: senza, ogni rotta OAuth risponde `503 Integrazione Yourang non configurata` — niente «Collega Yourang» dalle impostazioni e niente «login con Yourang» dalla pagina di login. |
| `YOURANG_PROXY_SLUG` | Il nome del portale sul proxy, che entra nell'URL `<YOURANG_PROXY_URL>/v/<slug>`. Il default `beauty` è già quello giusto: si cambia solo se sul proxy il portale è registrato con un altro nome. |
| `YOURANG_PROXY_WEBHOOK_SECRET` | Con questo il proxy firma i webhook in ingresso. È fail-closed: senza, `POST /api/integrations/yourang/webhook` rifiuta **tutto** con 401 e il sync resta fermo a quello iniziale. |

Opzionali, da aggiungere quando servono:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_CLIENT_ID=ca_...
```

Con Connect i webhook arrivano da **due** endpoint Stripe (vedi §8), ognuno col
suo segreto di firma: `STRIPE_WEBHOOK_SECRET` per quello dell'account della
piattaforma, `STRIPE_CONNECT_WEBHOOK_SECRET` per quello degli account collegati.
Con uno solo dei due, gli eventi dell'altra famiglia vengono rifiutati come
«Firma webhook non valida»: la cliente paga e la caparra resta «richiesta» fino
al rilascio dello slot. In alternativa, o durante la rotazione di un segreto,
`STRIPE_WEBHOOK_SECRETS=whsec_a,whsec_b` elenca tutti quelli validi.

`STRIPE_CONNECT_CLIENT_ID` è il client_id della piattaforma
(dashboard.stripe.com → *Connect* → *Impostazioni*): serve a far collegare al
titolare il **proprio** account Stripe, così le caparre arrivano a lui e non a
noi. Senza, il pulsante «Collega Stripe» in *Impostazioni → Pagamenti* risponde
503. Il `redirect_uri` da whitelistare su Stripe è
`https://beauty.yourang.ai/stripe-connect/done`, cioè
`<FRONTEND_ORIGIN>/stripe-connect/done`: se non combacia, Stripe rifiuta.

### Le altre variabili che il backend legge

Hanno tutte un default sensato e nessuna è obbligatoria, ma sono quelle che
prima o poi si vogliono cambiare in produzione — e una, `TRUSTED_PROXY_IPS`,
può essere necessaria a seconda di dove sta il proxy.

| Variabile | Default | A cosa serve |
| --- | --- | --- |
| `API_DOCS` | `0` in produzione, `1` con `DEBUG=1` | Riaccende `/api/docs` e `/api/openapi.json`. Sono **pubblici e senza autenticazione**: elencano ogni rotta, parametro e schema, comprese le aree riservate. Per questo in produzione sono spenti (`config/api.py`) e la loro assenza è normale: un 404 su `/api/docs` non è un deploy rotto. Metti `API_DOCS=1` solo per il tempo che serve. |
| `TRUSTED_PROXY_IPS` | vuota | IP separati da virgola da cui `X-Forwarded-For` è credibile, **in aggiunta** a localhost e alle reti private (già coperte: su Coolify il Traefik parla al container dalla rete Docker). Serve quando il proxy sta su un'altra macchina e raggiunge il backend da un IP pubblico. Senza elencarlo, l'header viene ignorato e ogni richiesta viene contata sull'indirizzo del proxy: un secchiello solo per tutti, e i rate limit (login staff, registrazioni, OTP) bloccano un salone intero a vicenda. |
| `SSE_MAX_CONNECTIONS` | `12` | Stream live accettati da UN processo gunicorn. Vedi *Note → Aggiornamenti in tempo reale* per il conto delle postazioni: si alza solo insieme a `--threads` nel Dockerfile. |
| `CLIENT_MOVE_CANCEL_MIN_HOURS` | `24` | Ore minime prima dell'appuntamento entro cui la cliente può ancora spostare o annullare **dall'app cliente** (lo staff non è vincolato). Sotto la soglia l'app risponde «Spostamento non consentito a meno di N ore dall'appuntamento: contatta il salone». Il valore viaggia anche nella configurazione che l'app legge (`cancel_min_hours`), quindi cambiarlo aggiorna anche il testo mostrato alla cliente. |
| `JWT_ACCESS_TTL_MIN` | `60` | Durata in minuti dell'access token dello staff. Scaduto, la dashboard lo rinnova da sola con il refresh: abbassarlo riduce la finestra di un token rubato, non fa riloggare nessuno. |
| `JWT_REFRESH_TTL_DAYS` | `30` | Durata in giorni del refresh staff, cioè da quanto tempo di inattività si deve rifare il login. È anche il tempo entro cui i vecchi refresh non tracciati si esauriscono da soli. |
| `JWT_CLIENT_TTL_DAYS` | `30` | Durata del token dell'app cliente, che è **unico e senza rinnovo**: alla scadenza la cliente rifà l'accesso con l'OTP. È volutamente separato da quello staff — prima accorciare le sessioni del gestionale accorciava in silenzio anche quelle delle clienti. |
| `JWT_SECRET` | `SECRET_KEY` | Chiave di firma dei JWT, se la si vuole diversa da quella di Django. Cambiarla invalida all'istante tutte le sessioni, staff e clienti. |
| `CORS_ALLOWED_ORIGIN_REGEXES` | vuota | Via di fuga se un giorno servisse un origin variabile: pattern separati da **spazio** (la virgola compare nei quantificatori regex). L'ancoraggio finale `$` viene aggiunto se manca. Con i tre domini fissi di oggi non serve. |
| `SERVE_MEDIA` | `1` | A `0` Django smette di servire `/media/`: si mette solo quando i file passano da S3 o da un nginx dedicato, altrimenti logo e foto diventano 404. |

> **Se stai aggiornando un deploy vecchio**, togli `ENCRYPTION_KEY`,
> `YOURANG_ISSUER_URL`, `YOURANG_CLIENT_ID`, `YOURANG_CLIENT_SECRET` e
> `YOURANG_WEBHOOK_RECEIVER_URL`: il backend non le legge più. Il portale non
> possiede credenziali Yourang e non custodisce token, quindi non ha niente da
> cifrare a riposo — l'OAuth client è il proxy (vedi §8).

`entrypoint.sh` esegue `migrate` e `collectstatic` a ogni avvio, e crea il superuser
al primo (poi lo salta). Dopo il primo deploy **rimuovi `DJANGO_SUPERUSER_PASSWORD`**
dalle env: non serve più.

Deploy → verifica `https://beautyapi.yourang.ai/healthz` e il login su `/admin/`.
Non cercare `/api/docs`: in produzione risponde 404 di proposito (vedi
`API_DOCS` qui sopra), quindi non è una spia di niente.

## 4. Dashboard staff (`beauty-dashboard`)

Stessa procedura, **Build Pack: Dockerfile**:

| Campo | Valore |
|---|---|
| Base Directory | `/frontend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Domains | `https://beauty.yourang.ai` |

Environment variables — **tutte marcate come Build Variable** (la spunta
*Build Variable?* accanto a ogni variabile). Vite le inlina nel bundle a build time:
se le lasci come env di runtime il container parte ma il bundle punta a localhost.

```
APP=dashboard
VITE_API_URL=https://beautyapi.yourang.ai
VITE_CLIENT_APP_URL=https://beautyclients.yourang.ai
```

`VITE_CLIENT_APP_URL` serve a *Impostazioni → Link pubblici*, dove la titolare
copia i propri URL (app cliente e modulo contatti). La dashboard sta su un altro
dominio e non può dedurlo. Se manca, quella sezione non compare.

Il Dockerfile fallisce apposta se manca `VITE_API_URL`, così non ti ritrovi in
produzione un frontend che chiama `http://localhost:8000`, **e se manca `APP`**:
`APP` non ha più un valore predefinito, perché con `dashboard` implicito bastava
dimenticare la spunta su `beauty-client` per pubblicare il gestionale staff sul
dominio delle clienti, con il build riuscito e l'healthcheck verde.

## 5. App cliente (`beauty-client`)

| Campo | Valore |
|---|---|
| Base Directory | `/frontend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Domains | `https://beautyclients.yourang.ai` |

Build Variables:

```
APP=client-app
VITE_API_URL=https://beautyapi.yourang.ai
```

Anche qui **tutte e due marcate come Build Variable**, `APP` compresa: se `APP`
resta una env di runtime il build non riceve niente e ora si ferma con
`ERRORE: build arg APP mancante` invece di pubblicare la dashboard staff su
questo dominio.

Un solo dominio per tutti i saloni. `VITE_SALON_SLUG` non serve in produzione:
resta solo come fallback per lo sviluppo locale, dove non c'è slug nel path.

### Aggiungere un salone

Crealo in `/admin/` (o dalla dashboard) con lo slug che vuoi, es. `bellezza-mia`.
Il suo URL — `https://beautyclients.yourang.ai/bellezza-mia` — è già attivo.

Niente DNS, niente domini in Coolify, niente rebuild, niente certificati. Era
esattamente il passo manuale che questa scelta elimina.

### Sessioni

Tutti i saloni condividono l'origin, quindi il localStorage. La chiave di sessione
è namespacizzata per slug (`yt.client.session:<slug>`, vedi `clientAuth.js`):
una cliente che apre due saloni diversi non si porta dietro il token sbagliato.

## 6. Verifica

- `https://beautyapi.yourang.ai/healthz` → `{"status": "ok"}`
- `https://beautyapi.yourang.ai/admin/` → login funzionante **con il CSS al suo posto**
  (se l'admin è senza stile, whitenoise non sta servendo `/static/`)
- `https://beauty.yourang.ai` → pagina di login staff, nessun errore CORS in console
- `https://beautyclients.yourang.ai/the-parlour` → branding del salone caricato
  (se vedi un errore, il salone con quello slug non esiste nel database). Se qui
  compare la **login staff**, la risorsa è stata costruita con `APP=dashboard`:
  rifai il build con `APP=client-app` marcata come Build Variable.
- Carica un logo da *Impostazioni → Brand*, poi ricarica l'app cliente: se il logo
  appare, il volume dei media e la rotta `/media/` funzionano.
- *Impostazioni → Notifiche* → `configured` deve essere vero: è la spia di
  `YOURANG_API_URL`, senza la quale nessun OTP raggiunge le clienti.
- Prenota una caparra di prova dall'app cliente e paga: devi tornare su
  `beautyclients.yourang.ai/<slug>?deposit=paid`, non sulla dashboard. Se torni
  sulla dashboard manca `CLIENT_APP_ORIGIN`.

## 7. Dati iniziali

Il database parte vuoto: il primo salone lo crei da `/admin/` (Saloni → Aggiungi),
poi Sede, Impostazioni e la Membership che collega il tuo utente al salone.
`/admin/` è dell'utente creato da `entrypoint.sh` (o da `createsuperuser`).

**Il salone demo non va mai creato in produzione.** `seed_demo` crea The Parlour
con un titolare che entra nella dashboard, e con `DEBUG=0` si rifiuta di partire.
Su un ambiente di prova (mai il server di produzione):

```bash
python manage.py seed_demo --allow-production            # stampa una volta la password
python manage.py seed_demo --allow-production --reset --password <scelta>   # la ricrea, password scelta
```

La password del titolare demo (`sole@theparlour.it`) è casuale e viene stampata
una volta sola; il titolare demo non entra in `/admin/`. Il seed tocca solo il
salone che ha creato lui (slug `the-parlour`): se lo slug o l'email sono di un
salone vero si ferma senza modificare niente.

## 8. Integrazioni

**Stripe** — endpoint webhook: `https://beautyapi.yourang.ai/api/sales/stripe/webhook`.
Senza `STRIPE_SECRET_KEY` gli endpoint di pagamento rispondono 503, il resto funziona.
Con Stripe Connect si registrano **due** endpoint sullo stesso URL (dashboard
Stripe → *Sviluppatori → Webhook*): uno per gli eventi dell'account, uno per gli
eventi degli account collegati («Events on Connected accounts»). Ciascuno ha il
suo segreto (`STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, vedi §3).
Eventi da selezionare su entrambi: `checkout.session.completed`,
`payment_intent.succeeded`, `setup_intent.succeeded`, `charge.refunded`,
`charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`.
Gli eventi `refund.*` non sono facoltativi: portano ogni rimborso con il suo
stato, e senza di loro una caparra con un rimborso ancora in corso (o fallito)
può risultare detraibile per l'importo sbagliato al checkout.

**Yourang** — abilita sia il "login con Yourang" dalla pagina di login (che
provisiona/collega il salone e conia la sessione staff) sia il "collega" dalle
impostazioni, seguito dal primo sync di contatti e servizi.

**Tutto passa dal proxy `connect.yourang.ai`**, ed è la cosa da tenere a mente
leggendo il resto: il portale beauty **non è** un client OAuth di Yourang. Non ha
`client_id` né `client_secret`, non vede mai un access token e non ha niente da
cifrare a riposo. L'OAuth client è il proxy, uno per tutti i portali: custodisce i
token di ogni organizzazione e li rinnova lui (Yourang ruota il refresh token a
ogni uso e brucia l'intera famiglia se due refresh corrono insieme — un solo
posto può farlo in sicurezza).

Quello che il portale ha sono due segreti **verso il proxy**, che genera chi lo
amministra (nel suo `deploy/.env.proxy`):

| Variabile qui | Nome lato proxy | A cosa serve |
| --- | --- | --- |
| `YOURANG_PROXY_API_KEY` | `PROXY_BEAUTY_API_KEY` | `Authorization: Bearer` sulle chiamate server-to-server verso `<YOURANG_PROXY_URL>/v/<slug>` (riscatto del link code e rotte external API del sync) |
| `YOURANG_PROXY_WEBHOOK_SECRET` | `PROXY_BEAUTY_OUT_SECRET` | verifica la firma dei webhook che il proxy ci ri-emette |

Il flusso: la dashboard apre un popup, il backend risponde con l'URL di login sul
proxy, il proxy gestisce consenso e PKCE e rimanda il browser su
`<FRONTEND_ORIGIN>/oauth-popup/done?mode=…&yr_link=…`, il backend riscatta il
codice monouso lato server. Quindi l'unica origine da far conoscere al proxy è
`https://beauty.yourang.ai`: il suo controllo anti open-redirect confronta
schema, host e porta del `return_to`.

Il webhook in ingresso è `POST https://beautyapi.yourang.ai/api/integrations/yourang/webhook`,
e non va registrato a mano: lo provisiona il consenso. È firmato HMAC-SHA256 su
`{timestamp}.{body}` con `YOURANG_PROXY_WEBHOOK_SECRET` (header
`X-Yourang-Signature: sha256=…` e `X-Yourang-Timestamp`, tolleranza 5 minuti), e
la rotta è pubblica: senza il segreto configurato **rifiuta tutto**, che è il
comportamento voluto ma è anche indistinguibile da "Yourang non manda niente".

**Outbox** — i messaggi verso le clienti (OTP, conferme, promemoria) si accodano
in `core_outboxevent` e li consegna `python manage.py flush_outbox`, che fa un
POST su `YOURANG_API_URL`. Servono **due** cose perché una cliente riceva il suo
codice: il job schedulato (vedi più sotto) **e** `YOURANG_API_URL` in ambiente.
Manca una delle due e il sintomo è lo stesso, la coda che si allunga. Nota che
`YOURANG_API_URL`/`YOURANG_API_KEY` non c'entrano con le `YOURANG_PROXY_*`: sono
il canale di uscita dei messaggi, non l'integrazione OAuth.

## 9. Aggiornare un'installazione già in produzione

`entrypoint.sh` esegue `migrate` a ogni avvio: le migrazioni partono da sole
appena la nuova immagine si accende. Non c'è un momento in cui fermarle a metà,
quindi quello che segue va fatto **prima** del push su `main`.

### 9.1 Doppioni di telefono: controlla, bonifica, poi migra

La migrazione `clients.0007_client_phone_key_unique` aggiunge il vincolo unico
su (salone, chiave telefono normalizzata). Su un database che ha già due schede
con lo stesso numero scritto in due modi — «348 221 0094» e «+39 348 2210094»,
esattamente i doppioni che i difetti corretti producevano — il vincolo **non
riesce ad applicarsi** e `migrate` si ferma con un errore di chiave duplicata su
`uniq_client_salon_phone_key`.

Il controllo è un comando di **sola lettura**, che esce con codice 1 se trova
qualcosa (quindi si può incatenare):

```bash
python manage.py check_phone_duplicates && python manage.py migrate
```

Stampa, per ogni gruppo, il salone, la chiave normalizzata e tutte le schede che
se la contendono, con identificativo, nome, telefono come è scritto, `cliente
dal`, e quante visite e vendite ha collegate — cioè quello che serve per
decidere quale tenere:

```
1 gruppo di doppioni, 2 schede coinvolte (su 412 controllate).

Salone «The Parlour» (the-parlour) · chiave +393482210094 · 2 schede
  #41     Giulia Rossi  348 221 0094     cliente dal 12/03/2024  visite 18   vendite 12
  #189    Giulia R.     +39 348 2210094  cliente dal —           visite 1    vendite 0
```

Opzioni: `--salon <slug>` per un salone solo, `--limit N` per i gruppi stampati
(0 = tutti), `--exit-zero` per usarlo come semplice rapporto senza far fallire
niente. Attenzione a due cose che il vincolo non perdona: contano anche le
schede **disattivate** (il vincolo non guarda `is_active`), mentre i numeri non
normalizzabili («n/d», «da chiedere») restano fuori perché il vincolo è parziale
sulla chiave vuota.

Bonifica: si tiene la scheda con lo storico, si spostano su quella le eventuali
visite dell'altra e si cancella la scheda svuotata (le visite sono in `PROTECT`:
finché ne ha, la cancellazione viene rifiutata). Attenzione a cosa porta via la
cancellazione: note, schede tecniche, punti fedeltà e posti in lista d'attesa se
ne vanno con la scheda; vendite, gift card e coupon restano ma perdono il
collegamento alla cliente. Quello che serve va spostato prima sulla scheda che
resta. Poi si aggiorna.

**Se lo salti**: `migrate` si interrompe su quella migrazione, il container
nuovo non arriva mai a gunicorn, Coolify tiene in piedi la versione precedente —
ma il database resta a metà strada (le migrazioni fino alla `0006` applicate, il
vincolo no), e la bonifica va comunque fatta, con il deploy fermo nel frattempo.

Dove eseguirlo, dato che il comando arriva **con** questo aggiornamento e il
container in esecuzione non ce l'ha ancora:

- **la prima volta**, dal server, usando la nuova immagine senza farla partire —
  `--entrypoint python` salta `entrypoint.sh`, quindi non migra niente:

  ```bash
  docker run --rm --entrypoint python \
    --network <rete del db> -e DATABASE_URL='<Postgres URL interna>' \
    <immagine beauty-api appena costruita> manage.py check_phone_duplicates
  ```

  Non servono `SECRET_KEY` né gli altri: senza `DEBUG=0` i controlli di avvio
  del §3 non scattano, e il comando non serve richieste. In alternativa lo si fa
  girare su una copia ripristinata dal backup Postgres, che è altrettanto valido
  perché è sola lettura.
- **dagli aggiornamenti successivi**, il comando è già dentro il container: si
  lancia dal terminale di `beauty-api` prima di far partire il deploy.

### 9.2 Volume dei media creato prima di settembre 2026

Il container del backend ora gira senza privilegi (utente `app`, uid 10001) e un
volume `beauty-media` creato quando girava come root ha i file di root: gli
upload nuovi falliscono in scrittura. Serve un `chown` una tantum — comando e
spiegazione nel §3, riquadro sotto *Storage persistente*.

### 9.3 Variabili da togliere e da controllare

Togli `ENCRYPTION_KEY`, `YOURANG_ISSUER_URL`, `YOURANG_CLIENT_ID`,
`YOURANG_CLIENT_SECRET`, `YOURANG_WEBHOOK_RECEIVER_URL`: il backend non le legge
più (§3). Controlla invece che `SECRET_KEY` sia lunga almeno 32 caratteri e che
`ALLOWED_HOSTS` non contenga `*`, altrimenti il primo avvio con il codice nuovo
si ferma prima di gunicorn: è il comportamento voluto descritto nel §3.

### 9.4 Aggiornamento di fine settembre 2026 (correzioni del 22/09)

Prima del push su `main`:

1. **Account demo in produzione.** Se sul database di produzione esiste
   `sole@theparlour.it` (creato da un vecchio `seed_demo`, superuser con una
   password pubblicata nella documentazione), disattivalo da `/admin/` o
   togligli *staff* e *superuser* e cambiagli la password; poi controlla chi è
   entrato in `/admin/`. D'ora in poi `seed_demo` in produzione non parte.
2. **Telefoni.** `clients.0008_caccia22_clienti_phone_key` è una migrazione di
   dati: ricalcola le chiavi telefono con le regole nuove (prefissi
   internazionali, zero dopo il prefisso, «+39 39…» doppio) e riscrive in forma
   internazionale i numeri che riconosce, tranne quelli con parole. Lancia
   `check_phone_duplicates` come nel §9.1 **prima** (exit 1 = doppioni da
   bonificare) e di nuovo **dopo** il deploy: i gruppi che emergono con le
   regole nuove restano con la chiave vecchia e vanno bonificati a mano.
3. **Tessere a timbri.** `marketing.0004` è irreversibile: i programmi «a
   timbri» con metrica «per euro» passano a «per visita» con rapporto 1, e i
   saldi già oltre la soglia scendono a soglia − 1 (i premi già emessi restano).
   Per sapere se ti riguarda: `LoyaltyProgram.objects.filter(type="stamps",
   earn_metric="per_euro")` dalla shell.
4. **Codifica del database**: la ricerca clienti senza accenti richiede un
   database UTF8 (`SHOW server_encoding;` deve rispondere `UTF8`).

Le migrazioni di questo aggiornamento sono tutte additive o di dati:
`core.0010` e `core.0011` (colonne nuove), `agenda.0011` (tre colonne nullable),
`sales.0004` (tabella dei rimborsi caparra), `sales.0005` (ripartisce i buoni
sulle righe delle vendite già registrate), `marketing.0004` (vedi sopra),
`marketing.0005` (accoda l'annullamento degli invii programmati già consegnati a
Yourang che non corrispondono più a una campagna), `clients.0008` (vedi sopra),
`integrations.0005` (tabella) e `integrations.0006` (collega i segnaposto
Yourang alle operatrici). Dopo `migrate` il ritorno alla versione precedente
non è sicuro: si va avanti, non indietro.

Dopo il deploy:

- `flush_outbox` diventa un **worker** (`--loop --interval 5`), non più un job
  al minuto, e va tenuto acceso anche senza `YOURANG_API_URL` (fa le scadenze e
  le pulizie): vedi *Job schedulati*. Al primo giro con l'URL configurato
  l'arretrato di messaggi ormai inutili passa a `expired` (in admin → Outbox).
- Programma `sync_yourang` ogni ora (vedi *Job schedulati*).
- Stripe: due endpoint webhook e i loro segreti (§3, §8).
- I dispositivi con un refresh token emesso prima del 18/09 rifanno l'accesso
  una volta (401 al rinnovo): è atteso.
- Incassare una gift card ora richiede il permesso *vendite*: controlla i ruoli
  che avevano solo *marketing*.
- Un popup «Collega Yourang» aperto prima del deploy e chiuso dopo risponde
  400: basta riprovare.

## Deploy automatico

Ogni push su `main` fa partire il deploy dei tre servizi (`beauty-api`,
`beauty-dashboard`, `beauty-client`), **migrazioni comprese**: `entrypoint.sh`
esegue `migrate` appena il container nuovo si accende, quindi i controlli del §9
vanno fatti prima del push, non dopo. Il tramite è un **webhook del repository**,
non la GitHub App: l'installazione `foodsoftboom` sull'organizzazione è a
repository selezionati e non comprende `beauty`, quindi i suoi eventi non
arrivavano e la coda di Coolify restava vuota dopo ogni merge.

- Webhook: `SoftBoom-SRL/beauty` → Settings → Webhooks →
  `https://coolify.softboom.it/webhooks/source/github/events/manual`,
  content type `application/json`, solo l'evento `push`, secret condiviso.
- Lo stesso secret sta su tutte e tre le applicazioni Coolify, nel campo
  `manual_webhook_secret_github`: Coolify cerca le applicazioni per repository e
  branch, e per ciascuna verifica la firma `X-Hub-Signature-256` con il PROPRIO
  secret. Se i tre valori divergono, si deploya solo quella che combacia.
- Nessun `watch_paths` impostato: ogni push su `main` ricostruisce tutti e tre.
  Se un giorno diventasse un problema, si restringono da Coolify (per esempio
  `backend/*` sull'api) invece di creare webhook separati.

Per rimettere tutto sulla GitHub App servirebbe che un Organization Owner
aggiunga `beauty` ai repository dell'installazione `foodsoftboom`; a quel punto
questo webhook si può togliere.

Verifica rapida dopo un push:

```bash
ssh root@91.99.117.151 'docker exec coolify-db psql -U coolify -d coolify -At \
  -c "select application_id, status, created_at from application_deployment_queues \
      order by id desc limit 3"'
```

## HTTPS e cookie

I cookie di sessione e CSRF (quelli dell'admin Django) viaggiano solo su HTTPS
appena `DEBUG=0`: non serve configurare niente. Il redirect a HTTPS e l'HSTS
restano invece da accendere a mano, perché dipendono dal proxy davanti
all'applicazione. Con Traefik/Coolify, che termina TLS e inoltra
`X-Forwarded-Proto`, le variabili da mettere sulla risorsa `beauty-api` sono:

| Variabile | Valore | Nota |
|---|---|---|
| `SECURE_SSL_REDIRECT` | `1` | `/healthz` resta esente, altrimenti il controllo interno del proxy fallirebbe |
| `SECURE_HSTS_SECONDS` | `31536000` | **irreversibile per un anno**: da mettere solo a certificato funzionante |
| `SECURE_HSTS_INCLUDE_SUBDOMAINS` | `1` | solo se TUTTI i sottodomini sono su HTTPS |
| `SECURE_HSTS_PRELOAD` | `1` | solo se si vuole chiedere l'inserimento nella lista dei browser |

Con queste quattro `python manage.py check --deploy` non segnala più nulla.

## Job schedulati (Coolify → *Scheduled Tasks* sulla risorsa `beauty-api`)

Tre comandi vanno programmati. Senza di loro il gestionale continua a funzionare
ma alcune funzioni restano ferme, e il sintomo non punta alla causa.

| Comando | Cadenza | Cosa succede se manca |
| --- | --- | --- |
| `python manage.py flush_outbox --loop --interval 5` | sempre acceso (worker) | Nessun messaggio parte: gli OTP dell'app cliente «non arrivano» e la cliente non riesce a entrare. **Va tenuto acceso come worker, non lanciato ogni minuto**: i messaggi sull'appuntamento restano trattenuti qualche secondo per fondere le correzioni ravvicinate, e un job al minuto li lascia fermi fino a un minuto — abbastanza perché ne partano due al posto di uno. Gira anche senza `YOURANG_API_URL` (fa scadenze e pulizie), ma allora non consegna niente e si limita a elencare i pendenti: stesso sintomo, causa diversa — controlla sempre tutte e due. |
| `python manage.py process_deposit_holds` | ogni 5 minuti | Le caparre scadute non liberano mai lo slot. In dashboard sembra funzionare, perché ogni apertura dell'agenda esegue il controllo sul salone visualizzato — ma solo su quello, e solo finché qualcuno guarda. |
| `python manage.py sync_yourang` | ogni ora | Clienti e servizi smettono di riallinearsi con Yourang quando un webhook va perso; anche la prima sincronizzazione interrotta da un riavvio si completa solo da qui. |

Lo stato della consegna messaggi è visibile al titolare in
*Impostazioni → Notifiche*, che legge `GET /api/core/outbox/status`: dice se
`YOURANG_API_URL` è configurato, quanti eventi sono in coda e da quando. È il
posto da guardare per primo quando «gli OTP non arrivano»: distingue la variabile
mancante (`configured: false`) dal job che non gira (coda che si allunga).

## Note

- **Aggiornamenti in tempo reale** fra postazioni: ogni dashboard aperta tiene UNA
  connessione Server-Sent Events su `GET /api/core/activity/stream` (HTTP normale,
  passa da Traefik senza configurazione; niente websocket, Redis o worker ASGI).
  Per questo il Dockerfile del backend usa `gunicorn --worker-class gthread
  --threads 24`: una connessione aperta occupa un thread, non un processo. Le
  postazioni servite però non sono 3 × 24: il tetto vero è
  `SSE_MAX_CONNECTIONS`, contato **per singolo processo** gunicorn, e vale
  circa la metà di `--threads` perché a ogni worker avanzi sempre spazio per le
  richieste normali (agenda, POS, `/media/`).

  **Il default è sceso da 40 a 12**: con `--threads 24` un tetto di 40 non
  scattava mai — finivano prima i thread — e 24 postazioni capitate sullo stesso
  worker lo paralizzavano per venti minuti, agenda e POS compresi, senza che
  nessuno ricevesse il 503 che fa ripiegare sul polling. Il conto di capacità
  oggi è quindi **3 worker × 12 = 36 dashboard aperte insieme** (erano
  nominalmente 120, che il server non ha mai potuto reggere). È un massimo
  teorico: gunicorn non distribuisce le connessioni sapendo quali sono stream,
  quindi con una distribuzione sfortunata il 503 può arrivare qualche postazione
  prima. Per salire si alzano **insieme** `SSE_MAX_CONNECTIONS` e `--threads`
  nel Dockerfile, tenendo il tetto a circa metà dei thread.

  Oltre il tetto lo stream riceve un 503 e la dashboard ripiega da sola su un
  polling ogni 3 secondi, come fa quando lo stream cade: si continua a lavorare,
  gli aggiornamenti arrivano con qualche secondo di ritardo. Il server chiude e
  fa riaprire ogni connessione dopo 20 minuti per riciclare i thread. Ogni
  stream aperto tiene anche una connessione Postgres (`conn_max_age=600`): 36
  stream sono 36 connessioni ferme lì, più quelle delle richieste normali, su un
  `max_connections` che di default è 100 — se si alza il tetto va alzato anche
  quello.

- Cambiare `VITE_API_URL` richiede un **redeploy con rebuild** del frontend
  interessato: è una costante compilata nel bundle.
- `/media/` è servito da Django (`config/urls.py`). Va benissimo per logo e foto di
  un salone; se un giorno il volume di upload cresce, sposta i media su S3 e metti
  `SERVE_MEDIA=0`.
- I `.jsx` nella root del repo sono il prototipo Babel-standalone originale: non
  fanno parte del deploy, il codice vivo è sotto `frontend/`.
