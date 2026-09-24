#!/usr/bin/env python
"""runserver del backend con l'orologio fermo a SMOKE_NOW.

    python serve.py <backend-dir> <host:port>

Equivale a `manage.py runserver <host:port> --noreload` lanciato da
<backend-dir>, ma con lo stesso istante del browser e del seed (vedi
smokeclock.py). Il caso NON è fissato qui: jti, ticket SSE e codici OTP del
server dipendono dall'ordine delle richieste concorrenti, quindi run.mjs li
maschera invece di pretenderli uguali.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smokeclock  # noqa: E402


def main():
    if len(sys.argv) != 3:
        sys.exit("uso: serve.py <backend-dir> <host:port>")
    smokeclock.start_clock()
    smokeclock.django_env(sys.argv[1])
    from django.core.management import execute_from_command_line

    execute_from_command_line(["manage.py", "runserver", sys.argv[2], "--noreload"])


if __name__ == "__main__":
    main()
