"""Servizi staff: disponibilità dell'operatrice (turni, pause, assenze, orari del salone).

`shift_windows` è LA funzione consumata dall'agenda (`apps.agenda.services.get_free_slots`)
per sapere quando un'operatrice è lavorabile in una data: la firma non va cambiata.
Agenda e insights la importano da qui e i test la patchano qui. I KPI
dell'operatrice (incassi, clienti) stanno in stats.py.
"""

from datetime import date as date_cls

from django.utils import timezone

from common.intervals import merge_intervals

# compat refactoring: rimuovere dopo l'integrazione. I KPI ora vivono in
# staff/stats.py; sales/tests_caccia22_storico.py
# (CouponOnTheLinesTests.test_the_operator_revenue_matches_the_takings) li
# importa ancora da questo modulo.
from .stats import month_revenue, month_revenue_by_operator, performance_series  # noqa: F401


def _current_absence(operator, on_date: date_cls):
    # `.all()` + filtro in Python: così un `prefetch_related("absences")` a monte
    # (vista mese: 40 giorni × N operatrici) evita una query per chiamata.
    absences = [a for a in operator.absences.all() if a.date_from <= on_date <= a.date_to]
    absences.sort(key=lambda a: a.date_from)
    return absences[0] if absences else None


def _hm_to_min(value: str) -> int:
    hours, minutes = str(value).split(":")
    return int(hours) * 60 + int(minutes)


def min_to_hm(minutes: int) -> str:
    """Minuti da mezzanotte → «HH:MM» (le finestre di turno nelle risposte)."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def opening_windows(salon, date: date_cls) -> list[tuple[int, int]] | None:
    """Fasce di apertura del salone per quella data, o None se gli orari non sono configurati.

    Fonte: SalonSettings.opening_hours_week ({"0": [["09:00","13:00"], …]}, 0 = lunedì).
    Lista vuota = giorno di chiusura.
    """
    salon_settings = getattr(salon, "settings", None)
    week = getattr(salon_settings, "opening_hours_week", None) or {}
    if not week:
        return None
    ranges = week.get(str(date.weekday()), []) or []
    return [(_hm_to_min(a), _hm_to_min(b)) for a, b in ranges]


def _intersect(windows: list[tuple[int, int]], bounds: list[tuple[int, int]]) -> list[tuple[int, int]]:
    result = []
    for w_start, w_end in windows:
        for b_start, b_end in bounds:
            start, end = max(w_start, b_start), min(w_end, b_end)
            if start < end:
                result.append((start, end))
    result.sort()
    return result


def _week_index(date: date_cls, cycle_weeks: int) -> int:
    """Indice della settimana dentro il ciclo dei turni.

    Si contano le settimane trascorse, non il numero di settimana ISO: ISO
    riparte da 1 ogni anno, e negli anni da 53 settimane (2026 lo è) la 53ª e la
    1ª successiva ricadono sullo stesso indice. Da quel capodanno in poi un
    ciclo di due settimane resta invertito per sempre. L'ordinale 1 cade di
    lunedì, quindi il conto cambia esattamente al cambio di settimana.
    """
    return ((date.toordinal() - 1) // 7) % max(cycle_weeks, 1)


def _subtract(windows: list[tuple[int, int]], cuts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Toglie dalle finestre gli intervalli `cuts` (le pause).

    Le pause vanno sottratte DOPO la fusione, non ritagliate riga per riga: con
    due righe che si sovrappongono (9–18 con pausa 13–14 e una seconda riga
    12–15) la fusione ricuciva i due tronconi e la pausa pranzo spariva, così
    l'agenda proponeva appuntamenti mentre l'operatrice era a tavola.
    """
    if not cuts:
        return windows
    result: list[tuple[int, int]] = []
    for start, end in windows:
        pieces = [(start, end)]
        for cut_start, cut_end in cuts:
            remaining: list[tuple[int, int]] = []
            for piece_start, piece_end in pieces:
                if cut_end <= piece_start or cut_start >= piece_end:
                    remaining.append((piece_start, piece_end))
                    continue
                if piece_start < cut_start:
                    remaining.append((piece_start, cut_start))
                if cut_end < piece_end:
                    remaining.append((cut_end, piece_end))
            pieces = remaining
        result.extend(pieces)
    result.sort()
    return result


def shift_windows(operator, date: date_cls) -> list[tuple[int, int]]:
    """Finestre lavorabili (minuti da mezzanotte) per l'operatrice in quella data.

    week_index = settimane trascorse % `operator.cycle_weeks`; per ciascuna riga
    di turno del weekday corrispondente si ritaglia l'eventuale pausa (che può
    spezzare la finestra in due). Ritorna [] se la data è coperta da un'`Absence`
    o se l'operatrice non ha turno per quel weekday/week_index.

    Se il salone ha configurato gli orari di apertura (Impostazioni), le finestre
    vengono intersecate con le fasce del giorno: fuori orario — o nei giorni di
    chiusura — non si prenota, qualunque sia il turno. Senza orari configurati
    contano solo i turni.
    """
    if _current_absence(operator, date) is not None:
        return []

    cycle_weeks = operator.cycle_weeks or 1
    week_index = _week_index(date, cycle_weeks)
    weekday = date.weekday()  # 0 = lunedì

    windows: list[tuple[int, int]] = []
    breaks: list[tuple[int, int]] = []
    for shift in operator.shifts.all():
        if shift.week_index != week_index or shift.weekday != weekday:
            continue
        start, end = shift.start_min, shift.end_min
        windows.append((start, end))
        if shift.break_start_min is not None and shift.break_end_min is not None:
            break_start = max(shift.break_start_min, start)
            break_end = min(shift.break_end_min, end)
            if break_start < break_end:
                breaks.append((break_start, break_end))
    # Prima si fondono le righe contigue (9–13 e 13–18 sono lo stesso turno
    # diviso in due: separate, un servizio che attraversa le 13 non entrerebbe
    # per intero in nessuna delle due), POI si tolgono le pause: al contrario la
    # fusione richiudeva il buco appena ritagliato (vedi `_subtract`).
    windows = _subtract(merge_intervals(windows), breaks)
    bounds = opening_windows(operator.salon, date)
    if bounds is not None:
        windows = merge_intervals(_intersect(windows, bounds))
    return windows


def today_status(operator, on_date: date_cls | None = None) -> dict:
    """Stato dell'operatrice per la giornata: finestre di turno, on_shift, assenza."""
    on_date = on_date or timezone.localdate()
    absence = _current_absence(operator, on_date)
    windows = shift_windows(operator, on_date)
    return {
        "windows": windows,
        "on_shift": bool(windows),
        "absence_type": absence.type if absence else None,
    }
