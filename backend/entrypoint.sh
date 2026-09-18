#!/bin/sh
# Entrypoint di produzione: migrazioni, static, superuser opzionale, poi il comando (gunicorn).
set -e

echo "→ migrate"
python manage.py migrate --noinput

echo "→ createcachetable"
python manage.py createcachetable

echo "→ collectstatic"
python manage.py collectstatic --noinput

# Superuser creato al primo avvio solo se le due env sono presenti.
# Se l'utente esiste già createsuperuser fallisce ed è normale: si prosegue.
# Il messaggio però va stampato, non buttato in /dev/null — con `2>/dev/null`
# una password rifiutata o una email non valida diventavano indistinguibili da
# "già presente", e il superuser non esisteva senza che nessuno lo sapesse.
if [ -n "$DJANGO_SUPERUSER_EMAIL" ] && [ -n "$DJANGO_SUPERUSER_PASSWORD" ]; then
  if err="$(python manage.py createsuperuser --noinput --email "$DJANGO_SUPERUSER_EMAIL" 2>&1 >/dev/null)"; then
    echo "→ superuser creato: $DJANGO_SUPERUSER_EMAIL"
  else
    echo "→ superuser NON creato ($DJANGO_SUPERUSER_EMAIL): ${err:-nessun dettaglio}"
    echo "  (se l'utente esiste già è atteso; qualunque altro messaggio è un errore vero)"
  fi
fi

exec "$@"
