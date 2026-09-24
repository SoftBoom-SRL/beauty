#!/usr/bin/env python
"""Database usa e getta per lo smoke test: migrate, cache, seed_demo ripetibile.

    python seed.py <backend-dir>

Legge DATABASE_URL (sqlite:////percorso/assoluto) e SMOKE_NOW dall'ambiente
(li imposta smoke.sh). Prima di Django ferma l'orologio a SMOKE_NOW e sostituisce
`secrets`/`random`/`uuid.uuid4` con un generatore a seme fisso (smokeclock.py):
due esecuzioni producono lo stesso database, riga per riga, compresi i codici
generati a caso (gift card, coupon, token dei webhook delle automazioni).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smokeclock  # noqa: E402

SEED = 20260924


def main():
    if len(sys.argv) != 2:
        sys.exit("uso: seed.py <backend-dir>")
    if not os.environ.get("DATABASE_URL", "").startswith("sqlite:"):
        sys.exit("seed.py: DATABASE_URL deve puntare a un sqlite usa e getta")
    smokeclock.start_clock()
    smokeclock.seed_rng(SEED)
    smokeclock.django_env(sys.argv[1])

    import django

    django.setup()
    from django.conf import settings
    from django.core.management import call_command
    from django.utils import timezone

    db = settings.DATABASES["default"]["NAME"]
    print(f"[seed] database {db} · ora del backend {timezone.localtime().isoformat()}", flush=True)
    call_command("migrate", interactive=False, verbosity=0)
    call_command("createcachetable", verbosity=0)
    call_command("seed_demo", reset=True, password="theparlour")
    print("[seed] fatto", flush=True)


if __name__ == "__main__":
    main()
