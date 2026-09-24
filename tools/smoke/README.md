# Smoke test deterministico (dashboard + app cliente)

Serve a dimostrare che un cambiamento non cambia niente di visibile (è nato per
il refactoring del 24/09/2026): lo stesso giro nel browser, fatto su due versioni
del codice, deve dare lo stesso report. Non tocca i repository (tranne `npm ci` se
manca `frontend/node_modules`).

Serve: il venv del backend (`backend/.venv`, con `requirements-dev.txt` per
`time-machine`; senza, lo script prova a installarlo con `uv` in
`tools/smoke/pylib/`), Node 22, Playwright con Chromium (`npm i -g playwright` e
`npx playwright install chromium`, oppure `SMOKE_PLAYWRIGHT` e
`PLAYWRIGHT_BROWSERS_PATH`).

## Cosa fa `smoke.sh <repo-o-worktree> <out-dir> <port-base>`
1. database sqlite nuovo in `<out-dir>`, `migrate`, `createcachetable`, poi
   `seed.py` → `seed_demo --reset --password theparlour` con `secrets`/`random`/`uuid4`
   a seme fisso (codici, token dei webhook, sali: identici a ogni giro);
2. backend `runserver 127.0.0.1:<port-base> --noreload` (log in `server.log`);
3. `vite build` delle due app in `<out-dir>/dist-*`, servite come SPA da `static.mjs`
   su `<port-base>+1` (dashboard) e `<port-base>+2` (app cliente, `/the-parlour`);
4. `run.mjs` (Playwright, Chromium headless) esegue 103 passi: 75 in dashboard
   (1440×900, login vero come sole@theparlour.it) e 28 nell'app cliente (390×844
   mobile, OTP letto da `server.log`). Per ogni passo registra esito, URL, errori di
   console/pagina, richieste fallite e risposte ≥ 400, chiamate API (metodo, percorso,
   query ordinata, corpo JSON a chiavi ordinate, token/codici mascherati), toast,
   testo visibile, valori dei campi e screenshot → `report.json` + `screenshots/`;
5. ferma tutti i processi. Exit ≠ 0 solo se si rompe l'harness (i passi falliti
   stanno nel report).

Mai salvataggi, cancellazioni o incassi: i modali si aprono e si chiudono con Esc,
le prenotazioni si fermano prima della conferma. Unici cambi di stato: la richiesta
dell'OTP e l'accesso della cliente, la lingua (rimessa a italiano) e l'uscita finale.

## Come si usa
La versione di partenza e quella nuova in due cartelle (per esempio con
`git worktree add ../base <commit-di-partenza>`), lo stesso giorno simulato:
```sh
T=tools/smoke
PY=backend/.venv/bin/python                         # compare.py vuole Pillow
SMOKE_DATE=2026-09-24 $T/smoke.sh ../base      /tmp/smoke/base 8400 &
SMOKE_DATE=2026-09-24 $T/smoke.sh .            /tmp/smoke/cand 8500
wait
$PY $T/compare.py /tmp/smoke/base /tmp/smoke/cand   # 0 = IDENTICI, 1 = differenze
```
`compare.py` elenca passi mancanti, esiti diversi e i diff (errori, API, toast,
campi, testo, troncati a `--max-lines`); per gli screenshot conta i pixel diversi
e salva l'immagine della differenza (B schiarito, pixel diversi in rosso) in
`<cand>/diff/`. `--fuzz N` tollera N livelli per canale (default 0: esatto).
Un giro dura 2,5–3,5 minuti secondo il carico (10–30 s di preparazione). Debug: `SMOKE_STEPS=regex`
esegue solo le catene che contengono quei passi (più i login), `SMOKE_HEADFUL=1`.

## Porte
Ogni giro occupa `<port-base>`, `+1`, `+2`: scegli un port-base tuo a passi di 100
(8400, 8500, …). Se una porta è occupata lo script si
ferma subito. Le porte non entrano nel confronto: nel testo diventano
`{API}`/`{DASH}`/`{CLIENT}`, e per lo screenshot i link che le mostrano
(Impostazioni → Link pubblici, anche sfocati dietro i drawer) si disegnano con le
porte canoniche 8300/8301/8302: due giri su port-base diversi sono confrontabili.

## Nondeterminismo: cosa è stato fissato
- **Orologio**: backend fermo a SMOKE_DATE (default oggi) alle 10:30 di Roma
  (`time-machine`, `tick=False`), browser con
  `clock.setFixedTime` sullo stesso istante. Il report vale per quel giorno: per
  confrontarsi con una baseline di un altro giorno passa `SMOKE_DATE` (è in
  `meta.date`). Il giorno della settimana conta (la domenica il salone è chiuso).
- **Caso**: seme fisso nel seed e `Math.random` a seme fisso nella pagina; jti, ticket
  SSE e OTP del server non sono fissati ma mascherati.
- **Feed live** (SSE `/api/core/activity/stream*` e polling `/activity/feed`):
  esclusi dall'attesa di pagina ferma e dalle liste API (solo l'elenco in
  `liveEndpoints`); `SSE_MAX_CONNECTIONS=64` evita il ripiego sul polling.
- **Tempi**: si registra dopo 800 ms senza richieste e 500 ms senza mutazioni del DOM;
  toast nascosti durante la cattura (il testo va in `toasts`); animazioni e
  transizioni azzerate; liste API, console ed errori ordinate.
- **Pixel**: `--disable-partial-raster` (senza, angoli e ombre ridisegnati dopo un
  hover o un modale variavano di ±1); font di sistema, niente LCD text.
- Hash dei chunk Vite normalizzati (`index-*.js`) in URL e messaggi.

## Limiti noti
- Lo screenshot copre il viewport: dashboard e app scorrono dentro contenitori, quindi
  ciò che sta sotto la piega è solo nel testo (che copre tutta la pagina).
- Con l'orologio fermo `Date.now()` è costante: chiavi React fatte con `Date.now()`
  (es. carrello della cassa) collidono se si aggiunge due volte lo stesso prodotto
  (il giro non lo fa).
- Un passo con `quiet: false` è stato catturato senza che la pagina fosse ferma
  (macchina molto carica): rilancia prima di credere alla differenza.
- La richiesta OTP ha un tetto per finestra: con l'orologio fermo la finestra non
  scade mai, ma ogni giro ha un database nuovo e ne chiede una sola.
