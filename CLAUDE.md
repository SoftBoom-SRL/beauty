# Note per chi lavora sul codice con un assistente AI

Progetto in produzione: un push su `main` fa il deploy (Coolify) e lancia le
migrazioni. Si lavora su un branch; si arriva su `main` solo con i controlli
verdi e quando lo chiede chi possiede il progetto.

Leggi prima [`docs/SVILUPPO.md`](docs/SVILUPPO.md) (mappa del codice, regole,
ricette) e, per il frontend, [`frontend/README.md`](frontend/README.md).

## Comandi

- Backend (da `backend/`, venv in `backend/.venv`):
  `ruff check .` · `python manage.py check` ·
  `python manage.py makemigrations --check --dry-run` ·
  `python manage.py test --noinput --parallel auto` (una sola app:
  `python manage.py test apps.agenda`).
- Frontend (da `frontend/`): `npm run lint` · `npm test` · `npm run build`.
- Tutto in locale: `./start-dev.sh` (dati demo: `manage.py seed_demo --reset --password <scelta>`).

## Regole

- Commenti, docstring, messaggi d'errore e messaggi di commit in **italiano**;
  i commenti spiegano il perché (lo scenario che si rompeva). I testi
  dell'interfaccia sempre in due lingue: `t('italiano', 'English')`.
- Ogni query filtra per il salone della richiesta (`salon_get`); le scritture
  chiedono il permesso (`require_scope`); i messaggi d'errore per l'utente con
  `HttpError(4xx, "…")`.
- Soldi in `Decimal`, mai float; date e ore nel fuso del salone (nel frontend
  con gli aiuti di `@youty/shared/format.js`).
- Endpoint sottili: la logica va nei moduli di dominio dell'app (vedi la
  tabella in `docs/SVILUPPO.md` §1.1). I docstring di schemi ed endpoint sono
  la documentazione pubblica OpenAPI.
- Nel frontend nessuna chiamata `api.*` nei componenti: passa dal modulo API del
  dominio (`apps/dashboard/src/api/`, `sections/agenda/agendaApi.js`,
  `apps/client-app/src/api/client.js`).
- Test nuovi nel modulo dell'argomento (`apps/<app>/tests/test_<argomento>.py`),
  non in file intitolati a una data. `mock.patch` sul modulo che CHIAMA il nome,
  e verificando che il mock sia stato chiamato.
- Le funzioni di altre app che i test sostituiscono si importano dentro la
  funzione che le usa (vengono cercate a ogni chiamata).
- Un campo nuovo vuole la migrazione (`makemigrations`), e una migrazione di
  dati deve reggere su PostgreSQL 16 e usare `apps.get_model`.
- Niente formattatori automatici sul codice esistente; lo stile è quello del
  codice intorno.
- Un bug trovato durante un altro lavoro si corregge in un commit a parte, con il
  test che lo riproduce.
