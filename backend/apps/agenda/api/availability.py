"""Orari liberi per lo staff: una prenotazione nuova, o «Riprogramma» di una visita."""

from ninja import Router

from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from ..models import Appointment
from ..schemas import SlotOut
# Il modulo dei servizi ha lo stesso nome della vista `availability`.
from ..services import availability as availability_services
from .params import _get_location, _parse_day, _parse_items_param

router = Router()


@router.get("/availability", auth=staff_auth, response=list[SlotOut])
def availability(
    request, date: str, items: str = "", location_id: int = None,
    exclude_appointment_id: int = None,
):
    """Orari liberi per una nuova prenotazione o, con `exclude_appointment_id`,
    per spostare quella visita («Riprogramma»).

    Nel secondo caso la visita non conta come occupata e il piano viene da lei
    (righe in ordine, durate e pose scritte, operatrici, servizi usciti dal
    listino compresi): `items` si ignora. Cercando col listino di oggi e con la
    visita stessa in agenda, spostarla di mezz'ora non era mai possibile e gli
    orari proposti a una visita allungata finivano in un 409 da forzare.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date)
    if exclude_appointment_id:
        moving = salon_get(Appointment, ctx, exclude_appointment_id)
        parsed, keep_service_ids = availability_services._visit_plan(moving)
        location = _get_location(ctx, location_id) if location_id else moving.location
        return availability_services.get_free_slots(
            ctx.salon,
            day,
            parsed,
            location,
            exclude_appointment_id=moving.id,
            keep_service_ids=keep_service_ids,
        )
    return availability_services.get_free_slots(
        ctx.salon,
        day,
        _parse_items_param(items),
        location=_get_location(ctx, location_id),
    )
