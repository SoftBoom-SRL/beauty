"""Primitive sui minuti da mezzanotte: la griglia su cui lavora la disponibilità.

Tutti i calcoli di disponibilità lavorano in MINUTI DA MEZZANOTTE del giorno
richiesto, nel fuso del salone (settings.TIME_ZONE). Un intervallo è
[inizio, fine) in minuti; gli impegni di un'operatrice sono tuple
(inizio, fine, hard) (vedi `occupancy._busy_map`).
"""

import datetime as dt

from django.utils import timezone


def day_and_minute(value: dt.datetime) -> tuple[dt.date, int]:
    """Il giorno e il minuto da mezzanotte di un istante, nel fuso del salone."""
    local = timezone.localtime(value)
    return local.date(), local.hour * 60 + local.minute


def _slot_datetime(day: dt.date, minutes: int) -> dt.datetime | None:
    """Istante del minuto `minutes` di quel giorno, None se quell'ora locale non esiste.

    La notte del passaggio all'ora legale un'ora sparisce dagli orologi (in Italia
    le 02:00-02:59 dell'ultima domenica di marzo): `make_aware` la converte
    comunque, e l'agenda proponeva un orario che nessuna cliente vedrà mai sul
    telefono. Se il giro di andata e ritorno non riporta lo stesso minuto locale,
    l'orario semplicemente non esiste e non va offerto.
    """
    naive = dt.datetime.combine(day, dt.time.min) + dt.timedelta(minutes=minutes)
    aware = timezone.make_aware(naive)
    # Il giro per UTC normalizza l'orologio da parete: se tornando indietro non
    # si riottiene lo stesso orario, quell'ora locale non è mai esistita. (Un
    # confronto diretto non basta: convertire un orario nel suo stesso fuso lo
    # lascia com'è, anche quando è impossibile.)
    if timezone.localtime(aware.astimezone(dt.timezone.utc)).replace(tzinfo=None) != naive:
        return None
    return aware


def _overlaps(intervals, start: int, end: int) -> bool:
    return any(b_start < end and b_end > start for b_start, b_end in intervals)


def _within_windows(windows, start: int, end: int) -> bool:
    # L'intervallo deve stare per intero DENTRO UNA sola finestra di turno
    # (un servizio non può scavalcare la pausa pranzo).
    return any(w_start <= start and end <= w_end for w_start, w_end in windows)


def _is_free(windows, busy, start: int, end: int, allow_soak: bool = False) -> bool:
    """Vero se [start, end) sta dentro una finestra di turno e non collide con
    alcun intervallo BLOCCANTE dell'operatrice.

    `busy` è una lista di tuple (start_min, end_min, hard):
    - hard=True  -> lavoro attivo o pausa: blocca SEMPRE (conflitto reale);
    - hard=False -> posa (soak): blocca solo se allow_soak è False.

    Con allow_soak=True gli intervalli di posa NON bloccano: una sovrapposizione
    manuale sulla posa altrui è ammessa (decisione dello staff), mai automatica.
    """
    if not _within_windows(windows, start, end):
        return False
    blocking = [(s, e) for s, e, hard in busy if hard or not allow_soak]
    return not _overlaps(blocking, start, end)
