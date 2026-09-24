"""Comunicazioni broadcast: invio subito o programmato, annullamento degli invii in coda, stato alla data.

L'invio vero lo fa Yourang dall'outbox (`communication.send`). Stava in
services.py; le regole «già inviata» e «destinatari validi» stavano in
api.py. L'endpoint tiene la lettura della comunicazione sotto lock
(`api._locked_communication`), questo modulo quello che succede dopo.
"""

import math
from datetime import datetime

from django.apps import apps as django_apps
from django.db.models import F
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity, supersede_events

from .models import Communication
from .schemas import CommunicationIn

# Sentinella per distinguere «non ho passato scheduled_at» da «l'ho passato a
# None perché voglio inviare adesso»: senza, una comunicazione già programmata
# non si poteva più forzare in invio immediato (il None veniva rimpiazzato dalla
# data salvata a database).
_UNSET = object()

SEND_EVENT = "communication.send"
# Annulla presso Yourang invii che potrebbe avere già in mano: payload
# {communication_id, outbox_event_ids}. Gli id sono quelli degli eventi
# `communication.send` consegnati, che Yourang ha ricevuto come `id` e come
# Idempotency-Key «outbox-<id>»: annullarli due volte non cambia niente.
CANCEL_EVENT = "communication.cancel"


def _parse_scheduled(value):
    """La data programmata scritta nel payload, con il fuso. ValueError se illeggibile."""
    when = datetime.fromisoformat(str(value))
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    return when


def _scheduled_ahead(value, now) -> bool:
    """La data programmata scritta nel payload è ancora da venire?"""
    if not value:
        return False  # invio immediato: è già partito, non c'è niente da fermare
    try:
        when = _parse_scheduled(value)
    except ValueError:
        return True  # illeggibile: meglio un annullamento inutile che un invio in più
    return when > now


def cancel_pending_send(comm: Communication) -> int:
    """Ferma l'invio di questa comunicazione che non è ancora partito.

    Una programmata ora resta TRATTENUTA in outbox fino alla sua data (vedi
    send_communication): modificarla, riprogrammarla o eliminarla la marca
    «superseded» e non partirà mai. Prima l'evento usciva subito, il worker lo
    consegnava in pochi secondi e questa pulizia — che guardava solo i
    `pending` — non trovava più niente: dopo «Modifica per riprogrammare» ogni
    cliente riceveva due messaggi, il primo col refuso, e una campagna
    eliminata partiva lo stesso (07-02).

    Quello che Yourang può avere già ricevuto — consegnato prima di questa
    correzione, preso in carico da un worker proprio adesso, o tentato e forse
    arrivato con la risposta persa — non si richiama dalla coda: per quello si
    accoda un `communication.cancel` con gli id da annullare, se la data non è
    ancora passata. Un evento già annullato non si annulla una seconda volta.

    Ritorna quanti invii sono stati fermati o annullati.
    """
    OutboxEvent = django_apps.get_model("core", "OutboxEvent")  # lazy: evita cicli
    sends = list(
        OutboxEvent.objects.filter(
            salon=comm.salon, event_type=SEND_EVENT, payload__communication_id=comm.id
        ).exclude(status=OutboxEvent.Status.SUPERSEDED)
    )
    if not sends:
        return 0
    supersede_events([e for e in sends if e.status == OutboxEvent.Status.PENDING])
    # Riletti dopo l'UPDATE: chi un worker ha preso in carico nel frattempo
    # resta vivo, ed è in volo.
    alive = set(
        OutboxEvent.objects.filter(pk__in=[e.pk for e in sends])
        .exclude(status=OutboxEvent.Status.SUPERSEDED)
        .values_list("pk", flat=True)
    )
    stopped = {e.pk for e in sends if e.pk not in alive}
    already = set()
    for cancel in OutboxEvent.objects.filter(
        salon=comm.salon, event_type=CANCEL_EVENT, payload__communication_id=comm.id
    ).exclude(status=OutboxEvent.Status.SUPERSEDED):
        already.update(cancel.payload.get("outbox_event_ids") or [])
    now = timezone.now()
    reached = [
        e.pk
        for e in sends
        if (e.pk in alive or e.attempts > 0)
        and e.pk not in already
        and _scheduled_ahead((e.payload or {}).get("scheduled_at"), now)
    ]
    if reached:
        payload = {"communication_id": comm.id, "outbox_event_ids": reached}
        # L'annullamento vale fino alla data dell'invio che ferma: con le dodici
        # ore contate dalla nascita (flush_outbox.expiry_of) scadeva prima di
        # una campagna fra qualche giorno, se la consegna restava ferma (Yourang
        # giù, worker spento), e alla data partiva la campagna eliminata.
        latest = _latest_scheduled([e for e in sends if e.pk in reached])
        if latest is not None:
            payload["scheduled_at"] = latest.isoformat()
        emit_event(comm.salon, CANCEL_EVENT, payload)
    return len(stopped | set(reached))


def _latest_scheduled(events):
    """La data programmata più avanti fra questi invii (None se nessuna leggibile)."""
    latest = None
    for event in events:
        value = (event.payload or {}).get("scheduled_at")
        if not value:
            continue
        try:
            when = _parse_scheduled(value)
        except ValueError:
            continue
        if latest is None or when > latest:
            latest = when
    return latest


def settle_due_communications(salon, now=None) -> int:
    """Le programmate con la data passata diventano «inviate».

    Alla data l'evento parte (o è appena partito): restare «Programmata» per
    sempre lasciava la campagna modificabile e rinviabile anche dopo l'invio.
    `sent_at` è la data programmata, e `scheduled_at` si svuota come per
    l'invio immediato, perché l'interfaccia non creda che parta un'altra volta.
    """
    now = now or timezone.now()
    return Communication.objects.filter(
        salon=salon, status=Communication.Status.SCHEDULED, scheduled_at__lte=now
    ).update(
        status=Communication.Status.SENT, sent_at=F("scheduled_at"), scheduled_at=None
    )


def send_communication(comm: Communication, *, scheduled_at=_UNSET, actor=None):
    """Risolve l'audience in client ids (consents.marketing=True) ed emette
    `communication.send`.

    Programmata: l'evento resta TRATTENUTO in outbox fino a `scheduled_at`
    (next_attempt_at) e parte alla data, con scheduled_at nel payload. Finché è
    in coda modifica ed eliminazione lo fermano davvero (cancel_pending_send);
    prima usciva subito e da lì in poi nessuno lo richiamava più.

    `scheduled_at` omesso significa «usa la data salvata sulla comunicazione»;
    `scheduled_at=None` esplicito significa «invia adesso»."""
    salon = comm.salon
    Client = django_apps.get_model("clients", "Client")  # lazy: evita cicli

    if scheduled_at is _UNSET:
        scheduled_at = comm.scheduled_at
    now = timezone.now()
    if scheduled_at and timezone.is_naive(scheduled_at):
        scheduled_at = timezone.make_aware(scheduled_at)
    # Una bozza con una data vecchia diventava «Programmata» per sempre con la
    # data nel passato, e cosa facesse Yourang con un invio già scaduto non lo
    # sapeva nessuno (07-14).
    if scheduled_at and scheduled_at <= now:
        raise HttpError(
            422, "La data di invio è già passata: scegline una futura oppure invia subito"
        )

    # Solo chi ha il consenso marketing ATTIVO adesso: la revoca (GDPR art. 7.3)
    # si scrive sullo stesso campo, quindi chi l'ha ritirato sparisce da qui.
    audience_ids = [int(x) for x in (comm.audience or [])]
    qs = Client.objects.filter(salon=salon, is_active=True, consents__marketing=True)
    if comm.audience_type == Communication.AudienceType.LABELS:
        qs = qs.filter(categories__id__in=audience_ids).distinct()
    else:
        qs = qs.filter(id__in=audience_ids)
    clients = list(qs.order_by("id"))

    payload = {
        "communication_id": comm.id,
        "title": comm.title,
        "body": comm.body,
        "image_url": comm.image.url if comm.image else None,
        "cta_label": comm.cta_label,
        "cta_url": comm.cta_url,
        "client_ids": [c.id for c in clients],
        "langs": {str(c.id): c.lang for c in clients},
    }

    # Un invio nuovo sostituisce quello eventualmente ancora in coda: mai due
    # eventi vivi per la stessa comunicazione.
    cancel_pending_send(comm)
    delay = 0
    if scheduled_at:
        comm.status = Communication.Status.SCHEDULED
        comm.scheduled_at = scheduled_at
        payload["scheduled_at"] = scheduled_at.isoformat()
        # Per eccesso: l'evento non deve diventare consegnabile prima della data.
        delay = math.ceil((scheduled_at - now).total_seconds())
        summary = f"Comunicazione «{comm.title}» programmata ({len(clients)} destinatari)"
    else:
        comm.status = Communication.Status.SENT
        comm.sent_at = timezone.now()
        # Inviata adesso: la data programmata non vale più, lasciarla scritta
        # farebbe credere all'interfaccia che parta una seconda volta.
        comm.scheduled_at = None
        summary = f"Comunicazione «{comm.title}» inviata a {len(clients)} clienti"
    comm.save(update_fields=["status", "scheduled_at", "sent_at"])

    emit_event(
        salon,
        SEND_EVENT,
        payload,
        delay_seconds=delay,
        coalesce_key=f"communication:{comm.id}",
    )
    log_activity(
        salon,
        "communication.send",
        summary,
        actor=actor,
        payload={"communication_id": comm.id, "recipients": len(clients)},
    )
    return comm


def already_sent(comm: Communication) -> bool:
    """Inviata, o programmata con la data già passata: l'evento è partito."""
    if comm.status == Communication.Status.SENT:
        return True
    return (
        comm.status == Communication.Status.SCHEDULED
        and comm.scheduled_at is not None
        and comm.scheduled_at <= timezone.now()
    )


def check_audience_type(data: CommunicationIn):
    """Un audience_type sconosciuto veniva letto come «lista di id cliente»:
    un refuso su «labels» e la promozione pensata per le VIP partiva a due
    persone a caso, quelle con l'id uguale all'id dell'etichetta."""
    if data.audience_type not in Communication.AudienceType.values:
        raise HttpError(422, "Destinatari non validi: scegli etichette o clienti")
