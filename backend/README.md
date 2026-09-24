# youty backend

Backend Django unico per la **dashboard gestionale** e la **web app cliente** (yourang).
Riferimento funzionale: `../docs/manuale-flussi.html` · Architettura e contratto: `SPEC.md`.

## Stack

Django 5 · Django Ninja (API REST + OpenAPI) · PostgreSQL (SQLite in locale) · JWT (staff e clienti) ·
Stripe (caparre, carte salvate) · Outbox verso la piattaforma **Yourang** (WhatsApp/automazioni — API in arrivo).

## Avvio locale

```bash
cd backend
uv venv --python 3.12
source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env
python manage.py migrate
python manage.py seed_demo        # salone The Parlour + dati demo (stampa la password del titolare)
python manage.py createsuperuser  # l'utente per /admin/
python manage.py runserver
```

- API docs: http://localhost:8000/api/docs
- Admin: http://localhost:8000/admin/ con l'utente di `createsuperuser`. Il titolare
  demo (`sole@theparlour.it`) entra nella dashboard, non in /admin/.
- La password del titolare demo è casuale e il seed la stampa una volta sola;
  per sceglierla: `python manage.py seed_demo --reset --password <scelta>`.
  Con `DEBUG=0` il seed si rifiuta di partire (vedi DEPLOY.md §7).

## Struttura

```
config/    settings (+ unfold.py: navigazione dell'admin), urls, api (monta i router delle app)
common/    aiuti senza dominio: auth JWT, permessi, rate limit, soldi, intervalli, telefoni,
           media, condizioni E/O, OkOut, testing/ (aiuti comuni ai test)
apps/
  core         salone, sedi, impostazioni, regole caparra, registro attività, feed live, outbox Yourang
  accounts     utenti staff, sessioni, ruoli/permessi, inviti, accesso OTP delle clienti
  clients      anagrafica, ricerca, etichette, note e schede tecniche, import CSV, form pubblico
  staff        operatrici, turni, assenze, KPI
  catalog      categorie, servizi, pacchetti
  agenda       appuntamenti, disponibilità, pause, lista d'attesa, caparre, «torna indietro»
  sales        checkout, cassa, pagamenti, Stripe (gateway e webhook), report
  inventory    prodotti, fornitori, movimenti, ordini, carico da CSV
  marketing    coupon, gift card, fedeltà, comunicazioni, consenso, portafoglio della cliente
  automations  regole automazioni (esecuzione delegata a Yourang)
  insights     KPI e analisi
  integrations Yourang: OAuth, collegamento, webhook, sincronizzazione
```

Ogni app ha gli stessi strati: `models.py`, `schemas.py`, `api.py` (o un package
`api/`) con gli endpoint, la logica in `services.py` e nei moduli fratelli per
argomento, i test in `tests/`. Dove sta cosa, app per app, e le regole comuni
(salone per richiesta, permessi, soldi, fusi, eventi, transazioni) sono in
[`../docs/SVILUPPO.md`](../docs/SVILUPPO.md); il contratto delle API in `SPEC.md`.

## Test e lint

```bash
uv pip install -r requirements-dev.txt          # ruff, tblib (fuori dall'immagine di produzione)
ruff check .
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test --noinput --parallel auto  # tutta la suite
python manage.py test apps.agenda                # una app
python manage.py test apps.agenda.tests.test_deposit.DepositHoldTests   # una classe
```

I test di un'app stanno in `apps/<app>/tests/`: un modulo per argomento
(`test_<argomento>.py`), le basi e gli aiuti comuni in `tests/base.py`, quelli
comuni a tutte le app in `common/testing`. Un test nuovo va nel modulo del suo
argomento, con il riferimento al reperto nel docstring della classe se nasce da
una segnalazione. `scripts/run_e2e.sh` prova il flusso completo su un server
vero con un database usa e getta.
