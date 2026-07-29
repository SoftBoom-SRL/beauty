# youty backend

Backend Django unico per la **dashboard gestionale** e la **web app cliente** (yourang).
Riferimento funzionale: `../yourang - Manuale flussi.doc` · Architettura e contratto: `SPEC.md`.

> **Pagamenti (Stripe):** il codice è completo e testato ma **non è mai stato
> eseguito contro Stripe reale**. Chi deve configurarlo e provarlo segua
> [`../docs/setup-stripe.md`](../docs/setup-stripe.md): guida passo per passo,
> non richiede di saper programmare per la parte di configurazione.

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
python manage.py seed_demo        # salone The Parlour + dati demo
python manage.py runserver
```

- API docs: http://localhost:8000/api/docs
- Admin: http://localhost:8000/admin/ (creato da seed_demo: vedi output del comando)

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
