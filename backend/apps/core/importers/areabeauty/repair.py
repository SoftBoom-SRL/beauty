"""Correzioni degli appuntamenti già importati: dividere una visita in più appuntamenti.

Lo usano i comandi `fix_areabeauty_pose` (dove c'era un buco) e
`fix_areabeauty_operatrici` (dove lavoravano più colleghe): i servizi di ogni
gruppo dopo il primo diventano un appuntamento a sé della stessa cliente, allo
stesso orario e nello stesso conto («incassato nel conto unico»). Nessun
servizio cambia orario: se succedesse, la divisione si ferma con un errore e il
comando annulla tutto.
"""

import datetime as dt

from django.contrib.contenttypes.models import ContentType
from django.core.management.base import CommandError

from apps.agenda.models import Appointment, AppointmentService
from apps.core.models import ExternalRef
from apps.sales.models import Sale

from . import SOURCE


def imported_appointment_ids(salon) -> set[int]:
    """Gli appuntamenti che vengono da AreaBeauty (righe del planning, annullati, parti divise)."""
    ct = ContentType.objects.get_for_model(Appointment)
    return set(
        ExternalRef.objects.filter(
            salon=salon, source=SOURCE, kind__in=["appuntamento", "annullato"], content_type=ct
        ).values_list("object_id", flat=True)
    )


def chain_starts(appointment, items) -> dict[int, dt.datetime]:
    """{id voce: inizio} come lo calcola l'agenda: in fila dall'inizio, durata più posa."""
    out, at = {}, appointment.start
    for item in items:
        out[item.id] = at
        at += dt.timedelta(minutes=item.duration_min + item.soak_min)
    return out


def split_off(appointment, items, groups, before, ref_prefix) -> list[Appointment]:
    """Fa di `groups[1:]` appuntamenti a sé. `before` = gli inizi PRIMA di toccare la visita.

    Il riferimento `appuntamento` delle parti (`<ref_prefix>:<visita>:<n>`)
    fa sì che, rilanciando l'import su un export nuovo, quelle ancora aperte
    si rifacciano insieme alle altre invece di restare doppie.
    """
    ct = ContentType.objects.get_for_model(Appointment)
    sale = Sale.objects.filter(appointment=appointment).first()
    paid_in = sale.pk if sale else appointment.paid_in_sale_id
    parts = []
    for n, group in enumerate(groups[1:], start=1):
        part = Appointment.objects.create(
            salon=appointment.salon,
            location=appointment.location,
            client=appointment.client,
            operator=group[0].operator,
            start=before[group[0].id],
            status=appointment.status,
            created_via=appointment.created_via,
            cancel_reason=appointment.cancel_reason,
            cancelled_late=appointment.cancelled_late,
            paid_in_sale_id=paid_in,
        )
        Appointment.objects.filter(pk=part.pk).update(created_at=appointment.created_at, updated_at=appointment.updated_at)
        for order, item in enumerate(group):
            AppointmentService.objects.filter(pk=item.pk).update(appointment=part, order=order)
        ExternalRef.objects.get_or_create(
            salon=appointment.salon, source=SOURCE, kind="appuntamento",
            external_id=f"{ref_prefix}:{appointment.pk}:{n}",
            defaults={"content_type": ct, "object_id": part.pk},
        )
        parts.append(part)
    Appointment.objects.filter(pk=appointment.pk).update(operator=groups[0][0].operator)

    # Nessun servizio deve aver cambiato orario. Gli aggiuntivi (durata 0) non
    # hanno un orario loro: si appoggiano al servizio prima.
    after = {}
    for apt in [appointment, *parts]:
        apt.refresh_from_db()
        after.update(chain_starts(apt, list(apt.items.order_by("order", "id"))))
    moved = [item.id for item in items if item.duration_min > 0 and before[item.id] != after.get(item.id)]
    if moved:
        raise CommandError(f"visita {appointment.pk}: {len(moved)} servizi cambierebbero orario, niente salvato")
    return parts
