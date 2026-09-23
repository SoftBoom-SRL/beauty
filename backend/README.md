# youty backend

Backend Django unico per la **dashboard gestionale** e la **web app cliente** (yourang).
Riferimento funzionale: `../yourang - Manuale flussi.doc` · Architettura e contratto: `SPEC.md`.

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
config/    settings, urls, api (mount dei router)
common/    auth JWT, permessi per scope, valutatore condizioni E/O, utility
apps/
  core         salone, sedi, branding white-label, regole deposito, registro attività, outbox Yourang
  accounts     utenti staff, ruoli/permessi, inviti, login OTP clienti
  clients      anagrafica, etichette, note, schede tecniche, import CSV
  staff        operatrici, turni, ferie/assenze, performance
  catalog      categorie, servizi, pacchetti
  agenda       appuntamenti, disponibilità slot, pause, lista d'attesa
  sales        checkout, POS, pagamenti, Stripe
  inventory    prodotti, fornitori, movimenti (integrità), ordini
  marketing    coupon, gift card, programmi fedeltà, comunicazioni
  automations  regole automazioni (esecuzione delegata a Yourang)
  insights     KPI e analisi (solo titolare)
```

## Convenzioni

Vedi `SPEC.md` §1. In sintesi: ogni modello top-level ha FK `salon` (multi-tenant);
mutazioni → `log_activity`; eventi per Yourang → `emit_event` (outbox);
permessi per scope (`common/permissions.py`); soldi in `Decimal(10,2)`.
