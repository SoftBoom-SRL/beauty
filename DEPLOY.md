# Deploy su Coolify

Sostituisci ovunque `esempio.it` con il tuo dominio.

## Architettura

Quattro risorse Coolify, tutte dallo stesso repository:

| Risorsa | Tipo | Dominio | Build context | Porta |
|---|---|---|---|---|
| `beauty-db` | Database PostgreSQL | — (interno) | — | 5432 |
| `beauty-api` | Application · Dockerfile | `api.esempio.it` | `/backend` | 8000 |
| `beauty-dashboard` | Application · Dockerfile | `app.esempio.it` | `/frontend` | 80 |
| `beauty-client` | Application · Dockerfile | `*.prenota.esempio.it` | `/frontend` | 80 |

Le due SPA sono file statici serviti da nginx: chiamano l'API in cross-origin, per
questo il backend ha un dominio suo (che ospita anche `/admin`).

**L'app cliente serve tutti i saloni con un solo deploy**: lo slug arriva dal
sottodominio (`the-parlour.prenota.esempio.it` → salone `the-parlour`), vedi
`resolveSalonSlug()` in `frontend/apps/client-app/src/ctx.jsx`.

## Prerequisiti

- Un server con Coolify installato e il suo IP pubblico.
- Accesso al DNS di `esempio.it`.
- Il repo `SoftBoom-SRL/beauty` collegato a Coolify (GitHub App o deploy key).

## 1. DNS

Tre record A verso l'IP del server:

```
api       A   <IP-SERVER>
app       A   <IP-SERVER>
*.prenota A   <IP-SERVER>
```

Il wildcard evita di toccare il DNS a ogni nuovo salone. I certificati invece
restano per-dominio: Coolify li emette via Let's Encrypt HTTP-01, quindi ogni
sottodominio di salone va **aggiunto nella lista domini** di `beauty-client`
(un certificato wildcard richiederebbe la challenge DNS-01, molto più laboriosa).

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
| Dockerfile Location | `/Dockerfile` (se Coolify lo vuole relativo alla root: `/backend/Dockerfile`) |
| Ports Exposes | `8000` |
| Domains | `https://api.esempio.it` |
| Health Check Path | `/healthz` |

**Storage persistente** (tab *Storages* → *Add volume mount*), altrimenti gli upload
spariscono a ogni redeploy:

| Name | Destination Path |
|---|---|
| `beauty-media` | `/app/media` |

**Environment variables** — nessuna va marcata come *Build Variable*:

```
SECRET_KEY=<genera: openssl rand -base64 48>
DEBUG=0
DATABASE_URL=<Postgres URL interna dal punto 2>
ALLOWED_HOSTS=api.esempio.it
CSRF_TRUSTED_ORIGINS=https://api.esempio.it
CORS_ALLOWED_ORIGINS=https://app.esempio.it
CORS_ALLOWED_ORIGIN_REGEXES=^https://[a-z0-9-]+\.prenota\.esempio\.it$
FRONTEND_ORIGIN=https://app.esempio.it
ENCRYPTION_KEY=<genera: openssl rand -hex 32>
DJANGO_SUPERUSER_EMAIL=tu@esempio.it
DJANGO_SUPERUSER_PASSWORD=<password forte>
```

Opzionali, da aggiungere quando servono:

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
YOURANG_ISSUER_URL=https://api.yourang.ai
YOURANG_CLIENT_ID=beauty-crm
YOURANG_CLIENT_SECRET=...
YOURANG_WEBHOOK_RECEIVER_URL=https://api.esempio.it/api/integrations/yourang/webhook
```

`entrypoint.sh` esegue `migrate` e `collectstatic` a ogni avvio, e crea il superuser
al primo (poi lo salta). Dopo il primo deploy **rimuovi `DJANGO_SUPERUSER_PASSWORD`**
dalle env: non serve più.

Deploy → verifica `https://api.esempio.it/healthz`, `/api/docs` e il login su `/admin/`.

## 4. Dashboard staff (`beauty-dashboard`)

Stessa procedura, **Build Pack: Dockerfile**:

| Campo | Valore |
|---|---|
| Base Directory | `/frontend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Domains | `https://app.esempio.it` |

Environment variables — **tutte marcate come Build Variable** (la spunta
*Build Variable?* accanto a ogni variabile). Vite le inlina nel bundle a build time:
se le lasci come env di runtime il container parte ma il bundle punta a localhost.

```
APP=dashboard
VITE_API_URL=https://api.esempio.it
```

Il Dockerfile fallisce apposta se `VITE_API_URL` manca, così non ti ritrovi in
produzione un frontend che chiama `http://localhost:8000`.

## 5. App cliente (`beauty-client`)

| Campo | Valore |
|---|---|
| Base Directory | `/frontend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Domains | `https://the-parlour.prenota.esempio.it` (uno per salone, separati da virgola) |

Build Variables:

```
APP=client-app
VITE_API_URL=https://api.esempio.it
VITE_CLIENT_BASE_HOST=prenota.esempio.it
VITE_SALON_SLUG=the-parlour
```

`VITE_CLIENT_BASE_HOST` è quello che abilita il multi-salone: l'app confronta
`window.location.hostname` con questo valore e usa come slug ciò che sta davanti.
`VITE_SALON_SLUG` resta solo come fallback (sviluppo, o host che non combacia).

### Aggiungere un salone

1. Crea il salone in `/admin/` (o via dashboard) con lo slug che vuoi, es. `bellezza-mia`.
2. In `beauty-client` → *Domains*, aggiungi `https://bellezza-mia.prenota.esempio.it`.
3. Salva: Coolify aggiorna Traefik ed emette il certificato. **Nessun rebuild.**

Il DNS è già coperto dal wildcard e il CORS dal regex.

## 6. Verifica

- `https://api.esempio.it/healthz` → `{"status": "ok"}`
- `https://api.esempio.it/admin/` → login funzionante **con il CSS al suo posto**
  (se l'admin è senza stile, whitenoise non sta servendo `/static/`)
- `https://app.esempio.it` → pagina di login staff, nessun errore CORS in console
- `https://the-parlour.prenota.esempio.it` → branding del salone caricato
  (se vedi il salone sbagliato, controlla `VITE_CLIENT_BASE_HOST`)
- Carica un logo da *Impostazioni → Brand*, poi ricarica l'app cliente: se il logo
  appare, il volume dei media e la rotta `/media/` funzionano.

## 7. Dati iniziali

Il database parte vuoto: il primo salone lo crei da `/admin/` (Saloni → Aggiungi),
poi Sede, Impostazioni e la Membership che collega il tuo utente al salone.

Per popolare invece un salone demo completo (The Parlour, 9 operatrici, 14 servizi,
10 clienti, appuntamenti di oggi — login `sole@theparlour.it` / `theparlour`), dal
terminale del container `beauty-api`:

```bash
python manage.py seed_demo
```

È scoped allo slug `the-parlour` e non tocca gli altri saloni: puoi tenerlo accanto
ai dati reali e rimuoverlo dopo. `--reset` lo ricrea da zero.

## 8. Integrazioni

**Stripe** — endpoint webhook: `https://api.esempio.it/api/sales/stripe/webhook`.
Senza `STRIPE_SECRET_KEY` gli endpoint di pagamento rispondono 503, il resto funziona.

**Yourang OAuth** — il `redirect_uri` da far whitelistare lato Yourang è
`https://app.esempio.it/oauth-popup/done`. Richiede `ENCRYPTION_KEY` impostata
(i token sono cifrati a riposo) e `FRONTEND_ORIGIN` uguale al dominio della dashboard.

**Outbox** — gli eventi verso Yourang si accodano in `core_outboxevent`.
Per svuotarli serve un job schedulato (Coolify → *Scheduled Tasks* sulla risorsa
`beauty-api`), comando `python manage.py flush_outbox`.

## Note

- Cambiare `VITE_API_URL` o `VITE_CLIENT_BASE_HOST` richiede un **redeploy con
  rebuild** del frontend interessato: sono costanti compilate nel bundle.
- `/media/` è servito da Django (`config/urls.py`). Va benissimo per logo e foto di
  un salone; se un giorno il volume di upload cresce, sposta i media su S3 e metti
  `SERVE_MEDIA=0`.
- I `.jsx` nella root del repo sono il prototipo Babel-standalone originale: non
  fanno parte del deploy, il codice vivo è sotto `frontend/`.
