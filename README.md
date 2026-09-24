# youty

Gestionale per saloni di bellezza, in produzione: la **dashboard** per lo staff
(agenda, cassa, clienti, magazzino, promozioni, analisi) e la **web app** con cui
le clienti di ogni salone prenotano, spostano e annullano. Messaggi WhatsApp e
automazioni li esegue la piattaforma Yourang, a cui il backend manda eventi.

| Parte | Dove | Tecnologie |
|---|---|---|
| API (una sola, per dashboard e web app) | [`backend/`](backend/README.md) | Django 5.2, django-ninja, PostgreSQL 16 (SQLite in locale), Stripe |
| Dashboard staff e web app clienti | [`frontend/`](frontend/README.md) | React 18, Vite, npm workspaces |
| Documentazione | [`docs/`](docs/README.md) | guida allo sviluppo, rapporti delle cacce ai bug, prototipo |
| Produzione | [`DEPLOY.md`](DEPLOY.md) | Coolify: tre servizi, deploy a ogni push su `main` |

## Avvio in locale

```sh
# backend
cd backend
uv venv --python 3.12 && source .venv/bin/activate
uv pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env
python manage.py migrate
python manage.py seed_demo --reset --password <scelta>   # salone demo «The Parlour»

# frontend
cd ../frontend && npm ci

# tutto insieme: backend su :8000, dashboard su :5173, web app su :5174/the-parlour
cd .. && ./start-dev.sh
```

La dashboard si apre con `sole@theparlour.it` e la password scelta; nella web
app il codice OTP delle clienti, in sviluppo, è nel log del backend.

## Controlli

```sh
cd backend  && ruff check . && python manage.py check && python manage.py makemigrations --check --dry-run && python manage.py test --noinput --parallel auto
cd frontend && npm run lint && npm test && npm run build
```

La CI di GitHub esegue gli stessi controlli su ogni pull request e su `main`.
**Un push su `main` va in produzione** (migrazioni comprese).

## Da leggere prima di cambiare il codice

- [`docs/SVILUPPO.md`](docs/SVILUPPO.md): dove sta cosa, le regole che valgono
  ovunque (salone per richiesta, permessi, soldi, fusi orari, eventi per
  Yourang), come si aggiunge un endpoint, un campo, un evento, una schermata,
  un test.
- [`backend/SPEC.md`](backend/SPEC.md): il contratto delle API per app.
- [`frontend/README.md`](frontend/README.md): convenzioni del frontend.
