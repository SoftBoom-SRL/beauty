"""Rotte della web app cliente (`/client/...`) e la disponibilità pubblica (`/public/...`).

Le rotte dell'app rispondono con la scheda della CLIENTE (`_client_appointment_out`):
con quella dello staff le arrivavano la nota interna scritta su di lei
(«cliente morosa…»), `forced`, `created_via` e il motivo di annullamento.
"""

from django.conf import settings
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import default_location, get_salon_by_slug
from common import ratelimit
from common.auth import client_auth
from common.schemas import OkOut
from common.utils import salon_get

from ..models import Appointment, WaitlistEntry
from ..presenters import _client_appointment_out, _waitlist_out, gift_index
from ..schemas import (
    ClientAppointmentCreateIn,
    ClientAppointmentOut,
    ClientMoveIn,
    SlotOut,
    WaitlistIn,
    WaitlistOut,
)
# `appointments` è anche il nome dei queryset e `availability` quello di una
# vista: i due moduli dei servizi si importano col suffisso.
from ..services import appointments as appointment_services
from ..services import availability as availability_services
from ..services import deposit_holds, deposits, transitions, waitlist
from .params import _parse_day, _parse_items_param

router = Router()


@router.get("/client/appointments", auth=client_auth)
def client_appointments(request):
    """Appuntamenti del cliente: futuri (attivi) e passati, in forma compatta."""
    ctx = request.auth
    now = timezone.now()
    deposit_holds.process_deposit_holds(ctx.salon)
    appointments = list(
        Appointment.objects.filter(salon=ctx.salon, client=ctx.client)
        .select_related("operator")
        .prefetch_related("items__service")
        .order_by("start")
    )
    gifts = gift_index(ctx.salon, [ctx.client.id])
    upcoming = [
        _client_appointment_out(a, gifts)
        for a in appointments
        if a.start >= now and a.status in Appointment.OPEN_STATUSES
    ]
    past = [
        _client_appointment_out(a, gifts)
        for a in reversed(appointments)
        if a.start < now or a.status not in Appointment.OPEN_STATUSES
    ]
    return {"upcoming": upcoming, "past": past}


@router.get("/client/availability", auth=client_auth, response=list[SlotOut])
def client_availability(request, date: str, items: str = "", exclude_appointment_id: int = None):
    """Disponibilità per il cliente. `exclude_appointment_id` (solo un proprio
    appuntamento) serve allo spostamento: l'appuntamento che si sta spostando
    non deve contare come occupato, e il piano viene dalla visita stessa
    (`items` si ignora)."""
    ctx = request.auth
    exclude = None
    keep_service_ids = ()
    location = default_location(ctx.salon)
    if exclude_appointment_id:
        moving = salon_get(Appointment, ctx, exclude_appointment_id, client=ctx.client)
        exclude = moving.id
        parsed, keep_service_ids = availability_services._visit_plan(moving)
        # Si cerca sulla sede dove la visita è già fissata.
        location = availability_services._client_move_location(ctx.salon, moving)
        if len(availability_services._unbookable_operator_ids(ctx.salon, parsed, location)) > 1:
            raise HttpError(400, availability_services.CLIENT_MOVE_NEEDS_SALON_MESSAGE)
    else:
        parsed = _parse_items_param(items)
    slots = availability_services.get_free_slots(
        ctx.salon,
        _parse_day(date),
        parsed,
        location,
        exclude_appointment_id=exclude,
        keep_service_ids=keep_service_ids,
    )
    return availability_services.smart_slots(ctx.salon, slots)


# Richieste di disponibilità pubbliche per IP e per ora: una ricerca costa
# decine di interrogazioni al database, e l'endpoint è senza autenticazione.
PUBLIC_AVAILABILITY_MAX_PER_WINDOW = 120
PUBLIC_AVAILABILITY_WINDOW_SECONDS = 3600


@router.get("/public/availability", response=list[SlotOut])
def public_availability(request, salon: str, date: str, items: str):
    """Disponibilità pubblica (no auth): solo orari liberi, salone per slug."""
    parsed = _parse_items_param(items)
    s = get_salon_by_slug(salon)
    ratelimit.enforce_public(
        request, s, "avail", PUBLIC_AVAILABILITY_MAX_PER_WINDOW, PUBLIC_AVAILABILITY_WINDOW_SECONDS
    )
    # Stessa sede della prenotazione: cercando su tutte e prenotando sulla
    # predefinita, l'app mostrava orari che poi rifiutava con un 409.
    return availability_services.smart_slots(
        s,
        availability_services.get_free_slots(s, _parse_day(date), parsed, default_location(s)),
    )


@router.post("/client/appointments", auth=client_auth, response=ClientAppointmentOut)
def client_create_appointment(request, data: ClientAppointmentCreateIn):
    """Prenotazione dall'app: mai nel passato, solo servizi attivi, sulla sede
    predefinita del salone (l'app non sceglie la sede), mai nella posa di
    un'altra cliente nemmeno con la stilista scelta."""
    ctx = request.auth
    location = default_location(ctx.salon)
    appointment = appointment_services.create_appointment(
        ctx.salon,
        ctx.client,
        [item.dict() for item in data.items],
        data.start,
        via=Appointment.CreatedVia.APP,
        location=location,
        allow_past=False,
        allow_soak=False,
    )
    deposits.send_deposit_link(appointment)
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


@router.post(
    "/client/appointments/{int:appointment_id}/move", auth=client_auth, response=ClientAppointmentOut
)
def client_move_appointment(request, appointment_id: int, data: ClientMoveIn):
    ctx = request.auth
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if not transitions.client_notice_ok(appointment):
        raise HttpError(
            400,
            "Spostamento non consentito a meno di "
            f"{settings.CLIENT_MOVE_CANCEL_MIN_HOURS} ore dall'appuntamento: "
            "contatta il salone",
        )
    operator, from_operator = availability_services._client_move_reassignment(
        ctx.salon, appointment, data.start
    )
    appointment = appointment_services.move_appointment(
        appointment, data.start, operator=operator, from_operator=from_operator, allow_past=False,
    )
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


@router.post(
    "/client/appointments/{int:appointment_id}/cancel", auth=client_auth, response=ClientAppointmentOut
)
def client_cancel_appointment(request, appointment_id: int):
    ctx = request.auth
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if not transitions.client_notice_ok(appointment):
        raise HttpError(400, "Annullamento non consentito: contatta il salone")
    appointment = transitions.cancel_appointment(appointment, by_client=True)
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


@router.get("/client/waitlist", auth=client_auth, response=list[WaitlistOut])
def client_list_waitlist(request):
    ctx = request.auth
    entries = (
        WaitlistEntry.objects.filter(
            salon=ctx.salon,
            client=ctx.client,
            status__in=[WaitlistEntry.Status.ACTIVE, WaitlistEntry.Status.CONTACTED],
        )
        .select_related("client", "service", "operator")
        .order_by("created_at")
    )
    return [_waitlist_out(e) for e in entries]


@router.post("/client/waitlist", auth=client_auth, response=WaitlistOut)
def client_create_waitlist(request, data: WaitlistIn):
    ctx = request.auth

    from apps.catalog.models import Service  # lazy

    service = salon_get(Service, ctx, data.service_id, active=True)
    operator = None
    if data.operator_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
    entry = waitlist.join_waitlist(
        ctx.salon, ctx.client, service, operator,
        preference=data.preference, exact_days=data.exact_days, exact_time=data.exact_time,
    )
    return _waitlist_out(entry)


@router.delete("/client/waitlist/{int:entry_id}", auth=client_auth, response=OkOut)
def client_delete_waitlist(request, entry_id: int):
    ctx = request.auth
    entry = salon_get(WaitlistEntry, ctx, entry_id, client=ctx.client)
    waitlist.leave_waitlist(ctx.salon, ctx.client, entry)
    return OkOut()
