"""Lista d'attesa vista dallo staff: chi aspetta, e chi è stata contattata."""

from ninja import Router

from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from ..models import WaitlistEntry
from ..presenters import _waitlist_out
from ..schemas import WaitlistOut
from ..services import waitlist

router = Router()


@router.get("/waitlist", auth=staff_auth, response=list[WaitlistOut])
def list_waitlist(request):
    ctx = request.auth
    require_scope(ctx, "agenda")
    entries = (
        WaitlistEntry.objects.filter(salon=ctx.salon, status=WaitlistEntry.Status.ACTIVE)
        .select_related("client", "service", "operator")
        .order_by("created_at")
    )
    return [_waitlist_out(e) for e in entries]


@router.post("/waitlist/{int:entry_id}/contacted", auth=staff_auth, response=WaitlistOut)
def waitlist_contacted(request, entry_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    entry = salon_get(WaitlistEntry, ctx, entry_id)
    return _waitlist_out(waitlist.mark_contacted(ctx.salon, entry, actor=ctx.user))
