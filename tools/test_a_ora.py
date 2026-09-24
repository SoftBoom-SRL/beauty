"""La suite del backend con l'orologio spostato a un'ora scelta.

    backend/.venv/bin/python tools/test_a_ora.py 2026-10-01T00:30 [etichette dei test…]

Un test che costruisce le date da «adesso» (una visita fra tre ore, «oggi» preso
in UTC, l'anno in corso) passa di giorno e fallisce la sera, a mezzanotte, il
primo del mese o a capodanno, e la CI diventa rossa senza che nessuno abbia
toccato niente. Il 24/09/2026 così ne sono venuti fuori sei. Lo script sposta
l'ora di tutto il processo, compresi i processi di `--parallel`, con
time-machine (è in requirements-dev.txt), e lancia `manage.py test --noinput
--parallel auto` con le etichette che seguono. L'ora si intende nel fuso del
salone (Europe/Rome) se non ha un offset, e da lì scorre.

Momenti che vale la pena provare: le 23:45 (visite che scavalcano la
mezzanotte), le 00:30 (la data UTC è ancora quella di ieri), le 00:30 del primo
del mese e del primo dell'anno, la notte del cambio dell'ora.
"""

import datetime as dt
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

BACKEND = Path(__file__).resolve().parents[1] / "backend"


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    try:
        import time_machine
    except ImportError:
        sys.exit("time-machine manca: pip install -r backend/requirements-dev.txt")
    when = dt.datetime.fromisoformat(sys.argv[1])
    if when.tzinfo is None:
        when = when.replace(tzinfo=ZoneInfo("Europe/Rome"))
    time_machine.travel(when, tick=True).start()

    os.chdir(BACKEND)
    sys.path.insert(0, str(BACKEND))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(["manage.py", "test", "--noinput", "--parallel", "auto", *sys.argv[2:]])


if __name__ == "__main__":
    main()
