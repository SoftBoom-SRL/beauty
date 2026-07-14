#!/usr/bin/env bash
# Orchestratore E2E youty — DB throwaway, server dedicato sulla porta 8123, smoke test.
# NON tocca mai il db.sqlite3 principale: tutto passa da DATABASE_URL=sqlite:///...e2e_db.sqlite3
#
# Uso:  backend/scripts/run_e2e.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="$BACKEND_DIR/.venv/bin/python"
PORT=8123
HOST=127.0.0.1
BASE_URL="http://$HOST:$PORT"
E2E_DB="$BACKEND_DIR/e2e_db.sqlite3"
SERVER_LOG="$SCRIPT_DIR/e2e_server.log"

# Tutto ciò che il server e i manage.py vedranno: SOLO il DB throwaway.
export DATABASE_URL="sqlite:///$E2E_DB"   # path assoluto -> sqlite:////Users/...

if [ ! -x "$PY" ]; then
  echo "[run_e2e] venv non trovato: $PY" >&2
  exit 2
fi

# Nessun server residuo da run precedenti sulla porta dedicata.
pkill -f "manage.py runserver $HOST:$PORT" 2>/dev/null && sleep 1 || true
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "[run_e2e] porta $PORT ancora occupata da un altro processo, interrompo." >&2
  lsof -i "tcp:$PORT" >&2
  exit 2
fi

echo "[run_e2e] DB throwaway: $E2E_DB (ricreato da zero)"
rm -f "$E2E_DB"

echo "[run_e2e] migrate..."
"$PY" "$BACKEND_DIR/manage.py" migrate --noinput >"$SERVER_LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[run_e2e] migrate fallita — vedi $SERVER_LOG" >&2
  tail -20 "$SERVER_LOG" >&2
  exit 2
fi

echo "[run_e2e] seed_demo --reset..."
"$PY" "$BACKEND_DIR/manage.py" seed_demo --reset >>"$SERVER_LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[run_e2e] seed fallito — vedi $SERVER_LOG" >&2
  tail -20 "$SERVER_LOG" >&2
  exit 2
fi

echo "[run_e2e] avvio runserver $HOST:$PORT (--noreload)..."
"$PY" "$BACKEND_DIR/manage.py" runserver "$HOST:$PORT" --noreload >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  # cintura di sicurezza: nessun runserver 8123 sopravvive
  pkill -f "manage.py runserver $HOST:$PORT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Readiness: l'endpoint pubblico risponde 200 quando server+seed sono pronti.
READY=0
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/core/public/branding?salon=the-parlour" 2>/dev/null)
  if [ "$code" = "200" ]; then READY=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[run_e2e] il server è morto in avvio — vedi $SERVER_LOG" >&2
    tail -30 "$SERVER_LOG" >&2
    exit 2
  fi
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  echo "[run_e2e] server non pronto entro 30s — vedi $SERVER_LOG" >&2
  tail -30 "$SERVER_LOG" >&2
  exit 2
fi
echo "[run_e2e] server pronto su $BASE_URL"
echo

"$PY" "$SCRIPT_DIR/e2e_smoke.py" --base-url "$BASE_URL" --db "$E2E_DB" --backend-dir "$BACKEND_DIR"
EXIT_CODE=$?

echo
echo "[run_e2e] exit code smoke test: $EXIT_CODE (log server: $SERVER_LOG)"
exit "$EXIT_CODE"
