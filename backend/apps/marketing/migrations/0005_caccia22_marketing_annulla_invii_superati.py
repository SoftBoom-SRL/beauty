"""Invii programmati consegnati a Yourang prima della correzione 07-02 (caccia del 22/09).

Fino a questa versione una comunicazione programmata usciva subito verso
Yourang, che la teneva fino alla data, e né la modifica né l'eliminazione la
fermavano più: la versione col refuso partirà comunque, e così la campagna
cancellata. Il codice nuovo trattiene l'invio in coda fino alla data e annulla
quello che Yourang ha già ricevuto; questa migrazione fa lo stesso, una volta,
per quello che è stato consegnato prima.

Per ogni invio con la data ancora da venire si accoda un `communication.cancel`
(gli id da annullare, come fa `services.cancel_pending_send`) quando non
corrisponde più a una campagna programmata:
- la comunicazione è stata eliminata;
- è tornata in bozza (modificata dopo averla programmata) o è stata inviata
  subito;
- è ancora programmata, ma quell'invio è una copia vecchia (un'altra data, o un
  invio più recente per la stessa data). L'invio che corrisponde alla data
  attuale resta.
Gli stessi invii ancora in coda per un ritentativo si marcano «superseded».
Gli invii immediati e quelli con la data passata non si toccano: sono partiti.
"""

from datetime import datetime

from django.db import migrations
from django.utils import timezone


def _when(value):
    try:
        when = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    return when


def forwards(apps, schema_editor):
    OutboxEvent = apps.get_model("core", "OutboxEvent")
    Communication = apps.get_model("marketing", "Communication")
    now = timezone.now()

    candidates = {}  # (salon_id, communication_id) -> [(evento, data programmata)]
    sends = (
        OutboxEvent.objects.filter(event_type="communication.send")
        .exclude(status="superseded")
        .order_by("id")
    )
    for event in sends.iterator():
        payload = event.payload or {}
        comm_id = payload.get("communication_id")
        when = _when(payload.get("scheduled_at")) if payload.get("scheduled_at") else None
        if comm_id is None or when is None or when <= now:
            continue
        candidates.setdefault((event.salon_id, comm_id), []).append((event, when))

    for (salon_id, comm_id), events in candidates.items():
        comm = Communication.objects.filter(pk=comm_id, salon_id=salon_id).first()
        keep = None
        if comm is not None and comm.status == "scheduled" and comm.scheduled_at:
            current = [event.pk for event, when in events if when == comm.scheduled_at]
            keep = current[-1] if current else None
        cancel_ids = []
        latest = None
        for event, when_at in events:
            if event.pk == keep:
                continue
            if event.status == "pending":
                OutboxEvent.objects.filter(pk=event.pk, status="pending").update(
                    status="superseded", next_attempt_at=None
                )
            if event.status in ("sent", "sending", "failed") or event.attempts > 0:
                cancel_ids.append(event.pk)
                latest = when_at if latest is None or when_at > latest else latest
        if cancel_ids:
            # Con la data dell'invio più lontano l'annullamento resta valido fino
            # a lì (flush_outbox.expiry_of), non solo dodici ore dalla nascita.
            OutboxEvent.objects.create(
                salon_id=salon_id,
                event_type="communication.cancel",
                payload={
                    "communication_id": comm_id,
                    "outbox_event_ids": cancel_ids,
                    "scheduled_at": latest.isoformat(),
                },
            )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0009_outboxevent_coalesce_key_and_more"),
        ("marketing", "0004_caccia22_marketing_timbri_per_visita"),
    ]

    operations = [
        # All'indietro non c'è niente da rifare: gli annullamenti sono già
        # partiti verso Yourang.
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
