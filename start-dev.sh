#!/usr/bin/env bash
# Avvia l'intero progetto youty in locale: backend Django + dashboard + app cliente.
# Uso:  ./start-dev.sh        (Ctrl-C ferma tutto)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

pids=()

# Uccide un processo E tutta la sua discendenza. Serve perché i pid che
# registriamo qui sotto sono quelli di `npm run`, non di vite: uccidendo solo il
# padre, vite restava attaccato alla 5173/5174 e al rilancio `strictPort: true`
# (vite.config.js) faceva fallire il dev server. Stessa storia per il processo
# figlio dell'autoreload di runserver.
# Prima c'era un `pkill -f "vite.*--port 517"` come rete di sicurezza: non ha mai
# combaciato con niente, perché la porta la decide vite.config.js e sulla riga di
# comando non compare. Risalire l'albero dei processi non dipende da come è
# scritto il comando, e non rischia di colpire un vite di un altro progetto.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  echo ""
  echo "→ arresto dei servizi…"
  # `${pids[@]}` su array vuoto è un errore con `set -u` (bash 3.2, quello di
  # macOS): capita se si preme Ctrl-C prima che parta il primo servizio.
  if [ ${#pids[@]} -gt 0 ]; then
    for pid in "${pids[@]}"; do kill_tree "$pid"; done
  fi
  exit 0
}
trap cleanup INT TERM

echo "→ backend Django su http://localhost:8000  (admin: /admin  · docs API: /api/docs)"
( cd "$BACKEND" && exec .venv/bin/python manage.py runserver 8000 ) &
pids+=($!)

# Il seed non ha una password fissa: la sceglie a caso e la stampa una volta, o
# usa quella data con `manage.py seed_demo --reset --password …`.
echo "→ dashboard staff su http://localhost:5173  (login sole@theparlour.it, password del seed_demo)"
( cd "$FRONTEND" && exec npm run dev:dashboard --silent ) &
pids+=($!)

echo "→ app cliente su http://localhost:5174  (registrazione + OTP: codice nel log del backend)"
( cd "$FRONTEND" && exec npm run dev:client --silent ) &
pids+=($!)

echo ""
echo "Tutto avviato. Premi Ctrl-C per fermare tutto."
wait
