#!/usr/bin/env bash
# Avvia l'intero progetto youty in locale: backend Django + dashboard + app cliente.
# Uso:  ./start-dev.sh        (Ctrl-C ferma tutto)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

pids=()
cleanup() {
  echo ""
  echo "→ arresto dei servizi…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  # pulizia di sicurezza
  pkill -f "manage.py runserver 8000" 2>/dev/null || true
  pkill -f "vite.*--port 517" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "→ backend Django su http://localhost:8000  (admin: /admin  · docs API: /api/docs)"
( cd "$BACKEND" && exec .venv/bin/python manage.py runserver 8000 ) &
pids+=($!)

echo "→ dashboard staff su http://localhost:5173  (login sole@theparlour.it / theparlour)"
( cd "$FRONTEND" && exec npm run dev:dashboard --silent ) &
pids+=($!)

echo "→ app cliente su http://localhost:5174  (registrazione + OTP: codice nel log del backend)"
( cd "$FRONTEND" && exec npm run dev:client --silent ) &
pids+=($!)

echo ""
echo "Tutto avviato. Premi Ctrl-C per fermare tutto."
wait
