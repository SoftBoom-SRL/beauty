"""Parametri delle rotte dell'agenda: date di query, voci della ricerca, sede."""

import datetime as dt
import json

from django.utils.dateparse import parse_date
from ninja.errors import HttpError

from apps.core.models import Location
from common.utils import salon_get

from ..schemas import MAX_ITEMS_PER_REQUEST, MAX_YEAR, MIN_YEAR


def _parse_day(value: str) -> dt.date:
    """Giorno da un parametro di query: 400 per ogni data che non sta in piedi.

    `parse_date` restituisce None solo per il formato sbagliato: una data ben
    scritta ma inesistente («2026-02-30») solleva ValueError, e un anno al
    limite (9999-12-30) faceva traboccare l'aritmetica dei giorni. Entrambi
    arrivavano all'utente come 500, anche sull'endpoint pubblico.
    """
    try:
        day = parse_date(value or "")
    except ValueError:
        day = None
    if day is None or not (MIN_YEAR <= day.year <= MAX_YEAR):
        raise HttpError(400, "Data non valida (atteso YYYY-MM-DD)")
    return day


def _as_optional_id(value):
    """int positivo, None se assente. Rifiuta tutto il resto con 400.

    `True` è un int per Python ma non è un id: senza il controllo su bool
    passerebbe come service_id=1.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise HttpError(400, "Parametro items non valido")
    return value


def _parse_items_param(raw: str) -> list[dict]:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise HttpError(400, "Parametro items non valido")
    if not isinstance(data, list) or not data:
        raise HttpError(400, "Parametro items non valido")
    if len(data) > MAX_ITEMS_PER_REQUEST:
        raise HttpError(400, f"Troppi servizi nella richiesta (massimo {MAX_ITEMS_PER_REQUEST})")
    items = []
    for entry in data:
        if not isinstance(entry, dict) or "service_id" not in entry:
            raise HttpError(400, "Parametro items non valido")
        service_id = _as_optional_id(entry["service_id"])
        if service_id is None:
            raise HttpError(400, "Parametro items non valido")
        items.append(
            {"service_id": service_id, "operator_id": _as_optional_id(entry.get("operator_id"))}
        )
    return items


def _get_location(ctx, location_id) -> Location | None:
    return salon_get(Location, ctx, location_id) if location_id else None
