"""La «permanenza» di una cliente: i suoi appuntamenti dello stesso giorno, uno dopo l'altro.

Mani alle 10 con Sole e piedi alle 11 con Mara sono due appuntamenti (ognuno
nella colonna della sua operatrice, ognuno spostabile da solo), ma per la
cliente è una visita sola e il conto è uno. Niente li legava: in agenda
sembravano estranei e in cassa si chiudeva solo quello su cui si era cliccato
(il titolare, 15/10).

Una permanenza sono gli appuntamenti attivi (non annullati né no-show) della
stessa cliente nello stesso giorno, dove ognuno comincia al più
`STAY_GAP_MIN` minuti dopo la fine di quelli prima. Una mattina e una sera
sono due permanenze. Non c'è un dato in più da tenere allineato: la regola è
la stessa in agenda (`frontend …/lib/stay.js`) e in cassa.
"""

import datetime as dt

from django.utils import timezone

from ..models import Appointment

STAY_GAP_MIN = 30


def stay_clusters(appointments) -> list[list]:
    """Gli appuntamenti (di una cliente, di un giorno) divisi in permanenze, in ordine di inizio."""
    gap = dt.timedelta(minutes=STAY_GAP_MIN)
    clusters, end = [], None
    for appointment in sorted(appointments, key=lambda a: (a.start, a.pk)):
        if clusters and appointment.start <= end + gap:
            clusters[-1].append(appointment)
            end = max(end, appointment.end)
        else:
            clusters.append([appointment])
            end = appointment.end
    return clusters


def stay_of(appointment) -> list[Appointment]:
    """La permanenza di `appointment`, lui compreso, in ordine di inizio."""
    if appointment.status in Appointment.INACTIVE_STATUSES:
        return [appointment]
    day = timezone.localdate(appointment.start)
    start = timezone.make_aware(dt.datetime.combine(day, dt.time.min))
    same_day = (
        Appointment.objects.filter(
            salon_id=appointment.salon_id,
            client_id=appointment.client_id,
            start__gte=start,
            start__lt=start + dt.timedelta(days=1),
        )
        .exclude(status__in=Appointment.INACTIVE_STATUSES)
        .select_related("operator", "sale")
        .prefetch_related("items__service", "items__operator")
    )
    for cluster in stay_clusters(list(same_day)):
        if any(a.pk == appointment.pk for a in cluster):
            return cluster
    return [appointment]


def bill_id(appointment):
    """Il conto in cui è stata incassata la visita: il suo, o quello unico di un'altra."""
    sale = getattr(appointment, "sale", None)
    return sale.pk if sale is not None else appointment.paid_in_sale_id
