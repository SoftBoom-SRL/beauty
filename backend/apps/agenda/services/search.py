"""Ricerca degli appuntamenti per cliente (nome o telefono), dalla barra in alto.

Per trovare un appuntamento bisognava sapere il giorno, oppure aprire la
scheda della cliente e scorrerne lo storico: al telefono «a che ora ho
domani?» voleva dire tre passaggi (Beauty Boutique, 11/2026). Il filtro sulla
cliente è quello dell'anagrafica (`clients.search.search_filter`): nome e
cognome senza accenti, numero con o senza prefisso e spazi.
"""

import datetime as dt

from django.utils import timezone

from ..models import Appointment

# Quante visite per parte: le prossime e le ultime passate. La barra mostra
# un elenco breve: chi non trova scrive di più (cognome, numero).
SEARCH_LIMIT = 8
# Sotto questa lunghezza ogni ricerca risponde con mezzo salone.
MIN_QUERY = 2


def search_appointments(salon, q: str, *, now=None, limit: int = SEARCH_LIMIT) -> list[Appointment]:
    """Le visite delle clienti che rispondono a `q`: prima quelle da oggi in
    poi (dalla più vicina), poi le passate (dalla più recente). «Oggi» è il
    giorno del salone: le visite di stamattina sono ancora fra le prossime.

    Restano fuori le annullate e quelle tolte dall'agenda: in agenda non si
    vedono, e aprirle dalla ricerca porterebbe a un giorno dove non ci sono.
    """
    from apps.clients.models import Client  # lazy
    from apps.clients.search import search_filter  # lazy

    q = (q or "").strip()
    if len(q) < MIN_QUERY:
        return []
    now = now or timezone.now()
    today = timezone.make_aware(dt.datetime.combine(timezone.localtime(now).date(), dt.time.min))
    clients = Client.objects.filter(salon=salon).filter(search_filter(q)).values("id")
    base = (
        Appointment.objects.filter(salon=salon, client_id__in=clients, removed_from_agenda_at__isnull=True)
        .exclude(status=Appointment.Status.CANCELLED)
        .select_related("client", "operator")
        .prefetch_related("items__service", "items__operator")
    )
    upcoming = list(base.filter(start__gte=today).order_by("start", "id")[:limit])
    past = list(base.filter(start__lt=today).order_by("-start", "-id")[:limit])
    return upcoming + past
