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

from django.db import transaction
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


def movable_mates(appointment) -> list[Appointment]:
    """Gli altri appuntamenti della permanenza che si spostano con lui: quelli
    ancora da cominciare e non incassati (chi è già in salone o ha pagato resta
    dov'è)."""
    return [
        a for a in stay_of(appointment)
        if a.pk != appointment.pk and a.status == Appointment.Status.CONFIRMED and bill_id(a) is None
    ]


@transaction.atomic
def move_stay(appointment, new_start, *, operator=None, from_operator=None, actor=None, force=False):
    """Sposta la visita e, dello stesso scarto, gli altri appuntamenti della sua permanenza.

    Mani alle 10 con Sole e piedi alle 11 con Mara, spostati a giovedì: prima
    si riprogrammava un appuntamento per volta, cercando a mano l'orario di
    ognuno (Beauty Boutique, 11/2026). Ognuno resta con la sua operatrice e la
    distanza dagli altri; o si spostano tutti o nessuno (un 409 annulla
    tutto). Lo scarto in avanti sposta prima gli ultimi, all'indietro prima i
    primi: spostati di mezz'ora nello stesso giorno, il primo finiva sul posto
    ancora occupato dal secondo con la stessa operatrice.
    → (appointment spostato, gli altri spostati)
    """
    from .appointments import move_appointment  # lazy: i test lo sostituiscono

    delta = new_start - appointment.start
    mates = movable_mates(appointment)
    group = sorted([appointment, *mates], key=lambda a: (a.start, a.pk), reverse=delta > dt.timedelta(0))
    moved = {}
    for a in group:
        main = a.pk == appointment.pk
        moved[a.pk] = move_appointment(
            a, a.start + delta,
            operator=operator if main else None, from_operator=from_operator if main else None,
            actor=actor, force=force, client_overlap_ok=True, any_operator=True,
        )
    return moved[appointment.pk], [moved[a.pk] for a in mates]
