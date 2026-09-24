"""Pause dello staff in agenda (GET e POST di `/pauses`, PUT e DELETE di `/pauses/{id}`)."""

from django.utils import timezone
from ninja import Router

from common.auth import staff_auth
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get

from ..models import Pause
from ..presenters import _pause_out
from ..schemas import PauseIn, PauseOut
from ..services import pauses as pause_services  # «pauses» è anche il nome dei queryset
from .params import _parse_day

router = Router()


@router.get("/pauses", auth=staff_auth, response=list[PauseOut])
def list_pauses(request, date: str = "", operator_id: int = None):
    """Pause di una giornata. Senza `date` vale oggi: la vista è quella di un
    giorno, e senza filtro l'endpoint restituiva ogni pausa mai creata dal
    salone, senza paginazione."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date) if date else timezone.localdate()
    pauses = Pause.objects.filter(salon=ctx.salon, start__date=day).select_related("operator")
    if operator_id:
        pauses = pauses.filter(operator_id=operator_id)
    return [_pause_out(p) for p in pauses.order_by("start")]


@router.post("/pauses", auth=staff_auth, response=PauseOut)
def create_pause(request, data: PauseIn):
    ctx = request.auth
    require_scope(ctx, "agenda")

    from apps.staff.models import Operator  # lazy

    operator = salon_get(Operator, ctx, data.operator_id)
    pause = pause_services.create_pause(
        ctx.salon, operator,
        start=data.start, duration_min=data.duration_min, note=data.note, actor=ctx.user,
    )
    return _pause_out(pause)


@router.put("/pauses/{int:pause_id}", auth=staff_auth, response=PauseOut)
def update_pause(request, pause_id: int, data: PauseIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    pause = salon_get(Pause, ctx, pause_id)

    from apps.staff.models import Operator  # lazy

    operator = salon_get(Operator, ctx, data.operator_id)
    pause = pause_services.update_pause(
        ctx.salon, pause, operator,
        start=data.start, duration_min=data.duration_min, note=data.note, actor=ctx.user,
    )
    return _pause_out(pause)


@router.delete("/pauses/{int:pause_id}", auth=staff_auth, response=OkOut)
def delete_pause(request, pause_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    pause = salon_get(Pause, ctx, pause_id)
    pause_services.delete_pause(ctx.salon, pause, actor=ctx.user)
    return OkOut()
