#!/usr/bin/env bash
# smoke.sh — smoke test deterministico di dashboard e app cliente su un repo/worktree.
#
#   smoke.sh <repo-o-worktree> <out-dir> <port-base>
#
# Porte: <port-base> backend, +1 dashboard, +2 app cliente (tutte su 127.0.0.1).
# Tutto ciò che scrive finisce in <out-dir>: database sqlite usa e getta, log,
# build delle due app, report.json e screenshots/. Nel repo non scrive nulla
# (bytecode Python in <out-dir>/.pycache, config di Vite caricata senza file
# temporanei), salvo `npm ci` quando frontend/node_modules manca.
#
# Variabili facoltative:
#   SMOKE_DATE=AAAA-MM-GG  giorno simulato (default: oggi a Roma). Backend e
#                          browser vedono quel giorno alle 10:30 ora di Roma:
#                          per confrontarsi con una baseline di un altro giorno
#                          si passa la sua data (report.json → meta.date).
#   SMOKE_PYTHON           interprete del venv del backend (default: backend/.venv)
#   SMOKE_PLAYWRIGHT       modulo Playwright da usare (default: quello installato)
#   SMOKE_STEPS=re         esegue solo i passi il cui nome combacia (debug)
#
# Esce con 0 quando il giro è arrivato in fondo (anche con passi falliti: quelli
# sono nel report), diverso da 0 solo se si è rotto l'harness.
set -u -o pipefail

usage() { echo "uso: $0 <repo-o-worktree> <out-dir> <port-base>" >&2; exit 2; }
[ $# -eq 3 ] || usage
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$1" 2>/dev/null && pwd)" || { echo "[smoke] repo non trovato: $1" >&2; exit 2; }
PORT="$3"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65000 ] || usage
mkdir -p "$2" || exit 2
OUT="$(cd "$2" && pwd)"
# L'interprete del venv del backend: quello del repo provato, altrimenti quello
# del repo che contiene questo script (i worktree di solito non ne hanno uno).
PY="${SMOKE_PYTHON:-}"
if [ -z "$PY" ]; then
  for cand in "$REPO/backend/.venv/bin/python" "$HERE/../../backend/.venv/bin/python"; do
    [ -x "$cand" ] && { PY="$cand"; break; }
  done
fi
[ -n "$PY" ] || { echo "[smoke] venv del backend non trovato: imposta SMOKE_PYTHON" >&2; exit 2; }
NODE="${SMOKE_NODE:-node}"
HOST=127.0.0.1
API_PORT=$PORT
DASH_PORT=$((PORT + 1))
CLIENT_PORT=$((PORT + 2))
T0=$(date +%s)

log() { echo "[smoke $(date +%H:%M:%S)] $*"; }
die() { echo "[smoke] ERRORE: $*" >&2; exit 3; }

[ -x "$PY" ] || die "interprete Python non trovato: $PY"
[ -f "$REPO/backend/manage.py" ] || die "$REPO/backend/manage.py non esiste"
[ -d "$REPO/frontend/apps/dashboard" ] || die "$REPO/frontend/apps/dashboard non esiste"

# ---- processi avviati: alla fine si uccide l'albero intero di ciascuno ----
pids=()
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ ${#pids[@]} -gt 0 ]; then
    for pid in "${pids[@]}"; do kill_tree "$pid"; done
    sleep 0.5
    for pid in "${pids[@]}"; do kill -9 "$pid" 2>/dev/null || true; done
    wait 2>/dev/null
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

port_busy() { (echo >"/dev/tcp/$HOST/$1") >/dev/null 2>&1; }
for p in "$API_PORT" "$DASH_PORT" "$CLIENT_PORT"; do
  port_busy "$p" && die "la porta $p è già occupata (scegli un altro port-base)"
done

# ---- output pulito (solo i file che produce questo script) ----
rm -rf "$OUT/db.sqlite3" "$OUT/db.sqlite3-journal" "$OUT/dist-dashboard" "$OUT/dist-client-app" \
  "$OUT/screenshots" "$OUT/report.json" "$OUT/seed.log" "$OUT/server.log" "$OUT/run.log" \
  "$OUT/build-dashboard.log" "$OUT/build-client-app.log" "$OUT/static-dashboard.log" "$OUT/static-client-app.log"

# ---- istante simulato: oggi (o SMOKE_DATE) alle 10:30 ora di Roma ----
SMOKE_DATE="${SMOKE_DATE:-$(TZ=Europe/Rome date +%F)}"
SMOKE_NOW="$("$PY" -c 'import sys, datetime as d, zoneinfo
y, m, g = map(int, sys.argv[1].split("-"))
print(d.datetime(y, m, g, 10, 30, tzinfo=zoneinfo.ZoneInfo("Europe/Rome")).isoformat())' "$SMOKE_DATE")" \
  || die "SMOKE_DATE non valida: $SMOKE_DATE"
export SMOKE_NOW

# ---- ambiente del backend: solo il DB usa e getta, niente servizi esterni ----
# Valori espliciti: un .env nel worktree non li sovrascrive (load_dotenv non
# tocca le variabili già impostate).
export DATABASE_URL="sqlite:///$OUT/db.sqlite3"
export DEBUG=1 SECRET_KEY=dev-insecure-change-me ALLOWED_HOSTS='*' SERVE_MEDIA=1
export STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET= STRIPE_CONNECT_WEBHOOK_SECRET= STRIPE_WEBHOOK_SECRETS= STRIPE_CONNECT_CLIENT_ID=
export YOURANG_API_URL= YOURANG_API_KEY= YOURANG_ISSUER_URL= YOURANG_CLIENT_ID= YOURANG_CLIENT_SECRET= YOURANG_WEBHOOK_RECEIVER_URL= ENCRYPTION_KEY=
export FRONTEND_ORIGIN="http://$HOST:$DASH_PORT" CLIENT_APP_ORIGIN="http://$HOST:$CLIENT_PORT"
# Stream live: ogni ricarica della dashboard ne apre uno e quello vecchio resta
# appeso fino al ping successivo (15 s). Col tetto di default (12) un giro veloce
# poteva ricevere il 503 e la dashboard passava al polling: stato «Riconnessione…».
export SSE_MAX_CONNECTIONS=64
export PYTHONUNBUFFERED=1 PYTHONPYCACHEPREFIX="$OUT/.pycache" TZ=Europe/Rome

log "repo $REPO · out $OUT · porte $API_PORT/$DASH_PORT/$CLIENT_PORT · ora simulata $SMOKE_NOW"

# ---- 1. seed (in background, intanto si costruiscono le app) ----
python_has_clock() { "$PY" -c "import sys; sys.path.insert(0, '$HERE/pylib'); import time_machine" 2>/dev/null; }
if ! python_has_clock; then
  log "time-machine mancante in $HERE/pylib: lo installo"
  uv pip install --quiet --target "$HERE/pylib" --python "$PY" time-machine==3.5.1 >/dev/null 2>&1 || true
  python_has_clock || die "impossibile importare time_machine (vedi README)"
fi
"$PY" "$HERE/seed.py" "$REPO/backend" >"$OUT/seed.log" 2>&1 &
SEED_PID=$!
pids+=("$SEED_PID")

# ---- 2. build delle due app ----
FE="$REPO/frontend"
if [ ! -d "$FE/node_modules" ]; then
  LOCK="${TMPDIR:-/tmp}/smoke-npmci-$(printf '%s' "$FE" | md5sum | cut -c1-12).lock"
  log "node_modules mancante: npm ci in $FE"
  (
    flock 9
    [ -d "$FE/node_modules" ] || (cd "$FE" && npm ci --no-audit --no-fund --prefer-offline)
  ) 9>"$LOCK" >"$OUT/npm-ci.log" 2>&1 || die "npm ci fallito — vedi $OUT/npm-ci.log"
fi
VITE="$FE/node_modules/.bin/vite"
[ -x "$VITE" ] || die "vite non trovato in $FE/node_modules/.bin"
build_app() {
  local app="$1"
  (
    cd "$FE/apps/$app" || exit 1
    export VITE_API_URL="http://$HOST:$API_PORT" VITE_SALON_SLUG=the-parlour VITE_CLIENT_APP_URL="http://$HOST:$CLIENT_PORT"
    # configLoader native: la config si importa così com'è, senza il file
    # temporaneo che Vite altrimenti scrive accanto (o in node_modules/.vite-temp).
    "$VITE" build --outDir "$OUT/dist-$app" --emptyOutDir --configLoader native \
      || { echo "[smoke] nuovo tentativo con il caricatore di default"; "$VITE" build --outDir "$OUT/dist-$app" --emptyOutDir; }
  ) >"$OUT/build-$app.log" 2>&1
}
build_app dashboard & B1=$!; pids+=("$B1")
build_app client-app & B2=$!; pids+=("$B2")
wait "$B1" || die "build della dashboard fallita — vedi $OUT/build-dashboard.log"
wait "$B2" || die "build dell'app cliente fallita — vedi $OUT/build-client-app.log"
log "build pronte"
wait "$SEED_PID" || { tail -30 "$OUT/seed.log" >&2; die "seed fallito — vedi $OUT/seed.log"; }
log "seed pronto"

# ---- 3. servizi ----
"$PY" "$HERE/serve.py" "$REPO/backend" "$HOST:$API_PORT" >"$OUT/server.log" 2>&1 &
SERVER_PID=$!; pids+=("$SERVER_PID")
"$NODE" "$HERE/static.mjs" "$OUT/dist-dashboard" "$DASH_PORT" "$HOST" >"$OUT/static-dashboard.log" 2>&1 &
pids+=($!)
"$NODE" "$HERE/static.mjs" "$OUT/dist-client-app" "$CLIENT_PORT" "$HOST" >"$OUT/static-client-app.log" 2>&1 &
pids+=($!)

wait_http() {  # url, secondi
  local url="$1" i code
  for i in $(seq 1 $(($2 * 4))); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
wait_http "http://$HOST:$API_PORT/api/core/public/branding?salon=the-parlour" 60 \
  || { tail -30 "$OUT/server.log" >&2; die "backend non pronto — vedi $OUT/server.log"; }
wait_http "http://$HOST:$DASH_PORT/" 20 || die "server statico della dashboard non pronto"
wait_http "http://$HOST:$CLIENT_PORT/the-parlour" 20 || die "server statico dell'app cliente non pronto"
log "servizi pronti ($(($(date +%s) - T0)) s)"

# ---- 4. giro nel browser ----
"$NODE" "$HERE/run.mjs" --out "$OUT" \
  --api "http://$HOST:$API_PORT" --dash "http://$HOST:$DASH_PORT" --client "http://$HOST:$CLIENT_PORT" \
  --now "$SMOKE_NOW" --date "$SMOKE_DATE" --server-log "$OUT/server.log" --repo "$REPO" 2>&1 | tee "$OUT/run.log"
RUN_RC=${PIPESTATUS[0]}
[ "$RUN_RC" -eq 0 ] && [ -s "$OUT/report.json" ] || die "run.mjs si è interrotto (exit $RUN_RC) — vedi $OUT/run.log"
log "fatto in $(($(date +%s) - T0)) s · report $OUT/report.json"
exit 0
