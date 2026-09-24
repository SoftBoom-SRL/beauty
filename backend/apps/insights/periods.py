"""Periodi degli insight: mese, trimestre, anno o un intervallo scelto, come istanti [inizio, fine).

Ogni metrica del cruscotto parte da qui: il periodo richiesto diventa due
istanti nel fuso del salone, controllati (date fuori scala, intervalli
rovesciati o troppo ampi rispondono 400, con il messaggio da mostrare). Stava
in testa a services.py, mescolato alle metriche.
"""

from datetime import date as date_cls
from datetime import datetime, time, timedelta

from django.utils import timezone
from ninja.errors import HttpError

PERIODS = {"month", "quarter", "year"}
GRANULARITIES = {"day", "week", "month"}

# Giorni massimi di un intervallo personalizzato: due anni abbondanti, cioè
# molto più del confronto anno su anno che il titolare guarda davvero.
MAX_RANGE_DAYS = 732

# Date accettate come periodo. Fuori da qui l'anno 1 andava in overflow nella
# conversione in UTC e il 9999 in `date(anno + 1, …)`: la richiesta finiva in un
# 500 invece di dire che la data non ha senso.
MIN_DATE = date_cls(1900, 1, 1)
MAX_DATE = date_cls(2999, 12, 31)


def _check_date(d: date_cls | None) -> None:
    if d is not None and not MIN_DATE <= d <= MAX_DATE:
        raise HttpError(
            400, f"Data fuori scala: usa una data fra il {MIN_DATE.year} e il {MAX_DATE.year}"
        )


def _add_months(d: date_cls, months: int) -> date_cls:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    return date_cls(year, month, 1)


def period_range(period: str, date: date_cls | None = None) -> tuple[datetime, datetime]:
    """Intervallo [start, end) del periodo che contiene `date` (default oggi).

    `period` è month/quarter/year. `end` è esclusivo. start/end sono datetime
    timezone-aware nel fuso applicativo corrente.
    """
    if period not in PERIODS:
        raise HttpError(400, "Periodo non valido: usa month, quarter o year")
    _check_date(date)
    anchor = date or timezone.localdate()
    if period == "month":
        start_date = anchor.replace(day=1)
        end_date = _add_months(start_date, 1)
    elif period == "quarter":
        quarter_start_month = (anchor.month - 1) // 3 * 3 + 1
        start_date = date_cls(anchor.year, quarter_start_month, 1)
        end_date = _add_months(start_date, 3)
    else:  # year
        start_date = date_cls(anchor.year, 1, 1)
        end_date = date_cls(anchor.year + 1, 1, 1)
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(start_date, time.min), tz)
    end = timezone.make_aware(datetime.combine(end_date, time.min), tz)
    return start, end


def custom_range(date_from: date_cls, date_to: date_cls) -> tuple[datetime, datetime]:
    """Intervallo esplicito [start, end) da due date INCLUSE (end = date_to + 1 giorno)."""
    _check_date(date_from)
    _check_date(date_to)
    if date_from > date_to:
        raise HttpError(400, "Intervallo non valido: la data iniziale è successiva a quella finale")
    # Tetto all'ampiezza: il selettore di date non ha un anno minimo, e un
    # "0202-01-01" produceva 666.000 giorni da scorrere uno per uno (turni,
    # bucket, occupazione) tenendo occupato un thread del server per minuti.
    if (date_to - date_from).days + 1 > MAX_RANGE_DAYS:
        raise HttpError(
            400, f"Intervallo troppo ampio: al massimo {MAX_RANGE_DAYS} giorni (circa due anni)"
        )
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(date_from, time.min), tz)
    end = timezone.make_aware(datetime.combine(date_to + timedelta(days=1), time.min), tz)
    return start, end


def resolve_range(period, date, date_from, date_to) -> tuple[datetime, datetime]:
    """Range personalizzato se `date_from` e `date_to` sono entrambi forniti,
    altrimenti il periodo standard month/quarter/year."""
    if date_from and date_to:
        return custom_range(date_from, date_to)
    return period_range(period, date)


def dates_in_range(start: datetime, end: datetime) -> list[date_cls]:
    """Elenco dei giorni [start.date(), end.date())."""
    d, end_d = start.date(), end.date()
    days = []
    while d < end_d:
        days.append(d)
        d += timedelta(days=1)
    return days
